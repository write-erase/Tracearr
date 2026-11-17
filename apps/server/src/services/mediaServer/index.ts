/**
 * Media Server Client Module
 *
 * Provides a unified interface for Plex and Jellyfin media server integrations.
 * Use the factory function to create clients based on server type.
 *
 * @example
 * import { createMediaServerClient, type IMediaServerClient } from './services/mediaServer';
 *
 * const client = createMediaServerClient({
 *   type: 'plex',
 *   url: 'http://plex.local:32400',
 *   token: 'encrypted-token',
 * });
 *
 * const sessions = await client.getSessions();
 * const users = await client.getUsers();
 */

import { assertNever, type JellyfinEmbyServerType, type ServerType } from '@tracearr/shared';
import { PlexClient } from './plex/client.js';
import { JellyfinClient } from './jellyfin/client.js';
import { EmbyClient } from './emby/client.js';
import { DispatcharrClient } from './dispatcharr/client.js';
import { ChannelsDvrClient } from './channelsDvr/client.js';
import type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  MediaServerConfig,
  CreateClientOptions,
} from './types.js';

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a media server client for the specified server type
 *
 * @param options - Client configuration including server type, URL, and token
 * @returns A media server client implementing IMediaServerClient
 * @throws Error if unknown server type is provided
 *
 * @example
 * const client = createMediaServerClient({
 *   type: server.type,
 *   url: server.url,
 *   token: server.token,
 * });
 *
 * // Use polymorphically
 * const sessions = await client.getSessions();
 */
export function createMediaServerClient(options: CreateClientOptions): IMediaServerClient {
  const config: MediaServerConfig = {
    url: options.url,
    token: options.token,
    ignoreAnonymousStreams: options.ignoreAnonymousStreams,
    id: options.id,
    name: options.name,
  };

  switch (options.type) {
    case 'plex':
      return new PlexClient(config);
    case 'jellyfin':
      return new JellyfinClient(config);
    case 'emby':
      return new EmbyClient(config);
    case 'dispatcharr':
      return new DispatcharrClient(config);
    case 'channels_dvr':
      return new ChannelsDvrClient(config);
    default:
      return assertNever(options.type);
  }
}

export function createJellyfinEmbyClient(
  type: JellyfinEmbyServerType,
  config: MediaServerConfig
): JellyfinClient | EmbyClient {
  switch (type) {
    case 'jellyfin':
      return new JellyfinClient(config);
    case 'emby':
      return new EmbyClient(config);
    default:
      return assertNever(type);
  }
}

export function isJellyfinEmby(type: ServerType): type is JellyfinEmbyServerType {
  switch (type) {
    case 'plex':
      return false;
    case 'jellyfin':
      return true;
    case 'emby':
      return true;
    case 'dispatcharr':
    case 'channels_dvr':
      return false;
    default:
      return assertNever(type);
  }
}

export async function verifyServerAdmin(type: ServerType, token: string, url: string) {
  switch (type) {
    case 'plex':
      return PlexClient.verifyServerAdmin(token, url);
    case 'jellyfin':
      return JellyfinClient.verifyServerAdmin(token, url);
    case 'emby':
      return EmbyClient.verifyServerAdmin(token, url);
    // Dispatcharr and Channels DVR report no error codes, so a failure is treated as
    // "could not connect", which replyAdminCheckFailure maps to 503 like d4rk's code did.
    case 'channels_dvr': {
      const reachable = await new ChannelsDvrClient({ url, token }).testConnection();
      return reachable
        ? { success: true as const }
        : {
            success: false as const,
            code: JellyfinClient.AdminVerifyError.CONNECTION_FAILED,
            message:
              'Could not read the Channels DVR /dvr status. Check the URL and port (default 8089).',
          };
    }
    case 'dispatcharr': {
      const check = await DispatcharrClient.verifyServerAdmin(token, url);
      return check.success
        ? { success: true as const }
        : {
            success: false as const,
            code: JellyfinClient.AdminVerifyError.CONNECTION_FAILED,
            message: check.message,
          };
    }
    default:
      return assertNever(type);
  }
}

export function logoutUserToken(
  type: JellyfinEmbyServerType,
  serverUrl: string,
  token: string
): Promise<void> {
  switch (type) {
    case 'jellyfin':
      return JellyfinClient.logoutUserToken(serverUrl, token);
    case 'emby':
      return EmbyClient.logoutUserToken(serverUrl, token);
    default:
      return assertNever(type);
  }
}

// ============================================================================
// Re-exports
// ============================================================================

// Types
export type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  MediaServerConfig,
  CreateClientOptions,
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaLibraryItem,
  MediaWatchHistoryItem,
} from './types.js';

// Clients (for static method access and direct instantiation)
export { PlexClient } from './plex/client.js';
export { JellyfinClient } from './jellyfin/client.js';
export { EmbyClient } from './emby/client.js';
export { DispatcharrClient } from './dispatcharr/client.js';
export { ChannelsDvrClient } from './channelsDvr/client.js';

// Plex-specific types
export type { PlexServerResource, PlexServerConnection } from './plex/parser.js';

// Jellyfin-specific types
export type { JellyfinActivityEntry } from './jellyfin/parser.js';

// Emby-specific types
export type { EmbyActivityEntry } from './emby/parser.js';

// Parsers (for testing and direct use)
export * as plexParser from './plex/parser.js';
export * as jellyfinParser from './jellyfin/parser.js';
export * as embyParser from './emby/parser.js';
export * as dispatcharrParser from './dispatcharr/parser.js';
export * as channelsDvrParser from './channelsDvr/parser.js';
