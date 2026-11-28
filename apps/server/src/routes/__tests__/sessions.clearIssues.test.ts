/**
 * Clearing a recent Channels DVR recording's issues (fork):
 * - POST /sessions/recordings/clear-issues stores the file ids for everyone
 * - GET /sessions/recordings marks those recordings issuesCleared
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import { REDIS_KEYS, type AuthUser, type ChannelsDvrScheduleResponse } from '@tracearr/shared';
import { queryChain } from '../../test/helpers.js';

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../../services/cache.js', () => ({ getCacheService: vi.fn(() => null) }));
vi.mock('../../services/termination.js', () => ({ terminateSession: vi.fn() }));
vi.mock('../../jobs/poller/database.js', () => ({ getActiveAutomations: vi.fn(async () => []) }));

const { getSchedule } = vi.hoisted(() => ({ getSchedule: vi.fn() }));
vi.mock('../../services/mediaServer/channelsDvr/client.js', () => ({
  ChannelsDvrClient: class {
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    getSchedule() {
      return getSchedule();
    }
  },
}));

import { db } from '../../db/client.js';
import { getCacheService } from '../../services/cache.js';
import { sessionRoutes } from '../sessions/index.js';
import { permissionGuard } from '../../lib/scope.js';

const SERVER_ID = randomUUID();

function redisMock() {
  const multi = {
    sadd: vi.fn(() => multi),
    expire: vi.fn(() => multi),
    exec: vi.fn(async () => []),
  };
  return {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn(),
    smembers: vi.fn(async (): Promise<string[]> => []),
    multi: vi.fn(() => multi),
  };
}

let redis: ReturnType<typeof redisMock>;
let app: FastifyInstance;

async function buildApp(user: AuthUser): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  instance.decorate('authenticate', async (request: any) => {
    request.user = user;
  });
  instance.decorate('requirePermission', permissionGuard(instance));
  instance.decorate('requireOwner', async (request: any) => {
    request.user = user;
  });
  instance.decorate('redis', redis as never);
  await instance.register(sessionRoutes, { prefix: '/sessions' });
  return instance;
}

const owner: AuthUser = {
  userId: randomUUID(),
  username: 'owner',
  role: 'owner',
  serverIds: [SERVER_ID],
};

function recentFile(fileId: string) {
  return {
    fileId,
    jobId: '1764016200-1',
    showId: null,
    title: 'World News Tonight',
    episodeTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    channelNumber: '1',
    startedAt: '2026-11-23T23:30:00Z',
    endedAt: '2026-11-23T23:46:00Z',
    durationSec: 1020,
    scheduledSec: 1800,
    thumbPath: null,
    issues: ['stoppedEarly'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  redis = redisMock();
});

afterEach(async () => {
  await app?.close();
});

describe('POST /sessions/recordings/clear-issues', () => {
  it('stores the file ids for the server, kept two days', async () => {
    vi.mocked(db.select).mockReturnValue(
      queryChain(vi.fn, [{ type: 'channels_dvr', historicalAt: null }])
    );
    app = await buildApp(owner);

    const response = await app.inject({
      method: 'POST',
      url: '/sessions/recordings/clear-issues',
      payload: { serverId: SERVER_ID, fileIds: ['1501', '1502'] },
    });

    expect(response.statusCode).toBe(200);
    const multi = redis.multi.mock.results[0]?.value;
    const key = REDIS_KEYS.CHANNELS_DVR_CLEARED_ISSUES(SERVER_ID);
    expect(multi.sadd).toHaveBeenCalledWith(key, '1501', '1502');
    expect(multi.expire).toHaveBeenCalledWith(key, 2 * 24 * 60 * 60);
    expect(multi.exec).toHaveBeenCalled();
  });

  it.each([
    ['no file ids', { serverId: SERVER_ID, fileIds: [] }],
    ['a file id that is not one', { serverId: SERVER_ID, fileIds: ['../x y'] }],
    ['no server', { fileIds: ['1501'] }],
  ])('refuses %s', async (_label, payload) => {
    app = await buildApp(owner);
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/recordings/clear-issues',
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(redis.multi).not.toHaveBeenCalled();
  });

  it('answers 404 for a server that is not Channels DVR', async () => {
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ type: 'plex', historicalAt: null }]));
    app = await buildApp(owner);
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/recordings/clear-issues',
      payload: { serverId: SERVER_ID, fileIds: ['1501'] },
    });
    expect(response.statusCode).toBe(404);
    expect(redis.multi).not.toHaveBeenCalled();
  });

  it('is not open to a member', async () => {
    app = await buildApp({ ...owner, role: 'member', serverIds: [] });
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/recordings/clear-issues',
      payload: { serverId: SERVER_ID, fileIds: ['1501'] },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(redis.multi).not.toHaveBeenCalled();
  });
});

describe('GET /sessions/recordings', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReturnValue(
      queryChain(vi.fn, [{ id: SERVER_ID, name: 'Channels', url: 'http://channels:8089' }])
    );
    getSchedule.mockResolvedValue({
      recordings: [],
      upcoming: [],
      tuners: null,
      disk: null,
      recent: [recentFile('1501'), recentFile('1502')],
      streams: [],
    });
  });

  it('marks the recordings whose issues were cleared', async () => {
    redis.smembers.mockResolvedValue(['1501']);
    app = await buildApp(owner);

    const response = await app.inject({ url: '/sessions/recordings' });
    const body = response.json<ChannelsDvrScheduleResponse>();

    expect(redis.smembers).toHaveBeenCalledWith(REDIS_KEYS.CHANNELS_DVR_CLEARED_ISSUES(SERVER_ID));
    expect(body.recent.map((file) => [file.fileId, file.issuesCleared])).toEqual([
      ['1501', true],
      ['1502', false],
    ]);
    expect(body.recent[0]?.issues).toEqual(['stoppedEarly']);
  });

  it('still answers, with nothing cleared, when Redis fails', async () => {
    redis.smembers.mockRejectedValue(new Error('redis down'));
    app = await buildApp(owner);

    const response = await app.inject({ url: '/sessions/recordings' });
    const body = response.json<ChannelsDvrScheduleResponse>();

    expect(body.recent.map((file) => file.issuesCleared)).toEqual([false, false]);
  });
});

describe('GET /sessions/recordings streaming now (fork)', () => {
  const LOCAL = '6-stream-M3U-DispatcharrMPEGTS-4-192.168.30.2';
  const REMOTE = '7-ch4-dANY-26688a6db1d2';

  beforeEach(() => {
    vi.mocked(db.select).mockReturnValue(
      queryChain(vi.fn, [{ id: SERVER_ID, name: 'Channels', url: 'http://channels:8089' }])
    );
    getSchedule.mockResolvedValue({
      recordings: [],
      upcoming: [],
      tuners: null,
      disk: null,
      recent: [],
      streams: [
        {
          channelNumber: '4',
          channelTitle: 'NBC KFOR',
          thumbPath: '/dvr/guide/channels/4/logo',
          sourceName: 'Trilo',
          recording: false,
          viewers: [
            { key: LOCAL, name: 'Apple TV' },
            { key: REMOTE, name: "Craig's Apple TV" },
          ],
        },
      ],
    });
    redis.smembers.mockResolvedValue([]);
  });

  it("names each client and times the stream from Tracearr's sessions", async () => {
    vi.mocked(getCacheService).mockReturnValue({
      getAllActiveSessions: async () => [
        {
          serverId: SERVER_ID,
          sessionKey: REMOTE,
          playerName: "Craig's Apple TV",
          startedAt: '2026-11-28T14:05:00.000Z',
        },
        {
          serverId: SERVER_ID,
          sessionKey: LOCAL,
          playerName: 'Living Room',
          startedAt: '2026-11-28T14:10:00.000Z',
        },
        // Another server's session under the same key is not this stream's
        {
          serverId: randomUUID(),
          sessionKey: LOCAL,
          playerName: 'Elsewhere',
          startedAt: '2026-11-28T13:00:00.000Z',
        },
      ],
    } as never);
    app = await buildApp(owner);

    const body = (
      await app.inject({ url: '/sessions/recordings' })
    ).json<ChannelsDvrScheduleResponse>();

    expect(body.streams).toEqual([
      {
        serverId: SERVER_ID,
        serverName: 'Channels',
        channelNumber: '4',
        channelTitle: 'NBC KFOR',
        thumbPath: '/dvr/guide/channels/4/logo',
        sourceName: 'Trilo',
        recording: false,
        startedAt: '2026-11-28T14:05:00.000Z',
        viewers: ['Living Room', "Craig's Apple TV"],
      },
    ]);
  });

  it("falls back to the activity line's names, with no time, when there's no session yet", async () => {
    vi.mocked(getCacheService).mockReturnValue(null);
    app = await buildApp(owner);

    const body = (
      await app.inject({ url: '/sessions/recordings' })
    ).json<ChannelsDvrScheduleResponse>();

    expect(body.streams[0]).toMatchObject({
      startedAt: null,
      viewers: ['Apple TV', "Craig's Apple TV"],
    });
  });
});
