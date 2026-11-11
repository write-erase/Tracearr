import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaSession } from '../types.js';
import { applyPauseState, PAUSE_AFTER_MS, resetPauseState } from '../channelsDvr/playbackState.js';

const URL = 'http://channels.local:8089';

const recording = (positionMs: number, sessionKey = '6-file-1089-192.168.30.8') =>
  ({
    sessionKey,
    media: { type: 'episode', durationMs: 1_538_932 },
    playback: { state: 'playing', positionMs, progressPercent: 0 },
  }) as unknown as MediaSession;

const state = (sessions: MediaSession[], now: number, complete = true) =>
  applyPauseState(URL, sessions, { complete, now })[0]?.playback.state;

describe('Channels DVR pause detection', () => {
  beforeEach(() => resetPauseState());

  it('stays playing across a normal 10 s gap between position updates', () => {
    expect(state([recording(258_000)], 0)).toBe('playing');
    expect(state([recording(258_000)], 10_000)).toBe('playing');
    expect(state([recording(268_000)], 15_000)).toBe('playing');
  });

  it('reports paused once the position has not moved for the pause window', () => {
    state([recording(255_000)], 0);
    expect(state([recording(255_000)], PAUSE_AFTER_MS - 1)).toBe('playing');
    expect(state([recording(255_000)], PAUSE_AFTER_MS)).toBe('paused');
  });

  it('goes back to playing as soon as the position moves again', () => {
    state([recording(255_000)], 0);
    expect(state([recording(255_000)], 30_000)).toBe('paused');
    expect(state([recording(265_000)], 40_000)).toBe('playing');
  });

  it('never pauses live TV', () => {
    const live = { ...recording(0), media: { type: 'live' } } as unknown as MediaSession;
    state([live], 0);
    expect(state([live], 60_000)).toBe('playing');
  });

  it('forgets sessions that ended, so a restart starts fresh', () => {
    state([recording(255_000)], 0);
    state([], 30_000);
    expect(state([recording(255_000)], 31_000)).toBe('playing');
  });

  it('keeps tracking other sessions during a single-session lookup', () => {
    state([recording(255_000)], 0);
    applyPauseState(URL, [recording(1_000, 'other')], { complete: false, now: 30_000 });
    expect(state([recording(255_000)], 30_000)).toBe('paused');
  });

  it('carries the position forward between Channels refreshes', () => {
    applyPauseState(URL, [recording(258_000)], { complete: true, now: 0 });
    const [later] = applyPauseState(URL, [recording(258_000)], { complete: true, now: 7_000 });
    expect(later?.playback.positionMs).toBe(265_000);
    expect(later?.playback.state).toBe('playing');
  });

  it('does not carry a paused position forward', () => {
    applyPauseState(URL, [recording(255_000)], { complete: true, now: 0 });
    const [paused] = applyPauseState(URL, [recording(255_000)], { complete: true, now: 30_000 });
    expect(paused?.playback.positionMs).toBe(255_000);
  });

  it('never carries the position past the end of the recording', () => {
    applyPauseState(URL, [recording(1_535_000)], { complete: true, now: 0 });
    const [end] = applyPauseState(URL, [recording(1_535_000)], { complete: true, now: 10_000 });
    expect(end?.playback.positionMs).toBe(1_538_932);
  });

  it('holds the last position, paused, when a file stream stops reporting one', () => {
    state([recording(1_500_000)], 0);
    const [ended] = applyPauseState(URL, [recording(0)], { complete: true, now: 5_000 });
    expect(ended?.playback.state).toBe('paused');
    expect(ended?.playback.positionMs).toBe(1_500_000);
    expect(ended?.playback.progressPercent).toBe(97);
  });

  it('leaves a file stream that never reported a position alone', () => {
    const [s] = applyPauseState(URL, [recording(0)], { complete: true, now: 0 });
    expect(s?.playback.state).toBe('playing');
    expect(s?.playback.positionMs).toBe(0);
  });
});
