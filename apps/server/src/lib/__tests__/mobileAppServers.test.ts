/**
 * Servers kept out of what the mobile app gets (fork). Dispatcharr and Channels DVR are shown;
 * a type outside the list stands in for a hidden server. The hooks run on a bare Fastify app with
 * stand-in routes at the real paths; only the servers table is stubbed.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverRows } = vi.hoisted(() => ({
  serverRows: [] as { id: string; type: string }[],
}));

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: async () => serverRows })) },
}));

import {
  NO_SERVER_ID,
  clearMobileAppServerCache,
  isHiddenFromMobileApp,
  narrowServerFilter,
  registerMobileAppServerFilter,
} from '../mobileAppServers.js';

const PLEX = '11111111-1111-4111-8111-111111111111';
const JELLYFIN = '22222222-2222-4222-8222-222222222222';
const DISPATCHARR = '33333333-3333-4333-8333-333333333333';
const CHANNELS = '44444444-4444-4444-8444-444444444444';
/** Servers of a type the list doesn't have, standing in for a hidden server */
const HIDDEN = '77777777-7777-4777-8777-777777777777';
const HIDDEN_TWO = '88888888-8888-4888-8888-888888888888';
const SHOWN = [PLEX, JELLYFIN, DISPATCHARR, CHANNELS];
const APP = { 'x-tracearr-client': 'mobile/3.2.1' };

let app: FastifyInstance;
const handled = vi.fn();

