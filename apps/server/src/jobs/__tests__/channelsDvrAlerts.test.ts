import { describe, expect, it } from 'vitest';
import { diskCrossings, recordingChanges, type ServerAlertState } from '../channelsDvrAlerts.js';
import type { ChannelsDvrJobStatus } from '../../services/mediaServer/channelsDvr/jobs.js';

const fresh = (): ServerAlertState => ({
  seeded: false,
  failedJobs: new Set(),
  resumedJobs: new Set(),
  corruptedFiles: new Set(),
  diskLevels: new Map(),
});

const job = (overrides: Partial<ChannelsDvrJobStatus> = {}): ChannelsDvrJobStatus => ({
  id: '1794424758-ch2',
  title: 'Beyond the Gates',
  channel: '2',
  failed: false,
  error: null,
  fileId: '1346',
  // Beyond the Gates, 13:00–14:00 CST on Nov 11, 2026.
  endsAt: (1794423600 + 3600) * 1000,
  ruleId: null,
  ...overrides,
});

/** A check during the airing, and one after it ended. */
const DURING = 1794424000 * 1000;
const AFTER = (1794423600 + 3600 + 60) * 1000;

describe('recordingChanges', () => {
  it('learns the current state silently on the first check', () => {
    const state = fresh();
    const changes = recordingChanges(state, {
      jobs: [job({ failed: true })],
      recordingJobIds: [],
      corruptedFileIds: ['1346'],
    });
    expect(changes).toEqual({ failed: [], resumed: [], glitched: [] });
    expect(state.failedJobs.has('1794424758-ch2')).toBe(true);
  });

  // The sequence from the live test: playing, Dispatcharr stream stopped (gap),
  // container stopped (failed), Dispatcharr back (Channels retried and resumed).
  it('reports a glitch, then a failure, then the resume', () => {
    const state = fresh();
    recordingChanges(state, {
      jobs: [job()],
      recordingJobIds: ['1794424758-ch2'],
      corruptedFileIds: [],
    });

    const gap = recordingChanges(state, {
      jobs: [job()],
      recordingJobIds: ['1794424758-ch2'],
      corruptedFileIds: ['1346'],
    });
    expect(gap.glitched.map((j) => j.id)).toEqual(['1794424758-ch2']);

    const failed = recordingChanges(state, {
      jobs: [job({ failed: true, error: 'connection refused' })],
      recordingJobIds: [],
      corruptedFileIds: [],
    });
    expect(failed.failed.map((j) => j.id)).toEqual(['1794424758-ch2']);
    expect(failed.glitched).toEqual([]);

    const stillFailed = recordingChanges(state, {
      jobs: [job({ failed: true })],
      recordingJobIds: [],
      corruptedFileIds: [],
    });
    expect(stillFailed).toEqual({ failed: [], resumed: [], glitched: [] });

    // Channels keeps Failed on after it retries; recording again is what says it resumed.
    const resumed = recordingChanges(state, {
      jobs: [job({ failed: true })],
      recordingJobIds: ['1794424758-ch2'],
      corruptedFileIds: ['1346'],
    });
    expect(resumed.resumed.map((j) => j.id)).toEqual(['1794424758-ch2']);
    // The file was already marked corrupted earlier: no second glitch for it.
    expect(resumed.glitched).toEqual([]);

    // Still recording with the old flag on: not a new failure, not a second resume.
    const stillRecording = recordingChanges(
      state,
      { jobs: [job({ failed: true })], recordingJobIds: ['1794424758-ch2'], corruptedFileIds: [] },
      DURING
    );
    expect(stillRecording).toEqual({ failed: [], resumed: [], glitched: [] });
  });

  it('also counts a resume when Channels clears the flag', () => {
    const state = fresh();
    recordingChanges(state, {
      jobs: [job()],
      recordingJobIds: ['1794424758-ch2'],
      corruptedFileIds: [],
    });
    recordingChanges(state, {
      jobs: [job({ failed: true })],
      recordingJobIds: [],
      corruptedFileIds: [],
    });
    const resumed = recordingChanges(state, {
      jobs: [job()],
      recordingJobIds: ['1794424758-ch2'],
      corruptedFileIds: [],
    });
    expect(resumed.resumed.map((j) => j.id)).toEqual(['1794424758-ch2']);
  });

  it('reports a second failure when a resumed recording stops before its airing ends', () => {
    const state = fresh();
    const failedJob = job({ failed: true });
    recordingChanges(state, {
      jobs: [job()],
      recordingJobIds: ['1794424758-ch2'],
      corruptedFileIds: [],
    });
    recordingChanges(
      state,
      { jobs: [failedJob], recordingJobIds: [], corruptedFileIds: [] },
      DURING
    );
    recordingChanges(
      state,
      { jobs: [failedJob], recordingJobIds: ['1794424758-ch2'], corruptedFileIds: [] },
      DURING
    );

    const again = recordingChanges(
      state,
      { jobs: [failedJob], recordingJobIds: [], corruptedFileIds: [] },
      DURING
    );
    expect(again.failed.map((j) => j.id)).toEqual(['1794424758-ch2']);

    // And it can resume again after that.
    const back = recordingChanges(
      state,
      { jobs: [failedJob], recordingJobIds: ['1794424758-ch2'], corruptedFileIds: [] },
      DURING
    );
    expect(back.resumed.map((j) => j.id)).toEqual(['1794424758-ch2']);
  });

  it('stays quiet when a resumed recording finishes at the end of its airing', () => {
    const state = fresh();
    const failedJob = job({ failed: true });
    recordingChanges(state, {
      jobs: [job()],
      recordingJobIds: ['1794424758-ch2'],
      corruptedFileIds: [],
    });
    recordingChanges(
      state,
      { jobs: [failedJob], recordingJobIds: [], corruptedFileIds: [] },
      DURING
    );
    recordingChanges(
      state,
      { jobs: [failedJob], recordingJobIds: ['1794424758-ch2'], corruptedFileIds: [] },
      DURING
    );

    const finished = recordingChanges(
      state,
      { jobs: [failedJob], recordingJobIds: [], corruptedFileIds: [] },
      AFTER
    );
    expect(finished).toEqual({ failed: [], resumed: [], glitched: [] });
  });

  it("doesn't report a failed job that was already recording again when Tracearr started", () => {
    const state = fresh();
    const failedJob = job({ failed: true });
    recordingChanges(state, {
      jobs: [failedJob],
      recordingJobIds: ['1794424758-ch2'],
      corruptedFileIds: [],
    });
    const next = recordingChanges(
      state,
      { jobs: [failedJob], recordingJobIds: ['1794424758-ch2'], corruptedFileIds: [] },
      DURING
    );
    expect(next).toEqual({ failed: [], resumed: [], glitched: [] });
  });

  it('forgets a failed job that ended without resuming', () => {
    const state = fresh();
    recordingChanges(state, { jobs: [job()], recordingJobIds: [], corruptedFileIds: [] });
    recordingChanges(state, {
      jobs: [job({ failed: true })],
      recordingJobIds: [],
      corruptedFileIds: [],
    });
    const gone = recordingChanges(state, { jobs: [], recordingJobIds: [], corruptedFileIds: [] });
    expect(gone).toEqual({ failed: [], resumed: [], glitched: [] });
    expect(state.failedJobs.size).toBe(0);
  });
});

