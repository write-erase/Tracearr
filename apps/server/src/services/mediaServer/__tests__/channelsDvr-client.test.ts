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
});
