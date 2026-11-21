import { describe, expect, it } from 'vitest';
import {
  countTunersInUse,
  findTunerConflicts,
  parseDisk,
  parseDvrJobStatuses,
  parseJobs,
  parseTunerSources,
  parseTunerTotal,
  tidyDvrError,
  upcomingJobs,
  type ChannelsDvrJob,
  type TunerSource,
} from '../channelsDvr/jobs.js';

// From GET /api/v1/jobs
const JOB = {
  id: '1794427200-ch1',
  name: 'The Jennifer Hudson Show',
  start_time: 1794427200,
  end_time: 1794430800,
  duration: 3600,
  channels: ['1'],
  skipped: false,
  failed: false,
  item: {
    show_id: 'The Jennifer Hudson Show',
    title: 'The Jennifer Hudson Show',
    season_number: 5,
    episode_number: 43,
    image_url: 'https://ebyl.tmsimg.com/assets/p33904385_b_h9_aa.jpg',
    cancelled: false,
  },
};

describe('parseJobs', () => {
  it('reads a queued job', () => {
    expect(parseJobs([JOB])).toEqual([
      {
        id: '1794427200-ch1',
        title: 'The Jennifer Hudson Show',
        showId: 'The Jennifer Hudson Show',
        episodeTitle: null,
        seasonNumber: 5,
        episodeNumber: 43,
        startSec: 1794427200,
        endSec: 1794430800,
        channels: ['1'],
        skipped: false,
        failed: false,
        image: 'https://ebyl.tmsimg.com/assets/p33904385_b_h9_aa.jpg',
      },
    ]);
  });

  it('falls back to start + duration and to the job name', () => {
    const [job] = parseJobs([{ id: 'x', name: 'Movie', start_time: 100, duration: 50 }]);
    expect(job).toMatchObject({ title: 'Movie', startSec: 100, endSec: 150 });
  });

  it('treats a cancelled item as skipped and drops unusable entries', () => {
    expect(parseJobs([{ ...JOB, item: { ...JOB.item, cancelled: true } }])[0]?.skipped).toBe(true);
    expect(parseJobs([{ name: 'no id', start_time: 1, end_time: 2 }, null, 'x'])).toEqual([]);
    expect(parseJobs({ not: 'an array' })).toEqual([]);
  });
});

describe('upcomingJobs', () => {
  const jobs = parseJobs([
    { id: 'later', start_time: 5000, end_time: 6000 },
    { id: 'running', start_time: 900, end_time: 2000 },
    { id: 'soon', start_time: 1500, end_time: 2500 },
    { id: 'skipped', start_time: 1200, end_time: 1300, skipped: true },
    { id: 'too-far', start_time: 99999, end_time: 100000 },
  ]);

  it('lists jobs not yet started within the window, soonest first, skipped ones included', () => {
    expect(upcomingJobs(jobs, 1000, 10_000, 10).map((j) => j.id)).toEqual([
      'skipped',
      'soon',
      'later',
    ]);
    expect(upcomingJobs(jobs, 1000, 10_000, 10)[0]?.skipped).toBe(true);
    expect(upcomingJobs(jobs, 1000, 10_000, 1).map((j) => j.id)).toEqual(['skipped']);
  });
});

describe('parseDisk', () => {
  it('reads free and total space from GET /dvr', () => {
    expect(
      parseDisk({ disk: { free: 200396926976, total: 315923169280, used: 99403497472 } })
    ).toEqual({ freeBytes: 200396926976, totalBytes: 315923169280 });
  });

  it('is null when Channels reports no disk', () => {
    expect(parseDisk({ activity: {} })).toBeNull();
    expect(parseDisk({ disk: { free: 1, total: 0 } })).toBeNull();
    expect(parseDisk(null)).toBeNull();
  });
});

describe('parseTunerTotal', () => {
  it('adds up tuner counts across sources', () => {
    expect(
      parseTunerTotal([
        { DeviceID: 'M3U-DispatcharrMPEGTS', TunerCount: 5 },
        { DeviceID: '1076C3A7', TunerCount: 4 },
      ])
    ).toBe(9);
  });

  it('is null when no source reports a count', () => {
    expect(parseTunerTotal([{ DeviceID: 'x' }])).toBeNull();
    expect(parseTunerTotal(null)).toBeNull();
  });
});

