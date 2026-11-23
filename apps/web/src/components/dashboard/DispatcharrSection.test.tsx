import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  DispatcharrEpgSource,
  DispatcharrProviderUsage,
  DispatcharrServerOverview,
  Server,
} from '@tracearr/shared';
import { DispatcharrSection } from './DispatcharrSection';
import { serverVersionsFor } from './RecordingNowSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const rest = Object.fromEntries(
        Object.entries(options ?? {}).filter(([name]) => !name.startsWith('defaultValue'))
      );
      return Object.keys(rest).length > 0 ? `${key}:${JSON.stringify(rest)}` : key;
    },
  }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'owner' } }) }));
vi.mock('@/hooks/queries', () => ({
  useStopRecording: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelRecording: () => ({ mutate: vi.fn(), isPending: false }),
  useSkipRecording: () => ({ mutate: vi.fn(), isPending: false }),
}));

function provider(overrides: Partial<DispatcharrProviderUsage> = {}): DispatcharrProviderUsage {
  return {
    id: 1,
    name: 'Provider One',
    status: 'success',
    lastMessage: null,
    refreshedAt: null,
    inUse: 1,
    maxStreams: 2,
    ...overrides,
  };
}

function guide(overrides: Partial<DispatcharrEpgSource> = {}): DispatcharrEpgSource {
  return {
    id: 5,
    name: 'XMLTV',
    status: 'success',
    lastMessage: null,
    refreshedAt: null,
    ...overrides,
  };
}

function server(overrides: Partial<DispatcharrServerOverview> = {}): DispatcharrServerOverview {
  return {
    serverId: 'd1',
    serverName: 'Dispatcharr',
    providers: [provider()],
    epgSources: [guide()],
    streams: [],
    ...overrides,
  };
}

