import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChannelsDvrTunerUsage, ChannelsDvrUpcomingEntry } from '@tracearr/shared';
import type { Server } from '@tracearr/shared';
import { RecordingNowSection, channelsUpdatesFor } from './RecordingNowSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'owner' } }) }));
vi.mock('@/hooks/queries', () => ({
  useStopRecording: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelRecording: () => ({ mutate: vi.fn(), isPending: false }),
  useSkipRecording: () => ({ mutate: skipMutate, isPending: false }),
}));

const skipMutate = vi.fn();

const NOW = new Date(2026, 10, 11, 12, 30);

function upcoming(overrides: Partial<ChannelsDvrUpcomingEntry> = {}): ChannelsDvrUpcomingEntry {
  return {
    serverId: 'cdvr',
    serverName: 'Channels',
    jobId: '1794427200-ch1',
    title: 'The Jennifer Hudson Show',
    episodeTitle: null,
    seasonNumber: 5,
    episodeNumber: 43,
    channelNumber: '1',
    channelTitle: 'ABC KOCO',
    showId: 'The Jennifer Hudson Show',
    startsAt: new Date(2026, 10, 11, 14, 0).toISOString(),
    endsAt: new Date(2026, 10, 11, 15, 0).toISOString(),
    thumbPath: null,
    skipped: false,
    fromPass: false,
    ...overrides,
  };
}

const tuners = (inUse: number, total = 5): ChannelsDvrTunerUsage[] => [
  { serverId: 'cdvr', serverName: 'Channels', inUse, total },
];

describe('RecordingNowSection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('renders nothing until the schedule has loaded (or with no Channels DVR server)', () => {
    const { container } = render(<RecordingNowSection recordings={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the panel even when the DVR is idle', () => {
    render(<RecordingNowSection recordings={[]} upcoming={[]} tuners={tuners(0)} />);
    expect(screen.getByText(/dashboard\.recording\.nothingRecording/)).toBeTruthy();
    expect(screen.getByTestId('tuner-usage').textContent).toMatch(/"inUse":0,"total":5/);
  });

  it('lists the coming-up recordings with episode and channel', () => {
    render(<RecordingNowSection recordings={[]} upcoming={[upcoming()]} tuners={tuners(0)} />);
    expect(
      screen.getByText('dashboard.recording.comingUp:{"defaultValue":"Coming Up"}')
    ).toBeTruthy();
    expect(screen.getByText('The Jennifer Hudson Show')).toBeTruthy();
    expect(screen.getByText(/dashboard\.recording\.episode.*"season":5,"episode":43/)).toBeTruthy();
    expect(screen.getByText(/dashboard\.recording\.nothingRecording/)).toBeTruthy();
  });

  it('marks tomorrow’s recordings', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        upcoming={[upcoming({ startsAt: new Date(2026, 10, 12, 7, 0).toISOString() })]}
      />
    );
    expect(screen.getByText(/dashboard\.recording\.tomorrow/)).toBeTruthy();
  });

  it("titles the panel with the server's name, falling back to Channels DVR", () => {
    const { rerender } = render(
      <RecordingNowSection title="Basement DVR" recordings={[]} upcoming={[upcoming()]} />
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toMatch(/^Basement DVR/);

    rerender(<RecordingNowSection recordings={[]} upcoming={[upcoming()]} />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toMatch(/panelTitle/);
  });

  it('shows tuner usage, highlighted when every tuner is busy', () => {
    const { rerender } = render(<RecordingNowSection recordings={[]} tuners={tuners(2)} />);
    const pill = screen.getByTestId('tuner-usage');
    expect(pill.textContent).toMatch(/"inUse":2,"total":5/);
    expect(pill.className).not.toMatch(/amber/);

    rerender(<RecordingNowSection recordings={[]} tuners={tuners(5)} />);
    expect(screen.getByTestId('tuner-usage').className).toMatch(/amber/);
  });

  it('shows free disk space in Channels units, amber below the alert threshold', () => {
    const disk = (freeBytes: number, warnPercent = 10) => [
      {
        serverId: 'cdvr',
        serverName: 'Channels',
        freeBytes,
        totalBytes: 315923169280,
        warnPercent,
      },
    ];
    const { rerender } = render(<RecordingNowSection recordings={[]} disks={disk(200396926976)} />);
    const pill = screen.getByTestId('disk-usage');
    expect(pill.textContent).toMatch(/"free":"186\.6 GB"/);
    expect(pill.className).not.toMatch(/amber/);

    rerender(<RecordingNowSection recordings={[]} disks={disk(20_000_000_000)} />);
    expect(screen.getByTestId('disk-usage').className).toMatch(/amber/);

    // A disk alert set to 70% moves the warning up with it: 63% free is now low.
    rerender(<RecordingNowSection recordings={[]} disks={disk(200396926976, 70)} />);
    expect(screen.getByTestId('disk-usage').className).toMatch(/amber/);
  });

  it('links a queued show to the Channels DVR schedule page', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        upcoming={[upcoming()]}
        linkBases={{ cdvr: 'http://192.168.30.241:8089' }}
      />
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'http://192.168.30.241:8089/admin/dvr/jobs'
    );
  });

  it('offers owners a cancel button on each queued recording', () => {
    render(<RecordingNowSection recordings={[]} upcoming={[upcoming()]} />);
    expect(screen.getByRole('button', { name: /dashboard\.recording\.cancel\b/ })).toBeTruthy();
  });

  it('offers skip instead of cancel for an airing a series pass scheduled', () => {
    skipMutate.mockClear();
    render(<RecordingNowSection recordings={[]} upcoming={[upcoming({ fromPass: true })]} />);
    expect(screen.queryByRole('button', { name: /dashboard\.recording\.cancel\b/ })).toBeNull();
    screen.getByRole('button', { name: /dashboard\.recording\.skip\b/ }).click();
    expect(skipMutate).toHaveBeenCalledWith({
      serverId: 'cdvr',
      jobId: '1794427200-ch1',
      skipped: true,
    });
  });

  it('keeps a skipped airing listed, marked skipped, with an unskip button', () => {
    skipMutate.mockClear();
    render(
      <RecordingNowSection
        recordings={[]}
        upcoming={[upcoming({ fromPass: true, skipped: true })]}
      />
    );
    expect(screen.getByText(/dashboard\.recording\.skipped\b/)).toBeTruthy();
    screen.getByRole('button', { name: /dashboard\.recording\.unskip\b/ }).click();
    expect(skipMutate).toHaveBeenCalledWith({
      serverId: 'cdvr',
      jobId: '1794427200-ch1',
      skipped: false,
    });
  });

  it('caps the list and says how many more are queued', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      upcoming({ jobId: `job-${i}`, title: `Show ${i}` })
    );
    render(<RecordingNowSection recordings={[]} upcoming={many} />);
    expect(screen.getByText('Show 4')).toBeTruthy();
    expect(screen.queryByText('Show 5')).toBeNull();
    expect(screen.getByText(/dashboard\.recording\.moreComingUp.*"count":2/)).toBeTruthy();
  });
});

