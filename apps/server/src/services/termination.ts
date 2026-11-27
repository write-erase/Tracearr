/**
 * Stream Termination Service
 *
 * Orchestrates stream termination across media servers and logs all termination events.
 * Supports both manual (admin-initiated) and automatic (rule-triggered) terminations.
 */

import {
  SERVER_PROFILES,
  assertNever,
  isDockerGatewayAddress,
  isTailscaleAddress,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { terminationLogs, sessions } from '../db/schema.js';
import { readSessionRow, sessionRowById } from '../db/sessions/row.js';
import { createMediaServerClient } from './mediaServer/index.js';
import { stopRefusal } from './mediaServer/byServerType.js';
import { getCacheService, getPubSubService } from './cache.js';
import { toRuleSession } from './automations/events/contextAssembly.js';
import { dispatchSessionStopped } from './automations/events/producers.js';
import { clearDbWriteTracking } from '../jobs/poller/dbWriteThrottle.js';
import { buildCompositeKey, terminationSessionId } from '../jobs/poller/sessionIdentity.js';
import { isPrivateIP } from '../jobs/poller/utils.js';
import { isLocalSession } from '../db/sessions/rules.js';

// ============================================================================
// Types
// ============================================================================

export interface TerminateSessionOptions {
  /** Database session ID (UUID) */
  sessionId: string;

  /** How the termination was triggered */
  trigger: 'manual' | 'rule';

  /** For manual: user ID who initiated the termination */
  triggeredByUserId?: string;

  /** For rule: the rule that triggered termination */
  ruleId?: string;

  /** For rule: the violation record */
  violationId?: string;

  /** Message to display to user (Plex, tofa and Silo; ignored by Jellyfin/Emby) */
  reason?: string;

  /** The session's start when the caller holds it, so the lookup skips the older chunks */
  sessionStartedAt?: Date | string | null;
}

export type TerminationOutcome =
  | 'terminated'
  | 'already_gone'
  | 'failed'
  | 'server_historical'
  /** Channels DVR: only sessions on the local network can be stopped */
  | 'not_local';

export const REMOTE_STREAM_NOT_TERMINABLE =
  'Tracearr can only stop Channels DVR streams on devices within your local network.';

export const WEB_PLAYER_NOT_TERMINABLE =
  "Tracearr can't stop Channels DVR streams playing in a web browser.";

export const PROXIED_STREAM_NOT_TERMINABLE =
  "This device reaches Channels DVR through a proxy, so Tracearr can't reach it to stop the stream.";

export interface TerminationResult {
  success: boolean;
  terminationLogId: string;
  error?: string;
  /** Specific outcome of the termination attempt */
  outcome: TerminationOutcome;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Terminate a stream and log the termination
 *
 * @param options - Termination options including session ID and trigger info
 * @returns Result indicating success/failure and the termination log ID
 *
 * @example
 * // Manual termination by admin
 * const result = await terminateSession({
 *   sessionId: 'uuid-123',
 *   trigger: 'manual',
 *   triggeredByUserId: adminUser.id,
 *   reason: 'Admin requested stream stop',
 * });
 *
 * @example
 * // Rule-triggered termination
 * const result = await terminateSession({
 *   sessionId: 'uuid-123',
 *   trigger: 'rule',
 *   ruleId: rule.id,
 *   violationId: violation.id,
 *   reason: 'Concurrent stream limit exceeded',
 * });
 */
export async function terminateSession(
  options: TerminateSessionOptions
): Promise<TerminationResult> {
  const { sessionId, trigger, triggeredByUserId, ruleId, violationId, reason } = options;

  const session = await readSessionRow(sessionId, options.sessionStartedAt, (where) =>
    db.query.sessions.findFirst({ where, with: { server: true, serverUser: true } })
  );

  if (!session) {
    // Don't log when session not found - we have no audit context (no server/user)
    // The route handler validates session exists before calling this service,
    // so this case only happens on race conditions or bugs
    return {
      success: false,
      terminationLogId: '',
      error: 'Session not found in database',
      outcome: 'failed',
    };
  }

  const logBase = {
    sessionId: session.id,
    sessionStartedAt: session.startedAt,
    serverId: session.serverId,
    serverUserId: session.serverUserId,
    trigger,
    triggeredByUserId: triggeredByUserId ?? null,
    ruleId: ruleId ?? null,
    violationId: violationId ?? null,
    reason: reason ?? null,
  };

  // The switch force-stopped the server's streams; anything queued before it ends here.
  if (session.server.historicalAt) {
    const logEntries = await db
      .insert(terminationLogs)
      .values({
        ...logBase,
        success: false,
        errorMessage: 'Server is historical',
      })
      .returning({ id: terminationLogs.id });

    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: 'Server is historical',
      outcome: 'server_historical',
    };
  }

  // Channels DVR stops playback by calling the Channels app on the device itself, which
  // only works on the local network. Refuse remote sessions up front.
  // The Channels web player is a browser: there is no app on :57000 to stop it, and an app
  // that once had its address might be stopped instead. Refuse before anything is sent.
  if (session.server.type === 'channels_dvr' && session.product === 'Channels Web') {
    const logEntries = await db
      .insert(terminationLogs)
      .values({ ...logBase, success: false, errorMessage: WEB_PLAYER_NOT_TERMINABLE })
      .returning({ id: terminationLogs.id });
    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: WEB_PLAYER_NOT_TERMINABLE,
      outcome: 'not_local',
    };
  }

  // Behind a proxy into the DVR's container, Channels DVR only sees the Docker gateway, never
  // the device; a stop sent there would reach nothing (fork).
  if (session.server.type === 'channels_dvr' && isDockerGatewayAddress(session.ipAddress)) {
    const logEntries = await db
      .insert(terminationLogs)
      .values({ ...logBase, success: false, errorMessage: PROXIED_STREAM_NOT_TERMINABLE })
      .returning({ id: terminationLogs.id });
    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: PROXIED_STREAM_NOT_TERMINABLE,
      outcome: 'not_local',
    };
  }

  // A Tailscale viewer is tried too: a Tracearr server on the tailnet reaches the device there,
  // and the client's reachability probe fails fast when it does not (fork).
  if (
    session.server.type === 'channels_dvr' &&
    !isTailscaleAddress(session.ipAddress) &&
    !(isLocalSession(session) && !!session.ipAddress && isPrivateIP(session.ipAddress))
  ) {
    const logEntries = await db
      .insert(terminationLogs)
      .values({
        ...logBase,
        success: false,
        errorMessage: REMOTE_STREAM_NOT_TERMINABLE,
      })
      .returning({ id: terminationLogs.id });

    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: REMOTE_STREAM_NOT_TERMINABLE,
      outcome: 'not_local',
    };
  }

  const refusal = stopRefusal(session);
  if (refusal) {
    const logEntries = await db
      .insert(terminationLogs)
      .values({ ...logBase, success: false, errorMessage: refusal })
      .returning({ id: terminationLogs.id });

    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: refusal,
      outcome: 'failed',
    };
  }

  // Create media server client
  const client = createMediaServerClient({
    type: session.server.type,
    url: session.server.url,
    token: session.server.token,
    ignoreAnonymousStreams: session.server.ignoreAnonymousStreams,
  });

  // Plex stops by Session.id and Jellyfin/Emby by the session id (terminationSessionId).
  // Channels DVR stops through the Channels app on the playback device, so it's the device's IP;
  // a Dispatcharr catch-up playback is stopped by its catch-up connection.
  const serverSessionId =
    session.server.type === 'channels_dvr'
      ? session.ipAddress
      : session.server.type === 'dispatcharr' && session.dispatcharrPlaybackKind === 'catchup'
        ? `catchup:${session.sessionKey.split(':')[1] ?? ''}`
        : terminationSessionId(session.server.type, session);

  if (!serverSessionId) {
    const logEntries = await db
      .insert(terminationLogs)
      .values({
        ...logBase,
        success: false,
        errorMessage: 'No session ID available for termination',
      })
      .returning({ id: terminationLogs.id });

    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: 'No session ID available for termination',
      outcome: 'failed',
    };
  }

  // Attempt to terminate the session
  let success = false;
  let errorMessage: string | null = null;
  let outcome: TerminationOutcome;

  try {
    await client.terminateSession(serverSessionId, reason);
    success = true;
    outcome = 'terminated';
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error during termination';

    // Treat "not found" as success - session is already gone
    if (errMsg.includes('not found') || errMsg.includes('404')) {
      success = true;
      outcome = 'already_gone';
      errorMessage = null;
    } else {
      errorMessage = errMsg;
      outcome = 'failed';
    }
  }

  // If termination was successful (or session already gone), clean up locally
  if (success) {
    const now = new Date();
    const startedAt = session.startedAt ? new Date(session.startedAt) : now;
    const durationMs = now.getTime() - startedAt.getTime();

    // Update database
    await db
      .update(sessions)
      .set({
        state: 'stopped',
        stoppedAt: now,
        durationMs,
        forceStopped: true,
      })
      .where(sessionRowById(session));

    await dispatchSessionStopped(
      toRuleSession(session, { state: 'stopped', stoppedAt: now, durationMs }),
      durationMs,
      now
    );

    clearDbWriteTracking(session.id);

    // Update cache (remove from active sessions)
    const cacheService = getCacheService();
    if (cacheService) {
      try {
        const live = await cacheService.getSessionById(session.id);
        await cacheService.removeActiveSession(session.id);

        // Keeps the server's leftover report of the killed playback from being re-created.
        // A session the server no longer had leaves nothing behind to hold off.
        if (outcome === 'terminated' && session.ratingKey) {
          const identity = SERVER_PROFILES[session.server.type].sessionIdentity;
          switch (identity) {
            case 'sessionKey':
              await cacheService.setTerminationCooldown(
                session.serverId,
                session.sessionKey,
                session.ratingKey
              );
              break;
            case 'composite':
              await cacheService.setTerminationCooldownComposite(
                session.serverId,
                buildCompositeKey({
                  serverType: session.server.type,
                  serverId: session.serverId,
                  externalUserId: session.serverUserId,
                  deviceId: session.deviceId,
                  ratingKey: session.ratingKey,
                  sessionKey: session.sessionKey,
                }),
                {
                  killedAt: now.getTime(),
                  positionMs: (live ?? session).progressMs ?? 0,
                  paused: (live ?? session).state === 'paused',
                }
              );
              break;
            default:
              assertNever(identity);
          }
        }
      } catch (cacheErr) {
        // Log but don't fail - DB is source of truth
        console.error('[Termination] Failed to update cache:', cacheErr);
      }
    }

    // Broadcast stop event
    const pubSubService = getPubSubService();
    if (pubSubService) {
      try {
        await pubSubService.publish('session:stopped', session.id);
      } catch (pubSubErr) {
        // Log but don't fail - clients will sync on next poll
        console.error('[Termination] Failed to broadcast stop:', pubSubErr);
      }
    }
  }

  // Log the termination attempt
  const logEntries = await db
    .insert(terminationLogs)
    .values({
      ...logBase,
      success,
      errorMessage,
    })
    .returning({ id: terminationLogs.id });

  return {
    success,
    terminationLogId: logEntries[0]?.id ?? '',
    error: errorMessage ?? undefined,
    outcome,
  };
}