describe('countTunersInUse', () => {
  it('counts one tuner per channel, shared between viewers and recordings', () => {
    const entries = [
      { key: '6-stream-M3U-DispatcharrMPEGTS-1-192.168.30.9', text: 'Watching ch1 …' },
      { key: '6-stream-M3U-DispatcharrMPEGTS-1-192.168.30.8', text: 'Watching ch1 …' },
      { key: '6-stream-M3U-DispatcharrMPEGTS-23-192.168.30.8', text: 'Watching ch23 …' },
      { key: '3-ch5.1-dANY-a1b2c3', text: 'Watching ch5.1 …' },
      { key: '7-ch1009-dM3U-Alabama-ip172.17.0.1', text: 'Watching ch1009 …' },
      { key: '6-file-1089-192.168.30.8', text: 'Watching M*A*S*H …' },
      { key: '0-job-1794391200-ch23', text: 'Recording ch23 …' },
    ];
    expect(countTunersInUse(entries, ['23', '4'])).toBe(5); // 1, 23, 5.1, 1009, 4
  });

  it('is zero when nothing is live or recording', () => {
    expect(countTunersInUse([{ key: '6-file-1089-192.168.30.8', text: '' }], [])).toBe(0);
  });
});

describe('parseDvrJobStatuses', () => {
  it('reads a failed job from GET /dvr/jobs', () => {
    const [job] = parseDvrJobStatuses([
      {
        ID: '1794424758-ch2',
        Name: 'Beyond the Gates',
        Channels: ['2'],
        Channel: '',
        Failed: true,
        Error: 'could not start stream on channels=[2]: connect: connection refused',
        FileID: '1346',
        Time: 1794423600,
        Duration: 3600,
        Airing: { Title: 'Beyond the Gates', Channel: '2' },
      },
    ]);
    expect(job).toEqual({
      id: '1794424758-ch2',
      title: 'Beyond the Gates',
      channel: '2',
      failed: true,
      error: 'could not start stream on channels=[2]: connect: connection refused',
      fileId: '1346',
      startsAt: 1794423600 * 1000,
      endsAt: (1794423600 + 3600) * 1000,
      skipped: false,
      ruleId: null,
    });
  });

  it('reads the series pass that scheduled a job', () => {
    const [pass, oneTime] = parseDvrJobStatuses([
      { ID: '1794510000-1', Name: 'General Hospital', RuleID: '1', Skipped: true },
      { ID: '1794424758-ch2', Name: 'Beyond the Gates', RuleID: '' },
    ]);
    expect(pass?.ruleId).toBe('1');
    expect(pass?.skipped).toBe(true);
    expect(oneTime?.ruleId).toBeNull();
    expect(oneTime?.skipped).toBe(false);
  });
});

describe('tidyDvrError', () => {
  it('keeps the useful last clause and drops the stream URL', () => {
    expect(
      tidyDvrError(
        'could not start stream on channels=[2]: M3U: Get "http://192.168.30.241:9191/proxy/ts/stream/b39c?output_profile=4": dial tcp 192.168.30.241:9191: connect: connection refused'
      )
    ).toBe("couldn't start the stream (connection refused)");
    expect(tidyDvrError('disk full')).toBe('disk full');
    expect(tidyDvrError(null)).toBeNull();
  });
});

describe('parseTunerSources', () => {
  // Shaped like a real GET /devices: an M3U source with a tuner limit, and Virtual Channels
  const DEVICES = [
    {
      DeviceID: 'M3U-DispatcharrMPEGTS',
      FriendlyName: 'Dispatcharr MPEG-TS',
      Provider: 'm3u',
      TunerCount: 5,
      Disabled: false,
      Channels: [
        { GuideNumber: '2', GuideName: 'KWTV' },
        { GuideNumber: '23', GuideName: 'Heroes' },
      ],
    },
    {
      DeviceID: 'VIRTUAL',
      FriendlyName: 'Virtual Channels',
      Provider: 'virtual',
      Channels: [{ GuideNumber: '6000', GuideName: 'Cartoons' }],
    },
  ];

  it('reads each source with a tuner count and its channels', () => {
    expect(parseTunerSources(DEVICES)).toEqual([
      {
        id: 'M3U-DispatcharrMPEGTS',
        name: 'Dispatcharr MPEG-TS',
        tuners: 5,
        channels: new Set(['2', '23']),
      },
    ]);
  });

  it('leaves out disabled sources and sources with no tuner count', () => {
    expect(
      parseTunerSources([
        { DeviceID: 'HDHR', TunerCount: 4, Disabled: true, Channels: [] },
        { DeviceID: 'TVE-Spectrum', FriendlyName: 'Spectrum', Channels: [{ GuideNumber: '100' }] },
      ])
    ).toEqual([]);
    expect(parseTunerSources(null)).toEqual([]);
  });

  it('reads numeric guide numbers', () => {
    expect(
      parseTunerSources([{ DeviceID: 'HDHR', TunerCount: 2, Channels: [{ GuideNumber: 4.1 }] }])[0]
        ?.channels
    ).toEqual(new Set(['4.1']));
  });
});

