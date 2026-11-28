/**
 * Live TV streams on a Channels DVR server and the clients sharing each one (fork).
 *
 * Channels lists one activity line per client watching, keyed by the channel and, for clients
 * on the network, the tuner source the stream comes from:
 *   "6-stream-M3U-DispatcharrMPEGTS-4-192.168.30.2": "Watching ch4 NBC KFOR from Apple TV: ..."
 *   "7-ch1009-dM3U-Alabama-ip172.17.0.1": "Watching ch1009 from Kitchen TV (Remux ...): ..."
 * A client away from home (cellular HLS) names no source: "7-ch4-dANY-26688a6db1d2". Clients on
 * the same channel share one stream from its source, so the lines are grouped by channel, as the
 * tuner count is; the source comes from whichever line names it.
 */

import type { ChannelsDvrActivityEntry } from './parser.js';
import { parseWatchActivity } from './parser.js';

/** One live channel being streamed, with the clients watching it */
export interface ChannelsDvrLiveStream {
  channelNumber: string;
  /** The channel's name from an activity line that has one */
  channelTitle: string | null;
  /** The tuner source's device id from a line that names one ("M3U-DispatcharrMPEGTS") */
  deviceId: string | null;
  /** Each client: its activity key (Tracearr's session key) and its name in the line, else its IP */
  viewers: { key: string; name: string }[];
}

const STREAM_KEY = /^\d+-stream-(.+)-([\d.]+)-(?:ip)?[\da-f.:]+$/i;
const CHANNEL_KEY = /^\d+-ch([\d.]+)-d(.+)$/i;
const IP_SUFFIX = /-ip\d{1,3}(?:\.\d{1,3}){3}$/i;

/** The channel and tuner source an activity key names; null when it isn't a live stream key */
export function liveStreamKey(key: string): { channel: string; deviceId: string | null } | null {
  const stream = STREAM_KEY.exec(key);
  if (stream?.[1] && stream[2]) return { channel: stream[2], deviceId: stream[1] };
  const channel = CHANNEL_KEY.exec(key);
  if (!channel?.[1] || !channel[2]) return null;
  // "dM3U-Alabama-ip172.17.0.1" names its source; "dANY-<session id>" and "dANY-ip<address>" don't
  const device = IP_SUFFIX.test(channel[2]) ? channel[2].replace(IP_SUFFIX, '') : null;
  return { channel: channel[1], deviceId: device && !/^ANY$/i.test(device) ? device : null };
}

/** Live clients grouped by channel, in the order Channels first lists each channel */
export function groupLiveStreams(entries: ChannelsDvrActivityEntry[]): ChannelsDvrLiveStream[] {
  const streams = new Map<string, ChannelsDvrLiveStream>();
  for (const entry of entries) {
    const target = liveStreamKey(entry.key);
    if (!target) continue;
    const parsed = parseWatchActivity(entry);
    if (!parsed || parsed.kind !== 'live') continue;
    let stream = streams.get(target.channel);
    if (!stream) {
      stream = { channelNumber: target.channel, channelTitle: null, deviceId: null, viewers: [] };
      streams.set(target.channel, stream);
    }
    // "ch4" alone is the channel number, not its name
    if (!stream.channelTitle && parsed.title && !/^ch(?:annel)?\s*[\w.]+$/i.test(parsed.title)) {
      stream.channelTitle = parsed.title;
    }
    stream.deviceId ??= target.deviceId;
    stream.viewers.push({
      key: entry.key,
      name: parsed.clientName ?? parsed.ipAddress ?? entry.key,
    });
  }
  return [...streams.values()];
}
