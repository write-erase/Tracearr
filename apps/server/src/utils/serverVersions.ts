/**
 * Media-server versions: what a server reports about itself, what its vendor ships,
 * and which of the two is newer. Every feed is public and read without a token; tofa
 * publishes none, so its servers are asked through their own update check instead.
 */

import { assertNever, type ServerType, type JellyfinEmbyServerType } from '@tracearr/shared';
import { fetchJson } from './http.js';
import { createLogger } from './logger.js';
import { compareVersions, maxVersion } from './pluginVersion.js';

const logger = createLogger('server-versions');

const PLEX_DOWNLOADS_URL = 'https://plex.tv/api/downloads/5.json';
/** Server types whose newest release is the latest (non-pre-release) GitHub release. */
type GithubFeedServerType = JellyfinEmbyServerType | 'dispatcharr';

const GITHUB_LATEST: Record<GithubFeedServerType, string> = {
  jellyfin: 'https://api.github.com/repos/jellyfin/jellyfin/releases/latest',
  emby: 'https://api.github.com/repos/MediaBrowser/Emby.Releases/releases/latest',
  // Tags read "v0.34.1"; the server's /api/core/version/ answers "0.34.1" (fork).
  dispatcharr: 'https://api.github.com/repos/Dispatcharr/Dispatcharr/releases/latest',
};

/**
 * Channels DVR's own update feeds, the ones its updater reads: `latest.json` is the stable
 * release, `prerelease.json` the newest pre-release. Both are `{"version":"2026.11.11.2228",...}`.
 * Tracearr never asks a server to check for updates itself: on Channels that installs them.
 */
const CHANNELS_FEEDS = {
  stable: 'https://channels-dvr.s3.amazonaws.com/latest.json',
  prerelease: 'https://channels-dvr.s3.amazonaws.com/prerelease.json',
} as const;

/** Release notes for Channels DVR pre-releases (stable ones use SERVER_RELEASE_PAGES). */
export const CHANNELS_PRERELEASE_NOTES =
  'https://community.getchannels.com/t/dvr-pre-release-notes/28832';

/** Where a nudge sends the reader; the feeds carry per-release links, these outlive them. */
export const SERVER_RELEASE_PAGES: Record<ServerType, string> = {
  plex: 'https://plex.tv/media-server-downloads',
  jellyfin: 'https://github.com/jellyfin/jellyfin/releases/latest',
  emby: 'https://github.com/MediaBrowser/Emby.Releases/releases/latest',
  tofa: 'https://docs.tofa.tv/keep-your-server-updated.html',
  dispatcharr: 'https://github.com/Dispatcharr/Dispatcharr/releases/latest',
  channels_dvr: 'https://getchannels.com/releases/',
};

/**
 * A Dispatcharr dev image (fork). Dev images keep the release's version (0.34.1) and add the
 * time they were built, which `/api/core/version/` reports as `timestamp`; Tracearr stores the
 * pair as `0.34.1-dev.<YYYYMMDDHHMMSS UTC>`. Dispatcharr's own update check, for a dev image,
 * compares that time with when the `dev` tag on Docker Hub was last pushed, and counts a push
 * more than 10 minutes later as an update; Tracearr does the same.
 */
const DISPATCHARR_DEV = /^(\d+\.\d+\.\d+)-dev\.(\d{14})$/;
const DISPATCHARR_DEV_THRESHOLD_MS = 10 * 60 * 1000;
const DISPATCHARR_DEV_TAG =
  'https://hub.docker.com/v2/repositories/dispatcharr/dispatcharr/tags/dev';
/** Where a Dispatcharr dev image's update is announced: its Docker Hub tags. */
export const DISPATCHARR_DEV_TAGS = 'https://hub.docker.com/r/dispatcharr/dispatcharr/tags';

/**
 * A build or push time as `YYYYMMDDHHMMSS` in UTC. Takes Dispatcharr's compact CI stamp, or an
 * ISO time, read as UTC when it carries no zone (as Dispatcharr reads it). Null when unreadable.
 */
