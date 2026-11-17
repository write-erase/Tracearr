/**
 * "Check connection" for a Channels DVR server: read each endpoint Tracearr uses and say what
 * came back, so a setup problem points at the part that's wrong instead of "can't connect".
 */

import type { ChannelsDvrCheck, ChannelsDvrCheckStep } from '@tracearr/shared';
import { parseDisk, parseDvrJobStatuses } from './jobs.js';
import { parseLineups } from './lineup.js';
import { parseDvrActivity, parseRecordingActivity } from './parser.js';

/** Reads one path on the server (`/status`, `/dvr`, …) and returns its JSON. */
export type ChannelsDvrFetch = (path: string) => Promise<unknown>;

function failure(error: unknown): { ok: false; error: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message || 'No answer' };
}

async function step<T extends object>(read: () => Promise<T>): Promise<ChannelsDvrCheckStep<T>> {
  try {
    return { ok: true, ...(await read()) };
  } catch (error) {
    return failure(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Runs every step; one failing doesn't stop the others. */
export async function runChannelsDvrCheck(fetch: ChannelsDvrFetch): Promise<ChannelsDvrCheck> {
  // /dvr feeds two steps; read it once.
  const dvr = fetch('/dvr').then(
    (data) => ({ data }),
    (error: unknown) => ({ error })
  );

  const [server, activity, disk, jobs, lineup] = await Promise.all([
    step(async () => {
      const data = await fetch('/status');
      if (!isRecord(data)) throw new Error('The server answered, but not like Channels DVR');
      const version = typeof data.version === 'string' && data.version ? data.version : null;
      return { version };
    }),
    step(async () => {
      const result = await dvr;
      if ('error' in result) throw result.error;
      if (!isRecord(result.data) || !('activity' in result.data)) {
        throw new Error('No activity feed in GET /dvr');
      }
      const recording = parseDvrActivity(result.data).filter(
        (entry) => parseRecordingActivity(entry) !== null
      ).length;
      return { recording };
    }),
    step(async () => {
      const result = await dvr;
      if ('error' in result) throw result.error;
      const space = parseDisk(result.data);
      if (!space) throw new Error("Channels didn't report disk space");
      return space;
    }),
    step(async () => {
      const data = await fetch('/dvr/jobs');
      if (!Array.isArray(data)) throw new Error('GET /dvr/jobs did not return a list');
      const now = Date.now();
      const scheduled = parseDvrJobStatuses(data).filter(
        (job) => !job.skipped && (job.endsAt === null || job.endsAt > now)
      ).length;
      return { scheduled };
    }),
    step(async () => {
      const data = await fetch('/devices');
      if (!Array.isArray(data)) throw new Error('GET /devices did not return a list');
      const sources = parseLineups(data);
      return {
        sources: sources.length,
        channels: sources.reduce((sum, source) => sum + source.channels.length, 0),
      };
    }),
  ]);

  return { server, activity, disk, jobs, lineup };
}
