/**
 * Live playback state from the Channels app on the playback device.
 *
 * `GET http://<device>:57000/api/status` reports exactly what the app is doing:
 *
 *   {"status":"playing","playback_time":152.2,
 *    "now_playing":{"title":"M*A*S*H","season_number":1,"episode_number":1,"duration":1538.9,...}}
 *
 * That is faster and more exact than inferring pauses from the DVR server's
 * activity line (which refreshes the position only about every 10 s), but it only
 * works when the device is reachable from the Tracearr server - in practice,
 * local viewers. Unreachable devices are skipped for a while so each poll does
 * not wait on them; their sessions fall back to the server-side detection.
 */

import type { MediaSession } from '../types.js';

export const DEVICE_API_PORT = 57000;
export const DEVICE_TIMEOUT_MS = 1000;
export const DEVICE_RETRY_AFTER_MS = 60_000;

export interface DeviceStatus {
  state: 'playing' | 'paused';
  positionMs: number;
}

/** ip -> time before which the device is not asked again */
const unreachableUntil = new Map<string, number>();

function normalizeTitle(value: unknown): string {
  return typeof value === 'string'
    ? value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
    : '';
}

/**
 * Whether the device's now_playing describes this session. Episodes must agree on
 * season and episode number (and on the show title when both have one); movies on
 * title.
 */
export function deviceMatchesSession(nowPlaying: unknown, session: MediaSession): boolean {
  if (!nowPlaying || typeof nowPlaying !== 'object') return false;
  const np = nowPlaying as Record<string, unknown>;

  if (session.episode) {
    if (np.season_number !== session.episode.seasonNumber) return false;
    if (np.episode_number !== session.episode.episodeNumber) return false;
    const deviceShow = normalizeTitle(np.title);
    const sessionShow = normalizeTitle(session.episode.showTitle);
    return !deviceShow || !sessionShow || deviceShow === sessionShow;
  }

  const deviceTitle = normalizeTitle(np.title);
  return Boolean(deviceTitle) && deviceTitle === normalizeTitle(session.media.title);
}

/** Parse a /api/status body for this session; null when it cannot be trusted. */
export function parseDeviceStatus(body: unknown, session: MediaSession): DeviceStatus | null {
  if (!body || typeof body !== 'object') return null;
  const data = body as Record<string, unknown>;
  if (data.status !== 'playing' && data.status !== 'paused') return null;
  if (typeof data.playback_time !== 'number' || !Number.isFinite(data.playback_time)) return null;
  if (!deviceMatchesSession(data.now_playing, session)) return null;
  return { state: data.status, positionMs: Math.max(0, Math.round(data.playback_time * 1000)) };
}

function deviceUrl(ip: string): string {
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${DEVICE_API_PORT}/api/status`;
}

/**
 * Ask each local recording session's device for its status, in parallel.
 * Returns sessionKey -> status for the devices that answered with a match.
 */
export async function readDeviceStatuses(
  sessions: MediaSession[],
  { now = Date.now(), fetchImpl = fetch }: { now?: number; fetchImpl?: typeof fetch } = {}
): Promise<Map<string, DeviceStatus>> {
  const result = new Map<string, DeviceStatus>();
  await Promise.all(
    sessions.map(async (session) => {
      const ip = session.network.ipAddress;
      // Only Channels apps answer on :57000; a browser has nothing to ask.
      if (session.player?.product === 'Channels Web') return;
      if (session.media.type === 'live' || !session.network.isLocal || !ip) return;
      if ((unreachableUntil.get(ip) ?? 0) > now) return;
      try {
        const response = await fetchImpl(deviceUrl(ip), {
          signal: AbortSignal.timeout(DEVICE_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        unreachableUntil.delete(ip);
        const status = parseDeviceStatus(await response.json(), session);
        if (status) result.set(session.sessionKey, status);
      } catch {
        unreachableUntil.set(ip, now + DEVICE_RETRY_AFTER_MS);
      }
    })
  );
  return result;
}

/** Test helper. */
export function resetDeviceStatus(): void {
  unreachableUntil.clear();
}