beforeEach(async () => {
  serverRows.splice(
    0,
    serverRows.length,
    { id: PLEX, type: 'plex' },
    { id: JELLYFIN, type: 'jellyfin' },
    { id: DISPATCHARR, type: 'dispatcharr' },
    { id: CHANNELS, type: 'channels_dvr' },
    { id: HIDDEN, type: 'not_in_the_app' },
    { id: HIDDEN_TWO, type: 'not_in_the_app' }
  );
  clearMobileAppServerCache();
  handled.mockReset();

  app = Fastify();
  registerMobileAppServerFilter(app);
  await app.register(
    async (servers) => {
      servers.get('/', async () => ({
        data: serverRows.map((row) => ({ id: row.id, name: row.type, type: row.type })),
      }));
      servers.get('/health', async () => ({
        data: [
          { serverId: PLEX, serverName: 'Plex' },
          { serverId: HIDDEN_TWO, serverName: 'Hidden' },
        ],
      }));
      servers.get('/:id/live-stats', async () => {
        handled();
        return { statistics: [] };
      });
    },
    { prefix: '/api/v1/servers' }
  );
  await app.register(
    async (sessions) => {
      sessions.get('/active', async (request) => ({ query: request.query }));
      sessions.get('/filter-options', async (request) => ({
        query: request.query,
        servers: [
          { id: JELLYFIN, name: 'Jellyfin', type: 'jellyfin' },
          { id: DISPATCHARR, name: 'Dispatcharr', type: 'dispatcharr' },
          { id: HIDDEN, name: 'Hidden', type: 'not_in_the_app' },
        ],
      }));
      sessions.get<{ Params: { id: string } }>('/:id', async (request) => ({
        id: request.params.id,
        server: { id: request.params.id === 'hidden-play' ? HIDDEN_TWO : PLEX, type: 'plex' },
      }));
    },
    { prefix: '/api/v1/sessions' }
  );
  await app.register(
    async (users) => {
      users.get('/', async (request) => ({ query: request.query }));
    },
    { prefix: '/api/v1/users' }
  );
  await app.register(
    async (violations) => {
      violations.post('/bulk/acknowledge', async (request) => ({ body: request.body }));
    },
    { prefix: '/api/v1/violations' }
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('narrowServerFilter', () => {
  const allowed = new Set([PLEX, JELLYFIN]);

  it('fills in every server the app knows when none is named', () => {
    const query: Record<string, unknown> = {};
    narrowServerFilter(query, allowed);
    expect(query).toEqual({ serverIds: [PLEX, JELLYFIN] });
  });

  it('leaves a filter of servers the app knows as it is', () => {
    const query: Record<string, unknown> = { serverId: PLEX };
    narrowServerFilter(query, allowed);
    expect(query).toEqual({ serverId: PLEX });
  });

  it('drops a hidden server from a list', () => {
    const query: Record<string, unknown> = { serverIds: [PLEX, HIDDEN] };
    narrowServerFilter(query, allowed);
    expect(query).toEqual({ serverIds: [PLEX] });
  });

  it('matches nothing rather than everything when only hidden servers are named', () => {
    const query: Record<string, unknown> = { serverId: HIDDEN_TWO };
    narrowServerFilter(query, allowed);
    expect(query).toEqual({ serverIds: [NO_SERVER_ID] });
  });

  it('matches nothing when the app knows no server at all', () => {
    const query: Record<string, unknown> = {};
    narrowServerFilter(query, new Set());
    expect(query).toEqual({ serverIds: [NO_SERVER_ID] });
  });
});

describe('isHiddenFromMobileApp', () => {
  it('shows Dispatcharr and Channels DVR, and hides a type outside the list or a server it does not know', async () => {
    expect(await isHiddenFromMobileApp(PLEX)).toBe(false);
    expect(await isHiddenFromMobileApp(DISPATCHARR)).toBe(false);
    expect(await isHiddenFromMobileApp(CHANNELS)).toBe(false);
    expect(await isHiddenFromMobileApp(HIDDEN)).toBe(true);
    expect(await isHiddenFromMobileApp('55555555-5555-4555-8555-555555555555')).toBe(true);
    expect(await isHiddenFromMobileApp(undefined)).toBe(false);
  });

  it('shows a server added since the list was read, without waiting for it to refresh', async () => {
    const added = '66666666-6666-4666-8666-666666666666';
    expect(await isHiddenFromMobileApp(PLEX)).toBe(false);
    serverRows.push({ id: added, type: 'emby' });
    expect(await isHiddenFromMobileApp(added)).toBe(false);
  });
});

describe('requests from the mobile app', () => {
  it('lists Dispatcharr and Channels DVR, and leaves a hidden server out', async () => {
    const response = await app.inject({ url: '/api/v1/servers', headers: APP });
    expect(response.json<{ data: { id: string }[] }>().data.map((s) => s.id)).toEqual(SHOWN);
  });

  it('leaves a hidden server out of server health and the filter options', async () => {
    const health = await app.inject({ url: '/api/v1/servers/health', headers: APP });
    expect(health.json()).toEqual({ data: [{ serverId: PLEX, serverName: 'Plex' }] });

    const options = await app.inject({ url: '/api/v1/sessions/filter-options', headers: APP });
    expect(options.json()).toMatchObject({
      query: { serverIds: SHOWN },
      servers: [{ id: JELLYFIN }, { id: DISPATCHARR }],
    });
  });

  it('asks for every server the app knows when it asks for all servers', async () => {
    const response = await app.inject({ url: '/api/v1/sessions/active', headers: APP });
    expect(response.json()).toEqual({ query: { serverIds: SHOWN } });
  });

  it('works on a list route registered as the prefix itself', async () => {
    const response = await app.inject({ url: '/api/v1/users?page=2', headers: APP });
    expect(response.json()).toEqual({ query: { page: '2', serverIds: SHOWN } });
  });

  it('keeps a filter naming only servers it knows', async () => {
    const response = await app.inject({
      url: `/api/v1/sessions/active?serverId=${CHANNELS}`,
      headers: APP,
    });
    expect(response.json()).toEqual({ query: { serverId: CHANNELS } });
  });

  it('answers 404 for a session on a hidden server, and 200 for one it knows', async () => {
    const hidden = await app.inject({ url: '/api/v1/sessions/hidden-play', headers: APP });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ message: 'Session not found' });

    const shown = await app.inject({ url: '/api/v1/sessions/plex-play', headers: APP });
    expect(shown.statusCode).toBe(200);
  });

  it('answers 404 for a hidden server without running the route', async () => {
    const response = await app.inject({
      url: `/api/v1/servers/${HIDDEN}/live-stats`,
      headers: APP,
    });
    expect(response.statusCode).toBe(404);
    expect(handled).not.toHaveBeenCalled();

    const shown = await app.inject({
      url: `/api/v1/servers/${DISPATCHARR}/live-stats`,
      headers: APP,
    });
    expect(shown.statusCode).toBe(200);
  });

  it('acknowledges all only on the servers it knows', async () => {
    const all = await app.inject({
      method: 'POST',
      url: '/api/v1/violations/bulk/acknowledge',
      headers: APP,
      payload: { selectAll: true, filters: { acknowledged: false } },
    });
    expect(all.json()).toEqual({
      body: { selectAll: true, filters: { acknowledged: false, serverIds: SHOWN } },
    });

    const picked = await app.inject({
      method: 'POST',
      url: '/api/v1/violations/bulk/acknowledge',
      headers: APP,
      payload: { ids: [PLEX] },
    });
    expect(picked.json()).toEqual({ body: { ids: [PLEX] } });
  });
});

describe('requests from the web app', () => {
  it('changes nothing', async () => {
    const list = await app.inject({ url: '/api/v1/servers' });
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(6);

    const active = await app.inject({ url: '/api/v1/sessions/active' });
    expect(active.json()).toEqual({ query: {} });

    const session = await app.inject({ url: '/api/v1/sessions/hidden-play' });
    expect(session.statusCode).toBe(200);

    const stats = await app.inject({ url: `/api/v1/servers/${HIDDEN}/live-stats` });
    expect(stats.statusCode).toBe(200);
  });
});
