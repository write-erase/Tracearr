import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ServerVersionsModule from '../../utils/serverVersions.js';

const { mockGetSettings, mockServerRows, mockUpdate, mockGetSoftwareVersion, mockCreateClient } =
  vi.hoisted(() => ({
    mockGetSettings: vi.fn(),
    mockServerRows: vi.fn(),
    mockUpdate: vi.fn(),
    mockGetSoftwareVersion: vi.fn(),
    mockCreateClient: vi.fn(),
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
}));

vi.mock('../../utils/serverVersions.js', async (importActual) => {
  const actual = await importActual<typeof ServerVersionsModule>();
  return { ...actual, latestVersionFor: vi.fn(), latestChannelsVersions: vi.fn() };
});

const mockDispatchServerUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/automations/events/producers.js', () => ({
  dispatchServerUpdate: (...args: unknown[]) => mockDispatchServerUpdate(...args),
}));

import { latestChannelsVersions, latestVersionFor } from '../../utils/serverVersions.js';
import {
  _resetServerUpdateStateForTests,
  runServerUpdateCheck,
  startServerUpdateChecker,
  stopServerUpdateChecker,
} from '../serverUpdateChecker.js';

const mockLatestVersionFor = vi.mocked(latestVersionFor);
const mockLatestChannelsVersions = vi.mocked(latestChannelsVersions);

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
    mockCreateClient.mockReturnValue({ getSoftwareVersion: mockGetSoftwareVersion });
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

  it('checks once after the initial delay, then every 6h, and Channels DVR every hour', async () => {
    startServerUpdateChecker();

    // Both sweeps run once after the delay
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockGetSettings).toHaveBeenCalledTimes(2);

    // An hour on: only the Channels DVR sweep again
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockGetSettings).toHaveBeenCalledTimes(3);

    // Six hours in: the Channels sweep five more times, the other sweep once
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(mockGetSettings).toHaveBeenCalledTimes(9);
  });

  it('stops checking once stopped', async () => {
    startServerUpdateChecker();
    stopServerUpdateChecker();

    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);

    expect(mockGetSettings).not.toHaveBeenCalled();
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

describe('runServerUpdateCheck scopes', () => {
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
    ]);
  });

  it('checks only Channels DVR servers on the hourly sweep', async () => {
    await runServerUpdateCheck('channels');
    expect(mockLatestChannelsVersions).toHaveBeenCalledTimes(1);
    expect(mockLatestVersionFor).not.toHaveBeenCalled();
  });

  it('leaves Channels DVR servers out of the 6-hourly sweep', async () => {
    await runServerUpdateCheck('others');
    expect(mockLatestChannelsVersions).not.toHaveBeenCalled();
    expect(mockLatestVersionFor).toHaveBeenCalledWith('jellyfin');
  });
});
