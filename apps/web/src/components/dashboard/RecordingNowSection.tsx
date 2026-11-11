import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, CircleDot, ExternalLink, HardDrive, Square, X } from 'lucide-react';
import type {
  ChannelsDvrDiskUsage,
  ChannelsDvrRecordingEntry,
  ChannelsDvrTunerUsage,
  ChannelsDvrUpcomingEntry,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/hooks/useAuth';
import { useCancelRecording, useStopRecording } from '@/hooks/queries';
import { imageProxyUrl } from '@/lib/api';
import { formatBytes } from '@/lib/formatters';

interface RecordingNowSectionProps {
  /** Panel title: the Channels DVR server's name as entered in Tracearr */
  title?: string;
  /** Undefined while loading or when no Channels DVR server is selected */
  recordings: ChannelsDvrRecordingEntry[] | undefined;
  /** Recordings starting in the next 24 hours, soonest first */
  upcoming?: ChannelsDvrUpcomingEntry[];
  /** Tuners busy on each Channels DVR server */
  tuners?: ChannelsDvrTunerUsage[];
  /** Recording disk space on each Channels DVR server */
  disks?: ChannelsDvrDiskUsage[];
  /** Server id -> the address to open the Channels DVR web UI at */
  linkBases?: Record<string, string>;
  /** Show which server each recording is on */
  showServer?: boolean;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Re-render every 10 s so time left and progress stay current between refetches. */
function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Admin/owner only: stops the recording after a confirmation. The partial file is kept. */
function StopRecordingButton({ recording }: { recording: ChannelsDvrRecordingEntry }) {
  const { t } = useTranslation(['pages', 'common']);
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const stop = useStopRecording();
  const canStop = (user?.role === 'admin' || user?.role === 'owner') && !!recording.jobId;
  if (!canStop) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-6 w-6 shrink-0"
        title={t('dashboard.recording.stop', { defaultValue: 'Stop' })}
        aria-label={t('dashboard.recording.stop', { defaultValue: 'Stop' })}
        onClick={() => setOpen(true)}
      >
        <Square className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('dashboard.recording.stopTitle', { defaultValue: 'Stop recording?' })}
            </DialogTitle>
            <DialogDescription>
              {t('dashboard.recording.stopConfirm', {
                defaultValue:
                  'Stop recording "{{title}}" now? What has been recorded so far stays in your Channels DVR library.',
                title: recording.title,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={stop.isPending}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={stop.isPending}
              onClick={() =>
                stop.mutate(
                  { serverId: recording.serverId, jobId: recording.jobId! },
                  { onSuccess: () => setOpen(false) }
                )
              }
            >
              {stop.isPending
                ? t('dashboard.recording.stopping', { defaultValue: 'Stopping…' })
                : t('dashboard.recording.stop', { defaultValue: 'Stop' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RecordingCard({
  recording,
  now,
  showServer,
}: {
  recording: ChannelsDvrRecordingEntry;
  now: number;
  showServer: boolean;
}) {
  const { t } = useTranslation('pages');
  const start = recording.startedAt ? Date.parse(recording.startedAt) : null;
  const end = recording.endsAt ? Date.parse(recording.endsAt) : null;
  const hasWindow = start !== null && end !== null && end > start;
  const percent = hasWindow ? Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100)) : 0;
  const minutesLeft = hasWindow ? Math.max(0, Math.ceil((end - now) / 60_000)) : null;

  const channel = recording.channelTitle
    ? t('dashboard.recording.channelNamed', {
        defaultValue: 'Channel {{number}} · {{name}}',
        number: recording.channelNumber,
        name: recording.channelTitle,
      })
    : t('dashboard.recording.channel', {
        defaultValue: 'Channel {{number}}',
        number: recording.channelNumber,
      });

  const timeWindow = hasWindow
    ? `${formatClock(recording.startedAt!)}–${formatClock(recording.endsAt!)}`
    : recording.untilText
      ? t('dashboard.recording.until', {
          defaultValue: 'until {{time}}',
          time: recording.untilText,
        })
      : null;

  return (
    <div className="bg-card flex gap-3 rounded-xl border p-3">
      <div className="bg-muted flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md">
        {recording.thumbPath ? (
          <img
            src={imageProxyUrl(recording.serverId, recording.thumbPath, 192, 128)}
            alt=""
            className="h-full w-full object-contain"
            loading="lazy"
          />
        ) : (
          <CircleDot className="text-muted-foreground h-6 w-6" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-red-500 uppercase">
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500"
              aria-hidden="true"
            />
            {t('dashboard.recording.badge', { defaultValue: 'Recording' })}
          </span>
          {showServer && (
            <span className="text-muted-foreground truncate text-xs">{recording.serverName}</span>
          )}
          <span className="ml-auto" />
          <StopRecordingButton recording={recording} />
        </div>
        <h3 className="mt-1 truncate text-sm leading-tight font-semibold" title={recording.title}>
          {recording.title}
        </h3>
        <p className="text-muted-foreground truncate text-xs">
          {[channel, timeWindow].filter(Boolean).join(' · ')}
        </p>
        {hasWindow && (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={percent} className="h-1.5 flex-1" />
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {t('dashboard.recording.minutesLeft', {
                defaultValue: '{{count}} min left',
                count: minutesLeft ?? 0,
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** How many Coming Up rows to show before "+N more". */
const UPCOMING_SHOWN = 5;

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "2:00 PM" today, "Tomorrow 7:00 AM" otherwise (the list only looks a day ahead). */
function StartTime({ iso, now }: { iso: string; now: number }) {
  const { t } = useTranslation('pages');
  const time = formatClock(iso);
  if (isSameDay(new Date(iso), new Date(now))) return <>{time}</>;
  return <>{t('dashboard.recording.tomorrow', { defaultValue: 'Tomorrow {{time}}', time })}</>;
}

/** "3 of 5 tuners in use", amber when every tuner is busy. */
function TunerPill({ usage, showServer }: { usage: ChannelsDvrTunerUsage; showServer: boolean }) {
  const { t } = useTranslation('pages');
  const full = usage.inUse >= usage.total;
  const label = showServer
    ? t('dashboard.recording.tunersOnServer', {
        defaultValue: '{{server}}: {{inUse}} of {{total}} tuners in use',
        server: usage.serverName,
        inUse: usage.inUse,
        total: usage.total,
      })
    : t('dashboard.recording.tuners', {
        defaultValue: '{{inUse}} of {{total}} tuners in use',
        inUse: usage.inUse,
        total: usage.total,
      });
  return (
    <span
      className={
        full
          ? 'rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400'
          : 'bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium'
      }
      title={t('dashboard.recording.tunersHint', {
        defaultValue: 'One tuner per channel being watched live or recorded',
      })}
      data-testid="tuner-usage"
    >
      {label}
    </span>
  );
}

/** Matches the disk-space alert's default: amber below 10% free. */
const DISK_LOW_FRACTION = 0.1;

/** "186.6 GB free", amber when space is low. Binary units, as Channels shows them. */
function DiskPill({ usage, showServer }: { usage: ChannelsDvrDiskUsage; showServer: boolean }) {
  const { t } = useTranslation('pages');
  const low = usage.freeBytes / usage.totalBytes < DISK_LOW_FRACTION;
  const free = formatBytes(usage.freeBytes);
  return (
    <span
      className={
        low
          ? 'inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400'
          : 'bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium'
      }
      title={t('dashboard.recording.diskHint', {
        defaultValue: '{{free}} free of {{total}} for recordings',
        free,
        total: formatBytes(usage.totalBytes),
      })}
      data-testid="disk-usage"
    >
      <HardDrive className="h-3 w-3" aria-hidden="true" />
      {showServer
        ? t('dashboard.recording.diskFreeOnServer', {
            defaultValue: '{{server}}: {{free}} free',
            server: usage.serverName,
            free,
          })
        : t('dashboard.recording.diskFree', { defaultValue: '{{free}} free', free })}
    </span>
  );
}

/** Admin/owner only: removes a queued recording from the Channels schedule, after a confirmation. */
function CancelRecordingButton({ job }: { job: ChannelsDvrUpcomingEntry }) {
  const { t } = useTranslation(['pages', 'common']);
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const cancel = useCancelRecording();
  if (user?.role !== 'admin' && user?.role !== 'owner') return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-6 w-6 shrink-0"
        title={t('dashboard.recording.cancel', { defaultValue: 'Cancel recording' })}
        aria-label={t('dashboard.recording.cancel', { defaultValue: 'Cancel recording' })}
        onClick={() => setOpen(true)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('dashboard.recording.cancelTitle', { defaultValue: 'Cancel this recording?' })}
            </DialogTitle>
            <DialogDescription>
              {t('dashboard.recording.cancelConfirm', {
                defaultValue:
                  'Cancel "{{title}}" at {{time}}? It will be removed from your Channels DVR schedule.',
                title: job.title,
                time: formatClock(job.startsAt),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={cancel.isPending}>
              {t('dashboard.recording.keep', { defaultValue: 'Keep it' })}
            </Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate(
                  { serverId: job.serverId, jobId: job.jobId },
                  { onSuccess: () => setOpen(false) }
                )
              }
            >
              {cancel.isPending
                ? t('dashboard.recording.cancelling', { defaultValue: 'Cancelling…' })
                : t('dashboard.recording.cancel', { defaultValue: 'Cancel recording' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UpcomingRow({
  job,
  now,
  showServer,
  linkBase,
}: {
  job: ChannelsDvrUpcomingEntry;
  now: number;
  showServer: boolean;
  linkBase?: string;
}) {
  const { t } = useTranslation('pages');
  const episode =
    job.seasonNumber !== null && job.episodeNumber !== null
      ? t('dashboard.recording.episode', {
          defaultValue: 'S{{season}} E{{episode}}',
          season: job.seasonNumber,
          episode: job.episodeNumber,
        })
      : null;
  // Channels' schedule page lists every queued recording; a show's page only lists what
  // it has already recorded, so it's empty for a show that hasn't recorded yet.
  const showUrl = linkBase ? `${linkBase.replace(/\/+$/, '')}/admin/dvr/jobs` : null;
  const channel = job.channelNumber
    ? job.channelTitle
      ? t('dashboard.recording.channelNamed', {
          defaultValue: 'Channel {{number}} · {{name}}',
          number: job.channelNumber,
          name: job.channelTitle,
        })
      : t('dashboard.recording.channel', {
          defaultValue: 'Channel {{number}}',
          number: job.channelNumber,
        })
    : null;

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span className="text-muted-foreground w-28 shrink-0 text-xs font-medium tabular-nums">
        <StartTime iso={job.startsAt} now={now} />
      </span>
      <div className="bg-muted flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded">
        {job.thumbPath ? (
          <img
            src={imageProxyUrl(job.serverId, job.thumbPath, 96, 64)}
            alt=""
            className="h-full w-full object-contain"
            loading="lazy"
          />
        ) : (
          <CalendarClock className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {showUrl ? (
          <a
            href={showUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group/link flex min-w-0 items-center gap-1 text-sm font-medium hover:underline"
            title={t('dashboard.recording.openInChannels', {
              defaultValue: 'Open the Channels DVR schedule',
            })}
          >
            <span className="truncate">{job.title}</span>
            <ExternalLink
              className="text-muted-foreground h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100"
              aria-hidden="true"
            />
          </a>
        ) : (
          <p className="truncate text-sm font-medium" title={job.title}>
            {job.title}
          </p>
        )}
        <p className="text-muted-foreground truncate text-xs">
          {[episode, job.episodeTitle, channel, showServer ? job.serverName : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <CancelRecordingButton job={job} />
    </li>
  );
}

/**
 * The Channels DVR panel: recordings in progress, the next day's queued recordings, and
 * how many tuners are busy. Kept apart from Now Playing on purpose: recordings are not
 * viewers, so they never count as streams, plays or users. Shown whenever a Channels DVR
 * server is selected, idle or not; `recordings` is undefined while loading or when none is.
 */
export function RecordingNowSection({
  title,
  recordings,
  upcoming = [],
  tuners = [],
  disks = [],
  linkBases = {},
  showServer = false,
}: RecordingNowSectionProps) {
  const { t } = useTranslation('pages');
  const now = useNow();
  if (!recordings) return null;

  const shown = upcoming.slice(0, UPCOMING_SHOWN);
  const more = upcoming.length - shown.length;

  return (
    <section>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <CircleDot className="h-4 w-4" aria-hidden="true" />
            {title ?? t('dashboard.recording.panelTitle', { defaultValue: 'Channels DVR' })}
            {tuners.map((usage) => (
              <TunerPill key={usage.serverId} usage={usage} showServer={showServer} />
            ))}
            {disks.map((usage) => (
              <DiskPill key={usage.serverId} usage={usage} showServer={showServer} />
            ))}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <span
              className={
                recordings.length > 0
                  ? 'h-2 w-2 animate-pulse rounded-full bg-red-500'
                  : 'bg-muted-foreground/40 h-2 w-2 rounded-full'
              }
              aria-hidden="true"
            />
            {t('dashboard.recording.title', { defaultValue: 'Recording Now' })}
            {recordings.length > 0 && (
              <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-xs font-medium">
                {recordings.length}
              </span>
            )}
          </h4>
          {recordings.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {recordings.map((recording) => (
                <RecordingCard
                  key={`${recording.serverId}:${recording.key}`}
                  recording={recording}
                  now={now}
                  showServer={showServer}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t('dashboard.recording.nothingRecording', {
                defaultValue: 'Nothing, absolutely nothing.',
              })}
            </p>
          )}
          {shown.length > 0 && (
            <div className="mt-5">
              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <CalendarClock className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                {t('dashboard.recording.comingUp', { defaultValue: 'Coming Up' })}
                <span className="text-muted-foreground text-xs font-normal">
                  {t('dashboard.recording.comingUpCaption', { defaultValue: 'next 24 hours' })}
                </span>
              </h4>
              <ul className="divide-y rounded-xl border">
                {shown.map((job) => (
                  <UpcomingRow
                    key={`${job.serverId}:${job.jobId}`}
                    job={job}
                    now={now}
                    showServer={showServer}
                    linkBase={linkBases[job.serverId]}
                  />
                ))}
              </ul>
              {more > 0 && (
                <p className="text-muted-foreground mt-2 text-xs">
                  {t('dashboard.recording.moreComingUp', {
                    defaultValue: '+{{count}} more in the next 24 hours',
                    count: more,
                  })}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