describe('Channels DVR update pill', () => {
  const server = (overrides: Partial<Server> = {}): Server => ({
    id: 'cdvr',
    name: 'Basement DVR',
    type: 'channels_dvr',
    url: 'http://192.168.30.241:8089',
    version: '2026.11.11.2228',
    latestVersion: '2026.11.12.0900',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it('lists Channels DVR servers with a newer release, and only those', () => {
    expect(channelsUpdatesFor([server()])).toEqual([
      {
        serverId: 'cdvr',
        serverName: 'Basement DVR',
        installed: '2026.11.11.2228',
        latest: '2026.11.12.0900',
      },
    ]);
    expect(channelsUpdatesFor([server({ latestVersion: '2026.11.11.2228' })])).toEqual([]);
    expect(channelsUpdatesFor([server({ latestVersion: null })])).toEqual([]);
    expect(channelsUpdatesFor([server({ type: 'plex' })])).toEqual([]);
  });

  it('shows a pill that opens the Channels DVR web UI', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        updates={channelsUpdatesFor([server()])}
        linkBases={{ cdvr: 'http://192.168.30.241:8089/' }}
      />
    );
    const pill = screen.getByTestId('dvr-update');
    expect(pill.getAttribute('href')).toBe('http://192.168.30.241:8089');
    expect(pill.getAttribute('title')).toMatch(/2026\.11\.12\.0900/);
  });

  it('shows no pill when nothing is waiting', () => {
    render(<RecordingNowSection recordings={[]} updates={[]} />);
    expect(screen.queryByTestId('dvr-update')).toBeNull();
  });
});
