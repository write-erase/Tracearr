import type { ServerType } from './serverTypes.js';

export interface ServerProfile {
  /** composite: keyed by user, device and item, because the server's session id changes when a client restarts playback. */
  sessionIdentity: 'sessionKey' | 'composite';
  /** The id the server needs to stop a playback. */
  terminatesBy: 'plexSessionId' | 'sessionKey';
  /**
   * ssePlugin: needs the Tracearr SSE plugin installed on the server; without it the poller covers the server.
   * dispatcharrRealtime: Dispatcharr's own WebSocket, with the Tracearr metrics plugin for stats (fork).
   * poller: no live events; the poller reads the server every few seconds (fork, Channels DVR).
   */
  liveEvents: 'plexWebsocket' | 'ssePlugin' | 'dispatcharrRealtime' | 'poller';
  /**
   * Where host CPU and memory come from: Plex's statistics endpoint, or the SSE plugin's stats events.
   * dispatcharrPlugin: the Dispatcharr metrics plugin over its WebSocket, with bandwidth (fork).
   * channelsSystem: sampled from Channels DVR's `/system` (fork).
   */
  hostStats: 'plexStatistics' | 'ssePlugin' | 'dispatcharrPlugin' | 'channelsSystem';
  /** username: the server reports no email, so an account's email is its username when that is an address. */
  emailSource: 'server' | 'username';
  /** User ids are minted per install, so one shared id proves two addresses reach the same install. */
  userIdsIdentifyInstall: boolean;
  /** The player name is the device name the server reports, not a title the user chose, so it can classify the device. */
  playerNameCountsTowardDevice: boolean;
  /** History imported for this server is linked to library items after a library sync. */
  linksImportedHistory: boolean;
  /**
   * How the owner adds the server: picked from a linked Plex account, or by URL and API key.
   * dispatcharr: URL with an API key, or a username and password (fork).
   * urlOnly: just the URL; the server's API takes no key (fork, Channels DVR).
   */
  addServerAuth: 'plexOAuth' | 'apiKey' | 'dispatcharr' | 'urlOnly';
  /** How members sign in: through plex.tv, with their username and password on the server, or not at all (fork). */
  memberSignIn: 'plexTv' | 'serverPassword' | 'none';
  /** The server measures its own bandwidth, so the dashboard can chart it. */
  reportsBandwidth: boolean;
  /** A transcode reports separate video and audio bitrates; without them only the total stream bitrate is known. */
  reportsTranscodeTrackBitrates: boolean;
  /** Tautulli tracks this server, so its play history can be imported from Tautulli. */
  importsTautulliHistory: boolean;
  /**
   * The library sync can ask for what changed since the last sync (fork). Without it every sync
   * is a full scan.
   */
  syncsLibraryIncrementally: boolean;
}

export const SERVER_PROFILES: Record<ServerType, ServerProfile> = {
  plex: {
    sessionIdentity: 'sessionKey',
    terminatesBy: 'plexSessionId',
    liveEvents: 'plexWebsocket',
    hostStats: 'plexStatistics',
    emailSource: 'server',
    userIdsIdentifyInstall: false,
    playerNameCountsTowardDevice: false,
    linksImportedHistory: true,
    addServerAuth: 'plexOAuth',
    memberSignIn: 'plexTv',
    reportsBandwidth: true,
    reportsTranscodeTrackBitrates: true,
    importsTautulliHistory: true,
    syncsLibraryIncrementally: true,
  },
  jellyfin: {
    sessionIdentity: 'composite',
    terminatesBy: 'sessionKey',
    liveEvents: 'ssePlugin',
    hostStats: 'ssePlugin',
    emailSource: 'username',
    userIdsIdentifyInstall: true,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'apiKey',
    memberSignIn: 'serverPassword',
    reportsBandwidth: false,
    reportsTranscodeTrackBitrates: false,
    importsTautulliHistory: false,
    syncsLibraryIncrementally: true,
  },
  emby: {
    sessionIdentity: 'composite',
    terminatesBy: 'sessionKey',
    liveEvents: 'ssePlugin',
    hostStats: 'ssePlugin',
    emailSource: 'username',
    userIdsIdentifyInstall: true,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'apiKey',
    memberSignIn: 'serverPassword',
    reportsBandwidth: false,
    reportsTranscodeTrackBitrates: false,
    importsTautulliHistory: false,
    syncsLibraryIncrementally: true,
  },
  // Fork server types. Where upstream branched Plex against everything else, these keep the
  // "everything else" side, as they had before the profiles existed.
  dispatcharr: {
    sessionIdentity: 'composite',
    terminatesBy: 'sessionKey',
    liveEvents: 'dispatcharrRealtime',
    hostStats: 'dispatcharrPlugin',
    emailSource: 'username',
    // Dispatcharr user ids are small integers, so a shared one proves nothing.
    userIdsIdentifyInstall: false,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'dispatcharr',
    memberSignIn: 'none',
    // Only once the metrics plugin has sent a sample; the dashboard checks for one.
    reportsBandwidth: true,
    reportsTranscodeTrackBitrates: true,
    importsTautulliHistory: false,
    syncsLibraryIncrementally: false,
  },
  channels_dvr: {
    sessionIdentity: 'composite',
    terminatesBy: 'sessionKey',
    liveEvents: 'poller',
    hostStats: 'channelsSystem',
    emailSource: 'username',
    // Viewers are keyed by device name ("iPad"), which any two installs can share.
    userIdsIdentifyInstall: false,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'urlOnly',
    memberSignIn: 'none',
    reportsBandwidth: false,
    reportsTranscodeTrackBitrates: true,
    importsTautulliHistory: false,
    syncsLibraryIncrementally: false,
  },
};
