/**
 * Scheduled recordings and tuner usage.
 *
 * `GET /api/v1/jobs` lists every recording the DVR has queued, including the one running
 * now, with exact start and end times (epoch seconds). Finished jobs drop off the list.
 * `GET /devices` lists the tuner sources and how many tuners each has.
 */
import type { ChannelsDvrActivityEntry } from './parser.js';

export interface ChannelsDvrJob {
  /** "1794427200-ch1": the id DELETE /dvr/jobs/<id> takes */
  id: string;
  /** Show or movie name */
  title: string;
  /** The show's id in Channels (for XMLTV guides, its name); opens /admin/shows/<id> */
  showId: string | null;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** Epoch seconds */
  startSec: number;
  endSec: number;
  channels: string[];
  skipped: boolean;
  failed: boolean;
  /** Programme image as Channels gave it (usually a TMS URL) */
  image: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse `GET /api/v1/jobs`. Entries missing an id or times are dropped. */
export function parseJobs(data: unknown): ChannelsDvrJob[] {
  if (!Array.isArray(data)) return [];
  const jobs: ChannelsDvrJob[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const job = raw as Record<string, unknown>;
    const item =
      job.item && typeof job.item === 'object' ? (job.item as Record<string, unknown>) : {};
    const id = str(job.id);
    const startSec = num(job.start_time);
    const duration = num(job.duration);
    const endSec =
      num(job.end_time) ?? (startSec !== null && duration !== null ? startSec + duration : null);
    if (!id || startSec === null || endSec === null || endSec <= startSec) continue;
    jobs.push({
      id,
      title: str(item.title) ?? str(job.name) ?? id,
      showId: str(item.show_id),
      episodeTitle: str(item.episode_title),
      seasonNumber: num(item.season_number),
      episodeNumber: num(item.episode_number),
      startSec,
      endSec,
      channels: Array.isArray(job.channels)
        ? job.channels.filter((c): c is string => typeof c === 'string' && !!c.trim())
        : [],
      skipped: job.skipped === true || item.cancelled === true,
      failed: job.failed === true,
      image: str(item.image_url),
    });
  }
  return jobs;
}

/** Jobs that haven't started yet and will run, soonest first. */
export function upcomingJobs(
  jobs: ChannelsDvrJob[],
  nowSec: number,
  withinSec: number,
  limit: number
): ChannelsDvrJob[] {
  return jobs
    .filter((job) => !job.skipped && job.startSec > nowSec && job.startSec <= nowSec + withinSec)
    .sort((a, b) => a.startSec - b.startSec)
    .slice(0, limit);
}

/** Free and total disk space for recordings, from the `disk` block of `GET /dvr`. */
export function parseDisk(data: unknown): { freeBytes: number; totalBytes: number } | null {
  if (!data || typeof data !== 'object') return null;
  const disk = (data as { disk?: unknown }).disk;
  if (!disk || typeof disk !== 'object') return null;
  const free = num((disk as { free?: unknown }).free);
  const total = num((disk as { total?: unknown }).total);
  return free !== null && total !== null && total > 0
    ? { freeBytes: free, totalBytes: total }
    : null;
}

/** Total tuners across the DVR's sources, from `GET /devices`; null when none report a count. */
export function parseTunerTotal(data: unknown): number | null {
  if (!Array.isArray(data)) return null;
  let total = 0;
  let any = false;
  for (const device of data) {
    if (!device || typeof device !== 'object') continue;
    const count = num((device as { TunerCount?: unknown }).TunerCount);
    if (count !== null && count > 0) {
      total += count;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * How many tuners are busy: one per distinct channel being watched live or recorded.
 * Channels shares a tuner between everyone on the same channel, recordings included.
 * Live keys: `<n>-stream-<source>-<channel>-<ip>` or `<n>-ch<channel>-dANY-<session>`;
 * recordings: "Recording ch2 for …" lines.
 */
export function countTunersInUse(
  entries: ChannelsDvrActivityEntry[],
  recordingChannels: string[]
): number {
  const channels = new Set(recordingChannels);
  for (const { key } of entries) {
    const stream = /^\d+-stream-.+-([\d.]+)-(?:ip)?[\da-f.:]+$/i.exec(key);
    const hls = /^\d+-ch([\d.]+)-dANY-/i.exec(key);
    const channel = stream?.[1] ?? hls?.[1];
    if (channel) channels.add(channel);
  }
  return channels.size;
}
