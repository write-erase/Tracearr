import { describe, it, expect } from 'vitest';
import { SERVER_PROFILES, SERVER_TYPES } from '../index.js';

describe('server profiles', () => {
  it('has a profile for every server type', () => {
    expect(Object.keys(SERVER_PROFILES).sort()).toEqual([...SERVER_TYPES].sort());
  });

  it('plex identifies sessions by session key, jellyfin and emby by composite', () => {
    expect(SERVER_PROFILES.plex.sessionIdentity).toBe('sessionKey');
    expect(SERVER_PROFILES.jellyfin.sessionIdentity).toBe('composite');
    expect(SERVER_PROFILES.emby.sessionIdentity).toBe('composite');
  });

  it.each([
    ['plex', 'plexWebsocket', 'plexStatistics', 'server', false],
    ['jellyfin', 'ssePlugin', 'ssePlugin', 'username', true],
    ['emby', 'ssePlugin', 'ssePlugin', 'username', true],
  ] as const)('%s', (type, liveEvents, hostStats, emailSource, playerName) => {
    expect(SERVER_PROFILES[type]).toMatchObject({
      liveEvents,
      hostStats,
      emailSource,
      playerNameCountsTowardDevice: playerName,
    });
  });

  it.each([
    ['plex', 'plexSessionId', false, true],
    ['jellyfin', 'sessionKey', true, false],
    ['emby', 'sessionKey', true, false],
  ] as const)(
    '%s terminates, identifies its install and links history',
    (type, terminatesBy, userIds, links) => {
      expect(SERVER_PROFILES[type]).toMatchObject({
        terminatesBy,
        userIdsIdentifyInstall: userIds,
        linksImportedHistory: links,
      });
    }
  );

  it.each([
    ['plex', 'plexOAuth', 'plexTv', true, true, true],
    ['jellyfin', 'apiKey', 'serverPassword', false, false, false],
    ['emby', 'apiKey', 'serverPassword', false, false, false],
  ] as const)(
    '%s adds, signs in, reports bandwidth and bitrates, and imports from Tautulli',
    (type, addServerAuth, memberSignIn, bandwidth, trackBitrates, tautulli) => {
      expect(SERVER_PROFILES[type]).toMatchObject({
        addServerAuth,
        memberSignIn,
        reportsBandwidth: bandwidth,
        reportsTranscodeTrackBitrates: trackBitrates,
        importsTautulliHistory: tautulli,
      });
    }
  );

  it.each([
    ['dispatcharr', 'dispatcharrRealtime', 'dispatcharrPlugin', 'dispatcharr', true],
    ['channels_dvr', 'poller', 'channelsSystem', 'urlOnly', false],
  ] as const)(
    '%s keeps the fork behavior',
    (type, liveEvents, hostStats, addServerAuth, reportsBandwidth) => {
      expect(SERVER_PROFILES[type]).toMatchObject({
        liveEvents,
        hostStats,
        addServerAuth,
        reportsBandwidth,
        // Plex against everything else: these took the "everything else" side
        sessionIdentity: 'composite',
        terminatesBy: 'sessionKey',
        emailSource: 'username',
        playerNameCountsTowardDevice: true,
        // Small integers and device names prove nothing about the install
        userIdsIdentifyInstall: false,
        memberSignIn: 'none',
        linksImportedHistory: false,
        importsTautulliHistory: false,
        syncsLibraryIncrementally: false,
      });
    }
  );

  it('syncs the upstream servers incrementally', () => {
    expect(SERVER_PROFILES.plex.syncsLibraryIncrementally).toBe(true);
    expect(SERVER_PROFILES.jellyfin.syncsLibraryIncrementally).toBe(true);
    expect(SERVER_PROFILES.emby.syncsLibraryIncrementally).toBe(true);
  });
});
