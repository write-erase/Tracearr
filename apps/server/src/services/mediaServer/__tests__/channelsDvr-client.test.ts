import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/http.js', () => ({ fetchJson: vi.fn(), fetchText: vi.fn() }));
// Session tests read the DVR server only; never reach out to real playback devices.
vi.mock('../channelsDvr/deviceStatus.js', () => ({
  readDeviceStatuses: vi.fn(async () => new Map()),
}));

import { fetchJson, fetchText } from '../../../utils/http.js';
import { ChannelsDvrClient, clearChannelsDvrScheduleCaches } from '../channelsDvr/client.js';

const BASE = 'http://channels.local:8089';
const client = () => new ChannelsDvrClient({ url: BASE, token: 'none' });

describe('Channels DVR session artwork', () => {
  beforeEach(() => {
    vi.mocked(fetchJson).mockReset();
    vi.mocked(fetchText).mockReset().mockResolvedValue('');
  });

  it('returns virtual-channel sessions when guide artwork is delayed', async () => {
    let resolveGuide!: (value: unknown) => void;
    const guideRequest = new Promise((resolve) => {
      resolveGuide = resolve;
    });
    const dvrStatus = {
      activity: {
        '6-stream-M3U-MyMediaServer-123-192.168.30.9':
          'Watching ch123 My Virtual Channel from Apple TV: buf=0% drop=0%',
      },
    };

    vi.mocked(fetchJson)
      .mockResolvedValueOnce(dvrStatus as never)
      .mockResolvedValueOnce([{ hostname: 'Apple TV', local_ip: '192.168.30.9' }] as never)
      .mockImplementationOnce(() => guideRequest as never)
      .mockResolvedValueOnce(dvrStatus as never);

    const channelsClient = client();

    // This must resolve even though the guide request is still pending.
    const [firstSession] = await channelsClient.getSessions();
    expect(firstSession?.media.type).toBe('live');
    expect(firstSession?.live?.channelTitle).toBe('My Virtual Channel');
    expect(firstSession?.media.thumbPath).not.toContain('p31385280_b_h9_aa.jpg');

    resolveGuide([
      {
        Channel: { Number: '123', Name: 'My Virtual Channel' },
        Airings: [
          {
            Time: Math.floor(Date.now() / 1000) - 60,
            Duration: 3600,
            Title: 'My Media Server Program',
            Image: 'https://ebyl.tmsimg.com/assets/p31385280_b_h9_aa.jpg',
          },
        ],
      },
    ]);
    await guideRequest;

    // The next poll can use the completed guide refresh without another request.
    const [nextSession] = await channelsClient.getSessions();
    expect(nextSession?.media.thumbPath).toBe('/tmsimg/assets/p31385280_b_h9_aa.jpg');
    expect(nextSession?.media.title).toBe('My Media Server Program');
    expect(fetchJson).toHaveBeenCalledTimes(4);
  });

  it('uses registered Channels DVR client metadata for the matching playback device', async () => {
    vi.mocked(fetchJson)
      .mockResolvedValueOnce({
        activity: {
          '6-file-378-192.168.30.9':
            'Watching Home Improvement - Season 6, Episode 24 from iPad at 0s',
        },
      } as never)
      .mockResolvedValueOnce([
        {
          id: 'b7bfc53adc025d77',
          machine_id: '9F5A5EE9-EE9D-5DE7-A841-C2DF1CD42F31',
          hostname: 'iPad',
          device: 'iPad8,6',
          platform: 'iPadOS 27.2',
          app_bundle: 'com.getchannels.dvr.beta',
          app_build: '10.29.54',
          local_ip: '192.168.30.9',
          connected: true,
        },
      ] as never);

    const [session] = await client().getSessions();

    // This client is the Channels Mac app (name-based machine_id), so it's reported as a Mac
    expect(session?.player).toMatchObject({
      name: 'Mac',
      deviceId: '9F5A5EE9-EE9D-5DE7-A841-C2DF1CD42F31',
      device: 'Mac',
      platform: 'macOS 27.2',
      product: 'Channels Beta v10.29.54',
    });
    expect(session?.network.ipAddress).toBe('192.168.30.9');
  });

  it('uses DVR file airing metadata for virtual-channel episode playback', async () => {
    vi.mocked(fetchJson)
      .mockResolvedValueOnce({
        activity: {
          '6-file-378-192.168.30.9':
            'Watching Home Improvement - Season 6, Episode 24 from iPad at 0s',
        },
      } as never)
      .mockResolvedValueOnce([{ hostname: 'iPad', local_ip: '192.168.30.9' }] as never)
      .mockResolvedValueOnce({
        Duration: 1353.897,
        Airing: {
          Title: 'Home Improvement',
          EpisodeTitle: 'Taps',
          SeasonNumber: 6,
          EpisodeNumber: 24,
          Image: 'https://tmsimg.fancybits.co/assets/p7895187_b_h9_aa.jpg?w=720&h=540',
        },
      } as never);

    const [session] = await client().getSessions();

    expect(session?.media.type).toBe('episode');
    expect(session?.media.title).toBe('Taps');
    expect(session?.episode).toEqual({
      showTitle: 'Home Improvement',
      seasonNumber: 6,
      episodeNumber: 24,
    });
    expect(session?.media.durationMs).toBe(1353897);
    expect(session?.media.thumbPath).toBe('/tmsimg/assets/p7895187_b_h9_aa.jpg?w=720&h=540');
    expect(session?.player.name).toBe('iPad');
    expect(session?.user.username).toBe('iPad');
    expect(fetchJson).toHaveBeenCalledTimes(3);
  });

  describe('matching a session to a registered device', () => {
    const ONN_LIVE =
      'Watching ch1009 from onn. Full HD Streaming Device (Remux Starting: 13m15s @ 1.01x (60.53fps)): buf=0% drop=0%';

    it('names a proxied device by its own name, not another client at the same address', async () => {
      // Remote devices reaching the DVR through Tailscale Services into its Docker container all
      // arrive from the bridge gateway, so the address alone matches several clients.
      vi.mocked(fetchJson)
        .mockResolvedValueOnce({
          activity: { '7-ch1009-dM3U-Alabama-ip172.17.0.1': ONN_LIVE },
        } as never)
        .mockResolvedValueOnce([
          { id: 'iphone', hostname: 'iPhone', remote_ip: '172.17.0.1', connected: true },
          {
            id: 'onn',
            hostname: 'onn. Full HD Streaming Device',
            remote_ip: '172.17.0.1',
            connected: true,
          },
        ] as never)
        .mockResolvedValue([] as never);

      const [session] = await client().getSessions();

      expect(session?.player.name).toBe('onn. Full HD Streaming Device');
      expect(session?.player.deviceId).toBe('onn');
      expect(session?.live?.channelIdentifier).toBe('1009');
    });

    it('does not borrow a name from a shared address when the device is not registered', async () => {
      vi.mocked(fetchJson)
        .mockResolvedValueOnce({
          activity: {
            '7-ch1009-dM3U-Alabama-ip172.17.0.1':
              'Watching ch1009 from Kitchen TV (Remux Starting: 5s @ 1.0x (60fps)): buf=0% drop=0%',
          },
        } as never)
        .mockResolvedValue([
          { id: 'iphone', hostname: 'iPhone', remote_ip: '172.17.0.1', connected: true },
          { id: 'onn', hostname: 'onn. Full HD Streaming Device', remote_ip: '172.17.0.1' },
        ] as never);

      const [session] = await client().getSessions();

      expect(session?.player.name).toBe('Kitchen TV');
    });

    it('does not borrow a name from the Docker gateway even when only one device is registered there', async () => {
      vi.mocked(fetchJson)
        .mockResolvedValueOnce({
          activity: {
            '7-ch1009-dM3U-Alabama-ip172.17.0.1':
              'Watching ch1009 from Kitchen TV (Remux Starting: 5s @ 1.0x (60fps)): buf=0% drop=0%',
          },
        } as never)
        .mockResolvedValueOnce([
          { id: 'iphone', hostname: 'iPhone', remote_ip: '172.17.0.1', connected: true },
        ] as never)
        .mockResolvedValue([] as never);

      const [session] = await client().getSessions();

      expect(session?.player.name).toBe('Kitchen TV');
      expect(session?.player.deviceId).not.toBe('iphone');
    });

    it('still matches a LAN device by its own address first (host network mode)', async () => {
      vi.mocked(fetchJson)
        .mockResolvedValueOnce({
          activity: {
            '7-ch1009-dM3U-Alabama-ip192.168.30.9':
              'Watching ch1009 from Living Room (Remux Starting: 5s @ 1.0x (60fps)): buf=0% drop=0%',
          },
        } as never)
        .mockResolvedValueOnce([
          { id: 'atv', hostname: 'Apple TV', local_ip: '192.168.30.9', connected: true },
          { id: 'other', hostname: 'Living Room', local_ip: '192.168.30.50', connected: true },
        ] as never)
        .mockResolvedValue([] as never);

      const [session] = await client().getSessions();

      expect(session?.player.deviceId).toBe('atv');
    });

    it('keeps the address match when several devices share a LAN address (host mode unchanged)', async () => {
      vi.mocked(fetchJson)
        .mockResolvedValueOnce({
          activity: { '7-ch1009-dM3U-Alabama-ip192.168.30.9': ONN_LIVE },
        } as never)
        .mockResolvedValueOnce([
          { id: 'iphone', hostname: 'iPhone', local_ip: '192.168.30.9', connected: true },
          { id: 'onn', hostname: 'onn. Full HD Streaming Device', local_ip: '192.168.30.9' },
        ] as never)
        .mockResolvedValue([] as never);

      const [session] = await client().getSessions();

      // As before this change: the connected device at the address wins.
      expect(session?.player.deviceId).toBe('iphone');
    });
  });

  it('uses the parent show poster for episode playback', async () => {
    vi.mocked(fetchJson)
      .mockResolvedValueOnce({
        activity: {
          '6-file-4880-10.0.0.90':
            'Watching recording Beat Bobby Flay S26E02 The Dynamic Duo 2020-08-23-1900.mpg from 10.0.0.90.',
        },
      } as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({
        show_id: '183983',
        image_url: 'https://tmsimg.fancybits.co/assets/episode.jpg',
      } as never)
      .mockResolvedValueOnce({
        image_url: 'https://tmsimg.fancybits.co/assets/show.jpg?w=720&h=540',
      } as never);

    const [session] = await client().getSessions();

    expect(session?.media.thumbPath).toBe('/tmsimg/assets/show.jpg?w=720&h=540');
    expect(fetchJson).toHaveBeenCalledTimes(5);
  });

  it('uses movie poster art instead of the preview frame', async () => {
    vi.mocked(fetchJson)
      .mockResolvedValueOnce({
        activity: {
          '6-file-5157-10.0.0.90':
            'Watching recording Indiana Jones and the Last Crusade 2021-09-02-0019.mpg from 10.0.0.90.',
        },
      } as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({
        image_url: 'https://tmsimg.fancybits.co/assets/movie.jpg?w=480&h=720',
      } as never);

    const [session] = await client().getSessions();

    expect(session?.media.thumbPath).toBe('/tmsimg/assets/movie.jpg?w=480&h=720');
    expect(fetchJson).toHaveBeenCalledTimes(4);
  });

  it('uses imported video artwork when the item is not classified as a movie', async () => {
    vi.mocked(fetchJson)
      .mockResolvedValueOnce({
        activity: {
          '6-file-7777-10.0.0.90':
            'Watching recording Imported video 2022-01-01-1200.mpg from 10.0.0.90.',
        },
      } as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({
        image_url: 'https://tmsimg.fancybits.co/assets/imported-video.jpg',
      } as never);

    const [session] = await client().getSessions();

    expect(session?.media.thumbPath).toBe('/tmsimg/assets/imported-video.jpg');
    expect(fetchJson).toHaveBeenCalledTimes(5);
  });

  it('resolves cellular live sessions to the registered client and guide metadata', async () => {
    vi.mocked(fetchJson)
      .mockResolvedValueOnce({
        activity: {
          '7-ch17-dANY-1050cb66a9c4':
            "Watching ch17 from Joe's iPhone (Transcoder Running at 2mbps: 1m36s @ 1.06x (66.79fps)): buf=0% drop=0%",
        },
      } as never)
      .mockResolvedValueOnce([
        {
          id: 'ab56002786c1e0ce',
          machine_id: '1C39359C-88C7-48B0-A724-98E1DC5D1DAB',
          hostname: "Joe's iPhone",
          alias: "Joe's iPhone",
          device: 'iPhone18,2',
          platform: 'iOS 27.2',
          app_bundle: 'com.getchannels.dvr.beta',
          app_build: '10.29.54',
          local_ip: '192.168.30.5',
          remote_ip: '12.75.44.97',
          seen_from: 'remote',
          connected: true,
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          Channel: { Number: '17', Name: 'CW' },
          Airings: [
            {
              Time: Math.floor(Date.now() / 1000) - 60,
              Duration: 3600,
              Title: 'The CW Program',
              Image: 'https://tmsimg.fancybits.co/assets/cw-program.jpg',
            },
          ],
        },
      ] as never);
    vi.mocked(fetchText).mockResolvedValueOnce(
      [
        '2026/11/03 13:30:06.813360 [HLS] Starting live stream for channel 17 from 12.75.44.97',
        '2026/11/03 13:30:06.917974 [HLS] Session ch17-dANY-1050cb66a9c4 started in 104.428162ms',
        '2026/11/03 13:30:07.069823 [HLS] Probed live stream in 256.399248ms: h264 1920x1080 progressive 3812286bps',
        '2026/11/03 13:30:07.073557 [ENC] Starting encoder for ch17 in /channels-data/Streaming/sessions/ch17-dANY-1050cb66a9c4-204794225/encoder-1-94592179 at 1 (0.050000) (encoder=h264_vaapi, codec=h264, acodec=aac, resolution=720, deinterlacer=hardware, bitrate=2094, segment_size=0.01)',
      ].join('\n')
    );
    const [session] = await client().getSessions();
    expect(session?.player).toMatchObject({
      name: "Joe's iPhone",
      deviceId: '1C39359C-88C7-48B0-A724-98E1DC5D1DAB',
      device: 'iPhone18,2',
      platform: 'iOS 27.2',
      product: 'Channels Beta v10.29.54',
    });
    expect(session?.network).toEqual({ ipAddress: '12.75.44.97', isLocal: false });
    expect(session?.live?.channelTitle).toBe('CW');
    expect(session?.media.title).toBe('The CW Program');
    expect(session?.media.thumbPath).toBe('/tmsimg/assets/cw-program.jpg');
    expect(session?.quality).toMatchObject({
      isTranscode: true,
      videoDecision: 'transcode',
      sourceVideoCodec: 'h264',
      videoWidth: 1920,
      videoHeight: 1080,
      streamAudioCodec: 'aac',
    });
  });

  it('maps Channels DVR HLS probe and encoder logs to live stream details without an upstream tuner dependency', async () => {
    vi.mocked(fetchJson)
      .mockResolvedValueOnce({
        activity: {
          '6-stream-M3U-AnyTuner-1-192.168.30.9': 'Watching ch1 ABC KOCO from iPad: buf=0% drop=0%',
        },
      } as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    vi.mocked(fetchText).mockResolvedValueOnce(
      [
        '2026/11/03 12:00:38.672772 [HLS] Starting live stream for channel 1 from 192.168.30.9',
        '2026/11/03 12:00:39.936010 [HLS] Session ch1-dANY-ip192.168.30.9 started in 1.263s',
        '2026/11/03 12:00:40.096451 [HLS] Probed live stream in 1.423s: h264 1920x1080 progressive 8098867bps',
        '2026/11/03 12:00:40.097300 [ENC] Starting encoder for ch1 in /channels-data/Streaming/sessions/ch1-dANY-ip192.168.30.9-4215598824/encoder-1-2811138658 at 1 (0.466000) (encoder=remux, acodec=aac, bitrate=8098, segment_size=0.01)',
      ].join('\n')
    );

    const [session] = await client().getSessions();

    expect(session?.quality).toMatchObject({
      bitrate: 8099,
      isTranscode: false,
      videoDecision: 'copy',
      audioDecision: 'unknown',
      sourceVideoCodec: 'h264',
      videoWidth: 1920,
      videoHeight: 1080,
      sourceVideoDetails: { bitrate: 8099 },
      streamVideoCodec: 'h264',
      streamVideoDetails: { width: 1920, height: 1080, bitrate: 8098 },
      streamAudioCodec: 'aac',
    });
    expect(session?.quality.sourceAudioCodec).toBeUndefined();
    expect(fetchText).toHaveBeenCalledWith(
      `${BASE}/log?n=10000`,
      expect.objectContaining({ service: 'channels-dvr' })
    );
  });
});

describe('Channels DVR recordings and live progress', () => {
  const NOW = 1794391200 + 18 * 60; // 18 minutes into a 4:00-4:30 airing
  const guide = [
    {
      Channel: { Number: '2', Name: 'KWTV' },
      Airings: [
        {
          Time: 1794391200,
          Duration: 1800,
          Title: 'News 9 @ 4a',
          Image: 'https://tmsimg.fancybits.co/assets/p31603093_b_h9_aa.jpg',
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    vi.mocked(fetchText).mockReset().mockResolvedValue('');
    clearChannelsDvrScheduleCaches();
  });
  afterEach(() => vi.useRealTimers());

  it('lists a recording with guide times and artwork', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr'))
        return {
          activity: {
            '0-job-1794391200-ch2': 'Recording ch2 for News 9 @ 4a until 4:30AM: buf=0% drop=0%',
          },
        };
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const [recording] = await client().getRecordings();
    expect(recording).toMatchObject({
      channelNumber: '2',
      channelTitle: 'KWTV',
      title: 'News 9 @ 4a',
      startedAt: new Date(1794391200 * 1000).toISOString(),
      endsAt: new Date((1794391200 + 1800) * 1000).toISOString(),
      untilText: '4:30AM',
      thumbPath: '/tmsimg/assets/p31603093_b_h9_aa.jpg',
    });
  });

  it('ignores guide times when the guide is airing something else', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr'))
        return {
          activity: { '0-job-1794391200-ch2': 'Recording ch2 for Late Movie until 4:30AM' },
        };
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const [recording] = await client().getRecordings();
    expect(recording?.endsAt).toBeNull();
    expect(recording?.untilText).toBe('4:30AM');
    expect(recording?.thumbPath).toBe('/dvr/guide/channels/2/logo');
  });

  it("takes exact times from the recording's job, padding included", async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr'))
        return {
          activity: { '0-job-1794391200-ch2': 'Recording ch2 for Late Movie until 4:32AM' },
        };
      if (url.endsWith('/api/v1/jobs'))
        return [
          {
            id: '1794391200-ch2',
            name: 'Late Movie',
            start_time: 1794391080,
            end_time: 1794393120,
            channels: ['2'],
            item: { title: 'Late Movie' },
          },
        ];
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const [recording] = await client().getRecordings();
    expect(recording?.startedAt).toBe(new Date(1794391080 * 1000).toISOString());
    expect(recording?.endsAt).toBe(new Date(1794393120 * 1000).toISOString());
  });

  it('builds the schedule: recordings, the next day of jobs and tuner usage', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr'))
        return {
          disk: { free: 200396926976, total: 315923169280, used: 99403497472 },
          activity: {
            '0-job-1794391200-ch2': 'Recording ch2 for News 9 @ 4a until 4:30AM',
            '6-stream-M3U-DispatcharrMPEGTS-2-192.168.30.8': 'Watching ch2 KWTV from Den',
            '6-stream-M3U-DispatcharrMPEGTS-23-192.168.30.9': 'Watching ch23 Heroes from Mac',
          },
        };
      if (url.endsWith('/api/v1/jobs'))
        return [
          { id: '1794391200-ch2', start_time: 1794391200, end_time: 1794393000, channels: ['2'] },
          {
            id: '1794427200-ch1',
            name: 'The Jennifer Hudson Show',
            start_time: 1794427200,
            end_time: 1794430800,
            channels: ['1'],
            item: {
              show_id: 'The Jennifer Hudson Show',
              title: 'The Jennifer Hudson Show',
              season_number: 5,
              episode_number: 43,
              image_url: 'https://ebyl.tmsimg.com/assets/p33904385_b_h9_aa.jpg',
            },
          },
          // More than a day away: left out
          { id: '1794600000-ch4', start_time: 1794600000, end_time: 1794601800, channels: ['4'] },
        ];
      if (url.endsWith('/devices')) return [{ DeviceID: 'M3U-DispatcharrMPEGTS', TunerCount: 5 }];
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const schedule = await client().getSchedule();
    expect(schedule.recordings).toHaveLength(1);
    expect(schedule.upcoming).toEqual([
      expect.objectContaining({
        jobId: '1794427200-ch1',
        title: 'The Jennifer Hudson Show',
        showId: 'The Jennifer Hudson Show',
        seasonNumber: 5,
        episodeNumber: 43,
        channelNumber: '1',
        startsAt: new Date(1794427200 * 1000).toISOString(),
        endsAt: new Date(1794430800 * 1000).toISOString(),
      }),
    ]);
    // ch2 is recorded and watched (one shared tuner); ch23 is watched
    expect(schedule.tuners).toEqual({ inUse: 2, total: 5 });
    expect(schedule.disk).toEqual({ freeBytes: 200396926976, totalBytes: 315923169280 });
  });

  it('marks queued airings a series pass scheduled, and keeps skipped ones', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr')) return { activity: {} };
      if (url.endsWith('/api/v1/jobs'))
        return [
          {
            id: '1794510000-1',
            name: 'General Hospital',
            start_time: Date.now() / 1000 + 3600,
            end_time: Date.now() / 1000 + 7200,
            channels: ['1'],
            skipped: true,
          },
          {
            id: '1794513600-ch2',
            name: 'Late Movie',
            start_time: Date.now() / 1000 + 7200,
            end_time: Date.now() / 1000 + 9000,
            channels: ['2'],
          },
        ];
      if (url.endsWith('/dvr/jobs'))
        return [
          { ID: '1794510000-1', Name: 'General Hospital', RuleID: '1', Skipped: true },
          { ID: '1794513600-ch2', Name: 'Late Movie', RuleID: '' },
        ];
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const schedule = await client().getSchedule();
    expect(schedule.upcoming.map((u) => [u.jobId, u.fromPass, u.skipped])).toEqual([
      ['1794510000-1', true, true],
      ['1794513600-ch2', false, false],
    ]);
  });

  it('flags queued recordings that need more tuners than their source has', async () => {
    const at = (h: number) => Math.round(Date.now() / 1000 + h * 3600);
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr')) return { activity: {} };
      if (url.endsWith('/api/v1/jobs'))
        return [
          { id: 'a', name: 'A', start_time: at(1), end_time: at(2), channels: ['2'] },
          { id: 'b', name: 'B', start_time: at(1), end_time: at(2), channels: ['4'] },
          { id: 'c', name: 'C', start_time: at(5), end_time: at(6), channels: ['2'] },
        ];
      if (url.endsWith('/devices'))
        return [
          {
            DeviceID: 'HDHR',
            FriendlyName: 'HDHomeRun',
            TunerCount: 1,
            Channels: [{ GuideNumber: '2' }, { GuideNumber: '4' }],
          },
        ];
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const schedule = await client().getSchedule();
    expect(schedule.upcoming.map((u) => [u.jobId, u.conflict])).toEqual([
      ['a', { source: 'HDHomeRun', tuners: 1, overlapping: 2 }],
      ['b', { source: 'HDHomeRun', tuners: 1, overlapping: 2 }],
      ['c', null],
    ]);
  });

  it('lists recordings finished in the last day, with channel logo artwork as a fallback', async () => {
    const nowSec = Math.round(Date.now() / 1000);
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr')) return { activity: {} };
      if (url.endsWith('/dvr/files'))
        return [
          {
            ID: '1353',
            JobID: '1794874205-ch1',
            GroupID: 'KOCO 5 News at 6pm',
            CreatedAt: nowSec - 900,
            Duration: 600,
            Completed: true,
            Cancelled: true,
            ChannelNumber: '1',
            JobDuration: 1800,
            Airing: { Title: 'KOCO 5 News at 6pm' },
          },
          { ID: '585', CreatedAt: nowSec - 900, Completed: true, ImportPath: '/media/TV/x' },
        ];
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const schedule = await client().getSchedule();
    expect(schedule.recent).toEqual([
      expect.objectContaining({
        fileId: '1353',
        title: 'KOCO 5 News at 6pm',
        startedAt: new Date((nowSec - 900) * 1000).toISOString(),
        endedAt: new Date((nowSec - 300) * 1000).toISOString(),
        thumbPath: '/dvr/guide/channels/1/logo',
        issues: ['stoppedEarly'],
      }),
    ]);
  });

  it('still builds the schedule when the file list is unavailable', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr')) return { activity: {} };
      if (url.endsWith('/dvr/files')) throw new Error('timeout');
      return [];
    }) as never);

    const schedule = await client().getSchedule();
    expect(schedule.recent).toEqual([]);
  });

  it('still lists recordings when the job list and tuner count are unavailable', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr'))
        return { activity: { '0-job-1794391200-ch2': 'Recording ch2 for News 9 @ 4a' } };
      if (url.endsWith('/api/v1/jobs') || url.endsWith('/devices')) throw new Error('404');
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const schedule = await client().getSchedule();
    expect(schedule.recordings).toHaveLength(1);
    expect(schedule.upcoming).toEqual([]);
    expect(schedule.tuners).toBeNull();
    expect(schedule.disk).toBeNull();
  });

  it('returns no recordings when nothing is recording', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) =>
      url.endsWith('/dvr') ? { activity: {} } : []) as never);
    expect(await client().getRecordings()).toEqual([]);
  });

  it('lists each live channel streaming once, with every client sharing it (fork)', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/dvr'))
        return {
          activity: {
            '0-job-1794391200-ch2': 'Recording ch2 for News 9 @ 4a until 4:30AM',
            '6-stream-M3U-DispatcharrMPEGTS-2-192.168.30.8': 'Watching ch2 from Den',
            '7-ch2-dANY-26688a6db1d2':
              "Watching ch2 from Craig's Apple TV (Remux Starting: 28m54s @ 1x (60.04fps)): buf=0% drop=0%",
            '6-stream-M3U-DispatcharrMPEGTS-23-192.168.30.9': 'Watching ch23 Heroes from Mac',
          },
        };
      if (url.endsWith('/devices'))
        return [{ DeviceID: 'M3U-DispatcharrMPEGTS', FriendlyName: 'Trilo', TunerCount: 5 }];
      if (url.includes('/guide')) return guide;
      return [];
    }) as never);

    const schedule = await client().getSchedule();

    expect(schedule.streams).toEqual([
      {
        channelNumber: '2',
        // Neither line names the channel, so the guide's name
        channelTitle: 'KWTV',
        thumbPath: '/dvr/guide/channels/2/logo',
        sourceName: 'Trilo',
        // The recording on ch2 shares the stream
        recording: true,
        viewers: [
          { key: '6-stream-M3U-DispatcharrMPEGTS-2-192.168.30.8', name: 'Den' },
          { key: '7-ch2-dANY-26688a6db1d2', name: "Craig's Apple TV" },
        ],
      },
      {
        channelNumber: '23',
        channelTitle: 'Heroes',
        thumbPath: '/dvr/guide/channels/23/logo',
        sourceName: 'Trilo',
        recording: false,
        viewers: [{ key: '6-stream-M3U-DispatcharrMPEGTS-23-192.168.30.9', name: 'Mac' }],
      },
    ]);
    // One tuner each: the shared stream and ch23
    expect(schedule.tuners).toEqual({ inUse: 2, total: 5 });
  });
});

