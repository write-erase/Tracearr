import { z } from 'zod';

export type TriggerContext = 'session' | 'account' | 'media' | 'server' | 'install';

/**
 * What each context sits under. `media` names a server and no account, so the
 * contexts are a tree rather than a line and `install` is its root.
 */
const TRIGGER_CONTEXT_PARENT: Record<TriggerContext, TriggerContext | null> = {
  session: 'account',
  account: 'server',
  media: 'server',
  server: 'install',
  install: null,
};

/** Whether a trigger of this context carries everything `requires` names. */
export function contextSupplies(context: TriggerContext, requires: TriggerContext): boolean {
  for (let at: TriggerContext | null = context; at; at = TRIGGER_CONTEXT_PARENT[at]) {
    if (at === requires) return true;
  }
  return false;
}

/** The narrowest context both supply: their lowest common ancestor in the tree. */
function meet(a: TriggerContext, b: TriggerContext): TriggerContext {
  for (let at: TriggerContext | null = b; at; at = TRIGGER_CONTEXT_PARENT[at]) {
    if (contextSupplies(a, at)) return at;
  }
  // Unreachable: every chain ends at the root, which supplies nothing and is shared.
  return 'install';
}

const SESSION_VARS = [
  'user.username',
  'user.identityName',
  'session.mediaTitle',
  'session.mediaType',
  'server.name',
  'server.type',
] as const;
/**
 * What is on screen, for the triggers that carry a whole stream. `account.new_device`
 * announces the device rather than the file, so it keeps the shorter list.
 */
const STREAM_VARS = [
  ...SESSION_VARS,
  'session.sourceDynamicRange',
  'session.sourceVideoCodec',
  'session.seasonNumber',
  'session.episodeNumber',
  'session.name',
] as const;
const ACCOUNT_VARS = ['user.username', 'user.identityName', 'server.name', 'server.type'] as const;
const SERVER_VARS = ['server.name', 'server.type'] as const;
/** `server.name` doubles `media.server` so an automation that also carries a server trigger keeps one. */
const MEDIA_VARS = [
  'media.title',
  'media.name',
  'media.show',
  'media.season',
  'media.episode',
  'media.episodeCount',
  'media.type',
  'media.year',
  'media.library',
  'media.server',
  'server.name',
  'server.type',
] as const;
const MEDIA_QUALITY_VARS = [
  'media.from.resolution',
  'media.to.resolution',
  'media.from.dynamicRange',
  'media.to.dynamicRange',
  'media.from.videoCodec',
  'media.to.videoCodec',
  'media.from.audioCodec',
  'media.to.audioCodec',
  'media.from.audioChannels',
  'media.to.audioChannels',
  'media.from.fileSize',
  'media.to.fileSize',
] as const;
const NEWSLETTER_VARS = [
  'newsletter.name',
  'newsletter.outcome',
  'newsletter.recipientCount',
  'newsletter.error',
] as const;

/** A Channels DVR recording an alert is about. */
const RECORDING_VARS = [
  ...SERVER_VARS,
  'recording.title',
  'recording.channel',
  'recording.error',
] as const;
/** Channels DVR recording space; sizes in binary units, as Channels shows them. */
const DISK_VARS = [
  ...SERVER_VARS,
  'disk.free',
  'disk.total',
  'disk.freePercent',
  'disk.threshold',
] as const;
/** A Channels DVR lineup change, listed per source. */
const LINEUP_VARS = [
  ...SERVER_VARS,
  'lineup.summary',
  'lineup.sources',
  'lineup.added',
  'lineup.removed',
  'lineup.renamed',
  'lineup.moved',
] as const;

/** What a trigger is about, and what the list filters on. */
export const TRIGGER_GROUPS = [
  'sessions',
  'accounts',
  'library',
  'servers',
  'updates',
  'notifications',
] as const;
export type TriggerGroup = (typeof TRIGGER_GROUPS)[number];

