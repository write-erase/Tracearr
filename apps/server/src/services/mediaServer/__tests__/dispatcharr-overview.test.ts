import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatcharrClient } from '../dispatcharr/client.js';
import {
  buildStreams,
  countProfileConnections,
  dispatcharrLogoPath,
  listRows,
  parseEpgSources,
  parseProviders,
  parseRecordingChannel,
  providerNamesByProfile,
  splitRecordings,
  withChannel,
} from '../dispatcharr/overview.js';
import type { MediaUser } from '../types.js';

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Shapes from Dispatcharr 0.34.1: /proxy/ts/status, /proxy/vod/stats/, /proxy/stats/ catchup.
const LIVE = [
  { channel_id: 'a', m3u_profile_id: 11, client_count: 2 },
  { channel_id: 'b', m3u_profile_id: 11, client_count: 1 },
  { channel_id: 'c', m3u_profile_id: 21, client_count: 1 },
  { channel_id: 'd', client_count: 1 },
];
const VOD = {
  vod_connections: [
    {
      content_name: 'A movie',
      connections: [
        { client_id: 'v1', m3u_profile_id: 12 },
        { client_id: 'v2', m3u_profile: { m3u_profile_id: 12 } },
      ],
    },
  ],
};
const CATCHUP = {
  timeshift_sessions: [
    {
      session_id: 's1',
      connections: [
        { stats_channel_id: 'ts-1', m3u_profile_id: 21 },
        { stats_channel_id: 'ts-1', m3u_profile_id: 21 },
      ],
    },
  ],
};

describe('countProfileConnections', () => {
  it('counts one per live channel, one per VOD client and one per catch-up stream', () => {
    const counts = countProfileConnections(LIVE, VOD, CATCHUP);
    expect(Object.fromEntries(counts)).toEqual({ 11: 2, 12: 2, 21: 2 });
  });

  it('counts live channels alone when VOD and catch-up are missing', () => {
    expect(Object.fromEntries(countProfileConnections(LIVE))).toEqual({ 11: 2, 21: 1 });
  });
});

describe('parseProviders', () => {
  const accounts = [
    {
      id: 1,
      name: 'Provider One',
      is_active: true,
      max_streams: 2,
      status: 'success',
      last_message: 'Refreshed',
      updated_at: '2026-11-23T15:00:00Z',
      profiles: [
        { id: 11, is_active: true, max_streams: 2 },
        { id: 12, is_active: true, max_streams: 3 },
        { id: 13, is_active: false, max_streams: 5 },
      ],
    },
    {
      id: 2,
      name: 'Unlimited',
      is_active: true,
      status: 'error',
      last_message: 'HTTP 401',
      updated_at: null,
      profiles: [{ id: 21, is_active: true, max_streams: 0 }],
    },
    { id: 3, name: 'Switched off', is_active: false, profiles: [] },
    {
      id: 5,
      name: 'custom',
      is_active: true,
      locked: true,
      max_streams: 0,
      profiles: [{ id: 51, is_active: true, max_streams: 0 }],
    },
    { id: 4, name: 'No profiles', max_streams: 4, status: 'refreshing-soon' },
  ];

  it('sums connections and active profile limits per account, and skips inactive and locked ones', () => {
    const counts = countProfileConnections(LIVE, VOD, CATCHUP);
    expect(parseProviders(accounts, counts)).toEqual([
      {
        id: 1,
        name: 'Provider One',
        status: 'success',
        lastMessage: 'Refreshed',
        refreshedAt: '2026-11-23T15:00:00.000Z',
        inUse: 4,
        maxStreams: 5,
      },
      {
        id: 2,
        name: 'Unlimited',
        status: 'error',
        lastMessage: 'HTTP 401',
        refreshedAt: null,
        inUse: 2,
        maxStreams: null,
      },
      {
        id: 4,
        name: 'No profiles',
        status: 'unknown',
        lastMessage: null,
        refreshedAt: null,
        inUse: 0,
        maxStreams: 4,
      },
    ]);
  });

  it('leaves connections in use unknown when the live streams could not be read', () => {
    expect(parseProviders(accounts, null).map((provider) => provider.inUse)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('reads a paginated answer', () => {
    expect(listRows({ results: [{ id: 1 }], next: null })).toEqual([{ id: 1 }]);
  });
});

describe('parseEpgSources', () => {
  it('keeps active sources and drops custom dummy guides', () => {
    expect(
      parseEpgSources([
        {
          id: 1,
          name: 'XMLTV',
          source_type: 'xmltv',
          is_active: true,
          status: 'success',
          last_message: null,
          updated_at: '2026-11-23T10:00:00Z',
          password: 'never-forwarded',
        },
        { id: 2, name: 'Dummy', source_type: 'dummy', is_active: true, status: 'idle' },
        { id: 3, name: 'Off', source_type: 'xmltv', is_active: false, status: 'disabled' },
        { id: 4, name: 'SD', source_type: 'schedules_direct', status: 'fetching' },
      ])
    ).toEqual([
      {
        id: 1,
        name: 'XMLTV',
        status: 'success',
        lastMessage: null,
        refreshedAt: '2026-11-23T10:00:00.000Z',
      },
      { id: 4, name: 'SD', status: 'fetching', lastMessage: null, refreshedAt: null },
    ]);
  });
});

describe('DispatcharrClient.getSoftwareVersion', () => {
  it('reads /api/core/version/', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ version: '0.34.1', timestamp: null }));
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191/', token: 'api-key' });

    await expect(client.getSoftwareVersion()).resolves.toBe('0.34.1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://dispatcharr:9191/api/core/version/');
  });

  it('reads a dev image as its version plus its build time (fork)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ version: '0.34.1', timestamp: '20261124013000' })
    );
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191/', token: 'api-key' });

    await expect(client.getSoftwareVersion()).resolves.toBe('0.34.1-dev.20261124013000');
  });

  it('answers null when the version cannot be read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191', token: 'api-key' });

    await expect(client.getSoftwareVersion()).resolves.toBeNull();
  });
});

