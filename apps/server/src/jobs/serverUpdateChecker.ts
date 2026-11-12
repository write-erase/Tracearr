/**
 * What each media server runs and what its vendor ships, every six hours on the leader.
 * Both versions land on the server row; a newer release nudges once per version.
 */

import { eq } from 'drizzle-orm';
import type { ServerType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { dispatchServerUpdate } from '../services/automations/events/producers.js';
import { createMediaServerClient } from '../services/mediaServer/index.js';
import { liveServers } from '../services/liveServers.js';
import { getSettings } from '../services/settings.js';
import { createLogger } from '../utils/logger.js';
import { startPeriodic, type PeriodicTimers } from '../utils/periodic.js';
import {
  CHANNELS_PRERELEASE_NOTES,
  SERVER_RELEASE_PAGES,
  channelsTrackFor,
  isNewerServerVersion,
  latestChannelsVersions,
  latestVersionFor,
  normalizeServerVersion,
  type ChannelsLatestVersions,
} from '../utils/serverVersions.js';

const logger = createLogger('ServerUpdate');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Channels DVR ships pre-releases often, sometimes several a day: its servers are checked hourly.
const CHANNELS_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;

/** Which servers a run covers: the 6-hourly sweep skips Channels DVR, which has its own hourly one. */
type CheckScope = 'all' | 'channels' | 'others';

export interface CheckedServer {
  id: string;
  name: string;
  type: ServerType;
  url: string;
  token: string;
  /** Channels DVR only; absent reads as 'auto' */
  updateTrack?: 'auto' | 'stable' | 'prerelease';
}

let timers: PeriodicTimers | null = null;
let channelsTimers: PeriodicTimers | null = null;
// serverId -> latest version already nudged for; re-arms when a newer release lands
const nudgedVersions = new Map<string, string>();

export function _resetServerUpdateStateForTests(): void {
  nudgedVersions.clear();
}

/**
 * Both columns hold normalized versions, so everything downstream compares them as
 * strings. An unreachable or unparseable server keeps whatever the row already holds.
 */
export async function installedVersionOf(server: CheckedServer): Promise<string | null> {
  let reported: string | null;
  try {
    const client = createMediaServerClient({
      type: server.type,
      url: server.url,
      token: server.token,
      id: server.id,
    });
    reported = (await client.getSoftwareVersion?.()) ?? null;
  } catch (error) {
    logger.warn(`${server.name}: could not read its version`, { error });
    return null;
  }
  if (!reported) return null;
  const normalized = normalizeServerVersion(server.type, reported);
  if (!normalized) logger.debug(`${server.name}: unreadable version ${reported}`);
  return normalized;
}

/**
 * The newest release for this server: one per type, except Channels DVR, where each server
 * follows its own track (stable or pre-release) and so has its own "latest".
 */
type LatestFor = (installed: string | null) => {
  version: string | null;
  releaseUrl: string;
};

async function checkServer(server: CheckedServer, latestFor: LatestFor): Promise<void> {
  const installed = await installedVersionOf(server);
  const { version: latest, releaseUrl } = latestFor(installed);

  const patch: { version?: string; latestVersion?: string } = {};
  if (installed) patch.version = installed;
  if (latest) patch.latestVersion = latest;
  if (installed ?? latest) {
    // One server's write failing leaves the rest of the sweep to run.
    try {
      await db
        .update(servers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(servers.id, server.id));
    } catch (error) {
      logger.warn(`${server.name}: could not store its version`, { error });
    }
  }

  if (!installed || !latest) return;
  if (!isNewerServerVersion(server.type, latest, installed)) {
    nudgedVersions.delete(server.id);
    return;
  }
  if (nudgedVersions.get(server.id) === latest) return;

  nudgedVersions.set(server.id, latest);
  await dispatchServerUpdate({
    server: { id: server.id, name: server.name, type: server.type },
    installedVersion: installed,
    latestVersion: latest,
    releaseUrl,
  });
  logger.info(`${server.name}: ${installed} -> ${latest} available`);
}

export async function runServerUpdateCheck(scope: CheckScope = 'all'): Promise<void> {
  try {
    const settings = await getSettings(['serverUpdateCheckEnabled']);
    if (!settings.serverUpdateCheckEnabled) return;

    const rows = (await liveServers()).filter((server) =>
      scope === 'all'
        ? true
        : scope === 'channels'
          ? server.type === 'channels_dvr'
          : server.type !== 'channels_dvr'
    );

    // The vendor feed is per type, not per server: read it once however many servers share it.
    const latestByType = new Map<ServerType, Promise<string | null>>();
    let channels: Promise<ChannelsLatestVersions> | null = null;
    for (const server of rows) {
      if (server.type === 'channels_dvr') {
        channels ??= latestChannelsVersions();
        const versions = await channels;
        await checkServer(server, (installed) => {
          const track = channelsTrackFor(server.updateTrack ?? 'auto', installed, versions);
          return {
            version: versions[track],
            releaseUrl:
              track === 'prerelease'
                ? CHANNELS_PRERELEASE_NOTES
                : SERVER_RELEASE_PAGES.channels_dvr,
          };
        });
        continue;
      }
      const latest = await latestByType.getOrInsertComputed(server.type, latestVersionFor);
      await checkServer(server, () => ({
        version: latest,
        releaseUrl: SERVER_RELEASE_PAGES[server.type],
      }));
    }
  } catch (error) {
    logger.error('Check failed', { error });
  }
}

export function startServerUpdateChecker(): void {
  if (timers) return;
  timers = startPeriodic(INITIAL_DELAY_MS, CHECK_INTERVAL_MS, () => runServerUpdateCheck('others'));
  channelsTimers = startPeriodic(INITIAL_DELAY_MS, CHANNELS_CHECK_INTERVAL_MS, () =>
    runServerUpdateCheck('channels')
  );
  logger.info('Checker started (every 6h; Channels DVR every hour)');
}

export function stopServerUpdateChecker(): void {
  timers?.stop();
  timers = null;
  channelsTimers?.stop();
  channelsTimers = null;
}
