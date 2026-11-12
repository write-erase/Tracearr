/**
 * Channels DVR library mapping.
 *
 * Channels has no user-defined libraries, so Tracearr exposes three fixed ones
 * backed by the Channels library API:
 *
 *   tv     -> GET /api/v1/shows    (containers) + GET /api/v1/episodes (leaves)
 *   movies -> GET /api/v1/movies
 *   videos -> GET /api/v1/videos   (imported personal media)
 *
 * Episode, movie and video `id`s are DVR file ids: the same id the activity feed
 * reports for a playing recording, so library items line up with sessions.
 */

import type { MediaLibrary, MediaLibraryItem } from '../types.js';
import { channelsDvrArtworkPath, isChannelsDvrItemId } from './artwork.js';

export const CHANNELS_DVR_LIBRARIES: MediaLibrary[] = [
  { id: 'tv', name: 'TV Shows', type: 'show' },
  { id: 'movies', name: 'Movies', type: 'movie' },
  { id: 'videos', name: 'Videos', type: 'movie' },
];

export type ChannelsDvrLibraryId = 'tv' | 'movies' | 'videos';

export function isChannelsDvrLibraryId(id: string): id is ChannelsDvrLibraryId {
  return id === 'tv' || id === 'movies' || id === 'videos';
}

type Raw = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return list.length ? list : undefined;
}

/** Channels timestamps are epoch milliseconds. */
function msDate(value: unknown): Date | undefined {
  const n = num(value);
  return n && n > 0 ? new Date(n) : undefined;
}

function yearOf(item: Raw): number | undefined {
  const year = num(item.release_year);
  if (year && year > 1800) return year;
  const date = str(item.release_date) ?? str(item.original_air_date);
  const parsed = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isInteger(parsed) && parsed > 1800 ? parsed : undefined;
}

function imdbFromPath(path: string | undefined): string | undefined {
  return path?.match(/\{imdb-(tt\d+)\}/)?.[1];
}

function tmdbFromPath(path: string | undefined): number | undefined {
  const id = path?.match(/\{tmdb-(\d+)\}/)?.[1];
  return id ? Number(id) : undefined;
}

function fileName(path: string | undefined): string {
  return path?.split('/').pop() ?? '';
}

/** Resolution from a filename quality tag such as `[Bluray-720p]`, `2160p` or `[DVD]`. */
function resolutionFromPath(path: string | undefined): string | undefined {
  const file = fileName(path);
  const match = file.match(/(?:^|[^0-9])(2160|1080|720|576|480)[pi](?![0-9a-z])/i)?.[1];
  if (match === '2160') return '4k';
  if (match === '1080' || match === '720') return `${match}p`;
  if (match || /(?:^|[^a-z])DVD(?:rip)?(?![a-z])/i.test(file)) return 'sd';
  return undefined;
}

/** Video codec from tags like `[x264]`, `h265` or `hevc`. */
function videoCodecFromPath(path: string | undefined): string | undefined {
  const file = fileName(path);
  if (/(?:^|[^a-z0-9])(x265|h\.?265|hevc)(?![a-z0-9])/i.test(file)) return 'HEVC';
  if (/(?:^|[^a-z0-9])(x264|h\.?264|avc)(?![a-z0-9])/i.test(file)) return 'H264';
  if (/(?:^|[^a-z0-9])av1(?![a-z0-9])/i.test(file)) return 'AV1';
  if (/(?:^|[^a-z0-9])mpeg-?2(?![a-z0-9])/i.test(file)) return 'MPEG2';
  return undefined;
}

const AUDIO_CODECS: [RegExp, string][] = [
  [/truehd/i, 'TrueHD'],
  [/dts-?hd(?:[ .-]?ma)?/i, 'DTS-HD MA'],
  [/dts/i, 'DTS'],
  [/e-?ac-?3|ddp|dd\+/i, 'EAC3'],
  [/ac-?3|dd(?=[ .]?\d)/i, 'AC3'],
  [/flac/i, 'FLAC'],
  [/aac/i, 'AAC'],
  [/opus/i, 'Opus'],
  [/mp3/i, 'MP3'],
];

