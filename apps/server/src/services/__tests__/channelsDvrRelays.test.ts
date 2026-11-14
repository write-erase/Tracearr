import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaSession } from '../mediaServer/types.js';

const where = vi.fn();
vi.mock('../../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where }) }) },
}));

const {
  clearChannelsDvrRelayUsers,
  getChannelsDvrRelayUsers,
  isChannelsDvrRelay,
  isChannelsDvrUserAgent,
  withoutChannelsDvrRelays,
} = await import('../channelsDvrRelays.js');

const session = (username: string, userAgent: string | undefined): MediaSession =>
  ({
    sessionKey: `${username}:${userAgent ?? 'none'}`,
    user: { id: '7', username },
    player: { name: userAgent ?? 'Dispatcharr Client', deviceId: 'c1', product: userAgent },
  }) as unknown as MediaSession;

describe('isChannelsDvrUserAgent', () => {
  it("recognises Channels DVR's own requests and nothing else", () => {
    expect(isChannelsDvrUserAgent('channels-dvr/2026.11.11.2228 (linux; amd64)')).toBe(true);
    expect(isChannelsDvrUserAgent('ChannelsDVR/2026.11.11')).toBe(true);
    expect(isChannelsDvrUserAgent('TiviMate/5.1.6 (Android 12)')).toBe(false);
    expect(isChannelsDvrUserAgent('Mozilla/5.0 channels-dvr/1')).toBe(false);
    expect(isChannelsDvrUserAgent(undefined)).toBe(false);
  });
});

describe('withoutChannelsDvrRelays', () => {
  const relayUsers = new Set(['moms-house']);

  it("hides the DVR's stream for its own user, and keeps the same user in another player", () => {
    const relay = session('Moms-House', 'channels-dvr/2026.11.11.2228');
    const tivimate = session('moms-house', 'TiviMate/5.1.6');
    const otherDvr = session('my-house', 'channels-dvr/2026.11.11.2228');

    expect(isChannelsDvrRelay(relay, relayUsers)).toBe(true);
    expect(withoutChannelsDvrRelays([relay, tivimate, otherDvr], relayUsers)).toEqual([
      tivimate,
      otherDvr,
    ]);
  });

  it('keeps everything when no Channels DVR server names a user', () => {
    const relay = session('moms-house', 'channels-dvr/2026.11.11.2228');
    expect(withoutChannelsDvrRelays([relay], new Set())).toEqual([relay]);
  });
});

describe('getChannelsDvrRelayUsers', () => {
  beforeEach(() => {
    clearChannelsDvrRelayUsers();
    where.mockReset();
  });

  it('reads the names once and reuses them for a while', async () => {
    where.mockResolvedValue([{ dispatcharrUser: ' Moms-House ' }, { dispatcharrUser: '' }]);
    const now = 1_000_000;
    expect(await getChannelsDvrRelayUsers(now)).toEqual(new Set(['moms-house']));
    await getChannelsDvrRelayUsers(now + 10_000);
    expect(where).toHaveBeenCalledTimes(1);
    await getChannelsDvrRelayUsers(now + 31_000);
    expect(where).toHaveBeenCalledTimes(2);
  });

  it('reads again after a server changes its user', async () => {
    where.mockResolvedValue([{ dispatcharrUser: 'a' }]);
    await getChannelsDvrRelayUsers(1);
    clearChannelsDvrRelayUsers();
    where.mockResolvedValue([{ dispatcharrUser: 'b' }]);
    expect(await getChannelsDvrRelayUsers(2)).toEqual(new Set(['b']));
  });

  it('hides nothing when the names cannot be read', async () => {
    where.mockRejectedValue(new Error('db down'));
    expect(await getChannelsDvrRelayUsers(1)).toEqual(new Set());
  });
});