describe('DispatcharrClient.getOverview', () => {
  function mockDispatcharr(overrides: Record<string, () => Response> = {}) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      for (const [path, respond] of Object.entries(overrides)) {
        if (url.endsWith(path)) return respond();
      }
      if (url.endsWith('/api/m3u/accounts/')) {
        return jsonResponse([
          {
            id: 1,
            name: 'Provider One',
            is_active: true,
            status: 'success',
            profiles: [{ id: 11, is_active: true, max_streams: 2 }],
          },
        ]);
      }
      if (url.endsWith('/api/epg/sources/')) {
        return jsonResponse([{ id: 5, name: 'Guide', source_type: 'xmltv', status: 'error' }]);
      }
      if (url.endsWith('/proxy/ts/status')) return jsonResponse({ channels: LIVE });
      if (url.endsWith('/proxy/vod/stats/')) return jsonResponse(VOD);
      if (url.endsWith('/proxy/stats/')) return jsonResponse({ catchup: CATCHUP });
      return new Response('not found', { status: 404 });
    });
  }

  it('combines accounts, guide sources and the stream snapshots', async () => {
    mockDispatcharr();
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191', token: 'api-key' });

    const overview = await client.getOverview();
    expect(overview).toMatchObject({
      providers: [
        {
          id: 1,
          name: 'Provider One',
          status: 'success',
          lastMessage: null,
          refreshedAt: null,
          inUse: 2,
          maxStreams: 2,
        },
      ],
      epgSources: [{ id: 5, name: 'Guide', status: 'error', lastMessage: null, refreshedAt: null }],
    });
    // 4 live channels, 2 VOD clients, 1 catch-up stream; users and channel names unavailable here
    expect(overview.streams).toHaveLength(7);
    expect(overview.streams[0]).toMatchObject({ key: 'live:a', providerName: 'Provider One' });
  });

  it('names channels, logos and viewers when Dispatcharr gives them', async () => {
    mockDispatcharr({
      '/proxy/ts/status': () =>
        jsonResponse({
          channels: [
            {
              channel_id: 'uuid-espn',
              m3u_profile_id: 11,
              started_at: 1795000000,
              clients: [
                { user_id: '7', ip_address: '192.168.1.5' },
                { user_id: '8', ip_address: '192.168.1.6' },
                { user_id: '9', ip_address: '192.168.1.7' },
              ],
            },
          ],
        }),
      '/api/accounts/users/': () =>
        jsonResponse([
          { id: 7, username: 'joe' },
          { id: 8, username: 'mom' },
          { id: 9, username: 'Anonymous' },
        ]),
      '/api/channels/channels/by-uuids/': () =>
        jsonResponse([{ uuid: 'uuid-espn', name: 'ESPN', logo_id: 42 }]),
      '/proxy/vod/stats/': () => jsonResponse({ vod_connections: [] }),
      '/proxy/stats/': () => jsonResponse({ catchup: { timeshift_sessions: [] } }),
    });
    // Anonymous streams ignored on this server: Now Playing drops them, the card still lists them
    const client = new DispatcharrClient({
      url: 'http://dispatcharr:9191',
      token: 'api-key',
      ignoreAnonymousStreams: true,
    });

    const { streams } = await client.getOverview();
    expect(streams).toEqual([
      {
        key: 'live:uuid-espn',
        kind: 'live',
        title: 'ESPN',
        logoPath: '/api/channels/logos/42/cache/',
        providerName: 'Provider One',
        startedAt: new Date(1795000000 * 1000).toISOString(),
        viewers: ['joe', 'mom', 'Anonymous'],
      },
    ]);
  });

  it('shows no guide sources when they cannot be read', async () => {
    mockDispatcharr({ '/api/epg/sources/': () => new Response('down', { status: 500 }) });
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191', token: 'api-key' });

    const overview = await client.getOverview();
    expect(overview.epgSources).toEqual([]);
    expect(overview.providers[0]?.inUse).toBe(2);
  });

  it('leaves connections in use unknown when the live streams cannot be read', async () => {
    mockDispatcharr({ '/proxy/ts/status': () => new Response('down', { status: 500 }) });
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191', token: 'api-key' });

    const overview = await client.getOverview();
    expect(overview.providers[0]?.inUse).toBeNull();
  });

  it('fails when the accounts cannot be read', async () => {
    mockDispatcharr({ '/api/m3u/accounts/': () => new Response('down', { status: 500 }) });
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191', token: 'api-key' });

    await expect(client.getOverview()).rejects.toThrow();
  });
});

