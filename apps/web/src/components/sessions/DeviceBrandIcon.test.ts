import { describe, expect, it } from 'vitest';
import { deviceBrand } from './DeviceBrandIcon';

describe('deviceBrand', () => {
  it.each([
    ['Apple TV', { platform: 'tvOS 26.1', device: 'AppleTV14,1' }, 'apple'],
    ['iPad', { platform: 'iPadOS 26.1', device: 'iPad13,18' }, 'apple'],
    ['iPhone', { platform: 'iOS 26.1', device: 'iPhone18,3' }, 'apple'],
    ['Channels Mac app', { platform: 'macOS 27.2', device: 'Mac' }, 'apple'],
    ['Fire TV model code', { platform: 'Android', device: 'AFTKM' }, 'amazon'],
    ['Fire TV platform', { platform: 'Fire TV', device: 'Fire TV Stick 4K' }, 'amazon'],
    ['Chromecast', { platform: 'Android', device: 'Chromecast' }, 'google'],
    ['Android TV', { platform: 'Android TV', device: 'SHIELD Android TV' }, 'android'],
    ['Android phone', { platform: 'Android', device: 'Galaxy S8' }, 'android'],
  ])('%s → %s', (_label, info, expected) => {
    expect(deviceBrand(info)).toBe(expected);
  });

  it.each([
    ['Channels web player', { platform: 'Web', product: 'Channels Web', device: 'Web Browser' }],
    ['nothing reported', {}],
  ])('%s has no logo', (_label, info) => {
    expect(deviceBrand(info)).toBeNull();
  });
});
