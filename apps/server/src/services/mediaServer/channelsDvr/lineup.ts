/**
 * Channel lineups from `GET /devices`: each source's channels, and what changed between two reads.
 *
 * A source is keyed by its DeviceID and named by its FriendlyName. Virtual Channels are left out:
 * they're the owner's own playlists, not a provider's lineup. A channel is its GuideNumber and
 * GuideName; the same number with a new name is a rename, the same name at a new number a move.
 */

export interface LineupChannel {
  number: string;
  name: string;
}

export interface LineupSource {
  id: string;
  name: string;
  channels: LineupChannel[];
}

export interface LineupSourceChange {
  source: string;
  /** A whole source appeared or went away; its channels aren't listed one by one. */
  status: 'changed' | 'added' | 'removed';
  channelCount: number;
  added: LineupChannel[];
  removed: LineupChannel[];
  renamed: { number: string; from: string; to: string }[];
  moved: { name: string; from: string; to: string }[];
}

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isVirtual(device: Record<string, unknown>): boolean {
  return [device.DeviceID, device.Provider].some(
    (value) => typeof value === 'string' && value.toUpperCase() === 'VIRTUAL'
  );
}

/** Guide numbers in channel order: 2 before 10, 4.1 before 4.2. */
export function compareGuideNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export function parseLineups(data: unknown): LineupSource[] {
  if (!Array.isArray(data)) return [];
  const sources: LineupSource[] = [];
  for (const device of data) {
    if (!device || typeof device !== 'object') continue;
    const record = device as Record<string, unknown>;
    if (isVirtual(record)) continue;
    const id = text(record.DeviceID);
    if (!id) continue;
    const seen = new Set<string>();
    const channels: LineupChannel[] = [];
    for (const channel of Array.isArray(record.Channels) ? record.Channels : []) {
      if (!channel || typeof channel !== 'object') continue;
      const entry = channel as Record<string, unknown>;
      const number = text(entry.GuideNumber);
      // A number listed twice keeps its first name.
      if (!number || seen.has(number)) continue;
      seen.add(number);
      channels.push({ number, name: text(entry.GuideName) ?? '' });
    }
    channels.sort((a, b) => compareGuideNumbers(a.number, b.number));
    sources.push({ id, name: text(record.FriendlyName) ?? id, channels });
  }
  return sources;
}

function diffSource(before: LineupSource, after: LineupSource): LineupSourceChange | null {
  const oldByNumber = new Map(before.channels.map((c) => [c.number, c.name]));
  const newByNumber = new Map(after.channels.map((c) => [c.number, c.name]));

  const renamed: LineupSourceChange['renamed'] = [];
  for (const [number, to] of newByNumber) {
    const from = oldByNumber.get(number);
    if (from !== undefined && from !== to) renamed.push({ number, from, to });
  }
  let removed = before.channels.filter((c) => !newByNumber.has(c.number));
  let added = after.channels.filter((c) => !oldByNumber.has(c.number));

  // A name that left one number and arrived at another moved.
  const moved: LineupSourceChange['moved'] = [];
  const arrivals = new Map<string, LineupChannel[]>();
  for (const channel of added) {
    if (!channel.name) continue;
    arrivals.set(channel.name, [...(arrivals.get(channel.name) ?? []), channel]);
  }
  const movedFrom = new Set<LineupChannel>();
  const movedTo = new Set<LineupChannel>();
  for (const channel of removed) {
    const target = arrivals.get(channel.name)?.shift();
    if (!target) continue;
    moved.push({ name: channel.name, from: channel.number, to: target.number });
    movedFrom.add(channel);
    movedTo.add(target);
  }
  removed = removed.filter((c) => !movedFrom.has(c));
  added = added.filter((c) => !movedTo.has(c));

  if (!added.length && !removed.length && !renamed.length && !moved.length) return null;
  return {
    source: after.name,
    status: 'changed',
    channelCount: after.channels.length,
    added,
    removed,
    renamed,
    moved,
  };
}

/** What changed between two reads, per source; sources with no change are left out. */
export function diffLineups(before: LineupSource[], after: LineupSource[]): LineupSourceChange[] {
  const empty = { added: [], removed: [], renamed: [], moved: [] };
  const changes: LineupSourceChange[] = [];
  const oldById = new Map(before.map((s) => [s.id, s]));
  const newIds = new Set(after.map((s) => s.id));
  for (const source of after) {
    const previous = oldById.get(source.id);
    if (!previous) {
      changes.push({
        source: source.name,
        status: 'added',
        channelCount: source.channels.length,
        ...empty,
      });
      continue;
    }
    const change = diffSource(previous, source);
    if (change) changes.push(change);
  }
  for (const source of before) {
    if (newIds.has(source.id)) continue;
    changes.push({
      source: source.name,
      status: 'removed',
      channelCount: source.channels.length,
      ...empty,
    });
  }
  return changes;
}

/** How many channels a change touches, for logs and headlines. */
export function lineupChangeCount(change: LineupSourceChange): number {
  return change.status === 'changed'
    ? change.added.length + change.removed.length + change.renamed.length + change.moved.length
    : change.channelCount;
}
