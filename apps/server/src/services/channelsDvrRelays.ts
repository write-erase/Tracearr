/**
 * Hiding the Dispatcharr side of a Channels DVR stream.
 *
 * When a Channels DVR server gets its channels from Dispatcharr, every channel it plays or
 * records is also a Dispatcharr stream, so one viewer shows up twice. With an M3U source that
 * stream is anonymous and "ignore anonymous streams" hides it; with an XC login it carries that
 * user's name. A Channels DVR server can name the Dispatcharr user it signs in as, and a
 * Dispatcharr stream from that user whose user agent is Channels DVR's own (`channels-dvr/…`) is
 * then left out. The same user in another player still shows.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { liveServerCondition } from './liveServers.js';
import type { MediaSession } from './mediaServer/types.js';

/** How long the list of relay users is reused; editing a server clears it at once. */
const CACHE_TTL_MS = 30_000;

let cache: { users: Set<string>; expiresAt: number } | null = null;

/** Names compare without case or surrounding spaces. */
export function relayUserKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Channels DVR's own requests: `channels-dvr/2026.11.11.2228 (linux; amd64)` and the like. */
export function isChannelsDvrUserAgent(userAgent: string | undefined): boolean {
  return !!userAgent && /^channels[-_ ]?dvr\//i.test(userAgent.trim());
}

/** A Dispatcharr stream that is a Channels DVR server fetching a channel for itself. */
export function isChannelsDvrRelay(session: MediaSession, relayUsers: Set<string>): boolean {
  if (relayUsers.size === 0) return false;
  const userAgent = session.player.product ?? session.player.name;
  return isChannelsDvrUserAgent(userAgent) && relayUsers.has(relayUserKey(session.user.username));
}

export function withoutChannelsDvrRelays(
  sessions: MediaSession[],
  relayUsers: Set<string>
): MediaSession[] {
  if (relayUsers.size === 0) return sessions;
  return sessions.filter((session) => !isChannelsDvrRelay(session, relayUsers));
}

/** The Dispatcharr users live Channels DVR servers sign in as. */
export async function getChannelsDvrRelayUsers(now: number = Date.now()): Promise<Set<string>> {
  if (cache && cache.expiresAt > now) return cache.users;
  try {
    return await readRelayUsers(now);
  } catch {
    // Hiding is a tidy-up: if it can't be read, show the duplicate rather than drop the poll.
    return cache?.users ?? new Set();
  }
}

async function readRelayUsers(now: number): Promise<Set<string>> {
  const rows = await db
    .select({ dispatcharrUser: servers.dispatcharrUser })
    .from(servers)
    .where(
      and(eq(servers.type, 'channels_dvr'), isNotNull(servers.dispatcharrUser), liveServerCondition)
    );
  const users = new Set(
    rows
      .map((row) => (row.dispatcharrUser ? relayUserKey(row.dispatcharrUser) : ''))
      .filter(Boolean)
  );
  cache = { users, expiresAt: now + CACHE_TTL_MS };
  return users;
}

/** Called when a server's Dispatcharr user changes, so the next poll uses it. */
export function clearChannelsDvrRelayUsers(): void {
  cache = null;
}