describe('findTunerConflicts', () => {
  const NOW = 1_800_000_000;
  const HOUR = 3600;
  const job = (
    id: string,
    startH: number,
    endH: number,
    channel: string,
    extra: Partial<ChannelsDvrJob> = {}
  ): ChannelsDvrJob => ({
    id,
    title: id,
    showId: null,
    episodeTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    startSec: NOW + startH * HOUR,
    endSec: NOW + endH * HOUR,
    channels: [channel],
    skipped: false,
    failed: false,
    image: null,
    ...extra,
  });
  const hdhr = (tuners: number): TunerSource => ({
    id: 'HDHR',
    name: 'HDHomeRun',
    tuners,
    channels: new Set(['2', '4', '5', '9']),
  });

  it('flags every recording overlapping when there are more than tuners', () => {
    const conflicts = findTunerConflicts(
      [job('a', 1, 3, '2'), job('b', 1.5, 2.5, '4'), job('c', 2, 4, '5')],
      [hdhr(2)],
      NOW
    );
    expect([...conflicts.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(conflicts.get('a')).toEqual({ source: 'HDHomeRun', tuners: 2, overlapping: 3 });
  });

  it('leaves alone recordings that fit, including back-to-back ones', () => {
    const conflicts = findTunerConflicts(
      [job('a', 1, 2, '2'), job('b', 2, 3, '4'), job('c', 1, 3, '5')],
      [hdhr(2)],
      NOW
    );
    expect(conflicts.size).toBe(0);
  });

  it('only flags the recordings in the overlap, not the rest of the day', () => {
    const conflicts = findTunerConflicts(
      [job('a', 1, 2, '2'), job('b', 1, 2, '4'), job('c', 1, 2, '5'), job('d', 5, 6, '9')],
      [hdhr(2)],
      NOW
    );
    expect([...conflicts.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('counts each source on its own tuners', () => {
    const m3u: TunerSource = {
      id: 'M3U',
      name: 'Dispatcharr',
      tuners: 5,
      channels: new Set(['100']),
    };
    const conflicts = findTunerConflicts(
      [job('a', 1, 2, '2'), job('b', 1, 2, '4'), job('c', 1, 2, '100')],
      [hdhr(2), m3u],
      NOW
    );
    expect(conflicts.size).toBe(0);
  });

  it('counts a recording already running against later ones', () => {
    const conflicts = findTunerConflicts(
      [job('running', -1, 2, '2'), job('next', 1, 3, '4')],
      [hdhr(1)],
      NOW
    );
    expect([...conflicts.keys()].sort()).toEqual(['next', 'running']);
  });

  it('ignores skipped and finished recordings, and channels on no counted source', () => {
    const conflicts = findTunerConflicts(
      [
        job('a', 1, 2, '2'),
        job('skipped', 1, 2, '4', { skipped: true }),
        job('over', -3, -1, '5'),
        job('tve', 1, 2, '700'),
      ],
      [hdhr(1)],
      NOW
    );
    expect(conflicts.size).toBe(0);
  });

  it('uses the first source carrying the channel', () => {
    const second: TunerSource = { id: 'B', name: 'Second', tuners: 1, channels: new Set(['2']) };
    const conflicts = findTunerConflicts(
      [job('a', 1, 2, '2'), job('b', 1, 2, '2')],
      [hdhr(2), second],
      NOW
    );
    expect(conflicts.size).toBe(0);
  });
});
