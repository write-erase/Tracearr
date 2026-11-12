import { describe, expect, it } from 'vitest';
import { describeChannelsClient, isChannelsMacClient } from '../channelsDvr/macClient.js';

// Entries as /dvr/clients/info lists them
const macBook = {
  device: 'iPad8,6',
  hostname: 'iPad',
  machine_id: '9F5A5EE9-EE9D-5DE7-A841-C2DF1CD42F31',
  platform: 'iPadOS 27.2',
};
const macMini = {
  alias: 'Mac Mini',
  device: 'iPad8,6',
  hostname: 'Mac Mini',
  machine_id: '2D95AC45-FF94-5B94-A2EA-FFD9ED33F259',
  platform: 'iPadOS 27.2',
};
const iPad = {
  device: 'iPad16,2',
  hostname: 'iPad',
  machine_id: '1D1522EA-708A-49B6-85C3-1C92DE920EB2',
  platform: 'iPadOS 27.2',
};
const appleTv = {
  device: 'AppleTV14,1',
  hostname: 'Living Room Apple TV',
  machine_id: 'F715D930-100B-439D-BA48-3662B8ABD3B9',
  platform: 'tvOS 27.2',
};

describe('Channels Mac app detection', () => {
  it('recognises the Mac app by its name-based machine_id', () => {
    expect(isChannelsMacClient(macBook)).toBe(true);
    expect(isChannelsMacClient(macMini)).toBe(true);
  });

  it('leaves real iPads, Apple TVs and clients without a machine_id alone', () => {
    expect(isChannelsMacClient(iPad)).toBe(false);
    expect(isChannelsMacClient(appleTv)).toBe(false);
    expect(isChannelsMacClient({ ...macBook, machine_id: undefined })).toBe(false);
    // The same old iPad model on a real iPad: random machine_id
    expect(isChannelsMacClient({ ...iPad, device: 'iPad8,6' })).toBe(false);
  });

  it('reports the Mac app as a Mac, replacing the generic "iPad" name', () => {
    expect(describeChannelsClient(macBook)).toEqual({
      name: 'Mac',
      device: 'Mac',
      platform: 'macOS 27.2',
    });
    expect(describeChannelsClient(macMini)).toEqual({
      name: 'Mac Mini',
      device: 'Mac',
      platform: 'macOS 27.2',
    });
  });

  it('passes other clients through unchanged', () => {
    expect(describeChannelsClient(iPad)).toEqual({
      name: 'iPad',
      device: 'iPad16,2',
      platform: 'iPadOS 27.2',
    });
    expect(describeChannelsClient({ ...appleTv, hostname: '', alias: 'Den' })).toEqual({
      name: 'Den',
      device: 'AppleTV14,1',
      platform: 'tvOS 27.2',
    });
  });
});
