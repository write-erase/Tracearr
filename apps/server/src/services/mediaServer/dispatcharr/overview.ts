/**
 * The Dispatcharr dashboard card (fork): M3U accounts with their refresh state and provider
 * connections, and guide sources with theirs. Pure parsing of Dispatcharr's own API answers,
 * so the client only fetches.
 *
 * Provider connections: Dispatcharr counts them in Redis (`profile_connections:<profile id>`)
 * and has no endpoint for that counter, so they are counted here from what it does report.
 * Each live channel holds one connection on its M3U profile, each VOD client one, and each
 * catch-up stream one, however many viewers share it.
 */

import type {
  DispatcharrEpgSource,
  DispatcharrProviderUsage,
  DispatcharrSourceStatus,
  DispatcharrStreamEntry,
} from '@tracearr/shared';
import type { MediaUser } from '../types.js';
import {
  isAnonymousDispatcharrUserName,
  type DispatcharrCatchupStatsResponse,
  type DispatcharrChannelStatus,
  type DispatcharrVodStatsResponse,
} from './parser.js';

const KNOWN_STATUSES: ReadonlySet<string> = new Set<DispatcharrSourceStatus>([
  'idle',
  'fetching',
  'parsing',
  'success',
  'error',
  'pending_setup',
  'disabled',
]);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record ? [record] : [];
  });
}

/** A list endpoint's rows: a plain array, or DRF's `{ results: [...] }` when paginated. */
export function listRows(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return asRecords(payload);
  return asRecords(asRecord(payload)?.results);
}