describe('diskCrossings', () => {
  it('fires low once when space drops below a threshold, even on the first check', () => {
    const state = fresh();
    expect(diskCrossings(state, 8, [10])).toEqual({ low: [10], ok: [] });
    expect(diskCrossings(state, 7, [10])).toEqual({ low: [], ok: [] });
  });

  it('waits for a one-point margin before space counts as OK again', () => {
    const state = fresh();
    diskCrossings(state, 9.5, [10]);
    expect(diskCrossings(state, 10.4, [10])).toEqual({ low: [], ok: [] });
    expect(diskCrossings(state, 9.9, [10])).toEqual({ low: [], ok: [] });
    expect(diskCrossings(state, 11.2, [10])).toEqual({ low: [], ok: [10] });
    expect(diskCrossings(state, 9.9, [10])).toEqual({ low: [10], ok: [] });
  });

  it('tracks each alert threshold on its own', () => {
    const state = fresh();
    expect(diskCrossings(state, 15, [10, 20])).toEqual({ low: [20], ok: [] });
    expect(diskCrossings(state, 9, [10, 20])).toEqual({ low: [10], ok: [] });
    expect(diskCrossings(state, 25, [10, 20])).toEqual({ low: [], ok: [10, 20] });
  });

  it('forgets thresholds no alert watches any more', () => {
    const state = fresh();
    diskCrossings(state, 5, [10]);
    diskCrossings(state, 5, []);
    expect(state.diskLevels.size).toBe(0);
  });
});
