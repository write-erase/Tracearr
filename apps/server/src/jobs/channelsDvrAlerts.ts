/**
 * Channels DVR alerts: once a minute on the leader, read each Channels DVR server's jobs,
 * recordings in progress and disk space, and turn changes into automation triggers.
 *
 * - dvr.recording_failed: a job's `Failed` flag turns on (Channels gave up on the stream).
 * - dvr.recording_resumed: a failed job is recording again (Channels retries on its own).
 * - dvr.recording_glitch: a recording in progress is marked corrupted (the stream dropped
 *   and Channels reconnected, leaving a gap).
 * - dvr.disk_low / dvr.disk_ok: free space crosses an enabled alert's threshold, with a
 *   one-point margin before it counts as OK again.
 *
 * State lives in memory. Recording state is learned silently on the first check after a
 * start, so a restart doesn't repeat old failures; disk thresholds start "OK", so an alert
 * created while space is already low fires on its first check.
 */

import type { ServerType } from '@tracearr/shared';
import {
  dispatchDvrDisk,
  dispatchDvrRecording,
  dvrDiskThresholds,
} from '../services/automations/events/producers.js';
import type { EvaluationServer } from '../services/automations/events/types.js';
import { liveServers } from '../services/liveServers.js';
import { ChannelsDvrClient } from '../services/mediaServer/channelsDvr/client.js';
import {
  diskFreePercent,
  tidyDvrError,
  type ChannelsDvrJobStatus,
} from '../services/mediaServer/channelsDvr/jobs.js';
import { createLogger } from '../utils/logger.js';
import { startPeriodic, type PeriodicTimers } from '../utils/periodic.js';

const logger = createLogger('ChannelsDvrAlerts');

const CHECK_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 20_000;
/** Space must climb this many points above a threshold before it counts as OK again. */
const DISK_RECOVERY_MARGIN = 1;

type DiskLevel = 'low' | 'ok';

export interface ServerAlertState {
  seeded: boolean;
  /** Jobs we've reported as failed and not yet seen finish */
  failedJobs: Set<string>;
  /**
   * Failed jobs we've since seen recording again. Channels keeps a job's Failed flag on after it
   * retries, so the flag can't say a job recovered or failed a second time; recording can.
   */
  resumedJobs: Set<string>;
  corruptedFiles: Set<string>;
  diskLevels: Map<number, DiskLevel>;
}

const states = new Map<string, ServerAlertState>();
let timers: PeriodicTimers | null = null;

export function _resetChannelsDvrAlertStateForTests(): void {
  states.clear();
}

function stateFor(serverId: string): ServerAlertState {
  return states.getOrInsertComputed(serverId, () => ({
    seeded: false,
    failedJobs: new Set(),
    resumedJobs: new Set(),
    corruptedFiles: new Set(),
    diskLevels: new Map(),
  }));
}

/** What changed in the recordings since the last check. */
export function recordingChanges(
  state: ServerAlertState,
  snapshot: { jobs: ChannelsDvrJobStatus[]; recordingJobIds: string[]; corruptedFileIds: string[] },
  now: number = Date.now()
): {
  failed: ChannelsDvrJobStatus[];
  resumed: ChannelsDvrJobStatus[];
  glitched: ChannelsDvrJobStatus[];
} {
  const byId = new Map(snapshot.jobs.map((job) => [job.id, job]));
  const failedNow = new Set(snapshot.jobs.filter((job) => job.failed).map((job) => job.id));
  const recording = new Set(snapshot.recordingJobIds);

  if (!state.seeded) {
    state.seeded = true;
    state.failedJobs = failedNow;
    // A failed job already recording again when we start has resumed; don't report it as failed
    // the moment it stops.
    state.resumedJobs = new Set([...failedNow].filter((id) => recording.has(id)));
    state.corruptedFiles = new Set(snapshot.corruptedFileIds);
    return { failed: [], resumed: [], glitched: [] };
  }

  // Failed: newly flagged, or flagged again after we saw it resume and it stopped recording before
  // its airing ended (stopping at the end is just the recording finishing).
  const stoppedEarly = (job: ChannelsDvrJobStatus) =>
    !recording.has(job.id) && job.endsAt !== null && now < job.endsAt;
  const failed = snapshot.jobs.filter(
    (job) =>
      job.failed &&
      (!state.failedJobs.has(job.id) || (state.resumedJobs.has(job.id) && stoppedEarly(job)))
  );
  for (const job of failed) {
    state.failedJobs.add(job.id);
    state.resumedJobs.delete(job.id);
  }

  // Resumed: a job we reported as failed is recording again, whatever its Failed flag says.
  const resumed: ChannelsDvrJobStatus[] = [];
  for (const id of state.failedJobs) {
    const job = byId.get(id);
    if (!job) {
      // Finished or deleted: nothing more to say.
      state.failedJobs.delete(id);
      state.resumedJobs.delete(id);
    } else if (recording.has(id) && !state.resumedJobs.has(id)) {
      resumed.push(job);
      state.resumedJobs.add(id);
    } else if (!job.failed && !recording.has(id)) {
      // Flag cleared and not recording: it's settled, so a later failure counts as new.
      state.failedJobs.delete(id);
      state.resumedJobs.delete(id);
    }
  }

  const glitched: ChannelsDvrJobStatus[] = [];
  for (const fileId of snapshot.corruptedFileIds) {
    if (state.corruptedFiles.has(fileId)) continue;
    state.corruptedFiles.add(fileId);
    const job = snapshot.jobs.find((candidate) => candidate.fileId === fileId);
    if (job) glitched.push(job);
  }
  // Forget files whose job has gone, so the set doesn't grow forever.
  const liveFiles = new Set(snapshot.jobs.map((job) => job.fileId).filter(Boolean));
  for (const fileId of state.corruptedFiles) {
    if (!liveFiles.has(fileId)) state.corruptedFiles.delete(fileId);
  }

  return { failed, resumed, glitched };
}