function asPositiveInt(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asStatus(value: unknown): DispatcharrSourceStatus {
  return typeof value === 'string' && KNOWN_STATUSES.has(value)
    ? (value as DispatcharrSourceStatus)
    : 'unknown';
}

/** A string or number id as a map key. */
function asKey(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asText(value);
}

/** An ISO time Date can read, or null. */
function asIsoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/**
 * Open provider connections per M3U profile id, from the three stream snapshots. A missing
 * snapshot (VOD or catch-up off, or unreachable) just adds nothing.
 */
export function countProfileConnections(
  live: DispatcharrChannelStatus[],
  vod?: DispatcharrVodStatsResponse,
  catchup?: DispatcharrCatchupStatsResponse
): Map<number, number> {
  const counts = new Map<number, number>();
  const add = (profileId: number | undefined) => {
    if (profileId !== undefined) counts.set(profileId, (counts.get(profileId) ?? 0) + 1);
  };

  // One upstream stream per live channel, shared by every client watching it.
  for (const channel of live) add(asPositiveInt(channel.m3u_profile_id));

  // VOD: grouped by title; every client has its own upstream connection.
  for (const group of asRecords(vod?.vod_connections)) {
    for (const connection of asRecords(group.connections)) {
      add(
        asPositiveInt(connection.m3u_profile_id) ??
          asPositiveInt(asRecord(connection.m3u_profile)?.m3u_profile_id)
      );
    }
  }

  // Catch-up: one upstream stream per stats channel, whoever is connected to it.
  const catchupStreams = new Map<string, number>();
  for (const session of asRecords(catchup?.timeshift_sessions)) {
    for (const connection of asRecords(session.connections)) {
      const profileId = asPositiveInt(connection.m3u_profile_id);
      const stream =
        asKey(connection.stats_channel_id) ??
        asKey(session.stats_channel_id) ??
        asKey(session.session_id);
      if (profileId !== undefined && stream) catchupStreams.set(stream, profileId);
    }
  }
  for (const profileId of catchupStreams.values()) add(profileId);

  return counts;
}

/**
 * Active M3U accounts from `GET /api/m3u/accounts/` (not the locked built-in "custom" one), with connections in use summed over their
 * profiles (null `connections`: the live streams couldn't be read). The limit is the sum of the active profiles' `max_streams`; a 0 there means
 * unlimited, and then so is the account.
 */
export function parseProviders(
  accountsPayload: unknown,
  connections: Map<number, number> | null
): DispatcharrProviderUsage[] {
  return listRows(accountsPayload).flatMap((account) => {
    const id = asPositiveInt(account.id);
    const name = asText(account.name);
    if (id === undefined || !name || account.is_active === false) return [];
    // Dispatcharr's own "custom" account for streams added by hand: locked, unlimited, and
    // hidden on its M3U page too.
    if (account.locked === true) return [];

    let inUse = 0;
    let limit: number | null = 0;
    let activeProfiles = 0;
    for (const profile of asRecords(account.profiles)) {
      const profileId = asPositiveInt(profile.id);
      if (profileId !== undefined) inUse += connections?.get(profileId) ?? 0;
      if (profile.is_active === false) continue;
      activeProfiles += 1;
      const max = asNonNegativeInt(profile.max_streams);
      if (max === undefined || max === 0) limit = null;
      else if (limit !== null) limit += max;
    }
    // No profile list (or none active): the account's own Max Streams, which Dispatcharr
    // copies onto its default profile.
    if (activeProfiles === 0) {
      const max = asNonNegativeInt(account.max_streams);
      limit = max === undefined || max === 0 ? null : max;
    }

    return [
      {
        id,
        name,
        status: asStatus(account.status),
        lastMessage: asText(account.last_message),
        refreshedAt: asIsoTime(account.updated_at),
        inUse: connections ? inUse : null,
        maxStreams: limit,
      },
    ];
  });
}

/** Active guide sources from `GET /api/epg/sources/`; custom dummy guides never refresh, so they're left out. */
export function parseEpgSources(sourcesPayload: unknown): DispatcharrEpgSource[] {
  return listRows(sourcesPayload).flatMap((source) => {
    const id = asPositiveInt(source.id);
    const name = asText(source.name);
    if (id === undefined || !name || source.is_active === false) return [];
    if (source.source_type === 'dummy') return [];
    return [
      {
        id,
        name,
        status: asStatus(source.status),
        lastMessage: asText(source.last_message),
        refreshedAt: asIsoTime(source.updated_at),
      },
    ];
  });
}

/** M3U account name per profile id, for the Streaming Now rows. Locked accounts read as none. */
export function providerNamesByProfile(accountsPayload: unknown): Map<number, string> {
  const names = new Map<number, string>();
  for (const account of listRows(accountsPayload)) {
    const name = asText(account.name);
    if (!name || account.locked === true) continue;
    for (const profile of asRecords(account.profiles)) {
      const id = asPositiveInt(profile.id);
      if (id !== undefined) names.set(id, name);
    }
  }
  return names;
}

/** An epoch-seconds time as ISO, or null. */
function epochToIso(value: unknown): string | null {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/** The logo Dispatcharr serves for a logo id, as a path the image proxy accepts. */
export function dispatcharrLogoPath(logoId: unknown): string | null {
  const id = asKey(logoId);
  return id && /^\d+$/.test(id) ? `/api/channels/logos/${id}/cache/` : null;
}

export interface StreamContext {
  /** M3U account name per profile id */
  providerNames: Map<number, string>;
  /** Every Dispatcharr user by id, Anonymous included */
  userById: Map<string, MediaUser>;
  /** Channel name and logo per channel uuid, from `POST /api/channels/channels/by-uuids/` */
  channels: Map<string, { name?: string; logoPath?: string }>;
}

/** A Channels DVR server pulling a channel from Dispatcharr says so in its user agent. */
const CHANNELS_DVR_AGENT = /channels[-_ ]?dvr/i;

/**
 * Who a client is: its Dispatcharr user's name, Anonymous for a client with no user, or its IP
 * address for a user Dispatcharr no longer lists. An Anonymous client whose user agent names
 * Channels DVR shows as "Channels DVR". Anonymous viewers always show here, whatever the server's
 * "ignore Anonymous streams" setting: they share the provider connection all the same. That
 * setting only keeps them out of Now Playing and history.
 */
function viewerName(
  client: { userId: unknown; ip: unknown; userAgent: unknown; name?: unknown },
  context: StreamContext
): string {
  const id = asKey(client.userId);
  const user = id ? context.userById.get(id) : undefined;
  const named = user?.username ?? asText(client.name);
  let name: string;
  if (named && named.toLowerCase() !== 'unknown') name = named;
  else if (!id || id === '0') name = 'Anonymous';
  else {
    const address = asText(client.ip);
    name = address && address !== 'Unknown' ? address : 'Anonymous';
  }
  const agent = asText(client.userAgent);
  if (isAnonymousDispatcharrUserName(name) && agent && CHANNELS_DVR_AGENT.test(agent)) {
    return 'Channels DVR';
  }
  return name;
}

function addViewer(viewers: string[], name: string): void {
  if (!viewers.includes(name)) viewers.push(name);
}

/**
 * Streaming Now: one row per provider connection, like the connection pills count them. A live
 * channel lists everyone sharing it; VOD is one row per viewer; catch-up one per stream.
 */
export function buildStreams(
  live: DispatcharrChannelStatus[],
  vod: DispatcharrVodStatsResponse | undefined,
  catchup: DispatcharrCatchupStatsResponse | undefined,
  context: StreamContext
): DispatcharrStreamEntry[] {
  const provider = (profileId: unknown) => {
    const id = asPositiveInt(profileId);
    return id === undefined ? null : (context.providerNames.get(id) ?? null);
  };

  const liveRows = live.flatMap((channel): DispatcharrStreamEntry[] => {
    const uuid = asKey(channel.channel_id);
    if (!uuid) return [];
    const known = context.channels.get(uuid);
    const viewers: string[] = [];
    for (const client of asRecords(channel.clients)) {
      addViewer(
        viewers,
        viewerName(
          { userId: client.user_id, ip: client.ip_address, userAgent: client.user_agent },
          context
        )
      );
    }
    const record = channel as Record<string, unknown>;
    return [
      {
        key: `live:${uuid}`,
        kind: 'live',
        title: known?.name ?? asText(channel.channel_name) ?? asText(channel.stream_name) ?? uuid,
        logoPath: known?.logoPath ?? null,
        providerName: provider(channel.m3u_profile_id),
        startedAt: epochToIso(record.started_at),
        viewers,
      },
    ];
  });
  liveRows.sort((a, b) => b.viewers.length - a.viewers.length || a.title.localeCompare(b.title));

  const vodRows: DispatcharrStreamEntry[] = [];
  for (const group of asRecords(vod?.vod_connections)) {
    for (const connection of asRecords(group.connections)) {
      const clientId = asKey(connection.client_id);
      if (!clientId) continue;
      const viewers: string[] = [];
      addViewer(
        viewers,
        viewerName(
          {
            userId: connection.user_id,
            ip: connection.client_ip,
            userAgent: connection.user_agent,
          },
          context
        )
      );
      vodRows.push({
        key: `vod:${clientId}`,
        kind: 'vod',
        title: asText(connection.content_name) ?? asText(group.content_name) ?? 'VOD',
        logoPath: null,
        providerName: provider(
          connection.m3u_profile_id ?? asRecord(connection.m3u_profile)?.m3u_profile_id
        ),
        startedAt: epochToIso(connection.connected_at),
        viewers,
      });
    }
  }

  const catchupRows = asRecords(catchup?.timeshift_sessions).flatMap(
    (session): DispatcharrStreamEntry[] => {
      const id = asKey(session.session_id) ?? asKey(session.stats_channel_id);
      if (!id) return [];
      const connections = asRecords(session.connections);
      const viewers: string[] = [];
      let started: number | undefined;
      for (const connection of connections) {
        addViewer(
          viewers,
          viewerName(
            {
              userId: connection.user_id,
              ip: connection.ip_address,
              userAgent: connection.user_agent,
              name: connection.username,
            },
            context
          )
        );
        const at = Number(connection.connected_at);
        if (Number.isFinite(at) && at > 0 && (started === undefined || at < started)) started = at;
      }
      return [
        {
          key: `catchup:${id}`,
          kind: 'catchup',
          title: asText(session.channel_name) ?? asText(connections[0]?.channel_name) ?? 'Catch-up',
          logoPath: dispatcharrLogoPath(session.logo_id ?? connections[0]?.logo_id),
          providerName: provider(connections[0]?.m3u_profile_id),
          startedAt: epochToIso(started),
          viewers,
        },
      ];
    }
  );

  return [...liveRows, ...vodRows, ...catchupRows];
}
