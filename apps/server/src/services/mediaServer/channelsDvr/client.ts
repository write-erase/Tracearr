import { fetchJson, fetchText } from '../../../utils/http.js';
import { calculateProgress } from '../shared/parserUtils.js';
import { applyPauseState } from './playbackState.js';
import { readDeviceStatuses } from './deviceStatus.js';
import { channelsDvrArtworkPath, isChannelsDvrItemId } from './artwork.js';
import { parseChannelsDvrStreamDetails } from './streamDetails.js';
import type {
  IMediaServerClient,
  MediaLibrary,
  MediaLibraryItem,
  MediaServerConfig,
  MediaSession,
  MediaUser,
} from '../types.js';
import {
  channelsDvrUserId,
  parseDvrActivity,
  parseRecordingActivity,
  parseWatchActivity,
  toMediaSession,
} from './parser.js';
import { channelLogoPath } from './logos.js';
import {
  CHANNELS_DVR_LIBRARIES,
  isChannelsDvrLibraryId,
  mapEpisode,
  mapMovie,
  mapShow,
} from './library.js';
import { describeChannelsClient } from './macClient.js';
import {
  countTunersInUse,
  parseDisk,
  parseDvrJobStatuses,
  parseJobs,
  parseTunerTotal,
  upcomingJobs,
  type ChannelsDvrJob,
  type ChannelsDvrJobStatus,
} from './jobs.js';
import type { ChannelsDvrActivityEntry } from './parser.js';

/** The job list changes rarely; the dashboard asks every 10 s. Shared across client instances. */
const JOBS_CACHE_TTL_MS = 15 * 1000;
/** Tuner counts only change when a source is reconfigured. */
const TUNERS_CACHE_TTL_MS = 5 * 60 * 1000;
const jobsCache = new Map<string, { data: ChannelsDvrJob[]; expiresAt: number }>();
const tunersCache = new Map<string, { total: number | null; expiresAt: number }>();
/** Tests share a fake clock and a base URL; let them start each case with empty caches. */
export function clearChannelsDvrScheduleCaches(): void {
  jobsCache.clear();
  tunersCache.clear();
}
/** How far ahead the dashboard's Coming Up list looks, and how many it shows. */
const UPCOMING_WINDOW_SEC = 24 * 60 * 60;
const UPCOMING_LIMIT = 10;

/**
 * Channels DVR client (sessions and library).
 *
 * Reads the undocumented `GET /dvr` status document and turns its "Watching"
 * activity lines into sessions. The Channels DVR server API has no
 * authentication on the local network, so `config.token` is unused.
 * See parser.ts for the caveats on the data format.
 */
interface ChannelsDvrClientInfo {
  id?: string;
  machine_id?: string;
  hostname?: string;
  alias?: string;
  device?: string;
  platform?: string;
  app_bundle?: string;
  app_build?: string;
  local_ip?: string;
  remote_ip?: string;
  connected?: boolean;
  seen_from?: string;
}

function normalizeClientIp(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '')
    .replace(/^\[|\]$/g, '');
}

/** A recording in progress, as the dashboard shows it. */
export interface ChannelsDvrRecording {
  key: string;
  /** Channels DVR job id; null when the activity key carries none (cannot be stopped) */
  jobId: string | null;
  channelNumber: string;
  channelTitle: string | null;
  title: string;
  /** ISO times; null when neither the guide nor the job key has them */
  startedAt: string | null;
  endsAt: string | null;
  /** "4:30AM" as Channels wrote it, shown when endsAt is unknown */
  untilText: string | null;
  /** Programme artwork or channel logo, relative to the Channels DVR server */
  thumbPath: string | null;
}

/** A recording queued to start within the next day. */
export interface ChannelsDvrUpcomingRecording {
  jobId: string;
  title: string;
  showId: string | null;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  channelNumber: string | null;
  channelTitle: string | null;
  /** ISO times */
  startsAt: string;
  endsAt: string;
  thumbPath: string | null;
  /** Skipped in Channels: it won't record unless unskipped */
  skipped: boolean;
  /** Scheduled by a series pass, so it can be skipped; otherwise it can only be cancelled */
  fromPass: boolean;
}

/** What the alert monitor reads each minute. */
export interface ChannelsDvrAlertSnapshot {
  jobs: ChannelsDvrJobStatus[];
  /** Job ids recording right now, from the activity feed */
  recordingJobIds: string[];
  /** File ids of recordings in progress that Channels marks corrupted (a stream gap) */
  corruptedFileIds: string[];
  disk: { freeBytes: number; totalBytes: number } | null;
}

/** Everything the dashboard's DVR panel shows, read in one pass. */
export interface ChannelsDvrSchedule {
  recordings: ChannelsDvrRecording[];
  upcoming: ChannelsDvrUpcomingRecording[];
  /** Null when no tuner source reports a tuner count */
  tuners: { inUse: number; total: number } | null;
  /** Recording disk space; null when Channels doesn't report it */
  disk: { freeBytes: number; totalBytes: number } | null;
}

export class ChannelsDvrClient implements IMediaServerClient {
  private static readonly ARTWORK_CACHE_TTL_MS = 10 * 60 * 1000;
  private static readonly GUIDE_CACHE_TTL_MS = 60 * 1000;

