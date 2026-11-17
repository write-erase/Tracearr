import { describe, expect, it } from 'vitest';
import {
  diffLineups,
  lineupChangeCount,
  parseLineups,
  type LineupSource,
} from '../channelsDvr/lineup.js';

/** Trimmed from a real `GET /devices`: one M3U source and Virtual Channels. */
const DEVICES = [
  {
    DeviceID: 'M3U-DispatcharrMPEGTS',
    FriendlyName: 'Dispatcharr MPEG-TS',
    Provider: 'm3u',
    TunerCount: 4,
    Channels: [
      { GuideNumber: '10', GuideName: 'ESPN', ID: 'a', HD: 1 },
      { GuideNumber: '2', GuideName: 'FOX', ID: 'b', HD: 1 },
      { GuideNumber: '4', GuideName: 'NBC', ID: 'c', HD: 1 },
      { GuideNumber: '4', GuideName: 'NBC duplicate', ID: 'd', HD: 1 },
      { GuideName: 'No number' },
    ],
  },
  {
    DeviceID: 'VIRTUAL',
    FriendlyName: 'Virtual Channels',
    Provider: 'VIRTUAL',
    Channels: [{ GuideNumber: '6000', GuideName: 'My Shows' }],
  },
];

const source = (channels: [string, string][], id = 'M3U-DispatcharrMPEGTS'): LineupSource => ({
  id,
  name: 'Dispatcharr MPEG-TS',
  channels: channels.map(([number, name]) => ({ number, name })),
});

describe('parseLineups', () => {
  it('reads each source in guide order and leaves out Virtual Channels', () => {
    expect(parseLineups(DEVICES)).toEqual([
      source([
        ['2', 'FOX'],
        ['4', 'NBC'],
        ['10', 'ESPN'],
      ]),
    ]);
  });

  it('reads nothing from something that is not a device list', () => {
    expect(parseLineups(null)).toEqual([]);
    expect(parseLineups({ error: 'x' })).toEqual([]);
  });
});

describe('diffLineups', () => {
  const before = source([
    ['2', 'FOX'],
    ['4', 'NBC'],
    ['10', 'ESPN'],
    ['210', 'CNN'],
  ]);

  it('says nothing when the lineup is the same', () => {
    expect(diffLineups([before], [before])).toEqual([]);
  });

  it('sorts changes into added, removed, renamed and moved', () => {
    const after = source([
      ['4', 'WDIV'],
      ['10', 'ESPN'],
      ['22', 'FOX'],
      ['105', 'ESPN2'],
    ]);
    const [change] = diffLineups([before], [after]);
    expect(change).toEqual({
      source: 'Dispatcharr MPEG-TS',
      status: 'changed',
      channelCount: 4,
      added: [{ number: '105', name: 'ESPN2' }],
      removed: [{ number: '210', name: 'CNN' }],
      renamed: [{ number: '4', from: 'NBC', to: 'WDIV' }],
      moved: [{ name: 'FOX', from: '2', to: '22' }],
    });
    expect(lineupChangeCount(change!)).toBe(4);
  });

  it('reports a whole source arriving or going away without listing its channels', () => {
    const other = { ...source([['1', 'Local']], 'HDHR-1'), name: 'HDHomeRun' };
    expect(diffLineups([before], [before, other])).toEqual([
      expect.objectContaining({ source: 'HDHomeRun', status: 'added', channelCount: 1, added: [] }),
    ]);
    expect(diffLineups([before, other], [before])).toEqual([
      expect.objectContaining({ source: 'HDHomeRun', status: 'removed', channelCount: 1 }),
    ]);
  });
});
