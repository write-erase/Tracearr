/**
 * Keeps Dispatcharr and Channels DVR servers out of what Tracearr's mobile app gets (fork).
 *
 * The app (Tracearr/Mobile-App, built on @tracearr/shared 3.2.1) looks every server's type up in
 * its own tables (`SERVER_PROFILES[type].displayName` and the like) and stops working on a type
 * it doesn't have. For a request from the app, recognised by its `x-tracearr-client: mobile/...`
 * header:
 * - the server lists (`/servers`, `/servers/health`, the servers in `/sessions/filter-options`)
 *   leave those servers out;
 * - a list or stat asked for "all servers" covers only the servers the app knows, and one asked
 *   for named servers drops any hidden one;
 * - a session or server of a hidden type answers 404.
 * Push notifications and socket server alerts for those servers are skipped where they are sent.
 * The web app is unchanged.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_BASE_PATH, MOBILE_CLIENT_HEADER, type ServerType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';

/** The server types the mobile app has in its tables. */
export const MOBILE_APP_SERVER_TYPES: ReadonlySet<string> = new Set<ServerType>([
  'plex',
  'jellyfin',
  'emby',
  'tofa',
]);

/** Matches no server, so a filter naming only hidden servers never widens to "all". */
export const NO_SERVER_ID = '00000000-0000-4000-8000-000000000000';

const CACHE_MS = 30_000;
let cache: { ids: ReadonlySet<string>; at: number } | null = null;

/** Ids of the servers the app can show. Cleared with the poller's servers cache. */
export async function mobileAppServerIds(): Promise<ReadonlySet<string>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.ids;
  const rows = await db.select({ id: servers.id, type: servers.type }).from(servers);
  const ids = new Set(rows.filter((row) => MOBILE_APP_SERVER_TYPES.has(row.type)).map((r) => r.id));
  cache = { ids, at: now };
  return ids;
}

export function clearMobileAppServerCache(): void {
  cache = null;
}

/**
 * Whether the app must not see this server. A server it doesn't find counts as hidden, so one
 * added since the last read stays out until the cache refreshes rather than reaching the app.
 */
export async function isHiddenFromMobileApp(serverId: string | null | undefined): Promise<boolean> {
  if (!serverId) return false;
  return !(await mobileAppServerIds()).has(serverId);
}

export function isMobileAppRequest(request: FastifyRequest): boolean {
  const header = request.headers[MOBILE_CLIENT_HEADER];
  return typeof header === 'string' && header.startsWith('mobile/');
}

function requestedServerIds(source: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (typeof source.serverId === 'string') ids.push(source.serverId);
  const many = source.serverIds;
  if (typeof many === 'string') ids.push(many);
  else if (Array.isArray(many))
    ids.push(...many.filter((id): id is string => typeof id === 'string'));
  return ids;
}

/**
 * Narrows a query or filter object's `serverId`/`serverIds` to the servers the app can show.
 * Left as it is when every server it names is one the app knows.
 */
export function narrowServerFilter(
  source: Record<string, unknown>,
  allowed: ReadonlySet<string>
): void {
  const requested = requestedServerIds(source);
  if (requested.length > 0 && requested.every((id) => allowed.has(id))) return;
  const ids = requested.length > 0 ? requested.filter((id) => allowed.has(id)) : [...allowed];
  delete source.serverId;
  source.serverIds = ids.length > 0 ? ids : [NO_SERVER_ID];
}

const API = API_BASE_PATH;

/** The app's list and stat endpoints that take a server filter in the query string. */
const SCOPED_QUERY_ROUTES = new Set([
  `${API}/stats/dashboard`,
  `${API}/stats/plays`,
  `${API}/stats/plays-by-dayofweek`,
  `${API}/stats/plays-by-hourofday`,
  `${API}/stats/platforms`,
  `${API}/stats/quality`,
  `${API}/stats/concurrent`,
  `${API}/sessions/active`,
  `${API}/sessions/history`,
  `${API}/sessions/history/aggregates`,
  `${API}/sessions/filter-options`,
  `${API}/users`,
  `${API}/violations`,
]);
/** Acknowledge-all takes its server filter in the body's `filters`. */
const BULK_ACKNOWLEDGE_ROUTE = `${API}/violations/bulk/acknowledge`;
const SERVER_ROUTE_PREFIX = `${API}/servers/:id`;
const SESSION_ROUTE = `${API}/sessions/:id`;

function routeOf(request: FastifyRequest): string {
  const url = request.routeOptions.url ?? '';
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function filterList(
  payload: Record<string, unknown>,
  key: string,
  idOf: (item: Record<string, unknown>) => unknown,
  allowed: ReadonlySet<string>
): void {
  const list = payload[key];
  if (!Array.isArray(list)) return;
  payload[key] = list.filter((item) => {
    const id = idOf(asRecord(item) ?? {});
    return typeof id === 'string' && allowed.has(id);
  });
}

async function beforeHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isMobileAppRequest(request)) return;
  const route = routeOf(request);

  if (request.method === 'GET' && SCOPED_QUERY_ROUTES.has(route)) {
    const query = asRecord(request.query);
    if (query) narrowServerFilter(query, await mobileAppServerIds());
    return;
  }

  if (request.method === 'POST' && route === BULK_ACKNOWLEDGE_ROUTE) {
    const body = asRecord(request.body);
    if (body?.selectAll === true) {
      const filters = asRecord(body.filters) ?? {};
      narrowServerFilter(filters, await mobileAppServerIds());
      body.filters = filters;
    }
    return;
  }

  if (route === SERVER_ROUTE_PREFIX || route.startsWith(`${SERVER_ROUTE_PREFIX}/`)) {
    const id = asRecord(request.params)?.id;
    if (typeof id === 'string' && (await isHiddenFromMobileApp(id))) {
      await reply
        .code(404)
        .send({ statusCode: 404, error: 'Not Found', message: 'Server not found' });
    }
  }
}

async function beforeSerialization(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> {
  if (!isMobileAppRequest(request) || reply.statusCode >= 300) return payload;
  const body = asRecord(payload);
  if (!body) return payload;
  const route = routeOf(request);

  if (request.method !== 'GET') return payload;
  if (route === `${API}/servers`) {
    filterList(body, 'data', (server) => server.id, await mobileAppServerIds());
  } else if (route === `${API}/servers/health`) {
    filterList(body, 'data', (server) => server.serverId, await mobileAppServerIds());
  } else if (route === `${API}/sessions/filter-options`) {
    filterList(body, 'servers', (server) => server.id, await mobileAppServerIds());
  } else if (route === SESSION_ROUTE) {
    const serverId = asRecord(body.server)?.id ?? body.serverId;
    if (typeof serverId === 'string' && (await isHiddenFromMobileApp(serverId))) {
      reply.code(404);
      return { statusCode: 404, error: 'Not Found', message: 'Session not found' };
    }
  }
  return payload;
}

/** Adds the app's server filtering to every route registered after it. */
export function registerMobileAppServerFilter(app: FastifyInstance): void {
  app.addHook('preHandler', beforeHandler);
  app.addHook('preSerialization', beforeSerialization);
}
