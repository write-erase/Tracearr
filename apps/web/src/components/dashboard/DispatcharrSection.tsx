import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalendarClock,
  CalendarDays,
  CircleDot,
  Film,
  History,
  List,
  Square,
  Tv,
  X,
} from 'lucide-react';
import type {
  DispatcharrEpgSource,
  DispatcharrProviderUsage,
  DispatcharrRecordingEntry,
  DispatcharrServerOverview,
  DispatcharrStreamEntry,
} from '@tracearr/shared';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
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
import { useDispatcharrRecordingAction } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import {
  StartTime,
  VersionPill,
  formatClock,
  useFormatMinutes,
  useNow,
  type ChannelsDvrVersion,
} from '@/components/dashboard/RecordingNowSection';
import { imageProxyUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

const DISPATCHARR_RELEASES = 'https://github.com/Dispatcharr/Dispatcharr/releases/latest';
/** A dev image's updates are pushes to the dev tag on Docker Hub (fork). */
const DISPATCHARR_DEV_TAGS = 'https://hub.docker.com/r/dispatcharr/dispatcharr/tags';

const PILL = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium';
const MUTED = 'bg-muted text-muted-foreground';
const AMBER = 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
const RED = 'bg-red-500/15 text-red-600 dark:text-red-400';

interface DispatcharrSectionProps {
  /** Panel title: the Dispatcharr server's name as entered in Tracearr */
  title?: string;
  /** Undefined while loading; servers that didn't answer are missing from it */
  overview: DispatcharrServerOverview[] | undefined;
  /** Each Dispatcharr server's installed version against its newest release */
  versions?: ChannelsDvrVersion[];
  /** Prefix each pill with its server's name */
  showServer?: boolean;
}

/** "Primary: 1 of 5 connections", amber once every one is taken, like the Channels DVR tuner pill. */
function ConnectionsPill({ provider, name }: { provider: DispatcharrProviderUsage; name: string }) {
  const { t } = useTranslation('pages');
  const { inUse, maxStreams } = provider;
  const full = inUse !== null && maxStreams !== null && inUse >= maxStreams;
  const label =
    inUse === null
      ? t('dashboard.dispatcharr.connectionsUnknown', {
          defaultValue: '{{name}}: connections unknown',
          name,
        })
      : maxStreams === null
        ? t('dashboard.dispatcharr.connectionsUnlimited', {
            defaultValue: '{{name}}: {{inUse}} connections, no limit',
            name,
            inUse,
          })
        : t('dashboard.dispatcharr.connections', {
            defaultValue: '{{name}}: {{inUse}} of {{max}} connections',
            name,
            inUse,
            max: maxStreams,
          });
  return (
    <span
      className={cn(PILL, 'tabular-nums', full ? AMBER : MUTED)}
      title={t('dashboard.dispatcharr.connectionsHint', {
        defaultValue:
          'Counted from the live channels, VOD and catch-up streams Dispatcharr reports: one per channel, however many are watching it',
      })}
      data-testid="dispatcharr-connections"
    >
      {label}
    </span>
  );
}

/**
 * "M3U Primary: refresh failed" or "EPG XMLTV: refresh failed" in red, with Dispatcharr's message
 * on hover. Guide sources are their own list in Dispatcharr, not part of any M3U account.
 */
function FailedRefreshPill({
  source,
  name,
  kind,
}: {
  source: DispatcharrProviderUsage | DispatcharrEpgSource;
  name: string;
  kind: 'provider' | 'guide';
}) {
  const { t } = useTranslation('pages');
  const Icon = kind === 'provider' ? List : CalendarDays;
  const kindLabel =
    kind === 'provider'
      ? t('dashboard.dispatcharr.m3uAccount', { defaultValue: 'M3U account' })
      : t('dashboard.dispatcharr.guideSource', { defaultValue: 'Guide source' });
  return (
    <span
      className={cn(PILL, RED)}
      title={source.lastMessage ? `${kindLabel}: ${source.lastMessage}` : kindLabel}
      data-testid={`dispatcharr-failed-${kind}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {kind === 'provider'
        ? t('dashboard.dispatcharr.m3uFailed', {
            defaultValue: 'M3U {{name}}: refresh failed',
            name,
          })
        : t('dashboard.dispatcharr.epgFailed', {
            defaultValue: 'EPG {{name}}: refresh failed',
            name,
          })}
    </span>
  );
}

/**
 * One provider connection: "ESPN", "Primary · 3 viewers · 1 h 5 min", and a chip per viewer.
 * A live channel lists everyone sharing it.
 */
function StreamRow({
  stream,
  serverId,
  serverName,
  now,
}: {
  stream: DispatcharrStreamEntry;
  serverId: string;
  serverName?: string;
  now: number;
}) {
  const { t } = useTranslation('pages');
  const formatMinutes = useFormatMinutes();
  const started = stream.startedAt ? new Date(stream.startedAt).getTime() : NaN;
  const kind =
    stream.kind === 'vod'
      ? t('dashboard.dispatcharr.kindVod', { defaultValue: 'VOD' })
      : stream.kind === 'catchup'
        ? t('dashboard.dispatcharr.kindCatchup', { defaultValue: 'Catch-up' })
        : null;
  const detail = [
    serverName,
    kind,
    stream.providerName,
    t('dashboard.dispatcharr.viewers', {
      defaultValue_one: '{{count}} viewer',
      defaultValue_other: '{{count}} viewers',
      count: stream.viewers.length,
    }),
    Number.isFinite(started) ? formatMinutes(Math.max(0, (now - started) / 1000)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const Icon = stream.kind === 'vod' ? Film : stream.kind === 'catchup' ? History : Tv;
  return (
    <li className="flex items-center gap-3 px-3 py-2" data-testid="dispatcharr-stream">
      <div className="bg-muted flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded">
        {stream.logoPath ? (
          <img
            src={imageProxyUrl(serverId, stream.logoPath, 96, 64)}
            alt=""
            className="h-full w-full object-contain"
            loading="lazy"
          />
        ) : (
          <Icon className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={stream.title}>
          {stream.title}
        </p>
        <p className="text-muted-foreground truncate text-xs">{detail}</p>
      </div>
      {stream.viewers.length > 0 && (
        <div className="flex max-w-[50%] shrink-0 flex-wrap justify-end gap-1">
          {stream.viewers.map((viewer) => (
            <span
              key={viewer}
              className={cn(PILL, MUTED, 'px-2 py-0.5 text-[11px]')}
              data-testid="dispatcharr-viewer"
            >
              {viewer}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/** How many Coming Up rows show before "+N more", as on the Channels DVR card. */
const UPCOMING_SHOWN = 5;

/** "S36 E5 · Channel 6 · FOX", leaving out whatever isn't known. */
function useRecordingDetail(): (recording: DispatcharrRecordingEntry) => string | null {
  const { t } = useTranslation('pages');
  return (recording) => {
    const episode =
      recording.seasonNumber !== null && recording.episodeNumber !== null
        ? t('dashboard.recording.episode', {
            defaultValue: 'S{{season}} E{{episode}}',
            season: recording.seasonNumber,
            episode: recording.episodeNumber,
          })
        : null;
    const channel = recording.channelNumber
      ? recording.channelName
        ? t('dashboard.recording.channelNamed', {
            defaultValue: 'Channel {{number}} · {{name}}',
            number: recording.channelNumber,
            name: recording.channelName,
          })
        : t('dashboard.recording.channel', {
            defaultValue: 'Channel {{number}}',
            number: recording.channelNumber,
          })
      : recording.channelName;
    const parts = [episode, recording.episodeTitle, channel].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  };
}

/**
 * Owner/admin only, after a confirmation: Stop a recording in progress (Dispatcharr keeps what
 * was recorded) or Cancel a scheduled one, as Dispatcharr's own buttons do.
 */
function RecordingActionButton({
  action,
  recording,
  serverId,
}: {
  action: 'stop' | 'cancel';
  recording: DispatcharrRecordingEntry;
  serverId: string;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const mutation = useDispatcharrRecordingAction(action);
  if (user?.role !== 'admin' && user?.role !== 'owner') return null;

  const label =
    action === 'stop'
      ? t('dashboard.recording.stop', { defaultValue: 'Stop' })
      : t('dashboard.recording.cancel', { defaultValue: 'Cancel recording' });
  const Icon = action === 'stop' ? Square : X;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-6 w-6 shrink-0"
        title={label}
        aria-label={label}
        data-testid={`dispatcharr-${action}`}
        onClick={() => setOpen(true)}
      >
        <Icon className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {action === 'stop'
                ? t('dashboard.recording.stopTitle', { defaultValue: 'Stop recording?' })
                : t('dashboard.recording.cancelTitle', { defaultValue: 'Cancel this recording?' })}
            </DialogTitle>
            <DialogDescription>
              {action === 'stop'
                ? t('dashboard.dispatcharr.stopConfirm', {
                    defaultValue:
                      'Stop recording "{{title}}" now? What has been recorded so far stays in Dispatcharr.',
                    title: recording.title,
                  })
                : t('dashboard.dispatcharr.cancelConfirm', {
                    defaultValue:
                      'Cancel "{{title}}" at {{time}}? It will be removed from your Dispatcharr recordings.',
                    title: recording.title,
                    time: formatClock(recording.startsAt),
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              {action === 'stop'
                ? t('common:actions.cancel')
                : t('dashboard.recording.keep', { defaultValue: 'Keep it' })}
            </Button>
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate(
                  { serverId, recordingId: recording.id },
                  { onSuccess: () => setOpen(false) }
                )
              }
            >
              {mutation.isPending
                ? action === 'stop'
                  ? t('dashboard.recording.stopping', { defaultValue: 'Stopping…' })
                  : t('dashboard.recording.cancelling', { defaultValue: 'Cancelling…' })
                : label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A recording in progress, laid out like the Channels DVR card's: badge, times, progress, Stop. */
function DvrRecordingCard({
  recording,
  serverId,
  serverName,
  now,
}: {
  recording: DispatcharrRecordingEntry;
  serverId: string;
  serverName?: string;
  now: number;
}) {
  const { t } = useTranslation('pages');
  const detail = useRecordingDetail()(recording);
  const start = Date.parse(recording.startsAt);
  const end = Date.parse(recording.endsAt);
  const percent =
    end > start ? Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100)) : 0;
  const minutesLeft = Math.max(0, Math.ceil((end - now) / 60_000));
  const timeWindow = `${formatClock(recording.startsAt)}–${formatClock(recording.endsAt)}`;
  return (
    <div className="bg-card flex gap-3 rounded-xl border p-3" data-testid="dispatcharr-recording">
      <div className="bg-muted flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md">
        {recording.logoPath ? (
          <img
            src={imageProxyUrl(serverId, recording.logoPath, 192, 128)}
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
          {serverName && (
            <span className="text-muted-foreground truncate text-xs">{serverName}</span>
          )}
          <span className="ml-auto" />
          <RecordingActionButton action="stop" recording={recording} serverId={serverId} />
        </div>
        <h3 className="mt-1 truncate text-sm leading-tight font-semibold" title={recording.title}>
          {recording.title}
        </h3>
        <p className="text-muted-foreground truncate text-xs">
          {[detail, timeWindow].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Progress value={percent} className="h-1.5 flex-1" />
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {t('dashboard.recording.minutesLeft', {
              defaultValue: '{{count}} min left',
              count: minutesLeft,
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

/** A recording starting in the next day: time, logo, title, Cancel. */
function DvrUpcomingRow({
  recording,
  serverId,
  serverName,
  now,
}: {
  recording: DispatcharrRecordingEntry;
  serverId: string;
  serverName?: string;
  now: number;
}) {
  const detail = useRecordingDetail()(recording);
  return (
    <li className="flex items-center gap-3 px-3 py-2" data-testid="dispatcharr-upcoming">
      <span className="text-muted-foreground w-28 shrink-0 text-xs font-medium tabular-nums">
        <StartTime iso={recording.startsAt} now={now} />
      </span>
      <div className="bg-muted flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded">
        {recording.logoPath ? (
          <img
            src={imageProxyUrl(serverId, recording.logoPath, 96, 64)}
            alt=""
            className="h-full w-full object-contain"
            loading="lazy"
          />
        ) : (
          <CalendarClock className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={recording.title}>
          {recording.title}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {[detail, serverName].filter(Boolean).join(' · ')}
        </p>
      </div>
      <RecordingActionButton action="cancel" recording={recording} serverId={serverId} />
    </li>
  );
}

/**
 * The Dispatcharr panel (fork), all pills like the Channels DVR one: each M3U account's provider
 * connections and the version in the header; below it any M3U account or guide source whose last
 * refresh failed, then Streaming Now: one row per provider connection with who's watching. Shown whenever a Dispatcharr server is selected; beside the Channels DVR panel
 * when one of those is selected too.
 */
export function DispatcharrSection({
  title,
  overview,
  versions = [],
  showServer = false,
}: DispatcharrSectionProps) {
  const { t } = useTranslation('pages');
  const now = useNow();
  if (!overview) return null;

  const named = (server: DispatcharrServerOverview, name: string) =>
    showServer ? `${server.serverName} · ${name}` : name;
  const providers = overview.flatMap((server) =>
    server.providers.map((provider) => ({ provider, server }))
  );
  const streams = overview.flatMap((server) =>
    server.streams.map((stream) => ({ stream, server }))
  );
  const recordings = overview.flatMap((server) =>
    server.recordings.map((recording) => ({ recording, server }))
  );
  const upcoming = overview
    .flatMap((server) => server.upcoming.map((recording) => ({ recording, server })))
    .sort((a, b) => a.recording.startsAt.localeCompare(b.recording.startsAt));
  const upcomingShown = upcoming.slice(0, UPCOMING_SHOWN);
  const upcomingMore = upcoming.length - upcomingShown.length;
  // Refreshes only show when one failed.
  const failedProviders = providers.filter(({ provider }) => provider.status === 'error');
  const failedSources = overview.flatMap((server) =>
    server.epgSources
      .filter((source) => source.status === 'error')
      .map((source) => ({ source, server }))
  );

  return (
    <section>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <MediaServerIcon type="dispatcharr" className="h-4 w-4 rounded-sm" alt="" />
            {title ?? t('dashboard.dispatcharr.panelTitle', { defaultValue: 'Dispatcharr' })}
            {providers.map(({ provider, server }) => (
              <ConnectionsPill
                key={`${server.serverId}:${provider.id}`}
                provider={provider}
                name={named(server, provider.name)}
              />
            ))}
            {versions.map((version) => (
              <VersionPill
                key={version.serverId}
                version={version}
                showServer={showServer}
                linkBase={
                  version.installed.includes('-dev.') ? DISPATCHARR_DEV_TAGS : DISPATCHARR_RELEASES
                }
              />
            ))}
          </CardTitle>
        </CardHeader>
        {overview.length === 0 ? (
          <CardContent>
            <p className="text-muted-foreground text-sm" data-testid="dispatcharr-unreachable">
              {t('dashboard.dispatcharr.unreachable', {
                defaultValue:
                  "Dispatcharr didn't answer. Its streams still show under Now Playing.",
              })}
            </p>
          </CardContent>
        ) : (
          <CardContent>
            {failedProviders.length + failedSources.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {failedProviders.map(({ provider, server }) => (
                  <FailedRefreshPill
                    key={`p:${server.serverId}:${provider.id}`}
                    source={provider}
                    name={named(server, provider.name)}
                    kind="provider"
                  />
                ))}
                {failedSources.map(({ source, server }) => (
                  <FailedRefreshPill
                    key={`g:${server.serverId}:${source.id}`}
                    source={source}
                    name={named(server, source.name)}
                    kind="guide"
                  />
                ))}
              </div>
            )}
            <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <span
                className={
                  streams.length > 0
                    ? 'h-2 w-2 rounded-full bg-emerald-500'
                    : 'bg-muted-foreground/40 h-2 w-2 rounded-full'
                }
                aria-hidden="true"
              />
              {t('dashboard.dispatcharr.streamingNow', { defaultValue: 'Streaming Now' })}
              {streams.length > 0 && (
                <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-xs font-medium">
                  {streams.length}
                </span>
              )}
            </h4>
            {streams.length > 0 ? (
              <ul className="divide-y rounded-xl border">
                {streams.map(({ stream, server }) => (
                  <StreamRow
                    key={`${server.serverId}:${stream.key}`}
                    stream={stream}
                    serverId={server.serverId}
                    serverName={showServer ? server.serverName : undefined}
                    now={now}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm" data-testid="dispatcharr-idle">
                {t('dashboard.dispatcharr.nothingStreaming', {
                  defaultValue: 'Nothing streaming.',
                })}
              </p>
            )}
            <h4 className="mt-5 mb-2 flex items-center gap-2 text-sm font-semibold">
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
              <div className="grid gap-4 sm:grid-cols-2">
                {recordings.map(({ recording, server }) => (
                  <DvrRecordingCard
                    key={`${server.serverId}:${recording.id}`}
                    recording={recording}
                    serverId={server.serverId}
                    serverName={showServer ? server.serverName : undefined}
                    now={now}
                  />
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm" data-testid="dispatcharr-not-recording">
                {t('dashboard.recording.nothingRecording', {
                  defaultValue: 'Nothing, absolutely nothing.',
                })}
              </p>
            )}
            {upcomingShown.length > 0 && (
              <div className="mt-5">
                <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <CalendarClock className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                  {t('dashboard.recording.comingUp', { defaultValue: 'Coming Up' })}
                  <span className="text-muted-foreground text-xs font-normal">
                    {t('dashboard.recording.comingUpCaption', { defaultValue: 'next 24 hours' })}
                  </span>
                </h4>
                <ul className="divide-y rounded-xl border">
                  {upcomingShown.map(({ recording, server }) => (
                    <DvrUpcomingRow
                      key={`${server.serverId}:${recording.id}`}
                      recording={recording}
                      serverId={server.serverId}
                      serverName={showServer ? server.serverName : undefined}
                      now={now}
                    />
                  ))}
                </ul>
                {upcomingMore > 0 && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    {t('dashboard.recording.moreComingUp', {
                      defaultValue: '+{{count}} more in the next 24 hours',
                      count: upcomingMore,
                    })}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </section>
  );
}
