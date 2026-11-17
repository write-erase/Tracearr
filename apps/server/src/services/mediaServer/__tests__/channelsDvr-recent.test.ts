import { describe, expect, it } from 'vitest';
import { recentRecordings } from '../channelsDvr/recent.js';

// A real GET /dvr/files recording (a 3-minute manual recording, started 10 minutes into the airing)
const RECORDING = {
  ID: '1353',
  JobID: '1794874205-ch1',
  GroupID: 'KOCO 5 News at 6pm',
  Path: 'TV/KOCO 5 News at 6pm/KOCO 5 News at 6pm S2026E1116 2026-11-16-1810.mpg',
  CreatedAt: 1794874205,
  FileSize: 117440512,
  Duration: 181.528678,
  Delayed: true,
  Cancelled: true,
  Completed: true,
  Processed: true,
  ChannelNumber: '1',
  DeviceID: 'M3U-DispatcharrMPEGTS',
  JobTime: 1794873600,
  JobDuration: 1800,
  Airing: {
    Title: 'KOCO 5 News at 6pm',
    Channel: '1',
    SeasonNumber: 2026,
    EpisodeNumber: 1116,
    Image: 'https://tmsimg.fancybits.co/assets/p123_b_h9_aa.jpg',
  },
};

// A real imported file: no JobID, an ImportPath
const IMPORT = {
  ID: '585',
  GroupID: '184164',
  CreatedAt: 1794874000,
  Duration: 1538.7,
  Completed: true,
  ImportPath: '/media/TV/The Addams Family (1964) {imdb-tt0057729}',
};

const NOW = 1794874205 + 600;
const DAY = 24 * 60 * 60;

describe('recentRecordings', () => {
  it('reads a finished recording and how it went', () => {
    expect(recentRecordings([RECORDING], NOW, DAY)).toEqual([
      {
        fileId: '1353',
        jobId: '1794874205-ch1',
        showId: 'KOCO 5 News at 6pm',
        title: 'KOCO 5 News at 6pm',
        episodeTitle: null,
        // Date-numbered (S2026 E1116): left out
        seasonNumber: null,
        episodeNumber: null,
        channelNumber: '1',
        startedSec: 1794874205,
        endedSec: 1794874205 + 181.528678,
        durationSec: 181.528678,
        scheduledSec: 1800,
        image: 'https://tmsimg.fancybits.co/assets/p123_b_h9_aa.jpg',
        issues: ['stoppedEarly', 'startedLate'],
      },
    ]);
  });

  it('puts an interrupted recording first among its issues, and keeps real episode numbers', () => {
    const [file] = recentRecordings(
      [
        {
          ...RECORDING,
          Corrupted: true,
          Delayed: false,
          Airing: { Title: 'Heroes', SeasonNumber: 2, EpisodeNumber: 5, EpisodeTitle: 'Lizards' },
        },
      ],
      NOW,
      DAY
    );
    expect(file?.issues).toEqual(['interrupted', 'stoppedEarly']);
    expect([file?.seasonNumber, file?.episodeNumber, file?.episodeTitle]).toEqual([
      2,
      5,
      'Lizards',
    ]);
  });

  it('has no issues for a clean recording', () => {
    const [file] = recentRecordings(
      [{ ...RECORDING, Delayed: false, Cancelled: false, Duration: 1800 }],
      NOW + 1800,
      DAY
    );
    expect(file?.issues).toEqual([]);
  });

  it('leaves out imports, recordings still running, deleted files and old ones', () => {
    expect(
      recentRecordings(
        [
          IMPORT,
          { ...RECORDING, ID: 'running', Completed: false },
          { ...RECORDING, ID: 'deleted', Deleted: true },
          { ...RECORDING, ID: 'old', CreatedAt: NOW - 2 * DAY },
        ],
        NOW,
        DAY
      )
    ).toEqual([]);
  });

  it('lists the newest finish first', () => {
    const files = recentRecordings(
      [
        { ...RECORDING, ID: 'early', CreatedAt: NOW - 7200 },
        { ...RECORDING, ID: 'late', CreatedAt: NOW - 600 },
      ],
      NOW,
      DAY
    );
    expect(files.map((f) => f.fileId)).toEqual(['late', 'early']);
  });

  it('falls back to the group name for the title, and accepts numeric ids', () => {
    const [file] = recentRecordings([{ ...RECORDING, ID: 1353, Airing: undefined }], NOW, DAY);
    expect(file?.fileId).toBe('1353');
    expect(file?.title).toBe('KOCO 5 News at 6pm');
  });

  it('reads nothing from a response that is not a list', () => {
    expect(recentRecordings({ error: 'x' }, NOW, DAY)).toEqual([]);
  });
});