/** Audio codec and channel count from tags like `[AC3 2.0]` or `[FLAC 5.1]`. */
function audioFromPath(path: string | undefined): { audioCodec?: string; audioChannels?: number } {
  const file = fileName(path);
  const codec = AUDIO_CODECS.find(([re]) => re.test(file))?.[1];
  const layout = file.match(/(?:^|[^0-9])([1-7])\.([01])(?![0-9])/);
  const audioChannels = layout ? Number(layout[1]) + Number(layout[2]) : undefined;
  return {
    ...(codec ? { audioCodec: codec } : {}),
    ...(codec && audioChannels ? { audioChannels } : {}),
  };
}

function containerFromPath(path: string | undefined): string | undefined {
  const ext = path?.match(/\.([A-Za-z0-9]{2,4})$/)?.[1];
  return ext ? ext.toLowerCase() : undefined;
}

/** Items Channels has flagged as unusable are left out of the library. */
function isUsable(item: Raw): boolean {
  return item.deleted !== true && item.corrupted !== true && item.cancelled !== true;
}

function artwork(baseUrl: string, item: Raw): string | undefined {
  const fileId = str(item.id);
  return (
    channelsDvrArtworkPath(baseUrl, item.image_url) ??
    (isChannelsDvrItemId(fileId) ? `/dvr/files/${fileId}/preview.jpg` : undefined)
  );
}

export function mapShow(baseUrl: string, item: Raw): MediaLibraryItem | null {
  const id = str(item.id);
  const title = str(item.name) ?? str(item.title);
  if (!id || !title) return null;
  return {
    ratingKey: id,
    title,
    mediaType: 'show',
    year: yearOf(item),
    addedAt: msDate(item.created_at) ?? new Date(0),
    updatedAt: msDate(item.updated_at),
    genres: strList(item.genres),
    // Show posters only; there is no file to fall back to.
    thumbPath: channelsDvrArtworkPath(baseUrl, item.image_url) ?? undefined,
  };
}

export function mapEpisode(
  baseUrl: string,
  item: Raw,
  showArtwork?: Map<string, string | undefined>
): MediaLibraryItem | null {
  const id = str(item.id);
  if (!id || !isUsable(item)) return null;
  const showTitle = str(item.title);
  const showId = str(item.show_id);
  const season = num(item.season_number);
  const episode = num(item.episode_number);
  const path = str(item.path);
  return {
    ratingKey: id,
    title: str(item.episode_title) ?? showTitle ?? `Episode ${episode ?? id}`,
    mediaType: 'episode',
    year: yearOf(item),
    addedAt: msDate(item.created_at) ?? new Date(0),
    updatedAt: msDate(item.updated_at),
    container: containerFromPath(path),
    genres: strList(item.genres),
    thumbPath: artwork(baseUrl, item) ?? (showId ? showArtwork?.get(showId) : undefined),
    grandparentTitle: showTitle,
    grandparentRatingKey: showId,
    parentTitle: season !== undefined ? `Season ${season}` : undefined,
    parentIndex: season,
    itemIndex: episode,
    videoResolution: resolutionFromPath(path),
    videoCodec: videoCodecFromPath(path),
    ...audioFromPath(path),
    // Path ids ({imdb-...}) sit on the show folder, so they identify the show, not the episode.
    filePath: path,
  };
}

/** Movies and imported videos share one shape for Tracearr's purposes. */
export function mapMovie(baseUrl: string, item: Raw): MediaLibraryItem | null {
  const id = str(item.id);
  const title = str(item.title) ?? str(item.name);
  if (!id || !title || !isUsable(item)) return null;
  const path = str(item.path);
  return {
    ratingKey: id,
    title,
    mediaType: 'movie',
    year: yearOf(item),
    addedAt: msDate(item.created_at) ?? new Date(0),
    updatedAt: msDate(item.updated_at),
    container: containerFromPath(path),
    videoResolution: resolutionFromPath(path),
    videoCodec: videoCodecFromPath(path),
    ...audioFromPath(path),
    genres: strList(item.genres),
    thumbPath: artwork(baseUrl, item),
    imdbId: imdbFromPath(path),
    tmdbId: tmdbFromPath(path),
    filePath: path,
  };
}
