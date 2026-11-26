import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ServerVersionsModule from '../../utils/serverVersions.js';

const {
  mockGetSettings,
  mockServerRows,
  mockUpdate,
  mockGetSoftwareVersion,
  mockCreateClient,
  mockGetUpdateVersion,
} = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockServerRows: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetSoftwareVersion: vi.fn(),
  mockCreateClient: vi.fn(),
  mockGetUpdateVersion: vi.fn(),
}));

vi.mock('../../services/settings.js', () => ({ getSettings: mockGetSettings }));
vi.mock('../../services/liveServers.js', () => ({ liveServers: mockServerRows }));
vi.mock('../../db/client.js', () => ({
  db: {
    update: () => ({
      set: (patch: unknown) => {
        mockUpdate(patch);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));
vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateClient,
  TofaClient: vi.fn(function () {
    return { getUpdateVersion: mockGetUpdateVersion };
  }),
}));

vi.mock('../../utils/serverVersions.js', async (importActual) => {
  const actual = await importActual<typeof ServerVersionsModule>();
  return {
    ...actual,
    latestVersionFor: vi.fn(),
    latestChannelsVersions: vi.fn(),
    latestDispatcharrDevBuild: vi.fn(),
  };
});

const mockPublishServersChanged = vi.fn().mockResolvedValue(undefined);
vi.mock('../poller/database.js', () => ({
  publishServersChanged: (...args: unknown[]) => mockPublishServersChanged(...args),
}));

const mockDispatchServerUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/automations/events/producers.js', () => ({
  dispatchServerUpdate: (...args: unknown[]) => mockDispatchServerUpdate(...args),
}));

import {
  latestChannelsVersions,
  latestDispatcharrDevBuild,
  latestVersionFor,
} from '../../utils/serverVersions.js';
import {
  _resetServerUpdateStateForTests,
  runChannelsUpdateWatch,
  runServerUpdateCheck,
  startServerUpdateChecker,
  stopServerUpdateChecker,
} from '../serverUpdateChecker.js';
import {
  fakeChannelsDvrClient,
  fakeJellyfinClient,
  fakePlexClient,
  fakeTofaClient,
} from '../../test/mediaServerFakes.js';

const mockLatestVersionFor = vi.mocked(latestVersionFor);
const mockLatestChannelsVersions = vi.mocked(latestChannelsVersions);
const mockLatestDispatcharrDevBuild = vi.mocked(latestDispatcharrDevBuild);
const fakeClients = {
  plex: fakePlexClient,
  jellyfin: fakeJellyfinClient,
  tofa: fakeTofaClient,
  channels_dvr: fakeChannelsDvrClient,
};

const JELLYFIN = {
  id: 's1',
  name: 'JF',
  type: 'jellyfin' as const,
  url: 'http://jf.local',
  token: 't',
};
const PLEX = {
  id: 's2',
  name: 'Plex',
  type: 'plex' as const,
  url: 'http://plex.local',
  token: 't',
};