  public readonly serverType = 'channels_dvr' as const;
  private readonly baseUrl: string;
  private readonly artworkCache = new Map<string, { path: string | null; expiresAt: number }>();
  private readonly fileDetailsCache = new Map<
    string,
    { data: Record<string, unknown> | null; expiresAt: number }
  >();
  private guideCache: { data: unknown; expiresAt: number } | null = null;
  private clientInfoCache: { data: ChannelsDvrClientInfo[]; expiresAt: number } | null = null;
  private streamLogCache: { data: string; expiresAt: number } | null = null;
  private guideRefresh: Promise<unknown> | null = null;
  private static readonly GUIDE_WAIT_TIMEOUT_MS = 1500;
  /** A library sync pages through each list; fetch it once per sync, not once per page. */
  private static readonly LIBRARY_LIST_TTL_MS = 60 * 1000;
  private readonly libraryListCache = new Map<
    string,
    { data: Record<string, unknown>[]; expiresAt: number }
  >();
  /** Channels client app remote-control API (runs on each playback device) */
  private static readonly CLIENT_API_PORT = 57000;
  private static readonly CLIENT_PROBE_TIMEOUT_MS = 2000;
  private static readonly CLIENT_STOP_TIMEOUT_MS = 5000;

  constructor(config: MediaServerConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '');
  }

  private async getDvrStatus(): Promise<unknown> {
    return fetchJson<unknown>(`${this.baseUrl}/dvr`, {
      headers: { Accept: 'application/json' },
      service: 'channels-dvr',
      timeout: 10000,
    });
  }

  /** Fetch registered clients, keeping this cache short because new sessions register asynchronously. */
  private async getClientInfo(forceRefresh = false): Promise<ChannelsDvrClientInfo[]> {
    if (!forceRefresh && this.clientInfoCache && this.clientInfoCache.expiresAt > Date.now()) {
      return this.clientInfoCache.data;
    }

    try {
      const data = await fetchJson<unknown>(`${this.baseUrl}/dvr/clients/info`, {
        headers: { Accept: 'application/json' },
        service: 'channels-dvr',
        timeout: 10000,
      });
      const clients = Array.isArray(data)
        ? data.filter(
            (item): item is ChannelsDvrClientInfo =>
              Boolean(item) && typeof item === 'object' && !Array.isArray(item)
          )
        : [];
      // A 60-second cache can preserve an incomplete client list long after a
      // newly connected phone has registered. Refresh frequently during playback.
      this.clientInfoCache = { data: clients, expiresAt: Date.now() + 2000 };
      return clients;
    } catch {
      // Device metadata is optional; never let this endpoint hide playback sessions.
      this.clientInfoCache = { data: [], expiresAt: Date.now() + 1000 };
      return [];
    }
  }

  /** Fetch recent playback diagnostics from Channels DVR's own log. */
  private async getStreamLog(): Promise<string> {
    if (this.streamLogCache && this.streamLogCache.expiresAt > Date.now()) {
      return this.streamLogCache.data;
    }

    try {
      const data = await fetchText(`${this.baseUrl}/log?n=10000`, {
        headers: { Accept: 'text/plain' },
        service: 'channels-dvr',
        timeout: 10000,
      });
      this.streamLogCache = { data, expiresAt: Date.now() + 5000 };
      return data;
    } catch {
      // Stream diagnostics are optional and must never hide active sessions.
      this.streamLogCache = { data: '', expiresAt: Date.now() + 5000 };
      return '';
    }
  }

  /**
   * Return cached guide data or share a single in-flight refresh.
   * Callers apply a short wait limit so guide artwork cannot stall sessions.
   */
  private getGuideData(): Promise<unknown> {
    if (this.guideCache && this.guideCache.expiresAt > Date.now()) {
      return Promise.resolve(this.guideCache.data);
    }

    if (!this.guideRefresh) {
      this.guideRefresh = fetchJson<unknown>(`${this.baseUrl}/devices/ANY/guide`, {
        headers: { Accept: 'application/json' },
        service: 'channels-dvr',
        timeout: 10000,
      })
        .then(
          (data) => {
            this.guideCache = {
              data,
              expiresAt: Date.now() + ChannelsDvrClient.GUIDE_CACHE_TTL_MS,
            };
            return data;
          },
          () => {
            // Guide artwork is optional. A guide failure must not hide live sessions.
            this.guideCache = {
              data: null,
              expiresAt: Date.now() + ChannelsDvrClient.GUIDE_CACHE_TTL_MS,
            };
            return null;
          }
        )
        .finally(() => {
          this.guideRefresh = null;
        });
    }

    // Serve stale data while a refresh is in flight, if available.
    return this.guideCache?.data != null
      ? Promise.resolve(this.guideCache.data)
      : this.guideRefresh;
  }

  /** Wait briefly for guide art, but never let it hold up live-session polling. */
  private async getGuideDataForSession(): Promise<unknown> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.getGuideData(),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), ChannelsDvrClient.GUIDE_WAIT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** Find the current programme title and image for a channel. */
  private getLiveAiring(
    guide: unknown,
    channelNumber: string
  ): {
    channelTitle: string | null;
    artworkPath: string | null;
    programTitle: string | null;
    /** Current airing start, epoch seconds */
    startSec?: number;
    /** Current airing length, seconds */
    durationSec?: number;
    /** Current airing series/programme title (not the episode title) */
    airingTitle?: string;
  } | null {
    if (!Array.isArray(guide)) return null;

    const now = Date.now() / 1000;
    for (const entry of guide) {
      if (!entry || typeof entry !== 'object') continue;
      const channel = (entry as { Channel?: unknown }).Channel;
      const airings = (entry as { Airings?: unknown }).Airings;
      if (!channel || typeof channel !== 'object' || !Array.isArray(airings)) continue;

      const channelInfo = channel as { Number?: unknown; Name?: unknown };
      if (String(channelInfo.Number ?? '') !== channelNumber) continue;
      const channelTitle =
        typeof channelInfo.Name === 'string' && channelInfo.Name.trim()
          ? channelInfo.Name.trim()
          : null;

      for (const airing of airings) {
        if (!airing || typeof airing !== 'object') continue;
        const item = airing as {
          Time?: unknown;
          Duration?: unknown;
          Image?: unknown;
          Title?: unknown;
          EpisodeTitle?: unknown;
        };
        if (
          typeof item.Time !== 'number' ||
          typeof item.Duration !== 'number' ||
          item.Time > now ||
          item.Time + item.Duration <= now
        ) {
          continue;
        }

        const programTitle =
          typeof item.EpisodeTitle === 'string' && item.EpisodeTitle.trim()
            ? item.EpisodeTitle.trim()
            : typeof item.Title === 'string' && item.Title.trim()
              ? item.Title.trim()
              : null;
        return {
          channelTitle,
          artworkPath: channelsDvrArtworkPath(this.baseUrl, item.Image),
          programTitle,
          startSec: item.Time,
          durationSec: item.Duration,
          ...(typeof item.Title === 'string' && item.Title.trim()
            ? { airingTitle: item.Title.trim() }
            : {}),
        };
      }
      return { channelTitle, artworkPath: null, programTitle: null };
    }

    return null;
  }

  private async getLibraryItem(path: string): Promise<Record<string, unknown> | null> {
    try {
      const data = await fetchJson<unknown>(`${this.baseUrl}${path}`, {
        headers: { Accept: 'application/json' },
        service: 'channels-dvr',
        timeout: 10000,
      });
      return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /** Fetch DVR file metadata, which includes programme and episode details. */
  private async getRecordingFileDetails(fileId: string): Promise<Record<string, unknown> | null> {
    const cached = this.fileDetailsCache.get(fileId);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const data = await this.getLibraryItem(`/dvr/files/${fileId}`);
    this.fileDetailsCache.set(fileId, {
      data,
      expiresAt: Date.now() + ChannelsDvrClient.ARTWORK_CACHE_TTL_MS,
    });
    return data;
  }

  /**
   * Resolve a recording's primary artwork using the documented Channels
   * library API. The activity feed only identifies the file, so metadata is
   * looked up by that ID and cached to avoid polling the API on every cycle.
   */
  private async getRecordingArtwork(
    parsed: NonNullable<ReturnType<typeof parseWatchActivity>>
  ): Promise<string | null> {
    if (parsed.kind !== 'recording' || !isChannelsDvrItemId(parsed.sourceId)) return null;

    const fileId = parsed.sourceId;
    const cacheKey = `${parsed.show ? 'episode' : 'movie'}:${fileId}`;
    const cached = this.artworkCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.path;

    let artworkPath: string | null = null;

    if (parsed.show) {
      const episode = await this.getLibraryItem(`/api/v1/episodes/${fileId}`);
      const showId = typeof episode?.show_id === 'string' ? episode.show_id : undefined;

      // Prefer the parent show's poster over an episode still/frame. The
      // episode image is retained as a fallback when show art is unavailable.
      if (isChannelsDvrItemId(showId)) {
        const show = await this.getLibraryItem(`/api/v1/shows/${showId}`);
        artworkPath = channelsDvrArtworkPath(this.baseUrl, show?.image_url);
      }
      artworkPath ??= channelsDvrArtworkPath(this.baseUrl, episode?.image_url);
    } else {
      // Movies includes feature films, including locally imported movies.
      // Videos is the fallback for imported items that Channels classifies
      // separately from its movie library.
      const movie = await this.getLibraryItem(`/api/v1/movies/${fileId}`);
      artworkPath = channelsDvrArtworkPath(this.baseUrl, movie?.image_url);
      if (!artworkPath) {
        const video = await this.getLibraryItem(`/api/v1/videos/${fileId}`);
        artworkPath = channelsDvrArtworkPath(this.baseUrl, video?.image_url);
      }
    }

    // Cache misses too, so a missing artwork record does not cause repeated
    // metadata requests during every session poll. The session parser keeps
    // its /dvr/files/<id>/preview.jpg fallback in that case.
    this.artworkCache.set(cacheKey, {
      path: artworkPath,
      expiresAt: Date.now() + ChannelsDvrClient.ARTWORK_CACHE_TTL_MS,
    });
    if (this.artworkCache.size > 500) {
      for (const [key, value] of this.artworkCache) {
        if (value.expiresAt <= Date.now()) this.artworkCache.delete(key);
      }
    }

    return artworkPath;
  }

  async getSessions(sessionKey?: string): Promise<MediaSession[]> {
    const sessions = await this.readSessions(sessionKey);
    // Local devices report play/pause and position directly; the rest fall back to
    // the server-side inference in applyPauseState.
    const deviceStatuses = await readDeviceStatuses(sessions);
    return applyPauseState(this.baseUrl, sessions, { complete: !sessionKey, deviceStatuses });
  }

  private async readSessions(sessionKey?: string): Promise<MediaSession[]> {
    const data = await this.getDvrStatus();
    const parsedSessions = [];
    for (const entry of parseDvrActivity(data)) {
      if (sessionKey && entry.key !== sessionKey) continue;
      const parsed = parseWatchActivity(entry);
      if (parsed) parsedSessions.push(parsed);
    }

    let clients = parsedSessions.length > 0 ? await this.getClientInfo() : [];

    // Channels DVR can publish the HLS activity before its registered client
    // record is ready. If a named device cannot be matched, bypass the cache
    // and fetch the client list again instead of retaining incomplete metadata.
    const hasUnmatchedNamedClient = parsedSessions.some((parsed) => {
      const name = (parsed.clientName ?? '').trim().toLowerCase();
      return Boolean(
        name &&
        !clients.some((client) =>
          [client.hostname, client.alias].some(
            (candidate) => typeof candidate === 'string' && candidate.trim().toLowerCase() === name
          )
        )
      );
    });
    if (hasUnmatchedNamedClient) {
      clients = await this.getClientInfo(true);
    }

    // One guide request serves every live session in this poll. The short
    // cache avoids re-downloading the full guide on every frequent poll.
    const hasLiveChannel = parsedSessions.some(
      (parsed) => parsed.kind === 'live' && Boolean(parsed.sourceId)
    );
    const guide = hasLiveChannel ? await this.getGuideDataForSession() : null;
    const streamDetails = hasLiveChannel
      ? parseChannelsDvrStreamDetails(await this.getStreamLog())
      : new Map();

    return Promise.all(
      parsedSessions.map(async (parsed) => {
        const session = toMediaSession(parsed);
        const sessionIp = normalizeClientIp(parsed.ipAddress);
        // The web player is not a registered client; an app that once had its address is not it.
        const matchingClientByIp =
          sessionIp && !parsed.webPlayer
            ? clients
                .filter(
                  (client) =>
                    normalizeClientIp(client.local_ip) === sessionIp ||
                    normalizeClientIp(client.remote_ip) === sessionIp
                )
                .sort((a, b) => {
                  const connected = Number(Boolean(b.connected)) - Number(Boolean(a.connected));
                  if (connected !== 0) return connected;
                  return (
                    Number(normalizeClientIp(b.local_ip) === sessionIp) -
                    Number(normalizeClientIp(a.local_ip) === sessionIp)
                  );
                })[0]
            : undefined;
        const normalizedClientName = (parsed.clientName ?? '').trim().toLowerCase();
        const matchingClient =
          matchingClientByIp ??
          (normalizedClientName && !parsed.webPlayer
            ? clients
                .filter((client) =>
                  [client.hostname, client.alias].some(
                    (name) =>
                      typeof name === 'string' && name.trim().toLowerCase() === normalizedClientName
                  )
                )
                .sort((a, b) => Number(Boolean(b.connected)) - Number(Boolean(a.connected)))[0]
            : undefined);
        const clientProduct = matchingClient
          ? `${matchingClient.app_bundle?.endsWith('.beta') ? 'Channels Beta' : 'Channels'}${matchingClient.app_build ? ` v${matchingClient.app_build}` : ''}`
          : undefined;
        const displayIp = matchingClient
          ? matchingClient.seen_from === 'remote'
            ? matchingClient.remote_ip
            : matchingClient.seen_from === 'local'
              ? matchingClient.local_ip
              : parsed.ipAddress
          : parsed.ipAddress;
        const streamIp = normalizeClientIp(displayIp);
        const clientIdentity: ReturnType<typeof describeChannelsClient> = matchingClient
          ? describeChannelsClient(matchingClient)
          : {};
        const sessionWithClient = matchingClient
          ? {
              ...session,
              network: {
                ...session.network,
                ...(displayIp ? { ipAddress: displayIp } : {}),
                ...(matchingClient.seen_from === 'remote' ? { isLocal: false } : {}),
                ...(matchingClient.seen_from === 'local' ? { isLocal: true } : {}),
              },
              player: {
                ...session.player,
                name: clientIdentity.name || session.player.name,
                deviceId: matchingClient.machine_id || matchingClient.id || session.player.deviceId,
                ...(clientIdentity.device ? { device: clientIdentity.device } : {}),
                ...(clientIdentity.platform ? { platform: clientIdentity.platform } : {}),
                ...(clientProduct ? { product: clientProduct } : {}),
              },
            }
          : session;
        const streamInfo =
          parsed.kind === 'live' && parsed.sourceId && streamIp
            ? streamDetails.get(`${parsed.sourceId}|${streamIp}`)
            : undefined;
        const sessionWithStream = streamInfo
          ? {
              ...sessionWithClient,
              quality: {
                ...sessionWithClient.quality,
                ...(streamInfo.sourceBitrateKbps !== undefined
                  ? { bitrate: streamInfo.sourceBitrateKbps }
                  : {}),
                isTranscode: streamInfo.encoder
                  ? streamInfo.encoder !== 'remux'
                  : sessionWithClient.quality.isTranscode,
                videoDecision: streamInfo.encoder
                  ? streamInfo.encoder === 'remux'
                    ? 'copy'
                    : 'transcode'
                  : sessionWithClient.quality.videoDecision,
                // The log reports the configured output codec, but not the
                // original audio codec, so an audio decision cannot be inferred.
                audioDecision: 'unknown',
                ...(streamInfo.videoCodec ? { sourceVideoCodec: streamInfo.videoCodec } : {}),
                ...(streamInfo.width !== undefined ? { videoWidth: streamInfo.width } : {}),
                ...(streamInfo.height !== undefined ? { videoHeight: streamInfo.height } : {}),
                ...(streamInfo.sourceBitrateKbps !== undefined
                  ? { sourceVideoDetails: { bitrate: streamInfo.sourceBitrateKbps } }
                  : {}),
                ...(streamInfo.encoder === 'remux' && streamInfo.videoCodec
                  ? {
                      streamVideoCodec: streamInfo.videoCodec,
                      streamVideoDetails: {
                        ...(streamInfo.width !== undefined ? { width: streamInfo.width } : {}),
                        ...(streamInfo.height !== undefined ? { height: streamInfo.height } : {}),
                        ...(streamInfo.outputBitrateKbps !== undefined
                          ? { bitrate: streamInfo.outputBitrateKbps }
                          : {}),
                      },
                    }
                  : {}),
                ...(streamInfo.audioCodec ? { streamAudioCodec: streamInfo.audioCodec } : {}),
              },
            }
          : sessionWithClient;
        const fileDetails =
          parsed.kind === 'recording' && isChannelsDvrItemId(parsed.sourceId)
            ? await this.getRecordingFileDetails(parsed.sourceId)
            : null;
        const airing =
          fileDetails?.Airing && typeof fileDetails.Airing === 'object'
            ? (fileDetails.Airing as Record<string, unknown>)
            : null;
        const fileShowTitle =
          (typeof airing?.Title === 'string' ? airing.Title.trim() : '') ||
          parsed.show?.title ||
          '';
        const episodeTitle =
          (typeof airing?.EpisodeTitle === 'string' ? airing.EpisodeTitle.trim() : '') ||
          parsed.show?.episodeTitle ||
          '';
        const seasonNumber =
          typeof airing?.SeasonNumber === 'number' ? airing.SeasonNumber : parsed.show?.season;
        const episodeNumber =
          typeof airing?.EpisodeNumber === 'number' ? airing.EpisodeNumber : parsed.show?.episode;
        const fileDuration =
          typeof fileDetails?.Duration === 'number' ? fileDetails.Duration : null;
        const fileArtwork = channelsDvrArtworkPath(this.baseUrl, airing?.Image);
        const liveAiring =
          parsed.kind === 'live' && parsed.sourceId
            ? this.getLiveAiring(guide, parsed.sourceId)
            : null;
        const artworkPath =
          liveAiring?.artworkPath ??
          fileArtwork ??
          (parsed.kind === 'recording' ? await this.getRecordingArtwork(parsed) : null);
        // Daily shows (news, talk) often have no episode title; the show, season and
        // episode are enough, and the show name stands in for the title.
        const hasFileEpisode =
          Boolean(fileShowTitle) && seasonNumber !== undefined && episodeNumber !== undefined;
        if (
          !liveAiring?.channelTitle &&
          !liveAiring?.programTitle &&
          !artworkPath &&
          !hasFileEpisode &&
          fileDuration === null &&
          liveAiring?.startSec === undefined
        ) {
          return sessionWithStream;
        }
        return {
          ...sessionWithStream,
          ...(liveAiring?.channelTitle && sessionWithStream.live
            ? { live: { ...sessionWithStream.live, channelTitle: liveAiring.channelTitle } }
            : {}),
          ...(hasFileEpisode && seasonNumber !== undefined && episodeNumber !== undefined
            ? { episode: { showTitle: fileShowTitle, seasonNumber, episodeNumber } }
            : {}),
          // Live TV: progress through the current programme, from the guide.
          ...(liveAiring?.startSec !== undefined &&
          liveAiring.durationSec !== undefined &&
          liveAiring.durationSec > 0
            ? (() => {
                const durationMs = Math.round(liveAiring.durationSec! * 1000);
                const positionMs = Math.min(
                  durationMs,
                  Math.max(0, Date.now() - liveAiring.startSec! * 1000)
                );
                return {
                  playback: {
                    ...sessionWithStream.playback,
                    positionMs,
                    progressPercent: calculateProgress(positionMs, durationMs),
                  },
                };
              })()
            : {}),
          ...(fileDuration !== null && fileDuration > 0
            ? {
                playback: {
                  ...sessionWithStream.playback,
                  progressPercent: calculateProgress(
                    sessionWithStream.playback.positionMs,
                    Math.round(fileDuration * 1000)
                  ),
                },
              }
            : {}),
          media: {
            ...session.media,
            ...(liveAiring?.programTitle ? { title: liveAiring.programTitle } : {}),
            ...(hasFileEpisode ? { title: episodeTitle || fileShowTitle } : {}),
            ...(fileDuration !== null ? { durationMs: Math.round(fileDuration * 1000) } : {}),
            ...(fileDuration === null &&
            liveAiring?.durationSec !== undefined &&
            liveAiring.durationSec > 0
              ? { durationMs: Math.round(liveAiring.durationSec * 1000) }
              : {}),
            ...(artworkPath ? { thumbPath: artworkPath } : {}),
          },
        };
      })
    );
  }

  /** Queued recordings, including the one running now (`GET /api/v1/jobs`). */
  private async getJobs(): Promise<ChannelsDvrJob[]> {
    const cached = jobsCache.get(this.baseUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    const data = await fetchJson<unknown>(`${this.baseUrl}/api/v1/jobs`, {
      headers: { Accept: 'application/json' },
      service: 'channels-dvr',
      timeout: 10000,
    });
    const jobs = parseJobs(data);
    jobsCache.set(this.baseUrl, { data: jobs, expiresAt: Date.now() + JOBS_CACHE_TTL_MS });
    return jobs;
  }

  /** Total tuners across the DVR's sources (`GET /devices`). */
  private async getTunerTotal(): Promise<number | null> {
    const cached = tunersCache.get(this.baseUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.total;
    const data = await fetchJson<unknown>(`${this.baseUrl}/devices`, {
      headers: { Accept: 'application/json' },
      service: 'channels-dvr',
      timeout: 10000,
    });
    const total = parseTunerTotal(data);
    tunersCache.set(this.baseUrl, { total, expiresAt: Date.now() + TUNERS_CACHE_TTL_MS });
    return total;
  }

  /**
   * Recordings the DVR is making right now. These are not viewing sessions and never
   * enter the session pipeline; the dashboard shows them in their own panel.
   */
  async getRecordings(): Promise<ChannelsDvrRecording[]> {
    const entries = parseDvrActivity(await this.getDvrStatus());
    const jobs = await this.getJobs().catch(() => [] as ChannelsDvrJob[]);
    return this.buildRecordings(entries, jobs);
  }

  /**
   * The dashboard's DVR panel: recordings in progress, recordings starting in the next
   * day, and how many tuners are busy. The job list and tuner count are optional extras:
   * if Channels doesn't answer for them, recordings still show.
   */
  async getSchedule(): Promise<ChannelsDvrSchedule> {
    const status = await this.getDvrStatus();
    const entries = parseDvrActivity(status);
    const [jobs, tunerTotal] = await Promise.all([
      this.getJobs().catch(() => [] as ChannelsDvrJob[]),
      this.getTunerTotal().catch(() => null),
    ]);
    const recordings = await this.buildRecordings(entries, jobs);

    const next = upcomingJobs(jobs, Date.now() / 1000, UPCOMING_WINDOW_SEC, UPCOMING_LIMIT);
    const [guide, passJobIds] =
      next.length > 0
        ? await Promise.all([
            this.getGuideDataForSession(),
            // Which jobs a series pass scheduled: only GET /dvr/jobs says (RuleID). Without it
            // every job falls back to Cancel, as before.
            this.getPassJobIds().catch(() => new Set<string>()),
          ])
        : [null, new Set<string>()];
    const upcoming = next.map((job): ChannelsDvrUpcomingRecording => {
      const channelNumber = job.channels[0] ?? null;
      return {
        jobId: job.id,
        title: job.title,
        showId: job.showId,
        episodeTitle: job.episodeTitle,
        seasonNumber: job.seasonNumber,
        episodeNumber: job.episodeNumber,
        channelNumber,
        channelTitle:
          guide && channelNumber
            ? (this.getLiveAiring(guide, channelNumber)?.channelTitle ?? null)
            : null,
        startsAt: new Date(job.startSec * 1000).toISOString(),
        endsAt: new Date(job.endSec * 1000).toISOString(),
        thumbPath:
          channelsDvrArtworkPath(this.baseUrl, job.image) ??
          (channelNumber ? channelLogoPath(channelNumber) : null),
        skipped: job.skipped,
        fromPass: passJobIds.has(job.id),
      };
    });

    const tuners =
      tunerTotal === null
        ? null
        : {
            inUse: countTunersInUse(
              entries,
              recordings.map((r) => r.channelNumber)
            ),
            total: tunerTotal,
          };
    return { recordings, upcoming, tuners, disk: parseDisk(status) };
  }

  /**
   * Turn "Recording ch2 for …" activity lines into recordings. Start and end come from the
   * recording's job when the job list has it (exact, padding included); otherwise from the
   * guide's current airing on that channel, if it's the same programme.
   */
  private async buildRecordings(
    entries: ChannelsDvrActivityEntry[],
    jobs: ChannelsDvrJob[]
  ): Promise<ChannelsDvrRecording[]> {
    const parsed = entries.map((entry) => parseRecordingActivity(entry)).filter((r) => r !== null);
    if (parsed.length === 0) return [];

    const guide = await this.getGuideDataForSession();
    return parsed.map((recording) => {
      const job = recording.jobId ? jobs.find((j) => j.id === recording.jobId) : undefined;
      const airing = guide ? this.getLiveAiring(guide, recording.channelNumber) : null;
      // Only trust the guide's times and artwork when its current airing is the programme
      // being recorded (a padded recording can run into the next programme).
      const sameProgramme =
        !!airing?.airingTitle &&
        airing.airingTitle.toLowerCase().replace(/[^a-z0-9]+/g, '') ===
          recording.title.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const guideStart = sameProgramme ? airing?.startSec : undefined;
      const guideDuration = sameProgramme ? airing?.durationSec : undefined;
      const startSec = job?.startSec ?? guideStart;
      const endSec =
        job?.endSec ??
        (guideStart !== undefined && guideDuration !== undefined
          ? guideStart + guideDuration
          : undefined);
      return {
        key: recording.key,
        jobId: recording.jobId ?? null,
        channelNumber: recording.channelNumber,
        channelTitle: airing?.channelTitle ?? null,
        title: recording.title,
        startedAt:
          (startSec !== undefined
            ? new Date(startSec * 1000)
            : (recording.startedAt ?? null)
          )?.toISOString() ?? null,
        endsAt: endSec !== undefined ? new Date(endSec * 1000).toISOString() : null,
        untilText: recording.untilText ?? null,
        thumbPath:
          (sameProgramme ? airing?.artworkPath : null) ??
          channelsDvrArtworkPath(this.baseUrl, job?.image) ??
          channelLogoPath(recording.channelNumber),
      };
    });
  }

  /**
   * The alert monitor's view: every job with its failure state, which are recording now,
   * which of those Channels has marked corrupted (it does this when the stream drops and
   * it reconnects), and disk space. Read fresh each time, bypassing the dashboard caches.
   */
  async getAlertSnapshot(): Promise<ChannelsDvrAlertSnapshot> {
    const [status, jobsData] = await Promise.all([
      this.getDvrStatus(),
      fetchJson<unknown>(`${this.baseUrl}/dvr/jobs`, {
        headers: { Accept: 'application/json' },
        service: 'channels-dvr',
        timeout: 10000,
      }),
    ]);
    const jobs = parseDvrJobStatuses(jobsData);
    const recordingJobIds = parseDvrActivity(status)
      .map((entry) => parseRecordingActivity(entry)?.jobId)
      .filter((id): id is string => !!id);

    const corruptedFileIds: string[] = [];
    await Promise.all(
      jobs
        .filter((job) => job.fileId && recordingJobIds.includes(job.id))
        .map(async (job) => {
          try {
            const file = await fetchJson<unknown>(
              `${this.baseUrl}/dvr/files/${encodeURIComponent(job.fileId!)}`,
              { headers: { Accept: 'application/json' }, service: 'channels-dvr', timeout: 10000 }
            );
            if (
              file &&
              typeof file === 'object' &&
              (file as { Corrupted?: unknown }).Corrupted === true
            ) {
              corruptedFileIds.push(job.fileId!);
            }
          } catch {
            // A file Channels can't describe right now is checked again next minute.
          }
        })
    );
    return { jobs, recordingJobIds, corruptedFileIds, disk: parseDisk(status) };
  }

  /**
   * Stop a recording in progress, as the Channels DVR web UI does (DVR > Schedule > Stop):
   * `DELETE /dvr/jobs/<jobId>`. What was recorded so far stays in the library.
   */
  async stopRecording(jobId: string): Promise<void> {
    if (!/^\d{9,11}-[\w.-]+$/.test(jobId)) throw new Error('Invalid Channels DVR job id');
    const response = await fetch(`${this.baseUrl}/dvr/jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Channels DVR refused to stop the recording: HTTP ${response.status}`);
    }
    jobsCache.delete(this.baseUrl);
  }

  /**
   * Skip one airing a series pass scheduled, or undo that, as the web UI does
   * (DVR > Schedule > Skip / Queued): `PUT /dvr/jobs/<jobId>/skip` or `.../unskip`. The pass
   * keeps going; a skipped job stays on the schedule, marked skipped, until its time passes.
   */
  async setRecordingSkipped(jobId: string, skipped: boolean): Promise<void> {
    if (!/^\d{9,11}-[\w.-]+$/.test(jobId)) throw new Error('Invalid Channels DVR job id');
    const action = skipped ? 'skip' : 'unskip';
    const response = await fetch(
      `${this.baseUrl}/dvr/jobs/${encodeURIComponent(jobId)}/${action}`,
      { method: 'PUT', signal: AbortSignal.timeout(10_000) }
    );
    if (!response.ok) {
      throw new Error(`Channels DVR refused to ${action} the recording: HTTP ${response.status}`);
    }
    jobsCache.delete(this.baseUrl);
  }

  /** Ids of the queued jobs a series pass scheduled (non-empty `RuleID` in `GET /dvr/jobs`). */
  private async getPassJobIds(): Promise<Set<string>> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/dvr/jobs`, {
      headers: { Accept: 'application/json' },
      service: 'channels-dvr',
      timeout: 10000,
    });
    return new Set(
      parseDvrJobStatuses(data)
        .filter((job) => job.ruleId !== null)
        .map((job) => job.id)
    );
  }

  /**
   * Channels DVR has no user list. Devices currently watching are returned so
   * user sync has something to work with; the poller also creates users from
   * sessions as they appear.
   */
  async getUsers(): Promise<MediaUser[]> {
    const data = await this.getDvrStatus();
    const byId = new Map<string, MediaUser>();
    for (const entry of parseDvrActivity(data)) {
      const parsed = parseWatchActivity(entry);
      if (!parsed) continue;
      const id = channelsDvrUserId(parsed);
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          username: parsed.clientName ?? parsed.ipAddress ?? 'Unknown device',
          isAdmin: false,
        });
      }
    }
    return [...byId.values()];
  }

  async getLibraries(): Promise<MediaLibrary[]> {
    return CHANNELS_DVR_LIBRARIES.map((library) => ({ ...library }));
  }

  /** Fetch a whole Channels library list (`/api/v1/shows`, `/episodes`, ...), cached briefly. */
  private async getLibraryList(path: string): Promise<Record<string, unknown>[]> {
    const cached = this.libraryListCache.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const data = await fetchJson<unknown>(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      service: 'channels-dvr',
      timeout: 60000,
    });
    const list = Array.isArray(data)
      ? data.filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === 'object' && !Array.isArray(item)
        )
      : [];
    this.libraryListCache.set(path, {
      data: list,
      expiresAt: Date.now() + ChannelsDvrClient.LIBRARY_LIST_TTL_MS,
    });
    return list;
  }

  /**
   * File sizes keyed by DVR file id, from `GET /dvr/files` (one request for every file).
   * The /api/v1 library lists carry no size. Best effort: on failure sizes stay unknown.
   */
  private async getFileSizes(): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    try {
      for (const file of await this.getLibraryList('/dvr/files')) {
        const id = file.ID ?? file.id;
        const size = file.FileSize ?? file.file_size;
        if (
          (typeof id === 'string' || typeof id === 'number') &&
          typeof size === 'number' &&
          size > 0
        ) {
          sizes.set(String(id), size);
        }
      }
    } catch {
      // Older servers or a failed request: leave sizes unknown rather than failing the sync.
    }
    return sizes;
  }

  private static withSizes(
    items: MediaLibraryItem[],
    sizes: Map<string, number>
  ): MediaLibraryItem[] {
    if (sizes.size === 0) return items;
    return items.map((item) => {
      const fileSize = sizes.get(item.ratingKey);
      return fileSize ? { ...item, fileSize } : item;
    });
  }

  private static page<T>(items: T[], options?: { offset?: number; limit?: number }) {
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit ?? items.length;
    return { items: items.slice(offset, offset + limit), totalCount: items.length };
  }

  async testConnection(): Promise<boolean> {
    try {
      const data = await this.getDvrStatus();
      return !!data && typeof data === 'object' && !Array.isArray(data) && 'activity' in data;
    } catch {
      return false;
    }
  }

  async getSoftwareVersion(): Promise<string | null> {
    try {
      const data = await this.getDvrStatus();
      const version = (data as { version?: unknown } | null)?.version;
      return typeof version === 'string' && version ? version : null;
    } catch {
      return null;
    }
  }

  /**
   * Stop playback on a Channels client app.
   *
   * The Channels DVR server has no "stop session" endpoint, so this goes straight to the
   * Channels app on the playback device (`POST http://<device>:57000/api/stop`). The request
   * comes from the Tracearr server, so the device must be reachable from it. The caller
   * (termination service) only calls this for sessions Tracearr classifies as local.
   *
   * @param deviceIp - The playback device's IP address (session.ipAddress)
   */
  async terminateSession(deviceIp: string): Promise<boolean> {
    const ip = normalizeClientIp(deviceIp);
    if (!ip) {
      throw new Error('No device IP available for this Channels session');
    }
    const host = ip.includes(':') ? `[${ip}]` : ip;
    const base = `http://${host}:${ChannelsDvrClient.CLIENT_API_PORT}`;

    // Reachability probe: fail fast with a clear message instead of a long stop timeout.
    try {
      const probe = await fetch(`${base}/api/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(ChannelsDvrClient.CLIENT_PROBE_TIMEOUT_MS),
      });
      if (!probe.ok) {
        throw new Error(`HTTP ${probe.status}`);
      }
    } catch {
      throw new Error(
        `Channels app at ${ip}:${ChannelsDvrClient.CLIENT_API_PORT} is unreachable from the Tracearr server`
      );
    }

    let response: Response;
    try {
      response = await fetch(`${base}/api/stop`, {
        method: 'POST',
        signal: AbortSignal.timeout(ChannelsDvrClient.CLIENT_STOP_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Stop request to Channels app at ${ip} failed: ${msg}`);
    }
    if (!response.ok) {
      throw new Error(
        `Channels app at ${ip} rejected the stop request: ${response.status} ${response.statusText}`
      );
    }
    return true;
  }

  /**
   * Top-level items of a library: shows for `tv`, movies for `movies`, imported
   * videos for `videos`. Episodes come from getLibraryLeaves.
   */
  async getLibraryItems(
    libraryId: string,
    options?: { offset?: number; limit?: number; libraryType?: string }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    if (!isChannelsDvrLibraryId(libraryId)) return { items: [], totalCount: 0 };

    let items: MediaLibraryItem[];
    if (libraryId === 'tv') {
      const shows = await this.getLibraryList('/api/v1/shows');
      items = shows.map((show) => mapShow(this.baseUrl, show)).filter((i) => i !== null);
    } else {
      const [list, sizes] = await Promise.all([
        this.getLibraryList(`/api/v1/${libraryId}`),
        this.getFileSizes(),
      ]);
      items = ChannelsDvrClient.withSizes(
        list.map((item) => mapMovie(this.baseUrl, item)).filter((i) => i !== null),
        sizes
      );
    }
    return ChannelsDvrClient.page(items, options);
  }

  // No getLibraryItemsSince/getLibraryLeavesSince: Channels DVR cannot filter by date, so
  // an incremental sync would download the whole list anyway and could not notice deleted
  // episodes. Without them every Channels sync is a full scan, which also removes deletions.

  /** Every episode in the TV library. Movies and videos have no leaves. */
  async getLibraryLeaves(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    if (libraryId !== 'tv') return { items: [], totalCount: 0 };

    const [episodes, shows, sizes] = await Promise.all([
      this.getLibraryList('/api/v1/episodes'),
      this.getLibraryList('/api/v1/shows'),
      this.getFileSizes(),
    ]);
    // Episodes without their own image fall back to the show poster.
    const showArtwork = new Map(
      shows.map((show) => [String(show.id), mapShow(this.baseUrl, show)?.thumbPath])
    );
    const items = ChannelsDvrClient.withSizes(
      episodes
        .map((episode) => mapEpisode(this.baseUrl, episode, showArtwork))
        .filter((i) => i !== null),
      sizes
    );
    return ChannelsDvrClient.page(items, options);
  }
}
