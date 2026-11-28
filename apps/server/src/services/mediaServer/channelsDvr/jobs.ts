/**
 * Scheduled recordings and tuner usage.
 *
 * `GET /api/v1/jobs` lists every recording the DVR has queued, including the one running
 * now, with exact start and end times (epoch seconds). Finished jobs drop off the list.
 * `GET /devices` lists the tuner sources, how many tuners each has and the channels on each.
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

/**
 * Jobs that haven't started yet, soonest first. Skipped ones stay in (marked by `skipped`) so
 * the dashboard can show them and offer to unskip.
 */
export function upcomingJobs(
  jobs: ChannelsDvrJob[],
  nowSec: number,
  withinSec: number,
  limit: number
): ChannelsDvrJob[] {
  return jobs
    .filter((job) => job.startSec > nowSec && job.startSec <= nowSec + withinSec)
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

/** A tuner source from `GET /devices`: how many tuners it has and the channels it carries. */
export interface TunerSource {
  id: string;
  name: string;
  tuners: number;
  /** Guide numbers on this source */
  channels: Set<string>;
}

/**
 * The sources a tuner conflict can happen on: those reporting a tuner count. Virtual Channels
 * (no tuners of their own) and sources with no count, such as TV Everywhere, are left out.
 */
export function parseTunerSources(data: unknown): TunerSource[] {
  if (!Array.isArray(data)) return [];
  const sources: TunerSource[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const device = raw as Record<string, unknown>;
    if (device.Disabled === true) continue;
    const id = str(device.DeviceID);
    const tuners = num(device.TunerCount);
    if (!id || id.toUpperCase() === 'VIRTUAL' || tuners === null || tuners <= 0) continue;
    const channels = new Set<string>();
    for (const channel of Array.isArray(device.Channels) ? device.Channels : []) {
      if (!channel || typeof channel !== 'object') continue;
      const number = (channel as { GuideNumber?: unknown }).GuideNumber;
      if (typeof number === 'string' && number.trim()) channels.add(number.trim());
      else if (typeof number === 'number' && Number.isFinite(number)) channels.add(String(number));
    }
    sources.push({ id, name: str(device.FriendlyName) ?? id, tuners, channels });
  }
  return sources;
}

/**
 * Every source's name in Channels by its device id, M3U and virtual sources included, for naming
 * the source a live stream comes from (fork).
 */
export function parseDeviceNames(data: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(data)) return names;
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const device = raw as Record<string, unknown>;
    const id = str(device.DeviceID);
    const name = str(device.FriendlyName);
    if (id && name) names.set(id, name);
  }
  return names;
}

/** More recordings than tuners at once on one source. */
export interface TunerConflict {
  /** The source's name, as Channels shows it */
  source: string;
  tuners: number;
  /** The most recordings this job overlaps with at once on that source, itself included */
  overlapping: number;
}

/**
 * Jobs that, at some moment, need more tuners on their source than it has. A job's source is
 * the first one carrying its first channel (the one Channels tries first). Skipped jobs and
 * jobs already over are left out; one that ends exactly as another starts doesn't overlap it.
 * Live viewers also take tuners, but they can't be known ahead, so only recordings count.
 */
export function findTunerConflicts(
  jobs: ChannelsDvrJob[],
  sources: TunerSource[],
  nowSec: number
): Map<string, TunerConflict> {
  const conflicts = new Map<string, TunerConflict>();
  for (const source of sources) {
    const onSource = jobs.filter((job) => {
      if (job.skipped || job.endSec <= nowSec) return false;
      const channel = job.channels[0];
      return channel !== undefined && sources.find((s) => s.channels.has(channel)) === source;
    });
    if (onSource.length <= source.tuners) continue;

    // Sweep the start and end times; ends sort before starts at the same second.
    const events = onSource.flatMap((job) => [
      { at: job.startSec, start: true, job },
      { at: job.endSec, start: false, job },
    ]);
    events.sort((a, b) => a.at - b.at || Number(a.start) - Number(b.start));
    const active = new Set<ChannelsDvrJob>();
    for (const event of events) {
      if (!event.start) {
        active.delete(event.job);
        continue;
      }
      active.add(event.job);
      if (active.size <= source.tuners) continue;
      for (const job of active) {
        const seen = conflicts.get(job.id)?.overlapping ?? 0;
        if (active.size > seen) {
          conflicts.set(job.id, {
            source: source.name,
            tuners: source.tuners,
            overlapping: active.size,
          });
        }
      }
    }
  }
  return conflicts;
}

