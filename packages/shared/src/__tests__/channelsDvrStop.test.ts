import { describe, expect, it } from 'vitest';
import { isDockerGatewayAddress, isTailscaleAddress } from '../channelsDvrStop.js';

describe('isDockerGatewayAddress', () => {
  it.each(['172.17.0.1', '172.18.0.1', '172.25.0.1', '172.31.0.1'])('is true for %s', (ip) => {
    expect(isDockerGatewayAddress(ip)).toBe(true);
  });

  it.each([
    '172.16.0.1',
    '172.32.0.1',
    '172.17.0.2',
    '172.20.4.12',
    '192.168.1.1',
    '100.101.102.103',
    '',
    null,
    undefined,
  ])('is false for %s', (ip) => {
    expect(isDockerGatewayAddress(ip)).toBe(false);
  });
});

describe('isTailscaleAddress', () => {
  it.each(['100.64.0.1', '100.101.102.103', '100.127.255.254'])('is true for %s', (ip) => {
    expect(isTailscaleAddress(ip)).toBe(true);
  });

  it.each(['100.63.0.1', '100.128.0.1', '10.0.0.5', '192.168.1.73', '1100.64.0.1', null])(
    'is false for %s',
    (ip) => {
      expect(isTailscaleAddress(ip)).toBe(false);
    }
  );
});
