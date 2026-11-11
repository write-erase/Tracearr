import { describe, expect, it } from 'vitest';
import { deviceKind } from './DeviceTypeIcon';

describe('deviceKind', () => {
  it.each([
    // Channels DVR clients, as /dvr/clients/info reports them
    [{ platform: 'tvOS 27.2', device: 'AppleTV14,1' }, 'tv'],
    [{ platform: 'iPadOS 26.1', device: 'iPad13,18' }, 'tablet'],
    [{ platform: 'macOS 27.2', device: 'Mac' }, 'desktop'], // Channels Mac app, as the server reports it
    [{ platform: 'iOS 27.2.1', device: 'iPhone18,3' }, 'phone'],
    [{ platform: 'Web', product: 'Channels Web' }, 'browser'],
    // Other servers' shapes
    [{ platform: 'Android TV', device: 'SHIELD Android TV' }, 'tv'],
    [{ platform: 'Android', device: 'AFTKM' }, 'tv'],
    [{ platform: 'Roku', device: 'Sun Room' }, 'tv'],
    [{ platform: 'webOS', device: 'LG 65UJ6200-UA' }, 'tv'],
    [{ platform: 'Tizen', device: 'TV 2020' }, 'tv'],
    [{ platform: 'Android', device: 'Galaxy S8' }, 'phone'],
    [{ platform: 'Chrome', device: 'Windows' }, 'browser'],
    [{ platform: 'macOS', device: 'Mac' }, 'desktop'],
    [{}, 'desktop'],
  ] as const)('%o is a %s', (info, kind) => {
    expect(deviceKind(info)).toBe(kind);
  });

  it('does not take tvOS for a phone because it contains "ios"', () => {
    expect(deviceKind({ platform: 'tvOS 27.2' })).toBe('tv');
  });
});
