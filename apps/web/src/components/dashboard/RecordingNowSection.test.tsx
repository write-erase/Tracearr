import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  ChannelsDvrRecentEntry,
  ChannelsDvrStreamEntry,
  ChannelsDvrTunerUsage,
  ChannelsDvrUpcomingEntry,
} from '@tracearr/shared';
import type { Server } from '@tracearr/shared';
import { RecordingNowSection, channelsVersionsFor } from './RecordingNowSection';

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
  useClearRecordingIssues: () => ({ mutate: clearMutate, isPending: false }),
}));

const skipMutate = vi.fn();
const clearMutate = vi.fn();

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
    conflict: null,
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

  it("shows Channels DVR's own logo before the title", () => {
    const { container } = render(<RecordingNowSection recordings={[]} />);
    const logo = container.querySelector('[data-slot="card-title"] img');
    expect(logo?.getAttribute('src')).toContain('images/servers/channels-dvr.svg');
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

describe('Coming Up tuner conflicts', () => {
  it('marks a queued recording that needs more tuners than its source has', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        upcoming={[
          upcoming({ conflict: { source: 'HDHomeRun', tuners: 2, overlapping: 3 } }),
          upcoming({ jobId: 'other', title: 'Other' }),
        ]}
      />
    );
    const flags = screen.getAllByTestId('tuner-conflict');
    expect(flags).toHaveLength(1);
    expect(flags[0]?.textContent).toContain('"overlapping":3');
    expect(flags[0]?.getAttribute('title')).toContain('HDHomeRun');
  });

  it('shows no conflict when everything fits', () => {
    render(<RecordingNowSection recordings={[]} upcoming={[upcoming()]} />);
    expect(screen.queryByTestId('tuner-conflict')).toBeNull();
  });
});

describe('Recently Recorded', () => {
  const recent = (overrides: Partial<ChannelsDvrRecentEntry> = {}): ChannelsDvrRecentEntry => ({
    serverId: 'cdvr',
    serverName: 'Channels',
    fileId: '1353',
    jobId: '1794874205-ch1',
    showId: 'KOCO 5 News at 6pm',
    title: 'KOCO 5 News at 6pm',
    episodeTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    channelNumber: '1',
    startedAt: new Date(2026, 10, 11, 11, 0).toISOString(),
    endedAt: new Date(2026, 10, 11, 11, 30).toISOString(),
    durationSec: 1800,
    scheduledSec: 1800,
    thumbPath: null,
    issues: [],
    issuesCleared: false,
    ...overrides,
  });

  it('lists finished recordings, linked to the show in Channels DVR', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        recent={[recent()]}
        linkBases={{ cdvr: 'http://192.168.30.241:8089/' }}
      />
    );
    const row = screen.getByTestId('recent-recording');
    expect(row.querySelector('a')?.getAttribute('href')).toBe(
      'http://192.168.30.241:8089/admin/shows/KOCO%205%20News%20at%206pm'
    );
    expect(screen.queryByTestId('recording-issue')).toBeNull();
    expect(screen.queryByTestId('recent-issue-count')).toBeNull();
  });

  it('badges recordings that went wrong and counts them in the heading', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        recent={[
          recent({ issues: ['interrupted'] }),
          recent({ fileId: '2', issues: ['stoppedEarly', 'startedLate'], durationSec: 180 }),
          recent({ fileId: '3' }),
        ]}
      />
    );
    expect(
      screen.getAllByTestId('recording-issue').map((b) => b.textContent?.split(':')[0])
    ).toEqual([
      'dashboard.recording.issueInterrupted',
      'dashboard.recording.issueStoppedEarly',
      'dashboard.recording.issueStartedLate',
    ]);
    expect(screen.getByTestId('recent-issue-count').textContent).toContain('"count":2');
    // A short recording says how much of its scheduled time it got
    expect(screen.getAllByTestId('recent-recording')[1]?.textContent).toContain(
      'dashboard.recording.recordedOf'
    );
  });

  it('stops flagging a recording whose alert was cleared, and leaves it listed (fork)', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        recent={[
          recent({ issues: ['stoppedEarly'], issuesCleared: true }),
          recent({ fileId: '2', issues: ['interrupted'] }),
        ]}
      />
    );
    expect(screen.getAllByTestId('recent-recording')).toHaveLength(2);
    expect(screen.getAllByTestId('recording-issue')).toHaveLength(1);
    expect(screen.getByTestId('recent-issue-count').textContent).toContain('"count":1');
    // One left: its own X clears it, so there is no Clear all
    expect(screen.queryByTestId('recent-clear-all')).toBeNull();
  });

  it("clears one recording's alert from its row (fork)", () => {
    clearMutate.mockClear();
    render(<RecordingNowSection recordings={[]} recent={[recent({ issues: ['stoppedEarly'] })]} />);
    fireEvent.click(screen.getByTestId('recent-clear'));
    expect(clearMutate).toHaveBeenCalledWith([{ serverId: 'cdvr', fileId: '1353' }]);
  });

  it('clears every flagged recording at once, the ones past the first five too (fork)', () => {
    clearMutate.mockClear();
    render(
      <RecordingNowSection
        recordings={[]}
        recent={[
          ...Array.from({ length: 6 }, (_, i) => recent({ fileId: String(i) })),
          recent({ fileId: 'a', issues: ['stoppedEarly'] }),
          recent({ fileId: 'b', issues: ['startedLate'], issuesCleared: true }),
          recent({ fileId: 'c', issues: ['interrupted'] }),
        ]}
      />
    );
    fireEvent.click(screen.getByTestId('recent-clear-all'));
    expect(clearMutate).toHaveBeenCalledWith([
      { serverId: 'cdvr', fileId: 'a' },
      { serverId: 'cdvr', fileId: 'c' },
    ]);
  });

  it('shows five and says how many more', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        recent={Array.from({ length: 7 }, (_, i) => recent({ fileId: String(i) }))}
      />
    );
    expect(screen.getAllByTestId('recent-recording')).toHaveLength(5);
    expect(screen.getByText(/dashboard\.recording\.moreRecent/).textContent).toContain('"count":2');
  });

  it('is left out when nothing finished in the last day', () => {
    render(<RecordingNowSection recordings={[]} recent={[]} />);
    expect(screen.queryByTestId('recent-recording')).toBeNull();
  });
});