export const TRIGGERS = {
  'session.started': { context: 'session', group: 'sessions', variables: STREAM_VARS },
  'session.first_seen': { context: 'session', group: 'sessions', variables: STREAM_VARS },
  'session.stopped': {
    context: 'session',
    group: 'sessions',
    variables: [...STREAM_VARS, 'durationMinutes'],
  },
  'session.transcode_changed': { context: 'session', group: 'sessions', variables: STREAM_VARS },
  'session.paused': { context: 'session', group: 'sessions', variables: STREAM_VARS },
  'session.held_for': {
    context: 'session',
    group: 'sessions',
    variables: [...STREAM_VARS, 'minutes'],
  },
  'session.watched': { context: 'session', group: 'sessions', variables: STREAM_VARS },
  'account.inactive_for': {
    context: 'account',
    group: 'accounts',
    variables: [...ACCOUNT_VARS, 'days'],
  },
  'account.new_device': {
    context: 'session',
    group: 'accounts',
    variables: [
      ...SESSION_VARS,
      'device.name',
      'device.platform',
      'device.product',
      'device.location',
    ],
  },
  'account.trust_changed': {
    context: 'account',
    group: 'accounts',
    variables: [...ACCOUNT_VARS, 'trust.previous', 'trust.new', 'trust.reason'],
  },
  'account.media_downloaded': {
    context: 'account',
    group: 'accounts',
    variables: [
      ...ACCOUNT_VARS,
      'download.title',
      'download.app',
      'download.device',
      'download.last24h',
    ],
  },
  'media.added': { context: 'media', group: 'library', variables: MEDIA_VARS },
  'media.upgraded': {
    context: 'media',
    group: 'library',
    variables: [...MEDIA_VARS, ...MEDIA_QUALITY_VARS],
  },
  'server.down': { context: 'server', group: 'servers', variables: SERVER_VARS },
  'server.up': { context: 'server', group: 'servers', variables: SERVER_VARS },
  'plugin.update_available': {
    context: 'server',
    group: 'updates',
    variables: [...SERVER_VARS, 'installedVersion', 'latestVersion', 'downloadUrl'],
  },
  'server.update_available': {
    context: 'server',
    group: 'updates',
    variables: [...SERVER_VARS, 'installedVersion', 'latestVersion', 'releaseUrl'],
  },
  'tracearr.update_available': {
    context: 'install',
    group: 'updates',
    variables: ['installedVersion', 'latestVersion', 'releaseUrl'],
  },
  'dvr.recording_failed': { context: 'server', group: 'servers', variables: RECORDING_VARS },
  'dvr.recording_resumed': { context: 'server', group: 'servers', variables: RECORDING_VARS },
  'dvr.recording_glitch': { context: 'server', group: 'servers', variables: RECORDING_VARS },
  'dvr.recording_missed': { context: 'server', group: 'servers', variables: RECORDING_VARS },
  'dvr.disk_low': { context: 'server', group: 'servers', variables: DISK_VARS },
  'dvr.disk_ok': { context: 'server', group: 'servers', variables: DISK_VARS },
  'dvr.lineup_changed': { context: 'server', group: 'servers', variables: LINEUP_VARS },
  'newsletter.sent': { context: 'install', group: 'notifications', variables: NEWSLETTER_VARS },
  'newsletter.failed': { context: 'install', group: 'notifications', variables: NEWSLETTER_VARS },
} as const satisfies Record<
  string,
  { context: TriggerContext; group: TriggerGroup; variables: readonly string[] }
>;

export type TriggerType = keyof typeof TRIGGERS;

/** Every name some trigger offers a template. */
export type TemplateVariable = (typeof TRIGGERS)[TriggerType]['variables'][number];

/** Names a template may still use after a rename; each resolves to the current name. */
export const VARIABLE_ALIASES: Readonly<Record<string, TemplateVariable>> = {
  current: 'installedVersion',
  latest: 'latestVersion',
};

export function resolveVariable(name: string): string {
  return Object.hasOwn(VARIABLE_ALIASES, name) ? (VARIABLE_ALIASES[name] ?? name) : name;
}

