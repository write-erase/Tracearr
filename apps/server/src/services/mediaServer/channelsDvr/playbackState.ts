/**
 * Pause detection for Channels DVR recordings.
 *
 * The /dvr activity line carries the playback position ("at 4m28s") but no
 * paused flag. While playing, Channels advances that position roughly every
 * 10 seconds; while paused it stays put. A session is therefore reported as
 * paused once its position has not moved for PAUSE_AFTER_MS (two update cycles),
 * so normal 10 s update gaps never read as a pause.
 *
 * State is module-level because the poller may build a new client per poll.
 * Entries are keyed by server URL + activity key and dropped once the session
 * disappears from a full (unfiltered) poll.
 *
 * Between refreshes a playing session's position is carried forward by the time
 * since it last changed, so the Now Playing counter does not step backwards.
 *
 * When the device itself reported its state (see deviceStatus.ts) that wins, and
 * none of the inference above applies to that session.
 */

import type { MediaSession } from '../types.js';
import type { DeviceStatus } from './deviceStatus.js';
import { calculateProgress } from '../shared/parserUtils.js';

export const PAUSE_AFTER_MS = 20_000;

interface Seen {
  positionMs: number;
  changedAt: number;
}

const seenByServer = new Map<string, Map<string, Seen>>();

export function applyPauseState(
  serverUrl: string,
  sessions: MediaSession[],
  {
    complete,
    now = Date.now(),
    deviceStatuses,
  }: { complete: boolean; now?: number; deviceStatuses?: Map<string, DeviceStatus> }
): MediaSession[] {
  let seen = seenByServer.get(serverUrl);
  if (!seen) {
    seen = new Map();
    seenByServer.set(serverUrl, seen);
  }

  const result = sessions.map((session) => {
    // Live TV has no position to watch, so it is always playing.
    if (session.media.type === 'live') return session;

    // A file stream that has lost its position (the web player sitting on its end screen
    // drops "at …" but stays listed) is not playing: hold the last position, paused.
    if (session.playback.positionMs <= 0) {
      const last = seen.get(session.sessionKey);
      if (!last || last.positionMs <= 0) return session;
      const durationMs = session.media.durationMs;
      return {
        ...session,
        playback: {
          ...session.playback,
          state: 'paused' as const,
          positionMs: last.positionMs,
          ...(durationMs > 0
            ? { progressPercent: calculateProgress(last.positionMs, durationMs) }
            : {}),
        },
      };
    }

    // The device said exactly what it is doing: use that, and keep the server-side
    // tracker current so a later fallback starts from the right place.
    const device = deviceStatuses?.get(session.sessionKey);
    if (device) {
      const tracked = seen.get(session.sessionKey);
      if (!tracked || tracked.positionMs !== session.playback.positionMs) {
        seen.set(session.sessionKey, { positionMs: session.playback.positionMs, changedAt: now });
      }
      const durationMs = session.media.durationMs;
      const positionMs =
        durationMs > 0 ? Math.min(device.positionMs, durationMs) : device.positionMs;
      return {
        ...session,
        playback: {
          ...session.playback,
          state: device.state,
          positionMs,
          ...(durationMs > 0 ? { progressPercent: calculateProgress(positionMs, durationMs) } : {}),
        },
      };
    }

    const previous = seen.get(session.sessionKey);
    if (!previous || previous.positionMs !== session.playback.positionMs) {
      seen.set(session.sessionKey, { positionMs: session.playback.positionMs, changedAt: now });
      return session;
    }
    const sinceChange = now - previous.changedAt;
    if (sinceChange >= PAUSE_AFTER_MS) {
      return { ...session, playback: { ...session.playback, state: 'paused' as const } };
    }
    // Still playing, but Channels has not refreshed the position yet (it does so about
    // every 10 s). Carry it forward by the time since it last moved so the reported
    // position never steps backwards between refreshes.
    const positionMs = session.playback.positionMs + sinceChange;
    const durationMs = session.media.durationMs;
    return {
      ...session,
      playback: {
        ...session.playback,
        positionMs: durationMs > 0 ? Math.min(positionMs, durationMs) : positionMs,
        ...(durationMs > 0
          ? { progressPercent: calculateProgress(Math.min(positionMs, durationMs), durationMs) }
          : {}),
      },
    };
  });

  if (complete) {
    const active = new Set(sessions.map((s) => s.sessionKey));
    for (const key of seen.keys()) if (!active.has(key)) seen.delete(key);
  }
  return result;
}

/** Test helper. */
export function resetPauseState(): void {
  seenByServer.clear();
}
