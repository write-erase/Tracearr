import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaSession } from '../types.js';
import {
  DEVICE_RETRY_AFTER_MS,
  parseDeviceStatus,
  readDeviceStatuses,
  resetDeviceStatus,
} from '../channelsDvr/deviceStatus.js';
import { applyPauseState, resetPauseState } from '../channelsDvr/playbackState.js';

const MASH_STATUS = {
  status: 'playing',
  playback_time: 152.235,
  now_playing: {
    title: 'M*A*S*H',
    season_number: 1,
    episode_number: 1,
    episode_title: 'Pilot',
    duration: 1538.932,
    type: 'tv',
  },
};

const session = (overrides: Record<string, unknown> = {}) =>
  ({
    sessionKey: '6-file-1089-192.168.30.8',
    media: { type: 'episode', title: 'Pilot', durationMs: 1_538_932 },
    episode: { showTitle: 'M*A*S*H', seasonNumber: 1, episodeNumber: 1 },
    network: { ipAddress: '192.168.30.8', isLocal: true },
    playback: { state: 'playing', positionMs: 140_000, progressPercent: 0 },
    ...overrides,
  }) as unknown as MediaSession;

const ok = (body: unknown) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);

describe('Channels device status', () => {
  beforeEach(() => {
    resetDeviceStatus();
    resetPauseState();
  });

  it('reads play state and exact position for a matching episode', () => {
    expect(parseDeviceStatus(MASH_STATUS, session())).toEqual({
      state: 'playing',
      positionMs: 152_235,
    });
    expect(parseDeviceStatus({ ...MASH_STATUS, status: 'paused' }, session())?.state).toBe(
      'paused'
    );
  });

  it('ignores the device when it is playing something else', () => {
    const other = {
      ...MASH_STATUS,
      now_playing: { ...MASH_STATUS.now_playing, episode_number: 2 },
    };
    expect(parseDeviceStatus(other, session())).toBeNull();
    const otherShow = {
      ...MASH_STATUS,
      now_playing: { ...MASH_STATUS.now_playing, title: 'Taxi' },
    };
    expect(parseDeviceStatus(otherShow, session())).toBeNull();
  });

  it('ignores idle or malformed statuses', () => {
    expect(parseDeviceStatus({ ...MASH_STATUS, status: 'stopped' }, session())).toBeNull();
    expect(parseDeviceStatus({ status: 'playing' }, session())).toBeNull();
    expect(parseDeviceStatus(null, session())).toBeNull();
  });

  it('matches movies by title', () => {
    const movie = session({
      media: { type: 'movie', title: 'Some Movie', durationMs: 0 },
      episode: undefined,
    });
    const body = {
      status: 'paused',
      playback_time: 10,
      now_playing: { title: 'Some Movie', type: 'movie' },
    };
    expect(parseDeviceStatus(body, movie)).toEqual({ state: 'paused', positionMs: 10_000 });
  });

  it('only asks local recording sessions', async () => {
    const fetchImpl = ok(MASH_STATUS);
    await readDeviceStatuses(
      [
        session({ network: { ipAddress: '8.8.8.8', isLocal: false } }),
        session({ media: { type: 'live', title: 'ch2', durationMs: 0 } }),
      ],
      { fetchImpl }
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips an unreachable device until the retry window passes', async () => {
    const failing = vi.fn(async () => {
      throw new Error('timeout');
    });
    expect((await readDeviceStatuses([session()], { now: 0, fetchImpl: failing })).size).toBe(0);
    await readDeviceStatuses([session()], { now: 1_000, fetchImpl: failing });
    expect(failing).toHaveBeenCalledTimes(1);

    const fetchImpl = ok(MASH_STATUS);
    const statuses = await readDeviceStatuses([session()], {
      now: DEVICE_RETRY_AFTER_MS + 1,
      fetchImpl,
    });
    expect(statuses.get(session().sessionKey)?.positionMs).toBe(152_235);
  });

  it('device state overrides the server-side inference immediately', () => {
    const statuses = new Map([
      [session().sessionKey, { state: 'paused' as const, positionMs: 255_000 }],
    ]);
    const [s] = applyPauseState('http://cdvr', [session()], {
      complete: true,
      now: 0,
      deviceStatuses: statuses,
    });
    expect(s?.playback.state).toBe('paused');
    expect(s?.playback.positionMs).toBe(255_000);
    expect(s?.playback.progressPercent).toBe(17);
  });

  it('falls back to server-side inference when the device did not answer', () => {
    const [s] = applyPauseState('http://cdvr', [session()], {
      complete: true,
      now: 0,
      deviceStatuses: new Map(),
    });
    expect(s?.playback.state).toBe('playing');
    expect(s?.playback.positionMs).toBe(140_000);
  });
});
