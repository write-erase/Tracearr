import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleDot, Square } from 'lucide-react';
import type { ChannelsDvrRecordingEntry } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
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
import { useStopRecording } from '@/hooks/queries';
import { imageProxyUrl } from '@/lib/api';
import { SectionHeading } from './SectionHeading';

interface RecordingNowSectionProps {
  /** Undefined while loading or when no Channels DVR server is selected */
  recordings: ChannelsDvrRecordingEntry[] | undefined;
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

/**
 * Channels DVR recordings in progress. Kept apart from Now Playing on purpose:
 * recordings are not viewers, so they never count as streams, plays or users.
 * Renders nothing when nothing is recording.
 */
export function RecordingNowSection({ recordings, showServer = false }: RecordingNowSectionProps) {
  const { t } = useTranslation('pages');
  const now = useNow();
  if (!recordings || recordings.length === 0) return null;

  return (
    <section>
      <SectionHeading
        icon={CircleDot}
        title={t('dashboard.recording.title', { defaultValue: 'Recording Now' })}
      >
        <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-xs font-medium">
          {recordings.length}
        </span>
      </SectionHeading>
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
    </section>
  );
}
