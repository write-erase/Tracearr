import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import {
  channelLogoPath,
  parseChannelLogoPath,
  parseGuideChannelLogos,
  resolveLogoUrl,
} from '../channelsDvr/logos.js';
import { SsrfBlockedError } from '../../../utils/ssrf.js';

const BASE = 'http://192.168.1.50:8089';

describe('channel logo routes', () => {
  it('round-trips safe channel numbers', () => {
    for (const n of ['1', '1429', '35.1', 'ABC_7']) {
      expect(parseChannelLogoPath(channelLogoPath(n)!)).toBe(n);
    }
  });

  it('rejects unsafe channel numbers and paths', () => {
    expect(channelLogoPath('../x')).toBeNull();
    expect(channelLogoPath('')).toBeNull();
    expect(channelLogoPath('a/b')).toBeNull();
    expect(parseChannelLogoPath('/dvr/guide/channels/../logo')).toBeNull();
    expect(parseChannelLogoPath('/dvr/guide/channels/1/logo?x=1')).toBeNull();
    expect(parseChannelLogoPath('/poster.jpg')).toBeNull();
  });
});

describe('parseGuideChannelLogos', () => {
  it('maps channel numbers to Image URLs and skips entries without one', () => {
    const logos = parseGuideChannelLogos({
      '1': { Number: '1', Name: 'ABC KOCO', Image: 'https://cdn.example.com/ABCKOCO.png' },
      '2': { Number: '2', Name: 'No logo' },
      '3': { Number: '3', Image: '   ' },
    });
    expect([...logos.entries()]).toEqual([['1', 'https://cdn.example.com/ABCKOCO.png']]);
  });

  it('returns nothing for malformed responses', () => {
    expect(parseGuideChannelLogos(null).size).toBe(0);
    expect(parseGuideChannelLogos([]).size).toBe(0);
    expect(parseGuideChannelLogos('nope').size).toBe(0);
  });
});

