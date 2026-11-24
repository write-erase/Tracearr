/**
 * Dispatcharr and Channels DVR servers kept out of what the mobile app gets (fork). The hooks
 * run on a bare Fastify app with stand-in routes at the real paths; only the servers table is
 * stubbed.
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
    { id: CHANNELS, type: 'channels_dvr' }
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
          { serverId: CHANNELS, serverName: 'DVR' },
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
        ],
      }));
      sessions.get<{ Params: { id: string } }>('/:id', async (request) => ({
        id: request.params.id,
        server: { id: request.params.id === 'dvr-play' ? CHANNELS : PLEX, type: 'plex' },
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
    const query: Record<string, unknown> = { serverIds: [PLEX, DISPATCHARR] };
    narrowServerFilter(query, allowed);
    expect(query).toEqual({ serverIds: [PLEX] });
  });

  it('matches nothing rather than everything when only hidden servers are named', () => {
    const query: Record<string, unknown> = { serverId: CHANNELS };
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
  it('hides Dispatcharr, Channels DVR and a server it does not know', async () => {
    expect(await isHiddenFromMobileApp(PLEX)).toBe(false);
    expect(await isHiddenFromMobileApp(DISPATCHARR)).toBe(true);
    expect(await isHiddenFromMobileApp(CHANNELS)).toBe(true);
    expect(await isHiddenFromMobileApp('55555555-5555-4555-8555-555555555555')).toBe(true);
    expect(await isHiddenFromMobileApp(undefined)).toBe(false);
  });
});

describe('requests from the mobile app', () => {
  it('leaves Dispatcharr and Channels DVR out of the server list', async () => {
    const response = await app.inject({ url: '/api/v1/servers', headers: APP });
    expect(response.json<{ data: { id: string }[] }>().data.map((s) => s.id)).toEqual([
      PLEX,
      JELLYFIN,
    ]);
  });

  it('leaves them out of server health and the filter options', async () => {
    const health = await app.inject({ url: '/api/v1/servers/health', headers: APP });
    expect(health.json()).toEqual({ data: [{ serverId: PLEX, serverName: 'Plex' }] });

    const options = await app.inject({ url: '/api/v1/sessions/filter-options', headers: APP });
    expect(options.json()).toMatchObject({
      query: { serverIds: [PLEX, JELLYFIN] },
      servers: [{ id: JELLYFIN }],
    });
  });

  it('asks for every server the app knows when it asks for all servers', async () => {
    const response = await app.inject({ url: '/api/v1/sessions/active', headers: APP });
    expect(response.json()).toEqual({ query: { serverIds: [PLEX, JELLYFIN] } });
  });

  it('works on a list route registered as the prefix itself', async () => {
    const response = await app.inject({ url: '/api/v1/users?page=2', headers: APP });
    expect(response.json()).toEqual({ query: { page: '2', serverIds: [PLEX, JELLYFIN] } });
  });

  it('keeps a filter naming only servers it knows', async () => {
    const response = await app.inject({
      url: `/api/v1/sessions/active?serverId=${JELLYFIN}`,
      headers: APP,
    });
    expect(response.json()).toEqual({ query: { serverId: JELLYFIN } });
  });

  it('answers 404 for a session on a hidden server, and 200 for one it knows', async () => {
    const hidden = await app.inject({ url: '/api/v1/sessions/dvr-play', headers: APP });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ message: 'Session not found' });

    const shown = await app.inject({ url: '/api/v1/sessions/plex-play', headers: APP });
    expect(shown.statusCode).toBe(200);
  });

  it('answers 404 for a hidden server without running the route', async () => {
    const response = await app.inject({
      url: `/api/v1/servers/${DISPATCHARR}/live-stats`,
      headers: APP,
    });
    expect(response.statusCode).toBe(404);
    expect(handled).not.toHaveBeenCalled();

    const shown = await app.inject({ url: `/api/v1/servers/${PLEX}/live-stats`, headers: APP });
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
      body: { selectAll: true, filters: { acknowledged: false, serverIds: [PLEX, JELLYFIN] } },
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
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(4);

    const active = await app.inject({ url: '/api/v1/sessions/active' });
    expect(active.json()).toEqual({ query: {} });

    const session = await app.inject({ url: '/api/v1/sessions/dvr-play' });
    expect(session.statusCode).toBe(200);

    const stats = await app.inject({ url: `/api/v1/servers/${DISPATCHARR}/live-stats` });
    expect(stats.statusCode).toBe(200);
  });
});