describe('ChannelsDvrClient.setRecordingSkipped', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('skips and unskips with the same requests as the web UI', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await client().setRecordingSkipped('1794510000-1', true);
    await client().setRecordingSkipped('1794510000-1', false);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      [`${BASE}/dvr/jobs/1794510000-1/skip`, 'PUT'],
      [`${BASE}/dvr/jobs/1794510000-1/unskip`, 'PUT'],
    ]);
  });

  it('rejects a bad job id and reports a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(client().setRecordingSkipped('../settings', true)).rejects.toThrow(/job id/);
    await expect(client().setRecordingSkipped('1794510000-1', true)).rejects.toThrow(/HTTP 404/);
  });
});

describe('ChannelsDvrClient.getSoftwareVersion', () => {
  it('reads the build from GET /status, which carries it (GET /dvr does not)', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) =>
      url.endsWith('/status')
        ? { version: '2026.11.11.2228', arch: 'x86_64', booted: true }
        : { activity: {} }) as never);

    await expect(client().getSoftwareVersion()).resolves.toBe('2026.11.11.2228');
    expect(fetchJson).toHaveBeenCalledWith(`${BASE}/status`, expect.anything());
  });

  it('reads as unknown when the server cannot be reached', async () => {
    vi.mocked(fetchJson).mockRejectedValue(new Error('offline'));
    await expect(client().getSoftwareVersion()).resolves.toBeNull();
  });
});
