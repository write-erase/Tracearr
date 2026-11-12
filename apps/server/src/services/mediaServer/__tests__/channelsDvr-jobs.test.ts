import { describe, expect, it } from 'vitest';
import {
  countTunersInUse,
  parseDisk,
  parseDvrJobStatuses,
  parseJobs,
  parseTunerTotal,
  tidyDvrError,
  upcomingJobs,
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

  it('lists jobs not yet started within the window, soonest first, skipping skipped ones', () => {
    expect(upcomingJobs(jobs, 1000, 10_000, 10).map((j) => j.id)).toEqual(['soon', 'later']);
    expect(upcomingJobs(jobs, 1000, 10_000, 1).map((j) => j.id)).toEqual(['soon']);
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
      { key: '6-file-1089-192.168.30.8', text: 'Watching M*A*S*H …' },
      { key: '0-job-1794391200-ch23', text: 'Recording ch23 …' },
    ];
    expect(countTunersInUse(entries, ['23', '4'])).toBe(4); // 1, 23, 5.1, 4
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
      endsAt: (1794423600 + 3600) * 1000,
    });
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
