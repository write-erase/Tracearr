import { describe, expect, it } from 'vitest';
import { runChannelsDvrCheck } from '../channelsDvr/check.js';

const NOW_SEC = Math.floor(Date.now() / 1000);

/** Trimmed answers from a real server. */
const ANSWERS: Record<string, unknown> = {
  '/status': { version: '2026.11.11.2228' },
  '/dvr': {
    activity: {
      '0-job-1794423600-ch2': 'Recording ch2 for Beyond the Gates until 2:00PM: buf=0% drop=0%',
      '1-stream-M3U-Dispatcharr-4-10.10.0.20': 'Watching ch4 NBC from Living Room',
    },
    disk: { free: 200396926976, total: 315923169280 },
  },
  '/dvr/jobs': [
    { ID: 'a', Name: 'Upcoming', Time: NOW_SEC + 3600, Duration: 1800 },
    { ID: 'b', Name: 'Skipped', Time: NOW_SEC + 3600, Duration: 1800, Skipped: true },
    { ID: 'c', Name: 'Over', Time: NOW_SEC - 7200, Duration: 1800 },
  ],
  '/devices': [
    {
      DeviceID: 'M3U-Dispatcharr',
      FriendlyName: 'Dispatcharr',
      Channels: [
        { GuideNumber: '2', GuideName: 'FOX' },
        { GuideNumber: '4', GuideName: 'NBC' },
      ],
    },
    { DeviceID: 'VIRTUAL', FriendlyName: 'Virtual Channels', Channels: [{ GuideNumber: '6000' }] },
  ],
};

const serve =
  (overrides: Record<string, unknown> = {}) =>
  async (path: string): Promise<unknown> => {
    const answer = path in overrides ? overrides[path] : ANSWERS[path];
    if (answer instanceof Error) throw answer;
    return answer;
  };

describe('runChannelsDvrCheck', () => {
  it('reports what each endpoint returned', async () => {
    const check = await runChannelsDvrCheck(serve());
    expect(check.server).toEqual({ ok: true, version: '2026.11.11.2228' });
    expect(check.activity).toEqual({ ok: true, recording: 1 });
    expect(check.disk).toMatchObject({ ok: true, totalBytes: 315923169280 });
    // Skipped and finished jobs aren't scheduled recordings.
    expect(check.jobs).toEqual({ ok: true, scheduled: 1 });
    // Virtual Channels are left out, as the lineup alert does.
    expect(check.lineup).toEqual({ ok: true, sources: 1, channels: 2 });
  });

  it('keeps going when one endpoint fails, and says why', async () => {
    const check = await runChannelsDvrCheck(
      serve({ '/devices': new Error('connect ECONNREFUSED 10.10.0.2:8089') })
    );
    expect(check.lineup).toEqual({ ok: false, error: 'connect ECONNREFUSED 10.10.0.2:8089' });
    expect(check.server.ok).toBe(true);
    expect(check.jobs.ok).toBe(true);
  });

  it('fails both /dvr steps when /dvr fails', async () => {
    const check = await runChannelsDvrCheck(serve({ '/dvr': new Error('timed out') }));
    expect(check.activity).toEqual({ ok: false, error: 'timed out' });
    expect(check.disk).toEqual({ ok: false, error: 'timed out' });
  });

  it("says when an answer doesn't look like Channels DVR", async () => {
    const check = await runChannelsDvrCheck(
      serve({ '/status': '<html>', '/dvr': {}, '/dvr/jobs': {}, '/devices': null })
    );
    expect(check.server.ok).toBe(false);
    expect(check.activity.ok).toBe(false);
    expect(check.disk.ok).toBe(false);
    expect(check.jobs.ok).toBe(false);
    expect(check.lineup.ok).toBe(false);
  });
});