describe('buildStreams', () => {
  const user = (id: string, username: string): MediaUser =>
    ({ id, username, isAdmin: false }) as MediaUser;
  const context = () => ({
    providerNames: providerNamesByProfile([
      { id: 1, name: 'Primary', profiles: [{ id: 11 }] },
      { id: 2, name: 'custom', locked: true, profiles: [{ id: 99 }] },
    ]),
    userById: new Map([['7', user('7', 'Joe')]]),
    channels: new Map([['uuid-a', { name: 'ESPN', logoPath: '/api/channels/logos/1/cache/' }]]),
  });

  it('lists everyone sharing a live channel on one row', () => {
    const [row] = buildStreams(
      [
        {
          channel_id: 'uuid-a',
          m3u_profile_id: 11,
          clients: [
            { user_id: '7', ip_address: '10.0.0.2' },
            { user_id: '7', ip_address: '10.0.0.3' },
            { user_id: '0', ip_address: '10.0.0.4' },
          ],
        },
      ],
      undefined,
      undefined,
      context()
    );
    // Anonymous shows here even though the server ignores Anonymous streams in Now Playing
    expect(row).toMatchObject({
      title: 'ESPN',
      providerName: 'Primary',
      viewers: ['Joe', 'Anonymous'],
    });
  });

  it('shows a client without a user as Anonymous and an unlisted user by address', () => {
    const [row] = buildStreams(
      [
        {
          channel_id: 'uuid-b',
          channel_name: 'CMT',
          m3u_profile_id: 99,
          clients: [
            { user_id: '0', ip_address: '10.0.0.4' },
            { user_id: '55', ip_address: '10.0.0.9' },
          ],
        },
      ],
      undefined,
      undefined,
      context()
    );
    expect(row).toMatchObject({
      title: 'CMT',
      providerName: null,
      logoPath: null,
      viewers: ['Anonymous', '10.0.0.9'],
    });
  });

  it('puts the busiest live channel first, then VOD per viewer, then catch-up', () => {
    const rows = buildStreams(
      [
        { channel_id: 'one', channel_name: 'One', clients: [{ user_id: '7' }] },
        {
          channel_id: 'two',
          channel_name: 'Two',
          clients: [{ user_id: '7' }, { user_id: '8', ip_address: 'x' }],
        },
      ],
      {
        vod_connections: [
          {
            content_name: 'A Movie',
            connections: [{ client_id: 'vod_1', user_id: '7', m3u_profile_id: 11 }],
          },
        ],
      },
      {
        timeshift_sessions: [
          {
            session_id: 's1',
            channel_name: 'News',
            logo_id: 3,
            connections: [{ user_id: '9', username: 'dad', m3u_profile_id: 11, connected_at: 100 }],
          },
        ],
      },
      context()
    );
    expect(rows.map((row) => row.key)).toEqual(['live:two', 'live:one', 'vod:vod_1', 'catchup:s1']);
    expect(rows[2]).toMatchObject({ kind: 'vod', title: 'A Movie', providerName: 'Primary' });
    expect(rows[3]).toMatchObject({
      kind: 'catchup',
      title: 'News',
      logoPath: '/api/channels/logos/3/cache/',
      viewers: ['dad'],
      startedAt: new Date(100_000).toISOString(),
    });
  });

  it('names an Anonymous client Channels DVR when its user agent says so', () => {
    const [row] = buildStreams(
      [
        {
          channel_id: 'uuid-a',
          clients: [
            { user_id: '0', user_agent: 'channels-dvr/2026.11.11.2228' },
            { user_id: '0', user_agent: 'VLC/3.0.20' },
          ],
        },
      ],
      undefined,
      undefined,
      { ...context(), userById: new Map([['9', user('9', 'Anonymous')]]) }
    );
    expect(row?.viewers).toEqual(['Channels DVR', 'Anonymous']);

    const [named] = buildStreams(
      [{ channel_id: 'uuid-a', clients: [{ user_id: '9', user_agent: 'Channels DVR' }] }],
      undefined,
      undefined,
      { ...context(), userById: new Map([['9', user('9', 'Anonymous')]]) }
    );
    expect(named?.viewers).toEqual(['Channels DVR']);
  });

  it("names an Anonymous client Dispatcharr DVR when it's Dispatcharr recording", () => {
    const [row] = buildStreams(
      [{ channel_id: 'uuid-a', clients: [{ user_id: '0', user_agent: 'Dispatcharr-DVR' }] }],
      undefined,
      undefined,
      context()
    );
    expect(row?.viewers).toEqual(['Dispatcharr DVR']);
  });

  it('keeps a real user named whatever their user agent', () => {
    const [row] = buildStreams(
      [{ channel_id: 'uuid-a', clients: [{ user_id: '7', user_agent: 'channels-dvr/2026' }] }],
      undefined,
      undefined,
      context()
    );
    expect(row?.viewers).toEqual(['Joe']);
  });

  it('only builds logo paths from numeric ids', () => {
    expect(dispatcharrLogoPath(12)).toBe('/api/channels/logos/12/cache/');
    expect(dispatcharrLogoPath('../x')).toBeNull();
  });
});