export function dispatcharrBuildStamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{14}$/.test(text)) return text;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const ms = Date.parse(zoned.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14);
}

/** The version Tracearr stores for a Dispatcharr image: dev when it reports a build time. */
export function dispatcharrVersion(version: string, timestamp: unknown): string {
  const stamp = dispatcharrBuildStamp(timestamp);
  return stamp ? `${version.replace(/^v/, '')}-dev.${stamp}` : version;
}

export function isDispatcharrDevVersion(version: string | null | undefined): boolean {
  return !!version && DISPATCHARR_DEV.test(version);
}

function stampMs(stamp: string): number {
  const [y, mo, d, h, mi, s] = [0, 4, 6, 8, 10, 12].map((at, i) =>
    Number(stamp.slice(at, at + (i === 0 ? 4 : 2)))
  ) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** When the `dev` tag on Docker Hub was last pushed, as a stamp; null when it can't be read. */
export async function latestDispatcharrDevBuild(): Promise<string | null> {
  try {
    const tag = await fetchJson<{ last_updated?: unknown }>(DISPATCHARR_DEV_TAG, {
      timeout: FEED_TIMEOUT_MS,
      service: 'docker-hub',
    });
    return dispatcharrBuildStamp(tag.last_updated);
  } catch (error) {
    logger.warn('Dispatcharr dev build lookup failed', { error });
    return null;
  }
}

/**
 * The newest dev image for a server running `installed`: the Docker Hub push when it's more than
 * 10 minutes after the running build, otherwise the running build itself (up to date).
 */
export function dispatcharrDevLatest(installed: string, pushed: string | null): string | null {
  const match = DISPATCHARR_DEV.exec(installed);
  if (!match?.[1] || !match[2] || !pushed) return null;
  return stampMs(pushed) - stampMs(match[2]) > DISPATCHARR_DEV_THRESHOLD_MS
    ? `${match[1]}-dev.${pushed}`
    : installed;
}

/** Server types whose vendor publishes a release feed. */
export type FeedServerType = Exclude<ServerType, 'tofa'>;

const FEED_TIMEOUT_MS = 10_000;
// Two to four parts. `compareVersions` only reads three- and four-part versions, so a
// two-part release gets padded rather than dropped: Jellyfin tags 12.0 as `v12.0` while
// the server reports `12.0.0`, and the two have to compare equal.
const DOTTED = /^\d+(\.\d+){1,3}$/;

interface PlexDownloads {
  computer?: Record<string, { version?: unknown } | undefined>;
}

function versionDigits(type: ServerType, version: string): string {
  switch (type) {
    case 'plex':
      return version.split('-')[0] ?? '';
    case 'jellyfin':
    case 'dispatcharr':
      return version.replace(/^v/, '');
    case 'emby':
    case 'tofa':
    case 'channels_dvr':
      return version;
    default:
      return assertNever(type);
  }
}

/**
 * The comparable digits of a version: Plex appends a build hash, Jellyfin and Dispatcharr tag
 * with a leading `v`, Emby and tofa are already numeric. A two-part version gains a `.0` so the
 * comparator can read it. Null when what is left is not two to four dotted numbers.
 */
export function normalizeServerVersion(type: ServerType, raw: string): string | null {
  const candidate = versionDigits(type, raw.trim());
  if (type === 'dispatcharr' && DISPATCHARR_DEV.test(candidate)) return candidate;
  if (!DOTTED.test(candidate)) return null;
  return candidate.split('.').length === 2 ? `${candidate}.0` : candidate;
}

/** An unparseable version on either side is never newer: a nudge needs both numbers. */
export function isNewerServerVersion(type: ServerType, latest: string, installed: string): boolean {
  if (type === 'dispatcharr' && (DISPATCHARR_DEV.test(latest) || DISPATCHARR_DEV.test(installed))) {
    // Only a newer dev push counts against a dev image; a dev and a release never compare.
    const pushed = DISPATCHARR_DEV.exec(latest)?.[2];
    const built = DISPATCHARR_DEV.exec(installed)?.[2];
    return !!pushed && !!built && stampMs(pushed) - stampMs(built) > DISPATCHARR_DEV_THRESHOLD_MS;
  }
  const newer = normalizeServerVersion(type, latest);
  const current = normalizeServerVersion(type, installed);
  if (!newer || !current) return false;
  return compareVersions(newer, current) > 0;
}

/** Plex publishes one version per platform; they move together, so the newest stands in. */
async function latestPlexVersion(): Promise<string | null> {
  const feed = await fetchJson<PlexDownloads>(PLEX_DOWNLOADS_URL, {
    timeout: FEED_TIMEOUT_MS,
    service: 'plex',
  });
  const versions = Object.values(feed.computer ?? {})
    .map((entry) =>
      typeof entry?.version === 'string' ? normalizeServerVersion('plex', entry.version) : null
    )
    .filter((version): version is string => version !== null);
  return maxVersion(versions);
}

async function latestGithubVersion(type: GithubFeedServerType): Promise<string | null> {
  const release = await fetchJson<{ tag_name?: unknown }>(GITHUB_LATEST[type], {
    timeout: FEED_TIMEOUT_MS,
    service: 'github',
  });
  return typeof release.tag_name === 'string'
    ? normalizeServerVersion(type, release.tag_name)
    : null;
}

export interface ChannelsLatestVersions {
  stable: string | null;
  prerelease: string | null;
}

async function channelsFeedVersion(url: string): Promise<string | null> {
  const feed = await fetchJson<{ version?: unknown }>(url, {
    timeout: FEED_TIMEOUT_MS,
    service: 'channels-dvr',
  });
  return typeof feed.version === 'string'
    ? normalizeServerVersion('channels_dvr', feed.version)
    : null;
}

/** Both Channels DVR feeds; either can be null when its read fails. */
export async function latestChannelsVersions(): Promise<ChannelsLatestVersions> {
  const read = (url: string) =>
    channelsFeedVersion(url).catch((error: unknown) => {
      logger.warn('Channels DVR version lookup failed', { url, error });
      return null;
    });
  const [stable, prerelease] = await Promise.all([
    read(CHANNELS_FEEDS.stable),
    read(CHANNELS_FEEDS.prerelease),
  ]);
  return { stable, prerelease };
}

/**
 * Which Channels DVR track a server follows. 'auto' reads pre-release when the installed build
 * is newer than the newest stable one (only a pre-release can be), otherwise stable. A build
 * equal to stable reads as stable: pick 'prerelease' to keep following pre-releases then.
 */
export function channelsTrackFor(
  setting: 'auto' | 'stable' | 'prerelease',
  installed: string | null,
  latest: ChannelsLatestVersions
): 'stable' | 'prerelease' {
  if (setting !== 'auto') return setting;
  if (
    installed &&
    latest.stable &&
    isNewerServerVersion('channels_dvr', installed, latest.stable)
  ) {
    return 'prerelease';
  }
  return 'stable';
}

/** The newest release the vendor publishes, normalized. Any failure reads as "unknown". */
export async function latestVersionFor(type: FeedServerType): Promise<string | null> {
  try {
    switch (type) {
      case 'plex':
        return await latestPlexVersion();
      case 'jellyfin':
      case 'emby':
      case 'dispatcharr':
        return await latestGithubVersion(type);
      // Channels DVR is checked per server by its own track (latestChannelsVersions).
      case 'channels_dvr':
        return null;
      default:
        return assertNever(type);
    }
  } catch (error) {
    // A firewalled or renamed feed is otherwise invisible: the nudge just never comes.
    logger.warn('Latest version lookup failed', { type, error });
    return null;
  }
}