describe('runServerUpdateCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetServerUpdateStateForTests();
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: true });
    mockServerRows.mockResolvedValue([JELLYFIN]);
    mockGetSoftwareVersion.mockResolvedValue('10.11.11');
    mockCreateClient.mockImplementation((options: { type: keyof typeof fakeClients }) =>
      fakeClients[options.type]({ getSoftwareVersion: mockGetSoftwareVersion })
    );
    mockLatestVersionFor.mockResolvedValue('10.11.12');
  });

  it('reads only live servers', async () => {
    await runServerUpdateCheck();
    expect(mockServerRows).toHaveBeenCalledTimes(1);
    expect(mockServerRows).toHaveBeenCalledWith();
  });

  it('persists the installed and latest versions it read', async () => {
    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '10.11.11', latestVersion: '10.11.12' })
    );
  });

  it('dispatches once per new latest version', async () => {
    await runServerUpdateCheck();
    await runServerUpdateCheck();

    expect(mockDispatchServerUpdate).toHaveBeenCalledTimes(1);
    expect(mockDispatchServerUpdate).toHaveBeenCalledWith({
      server: { id: 's1', name: 'JF', type: 'jellyfin' },
      installedVersion: '10.11.11',
      latestVersion: '10.11.12',
      releaseUrl: 'https://github.com/jellyfin/jellyfin/releases/latest',
    });
  });

  it('reads one vendor feed per server type, not per server', async () => {
    mockServerRows.mockResolvedValue([JELLYFIN, { ...JELLYFIN, id: 's3', name: 'JF2' }, PLEX]);

    await runServerUpdateCheck();

    expect(mockLatestVersionFor.mock.calls.map(([type]) => type)).toEqual(['jellyfin', 'plex']);
  });

  it('asks a tofa server for the release its own update check found', async () => {
    mockServerRows.mockResolvedValue([
      { id: 's4', name: 'tofa', type: 'tofa' as const, url: 'http://tofa.local', token: 't' },
    ]);
    mockGetSoftwareVersion.mockResolvedValue('0.13.2');
    mockGetUpdateVersion.mockResolvedValue('0.14.0');

    await runServerUpdateCheck();

    expect(mockLatestVersionFor).not.toHaveBeenCalled();
    expect(mockDispatchServerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        installedVersion: '0.13.2',
        latestVersion: '0.14.0',
        releaseUrl: 'https://docs.tofa.tv/keep-your-server-updated.html',
      })
    );
  });

  it('re-arms when a newer release appears', async () => {
    await runServerUpdateCheck();
    mockLatestVersionFor.mockResolvedValue('10.11.13');
    await runServerUpdateCheck();

    expect(mockDispatchServerUpdate).toHaveBeenCalledTimes(2);
  });

  it('says nothing about a server already on the latest release', async () => {
    mockGetSoftwareVersion.mockResolvedValue('10.11.12');

    await runServerUpdateCheck();

    expect(mockDispatchServerUpdate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '10.11.12', latestVersion: '10.11.12' })
    );
  });

  it('stores and compares a Plex version with its build hash stripped', async () => {
    mockServerRows.mockResolvedValue([PLEX]);
    mockGetSoftwareVersion.mockResolvedValue('1.43.3.10896-cb3ebc72d');
    mockLatestVersionFor.mockResolvedValue('1.44.0.11000');

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.43.3.10896', latestVersion: '1.44.0.11000' })
    );
    expect(mockDispatchServerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        installedVersion: '1.43.3.10896',
        latestVersion: '1.44.0.11000',
        releaseUrl: 'https://plex.tv/media-server-downloads',
      })
    );
  });

  it('leaves the version column alone when the server reports something unparseable', async () => {
    mockGetSoftwareVersion.mockResolvedValue('nightly-2026-08-21');

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ latestVersion: '10.11.12' }));
    expect(mockUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ version: expect.anything() })
    );
    expect(mockDispatchServerUpdate).not.toHaveBeenCalled();
  });

  it('keeps the latest version when the server itself cannot be reached', async () => {
    mockGetSoftwareVersion.mockRejectedValue(new Error('offline'));

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ latestVersion: '10.11.12' }));
    expect(mockUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ version: '10.11.11' }));
    expect(mockDispatchServerUpdate).not.toHaveBeenCalled();
  });

  it('keeps sweeping after the write fails for one server', async () => {
    mockServerRows.mockResolvedValue([JELLYFIN, PLEX]);
    mockUpdate.mockImplementationOnce(() => {
      throw new Error('deadlock detected');
    });

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockDispatchServerUpdate).toHaveBeenCalledTimes(2);
  });

  it('writes nothing when neither version can be read', async () => {
    mockGetSoftwareVersion.mockResolvedValue(null);
    mockLatestVersionFor.mockResolvedValue(null);

    await runServerUpdateCheck();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: false });

    await runServerUpdateCheck();

    expect(mockServerRows).not.toHaveBeenCalled();
    expect(mockLatestVersionFor).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

describe('startServerUpdateChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetServerUpdateStateForTests();
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: false });
  });

  afterEach(() => {
    stopServerUpdateChecker();
    vi.useRealTimers();
  });

  it('checks every server once after the initial delay, then every 6h, with no hourly sweep', async () => {
    const HOUR = 60 * 60 * 1000;
    // Every run reads the settings first: the sweep, plus the minute watch (45s, then each minute).
    const runsBy = (ms: number) =>
      (ms >= 15_000 ? 1 : 0) +
      Math.floor(ms / (6 * HOUR)) +
      (ms >= 45_000 ? 1 : 0) +
      Math.floor(ms / 60_000);
    startServerUpdateChecker();

    // The sweep runs once after the delay; the watch hasn't started yet
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockGetSettings).toHaveBeenCalledTimes(1);

    // The watch starts at 45s and runs every minute
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockGetSettings).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockGetSettings).toHaveBeenCalledTimes(3);

    // An hour on: only the watch has run since
    await vi.advanceTimersByTimeAsync(HOUR - 60_000 + 15_000);
    expect(mockGetSettings).toHaveBeenCalledTimes(runsBy(HOUR + 15_000));

    // Six hours in: the sweep once more
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(mockGetSettings).toHaveBeenCalledTimes(runsBy(6 * HOUR + 15_000));
  });

  it('stops checking once stopped', async () => {
    startServerUpdateChecker();
    stopServerUpdateChecker();

    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);

    expect(mockGetSettings).not.toHaveBeenCalled();
  });
});

