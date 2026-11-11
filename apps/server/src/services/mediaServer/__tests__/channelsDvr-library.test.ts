import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/http.js', () => ({ fetchJson: vi.fn(), fetchText: vi.fn() }));

import { fetchJson } from '../../../utils/http.js';
import { ChannelsDvrClient } from '../channelsDvr/client.js';
import { mapEpisode, mapMovie, mapShow } from '../channelsDvr/library.js';

const BASE = 'http://channels.local:8089';
const client = () => new ChannelsDvrClient({ url: BASE, token: 'none' });

const SHOW = {
  id: '184164',
  name: 'The Addams Family',
  image_url: 'https://tmsimg.fancybits.co/assets/p7895389_b_h9_aa.jpg?w=360&h=270',
  release_year: 1964,
  genres: ['Sitcom'],
  created_at: 1786564923000,
  updated_at: 1792717860678,
};

const EPISODE = {
  id: '586',
  show_id: '184164',
  path: '/media/TV/The Addams Family (1964) {imdb-tt0057729}/Season 2/The Addams Family (1964) - S02E30 - Ophelias Career [Bluray-720p][FLAC 2.0][x264]-BROADCAST.mkv',
  season_number: 2,
  episode_number: 30,
  title: 'The Addams Family',
  episode_title: "Ophelia's Career",
  image_url: 'https://tmsimg.fancybits.co/assets/p7895389_b_h9_aa.jpg?w=720&h=540',
  original_air_date: '1966-04-08',
  genres: ['Sitcom'],
  corrupted: false,
  cancelled: false,
  created_at: 1786444588000,
  updated_at: 1793237522303,
};

describe('Channels DVR library mapping', () => {
  it('maps a show to a show item with TMS artwork routed through the server', () => {
    expect(mapShow(BASE, SHOW)).toMatchObject({
      ratingKey: '184164',
      title: 'The Addams Family',
      mediaType: 'show',
      year: 1964,
      genres: ['Sitcom'],
      thumbPath: '/tmsimg/assets/p7895389_b_h9_aa.jpg?w=360&h=270',
    });
  });

  it('maps an episode with its show, season, episode and filename quality tags', () => {
    const item = mapEpisode(BASE, EPISODE);
    expect(item).toMatchObject({
      ratingKey: '586',
      title: "Ophelia's Career",
      mediaType: 'episode',
      year: 1966,
      grandparentTitle: 'The Addams Family',
      grandparentRatingKey: '184164',
      parentTitle: 'Season 2',
      parentIndex: 2,
      itemIndex: 30,
      container: 'mkv',
      videoResolution: '720p',
      videoCodec: 'H264',
      audioCodec: 'FLAC',
      audioChannels: 2,
    });
    expect(item?.addedAt).toEqual(new Date(1786444588000));
  });

  it("does not give episodes the show folder's IMDb id", () => {
    expect(mapEpisode(BASE, EPISODE)?.imdbId).toBeUndefined();
  });

  it('treats DVD-tagged files as SD', () => {
    const item = mapEpisode(BASE, {
      ...EPISODE,
      path: '/media/TV/Show/Season 1/Show - S01E10 - Title [DVD][AC3 2.0][x264]-Hype.mkv',
    });
    expect(item).toMatchObject({ videoResolution: 'sd', audioCodec: 'AC3' });
  });

  it('falls back to the file preview frame when an episode has no artwork', () => {
    const item = mapEpisode(BASE, { ...EPISODE, image_url: undefined });
    expect(item?.thumbPath).toBe('/dvr/files/586/preview.jpg');
  });

  it('skips corrupted or cancelled files', () => {
    expect(mapEpisode(BASE, { ...EPISODE, corrupted: true })).toBeNull();
    expect(mapEpisode(BASE, { ...EPISODE, cancelled: true })).toBeNull();
  });

  it('maps a movie and takes its IMDb id from the movie folder', () => {
    expect(
      mapMovie(BASE, {
        id: '900',
        title: 'Some Movie',
        release_year: 2001,
        path: '/media/Movies/Some Movie (2001) {imdb-tt0000001}/Some Movie (2001) [Bluray-2160p][TrueHD 7.1][x265].mkv',
        created_at: 1786444588000,
      })
    ).toMatchObject({
      ratingKey: '900',
      mediaType: 'movie',
      year: 2001,
      imdbId: 'tt0000001',
      videoResolution: '4k',
      videoCodec: 'HEVC',
      audioCodec: 'TrueHD',
      audioChannels: 8,
    });
  });
});

