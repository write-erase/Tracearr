/**
 * What each media server runs and what its vendor ships, every six hours on the leader, every
 * server type alike (fork: Channels DVR used to be checked hourly). Both versions land on the
 * server row; a newer release nudges once per version. A Channels DVR or Dispatcharr server with an update waiting is
 * also asked its version every minute, so the dashboard shows the update installed within a
 * minute of it finishing.
 */

import { eq } from 'drizzle-orm';
import { assertNever, type ServerType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { dispatchServerUpdate } from '../services/automations/events/producers.js';
import { publishServersChanged } from './poller/database.js';
import { createMediaServerClient, TofaClient } from '../services/mediaServer/index.js';
import { liveServers } from '../services/liveServers.js';
import { getSettings } from '../services/settings.js';
import { createLogger } from '../utils/logger.js';
import { startPeriodic, type PeriodicTimers } from '../utils/periodic.js';
import {
  CHANNELS_PRERELEASE_NOTES,
  DISPATCHARR_DEV_TAGS,
  SERVER_RELEASE_PAGES,
  channelsTrackFor,
  dispatcharrDevLatest,
  isDispatcharrDevVersion,
  latestDispatcharrDevBuild,
  isNewerServerVersion,
  latestChannelsVersions,
  latestVersionFor,
  normalizeServerVersion,
  type ChannelsLatestVersions,
  type FeedServerType,
} from '../utils/serverVersions.js';

const logger = createLogger('ServerUpdate');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;
// Only servers with an update waiting are asked, one /status read each.
const CHANNELS_WATCH_INTERVAL_MS = 60_000;
const CHANNELS_WATCH_INITIAL_DELAY_MS = 45_000;

export interface CheckedServer {
  id: string;
  name: string;
  type: ServerType;
  url: string;
  token: string;
  /** Channels DVR only; absent reads as 'auto' */
  updateTrack?: 'auto' | 'stable' | 'prerelease';
  /** What the row holds now, so a run can tell whether it changed anything */
  version?: string | null;
  latestVersion?: string | null;
}

let timers: PeriodicTimers | null = null;
let channelsWatchTimers: PeriodicTimers | null = null;
// A minute's watch still running (a slow server) isn't started a second time.
let watchRunning = false;
// serverId -> latest version already nudged for; re-arms when a newer release lands
const nudgedVersions = new Map<string, string>();

export function _resetServerUpdateStateForTests(): void {
  nudgedVersions.clear();
  watchRunning = false;
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
    reported = await client.getSoftwareVersion();
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
 * follows its own track (stable or pre-release) and so has its own "latest", and tofa, where each
 * server reports the update waiting for it.
 */
type LatestFor = (installed: string | null) => {
  version: string | null;
  releaseUrl: string;
};

/** Channels DVR: the newest release on the track this server follows, given what it runs. */
function channelsLatestFor(server: CheckedServer, versions: ChannelsLatestVersions): LatestFor {
  return (installed) => {
    const track = channelsTrackFor(server.updateTrack ?? 'auto', installed, versions);
    return {
      version: versions[track],
      releaseUrl:
        track === 'prerelease' ? CHANNELS_PRERELEASE_NOTES : SERVER_RELEASE_PAGES.channels_dvr,
    };
  };
}

async function tofaUpdateVersion(server: CheckedServer): Promise<string | null> {
  try {
    const client = new TofaClient({ url: server.url, token: server.token, id: server.id });
    const found = await client.getUpdateVersion();
    return found ? normalizeServerVersion(server.type, found) : null;
  } catch (error) {
    logger.warn(`${server.name}: could not read its update state`, { error });
    return null;
  }
}

/** One release for every server of the type, whatever each runs. */
function sameForAll(type: ServerType, version: string | null): LatestFor {
  return () => ({ version, releaseUrl: SERVER_RELEASE_PAGES[type] });
}

/**
 * Reads and stores both versions, nudging when a newer release is waiting. Resolves true
 * when the stored versions changed, so the caller can tell open dashboards to refetch.
 * `knownInstalled` is a version the caller has just read, to save asking again.
 */
async function checkServer(
  server: CheckedServer,
  latestFor: LatestFor,
  knownInstalled?: string
): Promise<boolean> {
  const installed = knownInstalled ?? (await installedVersionOf(server));
  const { version: latest, releaseUrl } = latestFor(installed);

  const patch: { version?: string; latestVersion?: string } = {};
  if (installed) patch.version = installed;
  if (latest) patch.latestVersion = latest;
  let changed = false;
  if (installed ?? latest) {
    // One server's write failing leaves the rest of the sweep to run.
    try {
      await db
        .update(servers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(servers.id, server.id));
      changed =
        (patch.version !== undefined && patch.version !== server.version) ||
        (patch.latestVersion !== undefined && patch.latestVersion !== server.latestVersion);
    } catch (error) {
      logger.warn(`${server.name}: could not store its version`, { error });
    }
  }

  if (!installed || !latest) return changed;
  if (!isNewerServerVersion(server.type, latest, installed)) {
    if (nudgedVersions.delete(server.id)) {
      logger.info(`${server.name}: now on ${installed}, the latest release`);
    }
    return changed;
  }
  if (nudgedVersions.get(server.id) === latest) return changed;

  nudgedVersions.set(server.id, latest);
  await dispatchServerUpdate({
    server: { id: server.id, name: server.name, type: server.type },
    installedVersion: installed,
    latestVersion: latest,
    releaseUrl,
  });
  logger.info(`${server.name}: ${installed} -> ${latest} available`);
  return changed;
}

/** Tells every open dashboard to refetch the server list; a failure only delays the refresh. */
async function announceVersionChange(): Promise<void> {
  try {
    await publishServersChanged();
  } catch (error) {
    logger.warn('Could not announce the new versions', { error });
  }
}

/** The vendor feeds one run reads, each at most once however many servers share it. */
interface FeedCache {
  feeds: Map<FeedServerType, Promise<string | null>>;
  channels: Promise<ChannelsLatestVersions> | null;
  dispatcharrDev: Promise<string | null> | null;
}

function newFeedCache(): FeedCache {
  return { feeds: new Map(), channels: null, dispatcharrDev: null };
}

/**
 * The newest release for one server, from the run's feeds. A Dispatcharr server is asked what it
 * runs first (fork): a dev image follows Docker Hub's dev tag, as Dispatcharr's own check does,
 * and a release image the GitHub releases. `known` is a version the caller has just read.
 */
async function latestForServer(
  server: CheckedServer,
  cache: FeedCache,
  known?: string
): Promise<{ latestFor: LatestFor; installed?: string }> {
  switch (server.type) {
    case 'channels_dvr':
      cache.channels ??= latestChannelsVersions();
      return { latestFor: channelsLatestFor(server, await cache.channels), installed: known };
    case 'tofa':
      return {
        latestFor: sameForAll(server.type, await tofaUpdateVersion(server)),
        installed: known,
      };
    // Silo reports a build hash and publishes no feed Tracearr reads, so it has no latest version.
    case 'silo':
      return { latestFor: sameForAll(server.type, null), installed: known };
    case 'dispatcharr': {
      const installed = known ?? (await installedVersionOf(server)) ?? undefined;
      if (installed && isDispatcharrDevVersion(installed)) {
        cache.dispatcharrDev ??= latestDispatcharrDevBuild();
        const pushed = await cache.dispatcharrDev;
        return {
          latestFor: () => ({
            version: dispatcharrDevLatest(installed, pushed),
            releaseUrl: DISPATCHARR_DEV_TAGS,
          }),
          installed,
        };
      }
      return {
        latestFor: sameForAll(
          server.type,
          await cache.feeds.getOrInsertComputed(server.type, latestVersionFor)
        ),
        installed,
      };
    }
    case 'plex':
    case 'jellyfin':
    case 'emby':
      return {
        latestFor: sameForAll(
          server.type,
          await cache.feeds.getOrInsertComputed(server.type, latestVersionFor)
        ),
        installed: known,
      };
    default:
      return assertNever(server.type);
  }
}

/**
 * Server types watched every minute while an update waits, so installing it shows within a
 * minute: Channels DVR, and Dispatcharr (fork).
 */
const WATCHED_TYPES: ReadonlySet<ServerType> = new Set<ServerType>(['channels_dvr', 'dispatcharr']);

export async function runServerUpdateCheck(): Promise<void> {
  try {
    const settings = await getSettings(['serverUpdateCheckEnabled']);
    if (!settings.serverUpdateCheckEnabled) return;

    const rows = await liveServers();

    const cache = newFeedCache();
    let changed = false;
    for (const server of rows) {
      const { latestFor, installed } = await latestForServer(server, cache);
      if (await checkServer(server, latestFor, installed)) changed = true;
    }
    if (changed) await announceVersionChange();
  } catch (error) {
    logger.error('Check failed', { error });
  }
}

/** The row says a newer release is waiting for this Channels DVR or Dispatcharr server. */
function hasUpdateWaiting(server: CheckedServer): boolean {
  return (
    WATCHED_TYPES.has(server.type) &&
    !!server.version &&
    !!server.latestVersion &&
    isNewerServerVersion(server.type, server.latestVersion, server.version)
  );
}

/**
 * Between the six-hourly checks, asks each Channels DVR or Dispatcharr server with an update waiting
 * what it runs now. Once that changes (the update was installed), the server gets a full check,
 * so the dashboard's "Update available" turns to "Up to date" within a minute instead of hours.
 * A server that's restarting mid-update just answers nothing and is asked again next minute.
 */
export async function runChannelsUpdateWatch(): Promise<void> {
  if (watchRunning) return;
  watchRunning = true;
  try {
    const settings = await getSettings(['serverUpdateCheckEnabled']);
    if (!settings.serverUpdateCheckEnabled) return;

    const waiting = (await liveServers()).filter(hasUpdateWaiting);
    if (waiting.length === 0) return;

    const cache = newFeedCache();
    let changed = false;
    for (const server of waiting) {
      const installed = await installedVersionOf(server);
      if (!installed || installed === server.version) continue;
      // The latest can follow the installed version (a Channels track, a Dispatcharr dev image),
      // so it's worked out again for it.
      const { latestFor } = await latestForServer(server, cache, installed);
      if (await checkServer(server, latestFor, installed)) changed = true;
    }
    if (changed) await announceVersionChange();
  } catch (error) {
    logger.error('Update watch failed', { error });
  } finally {
    watchRunning = false;
  }
}

export function startServerUpdateChecker(): void {
  if (timers) return;
  timers = startPeriodic(INITIAL_DELAY_MS, CHECK_INTERVAL_MS, () => runServerUpdateCheck());
  channelsWatchTimers = startPeriodic(
    CHANNELS_WATCH_INITIAL_DELAY_MS,
    CHANNELS_WATCH_INTERVAL_MS,
    runChannelsUpdateWatch
  );
  logger.info(
    'Checker started (every 6h, and every minute for a Channels DVR or Dispatcharr server while an update waits)'
  );
}

export function stopServerUpdateChecker(): void {
  timers?.stop();
  timers = null;
  channelsWatchTimers?.stop();
  channelsWatchTimers = null;
}
