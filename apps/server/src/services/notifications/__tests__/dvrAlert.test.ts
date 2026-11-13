import { describe, expect, it } from 'vitest';
import { formatDvrBytes, toNotificationPayload } from '../types.js';
import type { DvrAlertPayload } from '../events.js';

const base: DvrAlertPayload = {
  serverId: 'srv',
  serverName: 'Channels DVR',
  serverType: 'channels_dvr',
  kind: 'recording_failed',
  jobId: '1794424758-ch2',
  recordingTitle: 'Beyond the Gates',
  channel: '2',
  error: "couldn't start the stream (connection refused)",
  freeBytes: null,
  totalBytes: null,
  freePercent: null,
  thresholdPercent: null,
  lineup: null,
};

const render = (payload: DvrAlertPayload) =>
  toNotificationPayload({ type: 'dvr_alert', payload }, { kind: 'system' });

describe('Channels DVR alert notifications', () => {
  it('words a failed recording with its reason', () => {
    const out = render(base);
    expect(out.title).toBe('Recording failed');
    expect(out.message).toBe(
      "Beyond the Gates on channel 2 failed on Channels DVR: couldn't start the stream (connection refused)"
    );
    expect(out.severity).toBe('high');
  });

  it('words a resume and a glitch', () => {
    expect(render({ ...base, kind: 'recording_resumed' }).message).toBe(
      'Beyond the Gates on channel 2 is recording again on Channels DVR'
    );
    expect(render({ ...base, kind: 'recording_glitch' }).severity).toBe('warning');
    expect(render({ ...base, kind: 'recording_started' }).message).toBe(
      'Beyond the Gates on channel 2 started recording on Channels DVR'
    );
    expect(render({ ...base, kind: 'recording_completed', error: null })).toMatchObject({
      title: 'Recording finished',
      message: 'Beyond the Gates on channel 2 finished recording on Channels DVR',
      severity: 'low',
    });
    expect(render({ ...base, kind: 'recording_missed' }).message).toBe(
      "Beyond the Gates on channel 2 should be recording on Channels DVR but hasn't started"
    );
  });

  it('words disk space in the units Channels shows', () => {
    const out = render({
      ...base,
      kind: 'disk_low',
      jobId: null,
      recordingTitle: null,
      channel: null,
      error: null,
      freeBytes: 25_900_000_000,
      totalBytes: 315_923_169_280,
      freePercent: 8.2,
      thresholdPercent: 10,
    });
    expect(out.title).toBe('DVR disk almost full');
    expect(out.message).toBe('Channels DVR has 24.1 GB free of 294.2 GB for recordings (8.2%)');
  });

  it('renders the alert variables in an automation template', () => {
    const out = toNotificationPayload(
      { type: 'dvr_alert', payload: base },
      {
        kind: 'automation',
        automationId: 'a',
        automationName: 'Recordings',
        title: '{{recording.title}} failed',
        body: 'ch {{recording.channel}}: {{recording.error}}',
      }
    );
    expect(out.title).toBe('Beyond the Gates failed');
    expect(out.message).toBe("ch 2: couldn't start the stream (connection refused)");
  });

  it('words a lineup change one line per source', () => {
    const out = render({
      ...base,
      kind: 'lineup_changed',
      jobId: null,
      recordingTitle: null,
      channel: null,
      error: null,
      lineup: [
        {
          source: 'Dispatcharr MPEG-TS',
          status: 'changed',
          channelCount: 209,
          added: [
            { number: '105', name: 'ESPN' },
            { number: '106', name: 'ESPN2' },
          ],
          removed: [{ number: '210', name: 'CNN' }],
          renamed: [{ number: '4', from: 'NBC', to: 'WDIV' }],
          moved: [{ name: 'FOX', from: '2', to: '22' }],
        },
        {
          source: 'HDHomeRun',
          status: 'added',
          channelCount: 1,
          added: [],
          removed: [],
          renamed: [],
          moved: [],
        },
      ],
    });
    expect(out.title).toBe('Channel lineup changed');
    expect(out.severity).toBe('warning');
    expect(out.message).toBe(
      'Dispatcharr MPEG-TS on Channels DVR: 2 added (105 ESPN, 106 ESPN2), 1 removed (210 CNN), ' +
        '1 renamed (4 NBC → WDIV), 1 moved (FOX 2 → 22)\n' +
        'HDHomeRun on Channels DVR: new source with 1 channel'
    );
  });

  it('shortens a long list of channels', () => {
    const added = Array.from({ length: 8 }, (_, i) => ({
      number: String(i + 1),
      name: `Ch${i + 1}`,
    }));
    const out = render({
      ...base,
      kind: 'lineup_changed',
      lineup: [
        {
          source: 'M3U',
          status: 'changed',
          channelCount: 8,
          added,
          removed: [],
          renamed: [],
          moved: [],
        },
      ],
    });
    expect(out.message).toBe(
      'M3U on Channels DVR: 8 added (1 Ch1, 2 Ch2, 3 Ch3, 4 Ch4, 5 Ch5 and 3 more)'
    );
  });

  it('formats bytes in binary units', () => {
    expect(formatDvrBytes(200396926976)).toBe('186.6 GB');
    expect(formatDvrBytes(512)).toBe('512 B');
  });
});
