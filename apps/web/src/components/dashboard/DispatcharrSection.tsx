import { useTranslation } from 'react-i18next';
import { CalendarDays, Film, History, List, Tv } from 'lucide-react';
import type {
  DispatcharrEpgSource,
  DispatcharrProviderUsage,
  DispatcharrServerOverview,
  DispatcharrStreamEntry,
} from '@tracearr/shared';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  VersionPill,
  useFormatMinutes,
  useNow,
  type ChannelsDvrVersion,
} from '@/components/dashboard/RecordingNowSection';
import { imageProxyUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

const DISPATCHARR_RELEASES = 'https://github.com/Dispatcharr/Dispatcharr/releases/latest';

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
                linkBase={DISPATCHARR_RELEASES}
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
          </CardContent>
        )}
      </Card>
    </section>
  );
}