/**
 * How many tuners are busy: one per distinct channel being watched live or recorded.
 * Channels shares a tuner between everyone on the same channel, recordings included.
 * Live keys: `<n>-stream-<source>-<channel>-<ip>` or `<n>-ch<channel>-d<device>-<session or ip>`;
 * recordings: "Recording ch2 for …" lines.
 */
export function countTunersInUse(
  entries: ChannelsDvrActivityEntry[],
  recordingChannels: string[]
): number {
  const channels = new Set(recordingChannels);
  for (const { key } of entries) {
    const stream = /^\d+-stream-.+-([\d.]+)-(?:ip)?[\da-f.:]+$/i.exec(key);
    const hls = /^\d+-ch([\d.]+)-d.+/i.exec(key);
    const channel = stream?.[1] ?? hls?.[1];
    if (channel) channels.add(channel);
  }
  return channels.size;
}

/** A job as `GET /dvr/jobs` lists it: the alert monitor's view, with failure state and file. */
export interface ChannelsDvrJobStatus {
  id: string;
  title: string;
  channel: string | null;
  failed: boolean;
  /** Channels' raw error text, or null */
  error: string | null;
  /** The recording's file id once it has one */
  fileId: string | null;
  /** When the airing starts (ms since epoch), from `Time`; null when missing */
  startsAt: number | null;
  /** When the airing ends (ms since epoch), from `Time` + `Duration`; null when either is missing */
  endsAt: number | null;
  /** Skipped in Channels, so it isn't meant to record */
  skipped: boolean;
  /** The series pass (rule) that scheduled it; null for a one-time recording */
  ruleId: string | null;
}

/** Parse `GET /dvr/jobs` (capitalised fields, unlike `/api/v1/jobs`). */
export function parseDvrJobStatuses(data: unknown): ChannelsDvrJobStatus[] {
  if (!Array.isArray(data)) return [];
  const jobs: ChannelsDvrJobStatus[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const job = raw as Record<string, unknown>;
    const id = str(job.ID);
    if (!id) continue;
    const airing =
      job.Airing && typeof job.Airing === 'object' ? (job.Airing as Record<string, unknown>) : {};
    const channels = Array.isArray(job.Channels)
      ? job.Channels.filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [];
    jobs.push({
      id,
      title: str(airing.Title) ?? str(job.Name) ?? id,
      channel: str(job.Channel) ?? str(airing.Channel) ?? channels[0] ?? null,
      failed: job.Failed === true,
      error: str(job.Error),
      fileId: str(job.FileID) ?? (typeof job.FileID === 'number' ? String(job.FileID) : null),
      startsAt: typeof job.Time === 'number' ? job.Time * 1000 : null,
      endsAt:
        typeof job.Time === 'number' && typeof job.Duration === 'number'
          ? (job.Time + job.Duration) * 1000
          : null,
      skipped: job.Skipped === true,
      ruleId: str(job.RuleID) ?? (typeof job.RuleID === 'number' ? String(job.RuleID) : null),
    });
  }
  return jobs;
}

/**
 * Channels' error text for people. It reads like
 * `could not start stream on channels=[2]: M3U: Get "http://…": dial tcp …: connect: connection refused`,
 * where the useful part is the last clause, and the URL can carry a private stream token.
 */
export function tidyDvrError(error: string | null): string | null {
  if (!error) return null;
  const withoutUrls = error.replace(/"?https?:\/\/[^\s"]+"?/g, '').trim();
  const parts = withoutUrls
    .split(/:\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1] ?? withoutUrls;
  const reason = last.length > 120 ? `${last.slice(0, 117)}...` : last;
  return /could not start stream/i.test(error) ? `couldn't start the stream (${reason})` : reason;
}

/** Recording space as a percentage of the disk, from the `disk` block of `GET /dvr`. */
export function diskFreePercent(disk: { freeBytes: number; totalBytes: number }): number {
  return (disk.freeBytes / disk.totalBytes) * 100;
}
