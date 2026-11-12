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

  it('formats bytes in binary units', () => {
    expect(formatDvrBytes(200396926976)).toBe('186.6 GB');
    expect(formatDvrBytes(512)).toBe('512 B');
  });
});
