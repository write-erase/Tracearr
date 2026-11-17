/**
 * Recordings Channels DVR finished recently, from `GET /dvr/files`.
 *
 * `/dvr/files` lists every file in the DVR library: recordings and imported files alike. A
 * recording has a `JobID` (the job that made it); an import has an `ImportPath` instead.
 * Finished jobs leave `GET /dvr/jobs` straight away, so the file is the only record left, and a
 * recording that failed before writing anything doesn't show here at all.
 *
 * A file's flags say how the recording went: `Corrupted` (the stream dropped and Channels
 * reconnected, leaving a gap), `Cancelled` (stopped before the airing ended, by hand or by a
 * failure) and `Delayed` (started after the airing did). `Completed` is false while it records.
 * `CreatedAt` is epoch seconds and `Duration` seconds recorded.
 */

/** How a recording went, worst first. */
export type RecentRecordingIssue = 'interrupted' | 'stoppedEarly' | 'startedLate';

export interface RecentRecording {
  fileId: string;
  jobId: string;
  /** The show's id in Channels (its group), for /admin/shows/<id> */
  showId: string | null;
  title: string;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  channelNumber: string | null;
  /** Epoch seconds */
  startedSec: number;
  endedSec: number;
  /** Seconds recorded, and the length the job was scheduled for */
  durationSec: number;
  scheduledSec: number | null;
  /** Programme image as Channels gave it */
  image: string | null;
  issues: RecentRecordingIssue[];
}

function str(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Season and episode, unless Channels numbered the airing by date (news and talk shows come
 * through as S2026 E1116), which reads as noise next to the date the row already shows.
 */
function episodeNumbers(airing: Record<string, unknown>): [number | null, number | null] {
  const season = num(airing.SeasonNumber);
  const episode = num(airing.EpisodeNumber);
  if (season === null || episode === null || season >= 1900) return [null, null];
  return [season, episode];
}

/**
 * Recordings that finished (stopped recording) within `withinSec` of `nowSec`, newest first.
 * Imports, files still recording and files Channels has deleted are left out.
 */
export function recentRecordings(
  data: unknown,
  nowSec: number,
  withinSec: number
): RecentRecording[] {
  if (!Array.isArray(data)) return [];
  const recent: RecentRecording[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const file = raw as Record<string, unknown>;
    const fileId = str(file.ID);
    const jobId = str(file.JobID);
    if (!fileId || !jobId || str(file.ImportPath)) continue;
    if (file.Completed !== true || file.Deleted === true || file.Trashed === true) continue;
    const startedSec = num(file.CreatedAt);
    const durationSec = num(file.Duration) ?? 0;
    if (startedSec === null) continue;
    const endedSec = startedSec + durationSec;
    if (endedSec < nowSec - withinSec || startedSec > nowSec) continue;

    const airing =
      file.Airing && typeof file.Airing === 'object'
        ? (file.Airing as Record<string, unknown>)
        : {};
    const [seasonNumber, episodeNumber] = episodeNumbers(airing);
    const issues: RecentRecordingIssue[] = [];
    if (file.Corrupted === true) issues.push('interrupted');
    if (file.Cancelled === true) issues.push('stoppedEarly');
    if (file.Delayed === true) issues.push('startedLate');
    recent.push({
      fileId,
      jobId,
      showId: str(file.GroupID),
      title: str(airing.Title) ?? str(file.GroupID) ?? jobId,
      episodeTitle: str(airing.EpisodeTitle),
      seasonNumber,
      episodeNumber,
      channelNumber: str(file.ChannelNumber) ?? str(airing.Channel),
      startedSec,
      endedSec,
      durationSec,
      scheduledSec: num(file.JobDuration),
      image: str(airing.Image),
      issues,
    });
  }
  return recent.sort((a, b) => b.endedSec - a.endedSec);
}