/** The release that first shipped a trigger; one not listed has been there since 2.2.0. */
export const TRIGGER_INTRODUCED_IN: Partial<Record<TriggerType, string>> = {
  'session.first_seen': '2.3.0',
  'newsletter.sent': '2.3.0',
  'newsletter.failed': '2.3.0',
  'account.media_downloaded': '3.0.0',
  'session.watched': '3.1.4',
  'dvr.recording_failed': '3.1.7',
  'dvr.recording_resumed': '3.1.7',
  'dvr.recording_glitch': '3.1.7',
  'dvr.recording_missed': '3.1.7',
  'dvr.disk_low': '3.1.7',
  'dvr.disk_ok': '3.1.7',
  'dvr.lineup_changed': '3.1.7',
};
export const TRIGGER_TYPES = Object.keys(TRIGGERS) as TriggerType[];

/** Triggers a violation is never about: nobody did anything wrong by picking up a new phone. */
export const NOTIFICATION_ONLY_TRIGGERS = [
  'account.new_device',
  'account.trust_changed',
] as const satisfies readonly TriggerType[];

/** Triggers whose node carries params, each validated by its own branch of the schema. */
const PARAM_TRIGGER_TYPES = [
  'session.held_for',
  'account.inactive_for',
  'dvr.disk_low',
  'dvr.disk_ok',
] as const satisfies readonly TriggerType[];

type ParamlessTriggerType = Exclude<TriggerType, (typeof PARAM_TRIGGER_TYPES)[number]>;

const PARAMLESS_TRIGGER_TYPES = TRIGGER_TYPES.filter(
  (type): type is ParamlessTriggerType =>
    !(PARAM_TRIGGER_TYPES as readonly TriggerType[]).includes(type)
);

// z.uuid() rather than schemas.ts's uuidSchema: schemas.ts re-exports this directory's
// condition and action schemas, and importing back would read the binding before it exists.
const nodeBase = { id: z.uuid(), enabled: z.boolean() };

export const heldForParamsSchema = z.strictObject({
  minutes: z.number().int().min(1).max(1440),
  measure: z.enum(['current', 'total']),
});
export const inactiveForParamsSchema = z.strictObject({
  days: z.number().int().min(1).max(3650),
});

/** A disk alert's threshold: free space for recordings, as a percentage of the disk. */
export const diskThresholdParamsSchema = z.strictObject({
  percent: z.number().int().min(1).max(90),
});
/** The threshold a disk alert starts at, and the dashboard's when no alert sets one. */
export const DEFAULT_DISK_ALERT_PERCENT = 10;

export const triggerNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...nodeBase, type: z.enum(PARAMLESS_TRIGGER_TYPES) }),
  z.strictObject({ ...nodeBase, type: z.literal('session.held_for'), params: heldForParamsSchema }),
  z.strictObject({
    ...nodeBase,
    type: z.literal('account.inactive_for'),
    params: inactiveForParamsSchema,
  }),
  z.strictObject({
    ...nodeBase,
    type: z.literal('dvr.disk_low'),
    params: diskThresholdParamsSchema,
  }),
  z.strictObject({
    ...nodeBase,
    type: z.literal('dvr.disk_ok'),
    params: diskThresholdParamsSchema,
  }),
]);
export type TriggerNode = z.infer<typeof triggerNodeSchema>;

/** The most demanding context every enabled trigger can satisfy; null when nothing is enabled. */
export function contextOf(triggers: readonly TriggerNode[]): TriggerContext | null {
  let shared: TriggerContext | null = null;
  for (const trigger of triggers) {
    if (!trigger.enabled) continue;
    const context = TRIGGERS[trigger.type].context;
    shared = shared === null ? context : meet(shared, context);
  }
  return shared;
}

/** The variables every enabled trigger offers, so a template renders whichever one fired. */
export function variablesFor(
  triggers: readonly { type: TriggerType; enabled: boolean }[]
): TemplateVariable[] {
  const sets = triggers
    .filter((trigger) => trigger.enabled)
    .map((trigger) => new Set<TemplateVariable>(TRIGGERS[trigger.type].variables));
  const first = sets[0];
  if (!first) return [];
  return [...first].filter((variable) => sets.every((set) => set.has(variable)));
}