// Shapes from Dispatcharr 0.34.1's RecordingSerializer (fields "__all__", channel as its id).
describe('Dispatcharr DVR recordings', () => {
  const NOW = Date.parse('2026-11-23T18:00:00Z');
  const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
  const recording = (id: number, start: number, end: number, cp: Record<string, unknown> = {}) => ({
    id,
    channel: 7,
    start_time: at(start),
    end_time: at(end),
    custom_properties: cp,
  });

  it('splits in progress from the next 24 hours and drops what is over', () => {
    const { recording: now, upcoming } = splitRecordings(
      [
        recording(1, -30, 60, {
          status: 'recording',
          program: {
            title: 'Monday Night Football',
            sub_title: 'Week 12',
            season: 2026,
            episode: 12,
          },
        }),
        recording(2, -5, 30, { program: { title: 'No status yet' } }),
        recording(3, 120, 180, { status: 'scheduled', program: { title: 'The Simpsons' } }),
        recording(4, 60 * 30, 60 * 31, { program: { title: 'Too far out' } }),
        recording(5, -120, -60, { status: 'completed' }),
        recording(6, -10, 50, { status: 'stopped' }),
        recording(7, -10, 50, { status: 'interrupted' }),
      ],
      NOW
    );
    expect(now.map((r) => r.entry.id)).toEqual([2, 1]);
    expect(now[1]?.entry).toMatchObject({
      title: 'Monday Night Football',
      episodeTitle: 'Week 12',
      seasonNumber: 2026,
      episodeNumber: 12,
    });
    expect(upcoming.map((r) => r.entry.id)).toEqual([3]);
    expect(upcoming[0]?.channelId).toBe(7);
  });

  it("reads a channel's overridden name, number and logo", () => {
    expect(
      parseRecordingChannel({
        name: 'ESPN HD',
        effective_name: 'ESPN',
        channel_number: 206,
        effective_channel_number: 6.1,
        logo_id: 3,
        effective_logo_id: 9,
      })
    ).toEqual({ name: 'ESPN', number: '6.1', logoPath: '/api/channels/logos/9/cache/' });
  });

  it("titles a manual recording with its channel's name", () => {
    const [pending] = splitRecordings([recording(8, 30, 90)], NOW).upcoming;
    if (!pending) throw new Error('expected one upcoming recording');
    expect(withChannel(pending, { name: 'CMT', number: '49', logoPath: null })).toMatchObject({
      title: 'CMT',
      channelName: 'CMT',
      channelNumber: '49',
    });
  });

  it("shows the programme art Dispatcharr picked, else the channel's logo", () => {
    const channel = { name: 'KOCO', number: '5', logoPath: '/api/channels/logos/2/cache/' };
    const { upcoming } = splitRecordings(
      [
        recording(9, 30, 90, { program: { title: 'Jeopardy!' }, poster_logo_id: 41 }),
        recording(10, 40, 90, { program: { title: 'Wheel of Fortune' } }),
      ],
      NOW
    );
    expect(upcoming.map((pending) => withChannel(pending, channel).logoPath)).toEqual([
      '/api/channels/logos/41/cache/',
      '/api/channels/logos/2/cache/',
    ]);
    expect(upcoming[0] && withChannel(upcoming[0], undefined).logoPath).toBe(
      '/api/channels/logos/41/cache/'
    );
  });

  it('comes with the overview, channel included', async () => {
    const realNow = Date.now();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/m3u/accounts/')) return jsonResponse([]);
      if (url.endsWith('/api/channels/recordings/')) {
        return jsonResponse([
          {
            id: 1,
            channel: 7,
            start_time: new Date(realNow - 60_000).toISOString(),
            end_time: new Date(realNow + 3_600_000).toISOString(),
            custom_properties: { status: 'recording', program: { title: 'News' } },
          },
        ]);
      }
      if (url.endsWith('/api/channels/channels/7/')) {
        return jsonResponse({
          effective_name: 'KOCO',
          effective_channel_number: 5,
          effective_logo_id: 2,
        });
      }
      return new Response('not found', { status: 404 });
    });
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191', token: 'api-key' });

    const overview = await client.getOverview();
    expect(overview.recordings).toEqual([
      expect.objectContaining({
        id: 1,
        title: 'News',
        channelName: 'KOCO',
        channelNumber: '5',
        logoPath: '/api/channels/logos/2/cache/',
      }),
    ]);
    expect(overview.upcoming).toEqual([]);
  });

  it('stops with POST .../stop/ and cancels with DELETE', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ success: true }));
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191', token: 'api-key' });

    await client.stopRecording(4);
    await client.cancelRecording(5);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://dispatcharr:9191/api/channels/recordings/4/stop/'
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'http://dispatcharr:9191/api/channels/recordings/5/'
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('says so when the recording has already finished', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 409 }));
    const client = new DispatcharrClient({ url: 'http://dispatcharr:9191', token: 'api-key' });
    await expect(client.stopRecording(4)).rejects.toThrow('already finished');
  });
});