describe('DispatcharrSection', () => {
  it("shows Dispatcharr's own logo before the title", () => {
    const { container } = render(<DispatcharrSection overview={[server()]} />);
    const logo = container.querySelector('[data-slot="card-title"] img');
    expect(logo?.getAttribute('src')).toContain('images/servers/dispatcharr.png');
  });

  it('renders nothing while the overview is loading', () => {
    const { container } = render(<DispatcharrSection overview={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says so when Dispatcharr did not answer', () => {
    render(<DispatcharrSection overview={[]} />);
    expect(screen.getByTestId('dispatcharr-unreachable')).toBeInTheDocument();
  });

  it('shows a connections pill per provider in the header, amber once every one is taken', () => {
    render(
      <DispatcharrSection
        overview={[
          server({
            providers: [
              provider({ id: 1, name: 'Primary', inUse: 1, maxStreams: 5 }),
              provider({ id: 2, name: 'Full', inUse: 2, maxStreams: 2 }),
              provider({ id: 3, name: 'Open', inUse: 3, maxStreams: null }),
              provider({ id: 4, name: 'Unknown', inUse: null }),
            ],
          }),
        ]}
      />
    );
    const pills = screen.getAllByTestId('dispatcharr-connections');
    expect(pills[0]).toHaveTextContent(
      'dashboard.dispatcharr.connections:{"name":"Primary","inUse":1,"max":5}'
    );
    expect(pills[0]?.className).not.toContain('amber');
    expect(pills[1]?.className).toContain('amber');
    expect(pills[2]).toHaveTextContent(
      'dashboard.dispatcharr.connectionsUnlimited:{"name":"Open","inUse":3}'
    );
    expect(pills[3]).toHaveTextContent(
      'dashboard.dispatcharr.connectionsUnknown:{"name":"Unknown"}'
    );
    expect(pills[0]?.closest('h3, [data-slot="card-title"]')).not.toBeNull();
  });

  it("shows only failed refreshes below the header, with Dispatcharr's message on hover", () => {
    render(
      <DispatcharrSection
        overview={[
          server({
            providers: [
              provider({ id: 1, name: 'Primary', status: 'error', lastMessage: 'HTTP 401' }),
              provider({ id: 2, name: 'Secondary', status: 'fetching' }),
            ],
            epgSources: [
              guide({ id: 5, name: 'XMLTV', status: 'error' }),
              guide({ id: 6, name: 'SD', status: 'success' }),
            ],
          }),
        ]}
      />
    );
    const account = screen.getByTestId('dispatcharr-failed-provider');
    expect(account).toHaveTextContent('dashboard.dispatcharr.m3uFailed:{"name":"Primary"}');
    expect(account.className).toContain('red');
    expect(account.getAttribute('title')).toContain('HTTP 401');
    expect(screen.getAllByTestId('dispatcharr-failed-guide')).toHaveLength(1);
    expect(screen.getByTestId('dispatcharr-failed-guide')).toHaveTextContent(
      'dashboard.dispatcharr.epgFailed:{"name":"XMLTV"}'
    );
  });

  it('shows no refresh pills when nothing failed, and says when nothing is streaming', () => {
    render(
      <DispatcharrSection
        overview={[server({ epgSources: [guide({ refreshedAt: new Date().toISOString() })] })]}
      />
    );
    expect(screen.queryByTestId(/dispatcharr-failed-/)).not.toBeInTheDocument();
    expect(screen.getByTestId('dispatcharr-idle')).toHaveTextContent(
      'dashboard.dispatcharr.nothingStreaming'
    );
  });

  it('lists each stream with its provider, viewer count, time and a chip per viewer', () => {
    const startedAt = new Date(Date.now() - 65 * 60 * 1000).toISOString();
    render(
      <DispatcharrSection
        overview={[
          server({
            streams: [
              {
                key: 'live:espn',
                kind: 'live',
                title: 'ESPN',
                logoPath: '/api/channels/logos/1/cache/',
                providerName: 'Primary',
                startedAt,
                viewers: ['Joe', 'Mom', 'Channels DVR'],
              },
              {
                key: 'vod:1',
                kind: 'vod',
                title: 'A Movie',
                logoPath: null,
                providerName: 'Secondary',
                startedAt: null,
                viewers: ['Joe'],
              },
            ],
          }),
        ]}
      />
    );
    const [live, vod] = screen.getAllByTestId('dispatcharr-stream');
    expect(live).toHaveTextContent('ESPN');
    expect(live).toHaveTextContent('Primary');
    expect(live).toHaveTextContent('dashboard.dispatcharr.viewers:{"count":3}');
    expect(live).toHaveTextContent('dashboard.recording.hoursMinutes');
    expect(live?.querySelectorAll('[data-testid="dispatcharr-viewer"]')).toHaveLength(3);
    expect(live?.querySelector('img')?.getAttribute('src')).toContain('logos');
    expect(vod).toHaveTextContent('dashboard.dispatcharr.kindVod');
    expect(vod).toHaveTextContent('Secondary');
  });

  it('prefixes each pill with its server when several are selected', () => {
    render(
      <DispatcharrSection
        overview={[server(), server({ serverId: 'd2', serverName: 'Second' })]}
        showServer
      />
    );
    expect(screen.getAllByTestId('dispatcharr-connections')[1]).toHaveTextContent(
      'Second · Provider One'
    );
  });

  it('shows the version pill, linking to the Dispatcharr releases', () => {
    const versions = serverVersionsFor(
      [
        {
          id: 'd1',
          name: 'Dispatcharr',
          type: 'dispatcharr',
          version: '0.33.0',
          latestVersion: '0.34.1',
        } as Server,
      ],
      'dispatcharr'
    );
    render(<DispatcharrSection overview={[server()]} versions={versions} />);
    expect(screen.getByTestId('dvr-update')).toHaveAttribute(
      'href',
      'https://github.com/Dispatcharr/Dispatcharr/releases/latest'
    );
  });
});
