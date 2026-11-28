/**
 * Channels DVR live streams and the clients sharing them (fork). The first case is a real
 * /dvr activity read: an Apple TV at home and a remote viewer on the same channel.
 */

import { describe, expect, it } from 'vitest';
import { groupLiveStreams, liveStreamKey } from '../channelsDvr/streams.js';

const entries = (activity: Record<string, string>) =>
  Object.entries(activity).map(([key, text]) => ({ key, text }));

describe('liveStreamKey', () => {
  it('reads the channel and source from a client on the network', () => {
    expect(liveStreamKey('6-stream-M3U-DispatcharrMPEGTS-4-192.168.30.2')).toEqual({
      channel: '4',
      deviceId: 'M3U-DispatcharrMPEGTS',
    });
    expect(liveStreamKey('7-ch1009-dM3U-Alabama-ip172.17.0.1')).toEqual({
      channel: '1009',
      deviceId: 'M3U-Alabama',
    });
  });

  it('reads the channel, and no source, from a client away from home or in the web player', () => {
    expect(liveStreamKey('7-ch4-dANY-26688a6db1d2')).toEqual({ channel: '4', deviceId: null });
    expect(liveStreamKey('7-ch1009-dANY-ip192.168.1.73')).toEqual({
      channel: '1009',
      deviceId: null,
    });
    expect(liveStreamKey('3-ch5.1-dANY-a1b2c3')).toEqual({ channel: '5.1', deviceId: null });
  });

  it('is null for recordings and library playback', () => {
    expect(liveStreamKey('0-job-1794391200-ch2')).toBeNull();
    expect(liveStreamKey('7-file1109-ip192.168.30.9')).toBeNull();
  });
});

describe('groupLiveStreams', () => {
  it('puts a client at home and one away on the same channel on one stream', () => {
    const streams = groupLiveStreams(
      entries({
        '6-stream-M3U-DispatcharrMPEGTS-4-192.168.30.2':
          'Watching ch4 NBC KFOR from Apple TV: buf=0% drop=0%',
        '7-ch4-dANY-26688a6db1d2':
          "Watching ch4 from Craig's Apple TV (Remux Starting: 28m54s @ 1x (60.04fps)): buf=0% drop=0%",
      })
    );

    expect(streams).toEqual([
      {
        channelNumber: '4',
        channelTitle: 'NBC KFOR',
        deviceId: 'M3U-DispatcharrMPEGTS',
        viewers: [
          { key: '6-stream-M3U-DispatcharrMPEGTS-4-192.168.30.2', name: 'Apple TV' },
          { key: '7-ch4-dANY-26688a6db1d2', name: "Craig's Apple TV" },
        ],
      },
    ]);
  });

  it('takes the source from a later line when the first names none', () => {
    const [stream] = groupLiveStreams(
      entries({
        '7-ch4-dANY-26688a6db1d2': "Watching ch4 from Craig's Apple TV",
        '6-stream-M3U-DispatcharrMPEGTS-4-192.168.30.2': 'Watching ch4 NBC KFOR from Apple TV',
      })
    );
    expect(stream).toMatchObject({ channelTitle: 'NBC KFOR', deviceId: 'M3U-DispatcharrMPEGTS' });
  });

  it('keeps channels apart, leaves out recordings, and names a client without a name by its IP', () => {
    const streams = groupLiveStreams(
      entries({
        '0-job-1794391200-ch2': 'Recording ch2 for News 9 @ 4a until 4:30AM',
        '6-stream-M3U-DispatcharrMPEGTS-2-192.168.30.8': 'Watching ch2 KWTV from Den',
        '6-stream-M3U-DispatcharrMPEGTS-23-192.168.30.9': 'Watching ch23 Heroes',
        '7-file1109-ip192.168.30.9': 'Watching recording Movie (2024).mpg from Mac at 40s',
      })
    );

    expect(streams.map((s) => [s.channelNumber, s.viewers.map((v) => v.name)])).toEqual([
      ['2', ['Den']],
      ['23', ['192.168.30.9']],
    ]);
  });

  it('has no name for a channel no line names', () => {
    const [stream] = groupLiveStreams(
      entries({ '7-ch4-dANY-26688a6db1d2': 'Watching ch4 from Den' })
    );
    expect(stream?.channelTitle).toBeNull();
  });
});