describe('runServerUpdateCheck for Dispatcharr (fork)', () => {
  const DISPATCHARR = {
    id: 's4',
    name: 'Dispatcharr',
    type: 'dispatcharr' as const,
    url: 'http://dispatcharr.local:9191',
    token: 'key',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetServerUpdateStateForTests();
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: true });
    mockServerRows.mockResolvedValue([DISPATCHARR]);
    mockCreateClient.mockReturnValue({ getSoftwareVersion: mockGetSoftwareVersion });
    mockLatestVersionFor.mockResolvedValue('0.34.1');
  });

  it('nudges a dev image about a newer push to the dev tag, linking to Docker Hub', async () => {
    mockGetSoftwareVersion.mockResolvedValue('0.34.1-dev.20261124013000');
    mockLatestDispatcharrDevBuild.mockResolvedValue('20261124190512');

    await runServerUpdateCheck();

    expect(mockGetSoftwareVersion).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '0.34.1-dev.20261124013000',
        latestVersion: '0.34.1-dev.20261124190512',
      })
    );
    expect(mockDispatchServerUpdate).toHaveBeenCalledWith({
      server: { id: 's4', name: 'Dispatcharr', type: 'dispatcharr' },
      installedVersion: '0.34.1-dev.20261124013000',
      latestVersion: '0.34.1-dev.20261124190512',
      releaseUrl: 'https://hub.docker.com/r/dispatcharr/dispatcharr/tags',
    });
    expect(mockLatestVersionFor).not.toHaveBeenCalled();
  });

  it('calls a dev image up to date when the dev tag holds its own build', async () => {
    mockGetSoftwareVersion.mockResolvedValue('0.34.1-dev.20261124013000');
    mockLatestDispatcharrDevBuild.mockResolvedValue('20261124013600');

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '0.34.1-dev.20261124013000',
        latestVersion: '0.34.1-dev.20261124013000',
      })
    );
    expect(mockDispatchServerUpdate).not.toHaveBeenCalled();
  });

  it('compares a release image with GitHub releases, as before', async () => {
    mockGetSoftwareVersion.mockResolvedValue('0.34.0');

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.34.0', latestVersion: '0.34.1' })
    );
    expect(mockLatestDispatcharrDevBuild).not.toHaveBeenCalled();
  });
});

describe('runServerUpdateCheck for Channels DVR', () => {
  const CHANNELS_DVR = {
    id: 's3',
    name: 'Channels',
    type: 'channels_dvr' as const,
    url: 'http://cdvr.local:8089',
    token: '',
    updateTrack: 'auto' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetServerUpdateStateForTests();
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: true });
    mockCreateClient.mockReturnValue({ getSoftwareVersion: mockGetSoftwareVersion });
    mockLatestChannelsVersions.mockResolvedValue({
      stable: '2026.10.24.0621',
      prerelease: '2026.11.12.0900',
    });
  });

  it('nudges a pre-release build about the next pre-release, with the pre-release notes', async () => {
    mockServerRows.mockResolvedValue([CHANNELS_DVR]);
    mockGetSoftwareVersion.mockResolvedValue('2026.11.11.2228');

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2026.11.11.2228', latestVersion: '2026.11.12.0900' })
    );
    expect(mockDispatchServerUpdate).toHaveBeenCalledWith({
      server: { id: 's3', name: 'Channels', type: 'channels_dvr' },
      installedVersion: '2026.11.11.2228',
      latestVersion: '2026.11.12.0900',
      releaseUrl: 'https://community.getchannels.com/t/dvr-pre-release-notes/28832',
    });
    expect(mockLatestVersionFor).not.toHaveBeenCalled();
  });

  it('leaves a stable build alone when only a pre-release is newer', async () => {
    mockServerRows.mockResolvedValue([CHANNELS_DVR]);
    mockGetSoftwareVersion.mockResolvedValue('2026.10.24.0621');

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: '2026.10.24.0621' })
    );
    expect(mockDispatchServerUpdate).not.toHaveBeenCalled();
  });

  it('follows pre-releases when chosen, even from a stable build', async () => {
    mockServerRows.mockResolvedValue([{ ...CHANNELS_DVR, updateTrack: 'prerelease' as const }]);
    mockGetSoftwareVersion.mockResolvedValue('2026.10.24.0621');

    await runServerUpdateCheck();

    expect(mockDispatchServerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: '2026.11.12.0900' })
    );
  });

  it('reads the Channels feeds once for several Channels servers', async () => {
    mockServerRows.mockResolvedValue([CHANNELS_DVR, { ...CHANNELS_DVR, id: 's4' }]);
    mockGetSoftwareVersion.mockResolvedValue('2026.11.12.0900');

    await runServerUpdateCheck();

    expect(mockLatestChannelsVersions).toHaveBeenCalledTimes(1);
  });
});