describe('Channels DVR version pill', () => {
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

  it('lists every Channels DVR server with both versions known', () => {
    expect(channelsVersionsFor([server()])).toEqual([
      {
        serverId: 'cdvr',
        serverName: 'Basement DVR',
        installed: '2026.11.11.2228',
        latest: '2026.11.12.0900',
        updateAvailable: true,
      },
    ]);
    expect(channelsVersionsFor([server({ latestVersion: '2026.11.11.2228' })])).toEqual([
      expect.objectContaining({ serverId: 'cdvr', updateAvailable: false }),
    ]);
    expect(channelsVersionsFor([server({ latestVersion: null })])).toEqual([]);
    expect(channelsVersionsFor([server({ version: null })])).toEqual([]);
    expect(channelsVersionsFor([server({ type: 'plex' })])).toEqual([]);
  });

  it('counts a server ahead of the latest release as up to date', () => {
    expect(channelsVersionsFor([server({ version: '2026.11.13.0100' })])).toEqual([
      expect.objectContaining({ updateAvailable: false }),
    ]);
  });

  it('shows an update pill that opens the Channels DVR web UI', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        versions={channelsVersionsFor([server()])}
        linkBases={{ cdvr: 'http://192.168.30.241:8089/' }}
      />
    );
    const pill = screen.getByTestId('dvr-update');
    expect(pill.getAttribute('href')).toBe('http://192.168.30.241:8089');
    expect(pill.getAttribute('title')).toMatch(/2026\.11\.12\.0900/);
    expect(screen.queryByTestId('dvr-up-to-date')).toBeNull();
  });

  it('shows an up-to-date pill once the latest release is installed', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        versions={channelsVersionsFor([server({ version: '2026.11.12.0900' })])}
      />
    );
    const pill = screen.getByTestId('dvr-up-to-date');
    expect(pill.textContent).toContain('dashboard.recording.upToDate');
    expect(pill.getAttribute('title')).toMatch(/2026\.11\.12\.0900/);
    expect(screen.queryByTestId('dvr-update')).toBeNull();
  });

  it('names the server on each pill when several are shown', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        showServer
        versions={channelsVersionsFor([
          server(),
          server({ id: 'cdvr2', name: 'Attic DVR', version: '2026.11.12.0900' }),
        ])}
      />
    );
    const update = screen.getByTestId('dvr-update').textContent;
    const current = screen.getByTestId('dvr-up-to-date').textContent;
    expect(update).toContain('updateOnServer');
    expect(update).toContain('Basement DVR');
    expect(current).toContain('upToDateOnServer');
    expect(current).toContain('Attic DVR');
  });

  it('shows no pill when no versions are known', () => {
    render(<RecordingNowSection recordings={[]} versions={[]} />);
    expect(screen.queryByTestId('dvr-update')).toBeNull();
    expect(screen.queryByTestId('dvr-up-to-date')).toBeNull();
  });
});