/** Which thresholds crossed at this check, downwards and back up. */
export function diskCrossings(
  state: ServerAlertState,
  freePercent: number,
  thresholds: number[]
): { low: number[]; ok: number[] } {
  const low: number[] = [];
  const ok: number[] = [];
  for (const percent of thresholds) {
    const previous = state.diskLevels.get(percent) ?? 'ok';
    if (previous === 'ok' && freePercent < percent) {
      state.diskLevels.set(percent, 'low');
      low.push(percent);
    } else if (previous === 'low' && freePercent >= percent + DISK_RECOVERY_MARGIN) {
      state.diskLevels.set(percent, 'ok');
      ok.push(percent);
    } else {
      state.diskLevels.set(percent, previous);
    }
  }
  // A threshold no alert watches any more is forgotten.
  for (const percent of state.diskLevels.keys()) {
    if (!thresholds.includes(percent)) state.diskLevels.delete(percent);
  }
  return { low, ok };
}

function subject(job: ChannelsDvrJobStatus) {
  return { jobId: job.id, title: job.title, channel: job.channel, error: tidyDvrError(job.error) };
}

async function checkServer(server: EvaluationServer & { url: string }): Promise<void> {
  const client = new ChannelsDvrClient({ url: server.url, token: '' });
  const snapshot = await client.getAlertSnapshot();
  const state = stateFor(server.id);
  const evaluationServer: EvaluationServer = {
    id: server.id,
    name: server.name,
    type: server.type,
  };

  const { failed, resumed, glitched } = recordingChanges(state, snapshot);
  for (const job of failed) {
    logger.info(`${server.name}: recording failed: ${job.title}`);
    await dispatchDvrRecording('dvr.recording_failed', evaluationServer, subject(job));
  }
  for (const job of resumed) {
    logger.info(`${server.name}: recording resumed: ${job.title}`);
    await dispatchDvrRecording('dvr.recording_resumed', evaluationServer, subject(job));
  }
  for (const job of glitched) {
    logger.info(`${server.name}: recording glitch: ${job.title}`);
    await dispatchDvrRecording('dvr.recording_glitch', evaluationServer, subject(job));
  }

  if (!snapshot.disk) return;
  const thresholds = await dvrDiskThresholds(server.id);
  const freePercent = diskFreePercent(snapshot.disk);
  const { low, ok } = diskCrossings(state, freePercent, thresholds);
  const disk = { ...snapshot.disk, freePercent };
  await dispatchDvrDisk('dvr.disk_low', evaluationServer, disk, low);
  await dispatchDvrDisk('dvr.disk_ok', evaluationServer, disk, ok);
}

export async function runChannelsDvrAlertCheck(): Promise<void> {
  try {
    const rows = (await liveServers()).filter((row) => row.type === 'channels_dvr');
    for (const server of rows) {
      // One server being unreachable leaves the rest to run; server.down covers reachability.
      try {
        await checkServer({
          id: server.id,
          name: server.name,
          type: server.type as ServerType,
          url: server.url,
        });
      } catch (error) {
        logger.debug(`${server.name}: alert check failed`, { error });
      }
    }
    // Forget servers that were removed.
    const live = new Set(rows.map((row) => row.id));
    for (const id of states.keys()) if (!live.has(id)) states.delete(id);
  } catch (error) {
    logger.error('Check failed', { error });
  }
}

export function startChannelsDvrAlertMonitor(): void {
  if (timers) return;
  timers = startPeriodic(INITIAL_DELAY_MS, CHECK_INTERVAL_MS, runChannelsDvrAlertCheck);
  logger.info('Monitor started (every 60s)');
}

export function stopChannelsDvrAlertMonitor(): void {
  timers?.stop();
  timers = null;
}