describe('Channels DVR library client', () => {
  beforeEach(() => {
    vi.mocked(fetchJson).mockReset();
  });

  it('reports fixed TV, movie and video libraries', async () => {
    const libraries = await client().getLibraries();
    expect(libraries.map((l) => [l.id, l.type])).toEqual([
      ['tv', 'show'],
      ['movies', 'movie'],
      ['videos', 'movie'],
    ]);
  });

  it('lists shows for the TV library and episodes as its leaves', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/api/v1/shows')) return [SHOW];
      if (url.endsWith('/api/v1/episodes')) return [EPISODE, { ...EPISODE, id: '587' }];
      return [];
    }) as never);

    const c = client();
    const shows = await c.getLibraryItems('tv');
    expect(shows.totalCount).toBe(1);
    expect(shows.items[0]?.mediaType).toBe('show');

    const leaves = await c.getLibraryLeaves('tv', { offset: 1, limit: 10 });
    expect(leaves.totalCount).toBe(2);
    expect(leaves.items.map((i) => i.ratingKey)).toEqual(['587']);
  });

  it('adds file sizes from /dvr/files to episodes', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/api/v1/shows')) return [SHOW];
      if (url.endsWith('/api/v1/episodes')) return [EPISODE, { ...EPISODE, id: '587' }];
      if (url.endsWith('/dvr/files')) return [{ ID: '586', FileSize: 548242169 }];
      return [];
    }) as never);

    const { items } = await client().getLibraryLeaves('tv');
    expect(items.find((i) => i.ratingKey === '586')?.fileSize).toBe(548242169);
    expect(items.find((i) => i.ratingKey === '587')?.fileSize).toBeUndefined();
  });

  it('still lists episodes when /dvr/files fails', async () => {
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/api/v1/shows')) return [SHOW];
      if (url.endsWith('/api/v1/episodes')) return [EPISODE];
      throw new Error('HTTP 404');
    }) as never);

    const { items } = await client().getLibraryLeaves('tv');
    expect(items).toHaveLength(1);
    expect(items[0]?.fileSize).toBeUndefined();
  });

  it('returns only items changed since the last sync for incremental sync', async () => {
    const OLD = 1_700_000_000_000;
    const NEW = 1_800_000_000_000;
    vi.mocked(fetchJson).mockImplementation((async (url: string) => {
      if (url.endsWith('/api/v1/shows')) return [{ ...SHOW, created_at: OLD, updated_at: OLD }];
      if (url.endsWith('/api/v1/episodes'))
        return [
          { ...EPISODE, id: '1', created_at: OLD, updated_at: OLD },
          { ...EPISODE, id: '2', created_at: OLD, updated_at: NEW },
          { ...EPISODE, id: '3', created_at: NEW, updated_at: NEW },
        ];
      return [];
    }) as never);

    const since = new Date(1_750_000_000_000);
    const c = client();
    expect((await c.getLibraryItemsSince('tv', since)).totalCount).toBe(0);
    const leaves = await c.getLibraryLeavesSince('tv', since);
    expect(leaves.items.map((i) => i.ratingKey)).toEqual(['2', '3']);
  });

  it('fetches each list once while a sync pages through it', async () => {
    vi.mocked(fetchJson).mockResolvedValue([SHOW] as never);
    const c = client();
    await c.getLibraryItems('tv', { offset: 0, limit: 1 });
    await c.getLibraryItems('tv', { offset: 1, limit: 1 });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for unknown libraries and no leaves for movies', async () => {
    const c = client();
    expect(await c.getLibraryItems('nope')).toEqual({ items: [], totalCount: 0 });
    expect(await c.getLibraryLeaves('movies')).toEqual({ items: [], totalCount: 0 });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
