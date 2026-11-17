import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CalendarClock,
  CircleArrowUp,
  CircleCheck,
  CircleDot,
  ExternalLink,
  History,
  HardDrive,
  SkipForward,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import type {
  ChannelsDvrDiskUsage,
  ChannelsDvrRecentEntry,
  ChannelsDvrRecordingEntry,
  ChannelsDvrRecordingIssue,
  ChannelsDvrTunerUsage,
  ChannelsDvrUpcomingEntry,
  Server,
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
import { useCancelRecording, useSkipRecording, useStopRecording } from '@/hooks/queries';
import { imageProxyUrl } from '@/lib/api';
import { formatBytes } from '@/lib/formatters';
import { cn } from '@/lib/utils';

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
  /** Recordings finished in the last day, newest first */
  recent?: ChannelsDvrRecentEntry[];
  /** Each Channels DVR server's installed version against the newest on the track it follows */
  versions?: ChannelsDvrVersion[];
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
const RECENT_SHOWN = 5;

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

/** "6:10 PM" today, "Yesterday 6:10 PM" otherwise (the list only looks a day back). */
function EndTime({ iso, now }: { iso: string; now: number }) {
  const { t } = useTranslation('pages');
  const time = formatClock(iso);
  if (isSameDay(new Date(iso), new Date(now))) return <>{time}</>;
  return <>{t('dashboard.recording.yesterday', { defaultValue: 'Yesterday {{time}}', time })}</>;
}

/** "45 min", "1 h 5 min"; under a minute reads as "1 min". */
function useFormatMinutes(): (seconds: number) => string {
  const { t } = useTranslation('pages');
  return (seconds) => {
    const minutes = Math.max(1, Math.round(seconds / 60));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) {
      return t('dashboard.recording.minutes', { defaultValue: '{{count}} min', count: minutes });
    }
    return rest === 0
      ? t('dashboard.recording.hours', { defaultValue: '{{count}} h', count: hours })
      : t('dashboard.recording.hoursMinutes', {
          defaultValue: '{{hours}} h {{minutes}} min',
          hours,
          minutes: rest,
        });
  };
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

/**
 * "186.6 GB free", amber when space is low. Binary units, as Channels shows them. Low means
 * below the highest enabled disk alert's percentage for this server, or 10% with none.
 */
/** A Channels DVR server's installed version, and the newest release on the track it follows. */
export interface ChannelsDvrVersion {
  serverId: string;
  serverName: string;
  installed: string;
  latest: string;
  /** The latest release is newer than the installed one */
  updateAvailable: boolean;
}

/** Both versions are three or four dotted numbers; a missing part reads as zero. */
function isNewerVersion(latest: string, installed: string): boolean {
  const a = latest.split('.').map(Number);
  const b = installed.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const na = a[i] ?? 0;
    const nb = b[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

/**
 * Every Channels DVR server the update checker has read both versions for. Each server's
 * `latestVersion` is already the newest on the track it follows (stable or pre-release).
 * A server missing either version (unreachable so far, or update checks turned off) is left out.
 */
export function channelsVersionsFor(servers: Server[]): ChannelsDvrVersion[] {
  return servers.flatMap((server) =>
    server.type === 'channels_dvr' && server.version && server.latestVersion
      ? [
          {
            serverId: server.id,
            serverName: server.name,
            installed: server.version,
            latest: server.latestVersion,
            updateAvailable: isNewerVersion(server.latestVersion, server.version),
          },
        ]
      : []
  );
}

/**
 * "Update available" while a newer release is waiting, otherwise a green "Up to date". Either
 * opens the Channels DVR web UI, where updates are installed.
 */
function VersionPill({
  version,
  showServer,
  linkBase,
}: {
  version: ChannelsDvrVersion;
  showServer: boolean;
  linkBase?: string;
}) {
  const { t } = useTranslation('pages');
  const { updateAvailable } = version;
  const label = updateAvailable
    ? showServer
      ? t('dashboard.recording.updateOnServer', {
          defaultValue: '{{server}}: update available',
          server: version.serverName,
        })
      : t('dashboard.recording.update', { defaultValue: 'Update available' })
    : showServer
      ? t('dashboard.recording.upToDateOnServer', {
          defaultValue: '{{server}}: up to date',
          server: version.serverName,
        })
      : t('dashboard.recording.upToDate', { defaultValue: 'Up to date' });
  const hint = updateAvailable
    ? t('dashboard.recording.updateHint', {
        defaultValue: '{{latest}} is available (running {{installed}})',
        latest: version.latest,
        installed: version.installed,
      })
    : t('dashboard.recording.upToDateHint', {
        defaultValue: 'Running {{installed}}, the latest release',
        installed: version.installed,
      });
  const className = cn(
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
    updateAvailable
      ? 'bg-primary/15 text-primary'
      : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  );
  const Icon = updateAvailable ? CircleArrowUp : CircleCheck;
  const content = (
    <>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </>
  );
  const testId = updateAvailable ? 'dvr-update' : 'dvr-up-to-date';
  return linkBase ? (
    <a
      href={linkBase.replace(/\/+$/, '')}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(className, updateAvailable ? 'hover:bg-primary/25' : 'hover:bg-emerald-500/25')}
      title={hint}
      data-testid={testId}
    >
      {content}
    </a>
  ) : (
    <span className={className} title={hint} data-testid={testId}>
      {content}
    </span>
  );
}

function DiskPill({ usage, showServer }: { usage: ChannelsDvrDiskUsage; showServer: boolean }) {
  const { t } = useTranslation('pages');
  const low = (usage.freeBytes / usage.totalBytes) * 100 < usage.warnPercent;
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

/**
 * Admin/owner only, for airings a series pass scheduled: skip this one (the pass records the
 * rest), or unskip it. No confirmation, since it's undone with the same button.
 */
function SkipRecordingButton({ job }: { job: ChannelsDvrUpcomingEntry }) {
  const { t } = useTranslation('pages');
  const { user } = useAuth();
  const skip = useSkipRecording();
  if (user?.role !== 'admin' && user?.role !== 'owner') return null;

  const toggle = () =>
    skip.mutate({ serverId: job.serverId, jobId: job.jobId, skipped: !job.skipped });

  if (job.skipped) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-6 shrink-0 gap-1 px-2 text-xs"
        title={t('dashboard.recording.unskipHint', {
          defaultValue: 'Record this airing after all',
        })}
        disabled={skip.isPending}
        onClick={toggle}
      >
        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
        {t('dashboard.recording.unskip', { defaultValue: 'Unskip' })}
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground h-6 w-6 shrink-0"
      title={t('dashboard.recording.skipHint', {
        defaultValue: 'Skip this airing. The series pass keeps recording the rest.',
      })}
      aria-label={t('dashboard.recording.skip', { defaultValue: 'Skip this episode' })}
      disabled={skip.isPending}
      onClick={toggle}
    >
      <SkipForward className="h-3.5 w-3.5" />
    </Button>
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

  // A skipped airing stays listed, dimmed, so it can be unskipped; the button stays full strength.
  const dim = job.skipped ? 'opacity-50' : undefined;

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span
        className={cn(
          'text-muted-foreground w-28 shrink-0 text-xs font-medium tabular-nums',
          job.skipped && 'line-through',
          dim
        )}
      >
        <StartTime iso={job.startsAt} now={now} />
      </span>
      <div
        className={cn(
          'bg-muted flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded',
          dim
        )}
      >
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
      <div className={cn('min-w-0 flex-1', dim)}>
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
          {[
            job.skipped ? t('dashboard.recording.skipped', { defaultValue: 'Skipped' }) : null,
            episode,
            job.episodeTitle,
            channel,
            showServer ? job.serverName : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {job.conflict && (
          <p
            className="flex items-center gap-1 truncate text-xs font-medium text-amber-600 dark:text-amber-400"
            title={t('dashboard.recording.conflictHint', {
              defaultValue:
                '{{overlapping}} recordings overlap on {{source}}, which has {{tuners}} tuners, so one may not record. Skip or cancel one, or change its channel in Channels.',
              overlapping: job.conflict.overlapping,
              source: job.conflict.source,
              tuners: job.conflict.tuners,
            })}
            data-testid="tuner-conflict"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            {t('dashboard.recording.conflict', {
              defaultValue: 'Tuner conflict: {{overlapping}} at once, {{tuners}} tuners',
              overlapping: job.conflict.overlapping,
              tuners: job.conflict.tuners,
            })}
          </p>
        )}
      </div>
      {/* A pass airing is skipped (the pass keeps going); a one-time recording is cancelled. */}
      {job.fromPass || job.skipped ? (
        <SkipRecordingButton job={job} />
      ) : (
        <CancelRecordingButton job={job} />
      )}
    </li>
  );
}

/** How a finished recording went, as a small badge: red when it has a gap, amber otherwise. */
function IssueBadge({ issue }: { issue: ChannelsDvrRecordingIssue }) {
  const { t } = useTranslation('pages');
  const label =
    issue === 'interrupted'
      ? t('dashboard.recording.issueInterrupted', { defaultValue: 'Interrupted' })
      : issue === 'stoppedEarly'
        ? t('dashboard.recording.issueStoppedEarly', { defaultValue: 'Stopped early' })
        : t('dashboard.recording.issueStartedLate', { defaultValue: 'Started late' });
  const hint =
    issue === 'interrupted'
      ? t('dashboard.recording.issueInterruptedHint', {
          defaultValue: 'The stream dropped and Channels reconnected, so part of it is missing',
        })
      : issue === 'stoppedEarly'
        ? t('dashboard.recording.issueStoppedEarlyHint', {
            defaultValue:
              'It stopped before the airing ended, by hand or because the stream failed',
          })
        : t('dashboard.recording.issueStartedLateHint', {
            defaultValue: 'It started after the airing did, so the beginning is missing',
          });
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
        issue === 'interrupted'
          ? 'bg-red-500/15 text-red-600 dark:text-red-400'
          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
      )}
      title={hint}
      data-testid="recording-issue"
    >
      {label}
    </span>
  );
}

/** A recording that finished in the last day: when, what, how long, and how it went. */
function RecentRow({
  file,
  now,
  showServer,
  linkBase,
}: {
  file: ChannelsDvrRecentEntry;
  now: number;
  showServer: boolean;
  linkBase?: string;
}) {
  const { t } = useTranslation('pages');
  const formatMinutes = useFormatMinutes();
  const episode =
    file.seasonNumber !== null && file.episodeNumber !== null
      ? t('dashboard.recording.episode', {
          defaultValue: 'S{{season}} E{{episode}}',
          season: file.seasonNumber,
          episode: file.episodeNumber,
        })
      : null;
  const channel = file.channelNumber
    ? t('dashboard.recording.channel', {
        defaultValue: 'Channel {{number}}',
        number: file.channelNumber,
      })
    : null;
  // A short recording says how much of the scheduled time it got.
  const short =
    file.scheduledSec !== null &&
    file.scheduledSec > 0 &&
    file.durationSec < file.scheduledSec * 0.9;
  const length = short
    ? t('dashboard.recording.recordedOf', {
        defaultValue: '{{recorded}} of {{scheduled}}',
        recorded: formatMinutes(file.durationSec),
        scheduled: formatMinutes(file.scheduledSec ?? 0),
      })
    : formatMinutes(file.durationSec);
  const showUrl =
    linkBase && file.showId
      ? `${linkBase.replace(/\/+$/, '')}/admin/shows/${encodeURIComponent(file.showId)}`
      : null;

  return (
    <li className="flex items-center gap-3 px-3 py-2" data-testid="recent-recording">
      <span className="text-muted-foreground w-28 shrink-0 text-xs font-medium tabular-nums">
        <EndTime iso={file.endedAt} now={now} />
      </span>
      <div className="bg-muted flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded">
        {file.thumbPath ? (
          <img
            src={imageProxyUrl(file.serverId, file.thumbPath, 96, 64)}
            alt=""
            className="h-full w-full object-contain"
            loading="lazy"
          />
        ) : (
          <History className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {showUrl ? (
          <a
            href={showUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group/link flex min-w-0 items-center gap-1 text-sm font-medium hover:underline"
            title={t('dashboard.recording.openShowInChannels', {
              defaultValue: 'Open the show in Channels DVR',
            })}
          >
            <span className="truncate">{file.title}</span>
            <ExternalLink
              className="text-muted-foreground h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100"
              aria-hidden="true"
            />
          </a>
        ) : (
          <p className="truncate text-sm font-medium" title={file.title}>
            {file.title}
          </p>
        )}
        <p className="text-muted-foreground truncate text-xs">
          {[episode, file.episodeTitle, channel, length, showServer ? file.serverName : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      {file.issues.length > 0 && (
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {file.issues.map((issue) => (
            <IssueBadge key={issue} issue={issue} />
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * The Channels DVR panel: recordings in progress, the next day's queued recordings, the last
 * day's finished ones, and how many tuners are busy. Kept apart from Now Playing on purpose: recordings are not
 * viewers, so they never count as streams, plays or users. Shown whenever a Channels DVR
 * server is selected, idle or not; `recordings` is undefined while loading or when none is.
 */
export function RecordingNowSection({
  title,
  recordings,
  upcoming = [],
  tuners = [],
  disks = [],
  recent = [],
  versions = [],
  linkBases = {},
  showServer = false,
}: RecordingNowSectionProps) {
  const { t } = useTranslation('pages');
  const now = useNow();
  if (!recordings) return null;

  const shown = upcoming.slice(0, UPCOMING_SHOWN);
  const more = upcoming.length - shown.length;
  const recentShown = recent.slice(0, RECENT_SHOWN);
  const recentMore = recent.length - recentShown.length;
  const recentIssues = recent.filter((file) => file.issues.length > 0).length;

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
            {versions.map((version) => (
              <VersionPill
                key={version.serverId}
                version={version}
                showServer={showServer}
                linkBase={linkBases[version.serverId]}
              />
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
          {recentShown.length > 0 && (
            <div className="mt-5">
              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <History className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                {t('dashboard.recording.recent', { defaultValue: 'Recently Recorded' })}
                <span className="text-muted-foreground text-xs font-normal">
                  {t('dashboard.recording.recentCaption', { defaultValue: 'last 24 hours' })}
                </span>
                {recentIssues > 0 && (
                  <span
                    className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
                    data-testid="recent-issue-count"
                  >
                    {t('dashboard.recording.recentIssues', {
                      defaultValue: '{{count}} with problems',
                      count: recentIssues,
                    })}
                  </span>
                )}
              </h4>
              <ul className="divide-y rounded-xl border">
                {recentShown.map((file) => (
                  <RecentRow
                    key={`${file.serverId}:${file.fileId}`}
                    file={file}
                    now={now}
                    showServer={showServer}
                    linkBase={linkBases[file.serverId]}
                  />
                ))}
              </ul>
              {recentMore > 0 && (
                <p className="text-muted-foreground mt-2 text-xs">
                  {t('dashboard.recording.moreRecent', {
                    defaultValue: '+{{count}} more in the last 24 hours',
                    count: recentMore,
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