describe('RecordingNowSection streaming now (fork)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const stream = (overrides: Partial<ChannelsDvrStreamEntry> = {}): ChannelsDvrStreamEntry => ({
    serverId: 'cdvr',
    serverName: 'Channels',
    channelNumber: '4',
    channelTitle: 'NBC KFOR',
    thumbPath: '/dvr/guide/channels/4/logo',
    sourceName: 'Trilo',
    startedAt: new Date(NOW.getTime() - 35 * 60_000).toISOString(),
    recording: false,
    viewers: ['Apple TV', "Craig's Apple TV"],
    ...overrides,
  });

  it('says nothing is streaming when no client is watching live TV', () => {
    render(<RecordingNowSection recordings={[]} streams={[]} />);
    expect(screen.getByTestId('channels-streaming-idle')).toBeTruthy();
    expect(screen.queryByTestId('channels-stream')).toBeNull();
  });

  it('shows one row per shared stream, with its source, viewer count and a chip per client', () => {
    render(<RecordingNowSection recordings={[]} streams={[stream()]} />);

    const row = screen.getByTestId('channels-stream');
    expect(row.textContent).toContain('NBC KFOR');
    expect(row.textContent).toContain('Trilo');
    // A named channel isn't numbered too
    expect(row.textContent).not.toContain('dashboard.recording.channel:');
    expect(row.textContent).toContain('dashboard.recording.viewers:');
    expect(row.textContent).toContain('"count":2');
    expect(row.querySelector('img')?.getAttribute('src')).toContain(
      encodeURIComponent('/dvr/guide/channels/4/logo')
    );
    const chips = screen.getAllByTestId('channels-stream-viewer').map((chip) => chip.textContent);
    expect(chips).toEqual(['Apple TV', "Craig's Apple TV"]);
    expect(screen.queryByTestId('channels-stream-recording')).toBeNull();
  });

  it('tags a stream a recording shares, and names an unnamed channel by its number', () => {
    render(
      <RecordingNowSection
        recordings={[]}
        streams={[stream({ channelTitle: null, sourceName: null, recording: true })]}
      />
    );

    const row = screen.getByTestId('channels-stream');
    expect(row.textContent).toContain('dashboard.recording.channel:');
    expect(row.textContent).toContain('"number":"4"');
    expect(row.textContent).not.toContain('Trilo');
    expect(screen.getByTestId('channels-stream-recording')).toBeTruthy();
  });

  it('cuts the detail line off at full width, and wraps it beside the Dispatcharr card', () => {
    const { unmount } = render(<RecordingNowSection recordings={[]} streams={[stream()]} />);
    expect(screen.getByTestId('channels-stream-detail').className).toContain('truncate');
    unmount();

    render(<RecordingNowSection recordings={[]} streams={[stream()]} halfWidth />);
    expect(screen.getByTestId('channels-stream-detail').className).not.toContain('truncate');
  });

  it('counts shared streams on the tuner pill, and says nothing of sharing without any', () => {
    const { unmount } = render(
      <RecordingNowSection
        recordings={[]}
        tuners={[{ serverId: 'cdvr', serverName: 'Channels', inUse: 2, total: 5 }]}
        streams={[
          stream(),
          // One viewer and a recording on the same channel share a tuner too
          stream({ channelNumber: '9', viewers: ['Den'], recording: true }),
          // One viewer alone shares nothing
          stream({ channelNumber: '23', viewers: ['Mac'] }),
        ]}
      />
    );
    expect(screen.getByTestId('tuner-usage').textContent).toMatch(
      /dashboard\.recording\.tunersShared:.*"count":2/
    );
    unmount();

    render(
      <RecordingNowSection
        recordings={[]}
        tuners={[{ serverId: 'cdvr', serverName: 'Channels', inUse: 1, total: 5 }]}
        streams={[stream({ viewers: ['Apple TV'] })]}
      />
    );
    expect(screen.getByTestId('tuner-usage').textContent).not.toContain('tunersShared');
  });
});