describe('resolveLogoUrl', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '104.18.0.1', family: 4 }]);
  });

  it('allows paths on the Channels DVR server itself', async () => {
    await expect(resolveLogoUrl(BASE, '/tmsimg/assets/s1_ll_h15_aa.png')).resolves.toBe(
      `${BASE}/tmsimg/assets/s1_ll_h15_aa.png`
    );
    await expect(resolveLogoUrl(BASE, `${BASE}/dvr/uploads/3/content`)).resolves.toBe(
      `${BASE}/dvr/uploads/3/content`
    );
  });

  it('rejects other local paths and protocol-relative URLs', async () => {
    await expect(resolveLogoUrl(BASE, '/dvr/settings')).rejects.toThrow(SsrfBlockedError);
    await expect(resolveLogoUrl(BASE, '//evil.example/x.png')).rejects.toThrow();
  });

  it('allows a configured Dispatcharr origin only for its channel-logo cache endpoint', async () => {
    const trustedOrigins = ['http://192.168.1.50:9191'];
    await expect(
      resolveLogoUrl(
        BASE,
        'http://192.168.1.50:9191/api/channels/logos/1174/cache/',
        trustedOrigins
      )
    ).resolves.toBe('http://192.168.1.50:9191/api/channels/logos/1174/cache/');
    await expect(
      resolveLogoUrl(BASE, 'http://192.168.1.50:9191/api/core/settings/', trustedOrigins)
    ).rejects.toThrow(SsrfBlockedError);
    await expect(
      resolveLogoUrl(
        BASE,
        'http://192.168.1.51:9191/api/channels/logos/1174/cache/',
        trustedOrigins
      )
    ).rejects.toThrow(SsrfBlockedError);
    await expect(
      resolveLogoUrl(
        BASE,
        'http://192.168.1.50:9191/api/channels/logos/1174/cache/?next=/settings',
        trustedOrigins
      )
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('reads Docker addresses as the host the Channels DVR is reached on', async () => {
    const trustedOrigins = ['http://192.168.1.50:9191'];
    // Default bridge gateway, Compose network gateways, the container's own address and
    // host.docker.internal all map onto the configured server's host, keeping their port.
    for (const host of [
      '172.17.0.1',
      '172.18.0.1',
      '172.20.0.1',
      '172.31.0.1',
      'host.docker.internal',
    ]) {
      await expect(
        resolveLogoUrl(BASE, `http://${host}:9191/api/channels/logos/1174/cache/`, trustedOrigins)
      ).resolves.toBe('http://192.168.1.50:9191/api/channels/logos/1174/cache/');
    }
    await expect(resolveLogoUrl(BASE, 'http://172.17.0.2:8089/tmsimg/assets/s1.png')).resolves.toBe(
      `${BASE}/tmsimg/assets/s1.png`
    );
    await expect(
      resolveLogoUrl(BASE, 'http://172.17.0.1:8089/dvr/uploads/3/content')
    ).resolves.toBe(`${BASE}/dvr/uploads/3/content`);
  });

  it('still applies the usual checks after mapping a Docker address', async () => {
    const trustedOrigins = ['http://192.168.1.50:9191'];
    // Not a Dispatcharr logo path
    await expect(
      resolveLogoUrl(BASE, 'http://172.17.0.1:9191/api/core/settings/', trustedOrigins)
    ).rejects.toThrow(SsrfBlockedError);
    // No Dispatcharr configured on that host
    await expect(
      resolveLogoUrl(BASE, 'http://172.18.0.1:9191/api/channels/logos/1174/cache/')
    ).rejects.toThrow(SsrfBlockedError);
    // The DVR's own non-logo paths
    await expect(resolveLogoUrl(BASE, 'http://172.17.0.1:8089/dvr/settings')).rejects.toThrow(
      SsrfBlockedError
    );
    // Another app on the host's port
    await expect(resolveLogoUrl(BASE, 'http://172.17.0.1:5523/logos/abc.png')).rejects.toThrow(
      SsrfBlockedError
    );
  });

  it('leaves addresses outside the Docker range alone', async () => {
    const trustedOrigins = ['http://192.168.1.50:9191'];
    for (const host of ['172.15.0.1', '172.32.0.1', '10.0.0.1', '192.168.1.10']) {
      await expect(
        resolveLogoUrl(BASE, `http://${host}:9191/api/channels/logos/1174/cache/`, trustedOrigins)
      ).rejects.toThrow(SsrfBlockedError);
    }
  });

  it('keeps a Docker address that already names the DVR or a configured Dispatcharr', async () => {
    const dockerBase = 'http://172.18.0.5:8089';
    const trustedOrigins = ['http://172.18.0.6:9191'];
    await expect(
      resolveLogoUrl(
        dockerBase,
        'http://172.18.0.6:9191/api/channels/logos/7/cache/',
        trustedOrigins
      )
    ).resolves.toBe('http://172.18.0.6:9191/api/channels/logos/7/cache/');
    await expect(
      resolveLogoUrl(dockerBase, 'http://172.18.0.5:8089/tmsimg/assets/s1.png')
    ).resolves.toBe('http://172.18.0.5:8089/tmsimg/assets/s1.png');
  });

  it('allows https logos on public hostnames', async () => {
    await expect(
      resolveLogoUrl(BASE, 'https://cdn.iptvboss.pro/logos/USA/ABCKOCO.us.png')
    ).resolves.toBe('https://cdn.iptvboss.pro/logos/USA/ABCKOCO.us.png');
  });

  it.each([
    'http://cdn.example.com/logo.png',
    'https://127.0.0.1/logo.png',
    'https://192.168.1.10/logo.png',
    'https://[::1]/logo.png',
    'https://localhost/logo.png',
    'https://intranet/logo.png',
    'https://user:pass@cdn.example.com/logo.png',
    'file:///etc/passwd',
  ])('rejects %s', async (raw) => {
    await expect(resolveLogoUrl(BASE, raw)).rejects.toThrow();
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(resolveLogoUrl(BASE, 'https://cdn.example.com/logo.png')).rejects.toThrow(
      SsrfBlockedError
    );
    lookupMock.mockResolvedValue([
      { address: '104.18.0.1', family: 4 },
      { address: '::ffff:7f00:1', family: 6 },
    ]);
    await expect(resolveLogoUrl(BASE, 'https://cdn.example.com/logo.png')).rejects.toThrow(
      SsrfBlockedError
    );
  });
});