describe('runServerUpdateCheck covers every server type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetServerUpdateStateForTests();
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: true });
    mockCreateClient.mockReturnValue({ getSoftwareVersion: mockGetSoftwareVersion });
    mockGetSoftwareVersion.mockResolvedValue('10.11.11');
    mockLatestVersionFor.mockResolvedValue('10.11.11');
    mockLatestChannelsVersions.mockResolvedValue({ stable: null, prerelease: null });
    mockServerRows.mockResolvedValue([
      JELLYFIN,
      { id: 's3', name: 'Channels', type: 'channels_dvr', url: 'http://c', token: '' },
      { id: 's4', name: 'Dispatcharr', type: 'dispatcharr', url: 'http://d', token: 'k' },
    ]);
  });

  it('checks Jellyfin, Channels DVR and Dispatcharr in the same six-hourly sweep', async () => {
    await runServerUpdateCheck();
    expect(mockLatestChannelsVersions).toHaveBeenCalledTimes(1);
    expect(mockLatestVersionFor).toHaveBeenCalledWith('jellyfin');
    expect(mockLatestVersionFor).toHaveBeenCalledWith('dispatcharr');
    expect(mockUpdate).toHaveBeenCalledTimes(3);
  });
});

describe('telling dashboards the versions changed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetServerUpdateStateForTests();
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: true });
    mockCreateClient.mockReturnValue({ getSoftwareVersion: mockGetSoftwareVersion });
    mockGetSoftwareVersion.mockResolvedValue('10.11.11');
    mockLatestVersionFor.mockResolvedValue('10.11.12');
  });

  it('announces once per sweep when a stored version changed', async () => {
    mockServerRows.mockResolvedValue([
      { ...JELLYFIN, version: '10.11.10', latestVersion: '10.11.12' },
      { ...JELLYFIN, id: 's9', version: null, latestVersion: null },
    ]);

    await runServerUpdateCheck();

    expect(mockPublishServersChanged).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the sweep read what the rows already hold', async () => {
    mockServerRows.mockResolvedValue([
      { ...JELLYFIN, version: '10.11.11', latestVersion: '10.11.12' },
    ]);

    await runServerUpdateCheck();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockPublishServersChanged).not.toHaveBeenCalled();
  });

  it('stays quiet when the write failed', async () => {
    mockServerRows.mockResolvedValue([{ ...JELLYFIN, version: '10.11.10' }]);
    mockUpdate.mockImplementationOnce(() => {
      throw new Error('deadlock detected');
    });

    await runServerUpdateCheck();

    expect(mockPublishServersChanged).not.toHaveBeenCalled();
  });

  it('finishes the sweep when the announcement fails', async () => {
    mockServerRows.mockResolvedValue([{ ...JELLYFIN, version: '10.11.10' }]);
    mockPublishServersChanged.mockRejectedValueOnce(new Error('redis down'));

    await expect(runServerUpdateCheck()).resolves.toBeUndefined();
    expect(mockDispatchServerUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('runChannelsUpdateWatch', () => {
  const WAITING = {
    id: 's3',
    name: 'Channels',
    type: 'channels_dvr' as const,
    url: 'http://cdvr.local:8089',
    token: '',
    updateTrack: 'auto' as const,
    version: '2026.11.11.2228',
    latestVersion: '2026.11.12.0900',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetServerUpdateStateForTests();
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: true });
    mockCreateClient.mockReturnValue({ getSoftwareVersion: mockGetSoftwareVersion });
    mockLatestChannelsVersions.mockResolvedValue({
      stable: '2026.10.24.0621',
      prerelease: '2026.11.12.0900',
    });
  });

  it('stores the new version and announces it once the update is installed', async () => {
    mockServerRows.mockResolvedValue([WAITING]);
    mockGetSoftwareVersion.mockResolvedValue('2026.11.12.0900');

    await runChannelsUpdateWatch();

    expect(mockGetSoftwareVersion).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2026.11.12.0900', latestVersion: '2026.11.12.0900' })
    );
    expect(mockPublishServersChanged).toHaveBeenCalledTimes(1);
    expect(mockDispatchServerUpdate).not.toHaveBeenCalled();
  });

  it('watches a Dispatcharr dev image too, and stores the newer build once it is pulled (fork)', async () => {
    mockServerRows.mockResolvedValue([
      {
        id: 's4',
        name: 'Dispatcharr',
        type: 'dispatcharr' as const,
        url: 'http://dispatcharr.local:9191',
        token: 'key',
        version: '0.34.1-dev.20261124013000',
        latestVersion: '0.34.1-dev.20261124190512',
      },
    ]);
    mockGetSoftwareVersion.mockResolvedValue('0.34.1-dev.20261124190500');
    mockLatestDispatcharrDevBuild.mockResolvedValue('20261124190512');

    await runChannelsUpdateWatch();

    expect(mockGetSoftwareVersion).toHaveBeenCalledTimes(1);
    // The pulled build is within 10 minutes of the push: up to date
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '0.34.1-dev.20261124190500',
        latestVersion: '0.34.1-dev.20261124190500',
      })
    );
    expect(mockPublishServersChanged).toHaveBeenCalledTimes(1);
    expect(mockDispatchServerUpdate).not.toHaveBeenCalled();
  });

  it('only reads the version while the update is still waiting', async () => {
    mockServerRows.mockResolvedValue([WAITING]);
    mockGetSoftwareVersion.mockResolvedValue('2026.11.11.2228');

    await runChannelsUpdateWatch();

    expect(mockGetSoftwareVersion).toHaveBeenCalledTimes(1);
    expect(mockLatestChannelsVersions).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPublishServersChanged).not.toHaveBeenCalled();
  });

  it('tries again next time when the server is restarting mid-update', async () => {
    mockServerRows.mockResolvedValue([WAITING]);
    mockGetSoftwareVersion.mockRejectedValue(new Error('ECONNREFUSED'));

    await runChannelsUpdateWatch();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPublishServersChanged).not.toHaveBeenCalled();
  });

  it('asks only Channels DVR and Dispatcharr servers with an update waiting', async () => {
    mockServerRows.mockResolvedValue([
      { ...WAITING, id: 'current', latestVersion: '2026.11.11.2228' },
      { ...WAITING, id: 'unknown', latestVersion: null },
      { ...JELLYFIN, version: '10.11.11', latestVersion: '10.11.12' },
    ]);

    await runChannelsUpdateWatch();

    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('rechecks a server that moved to a version that still is not the latest', async () => {
    mockServerRows.mockResolvedValue([WAITING]);
    mockGetSoftwareVersion.mockResolvedValue('2026.11.12.0100');

    await runChannelsUpdateWatch();

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2026.11.12.0100', latestVersion: '2026.11.12.0900' })
    );
    expect(mockDispatchServerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ installedVersion: '2026.11.12.0100' })
    );
    expect(mockPublishServersChanged).toHaveBeenCalledTimes(1);
  });

  it('does nothing when update checks are off', async () => {
    mockGetSettings.mockResolvedValue({ serverUpdateCheckEnabled: false });

    await runChannelsUpdateWatch();

    expect(mockServerRows).not.toHaveBeenCalled();
  });

  it('skips a run while the previous one is still going', async () => {
    mockServerRows.mockResolvedValue([WAITING]);
    let finish: (value: string) => void = () => {};
    mockGetSoftwareVersion.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      })
    );

    const first = runChannelsUpdateWatch();
    await runChannelsUpdateWatch();
    finish('2026.11.11.2228');
    await first;

    expect(mockServerRows).toHaveBeenCalledTimes(1);
  });
});
