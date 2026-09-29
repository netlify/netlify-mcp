// The catalogue of Netlify events this server can deliver to an MCP client, and
// the JSON Schemas it advertises for them.
//
// Every entry maps an MCP-facing event name onto a Netlify outgoing-hook event
// (`UrlHook`'s `events` declarations in bitballoon). We expose dotted names
// rather than Netlify's snake_case because (a) it matches the convention in the
// events extension, and (b) some Netlify names are wrong from a caller's point
// of view — `deploy_created` fires on SUCCESS, and a model asked to watch for
// successful deploys will not reliably pick a symbol called "created".
//
// `requiresCapability` records the account capability that gates the event in
// bitballoon (`Hook::Event#available_for?`). It is enforced at subscribe time
// because the gate is otherwise SILENT: `Hook#restricted?` makes the trigger
// path skip a restricted hook, so a hook created without the capability is
// stored successfully and then never fires.

export interface EventDefinition {
  /** The `event` value Netlify stores on the hook. */
  netlifyEvent: string;
  /** Account capability required for the hook to actually fire, if any. */
  requiresCapability?: string;
  /** True when the gate is a per-site setting rather than an account capability. */
  requiresSiteSetting?: 'dev_server';
  description: string;
  /** Which Netlify payload class arrives on the wire, so the relay can project it. */
  payloadKind: 'deploy' | 'form_submission' | 'split_test' | 'dev_server';
}

// Shared across every deploy event: which site, and optional narrowing that
// Netlify itself cannot do (hooks fire for ALL deploys of a site), so the relay
// filters on delivery.
const DEPLOY_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    site: {
      type: 'string',
      description:
        "The site to watch. Accepts a site ID, or the site's name/slug (e.g. 'my-marketing-site'). " +
        'Prefer the ID when it is already known; names are resolved server-side.',
    },
    branch: {
      type: 'string',
      description: 'Optional. Only notify for deploys of this git branch (e.g. "main").',
    },
    context: {
      type: 'string',
      enum: ['production', 'branch-deploy', 'deploy-preview'],
      description:
        'Optional. Only notify for deploys in this context. Use "production" to ignore ' +
        'deploy previews and branch deploys, which are usually the bulk of deploy volume.',
    },
  },
  required: ['site'],
  additionalProperties: false,
} as const;

const SITE_ONLY_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    site: {
      type: 'string',
      description: "The site to watch. Accepts a site ID, or the site's name/slug.",
    },
  },
  required: ['site'],
  additionalProperties: false,
} as const;

// The projected deploy payload. Deliberately far smaller than Netlify's
// DeploySerializer (~70 fields), which carries the parsed netlify.toml in
// `file_configuration` and thousands of file SHAs in `required` — that both
// leaks build configuration to the subscriber and can blow the extension's
// 256 KiB per-event ceiling on a large site.
const DEPLOY_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    site_id: { type: 'string' },
    site_name: { type: 'string' },
    deploy_id: { type: 'string' },
    state: { type: 'string', description: 'Deploy state, e.g. "ready" or "error".' },
    error_message: {
      type: ['string', 'null'],
      description: 'Why the deploy failed, when it failed. Null otherwise.',
    },
    branch: { type: ['string', 'null'] },
    context: { type: ['string', 'null'], description: 'production | branch-deploy | deploy-preview' },
    commit_ref: { type: ['string', 'null'] },
    commit_url: { type: ['string', 'null'] },
    committer: { type: ['string', 'null'] },
    deploy_time: { type: ['number', 'null'], description: 'Seconds the deploy took.' },
    admin_url: {
      type: ['string', 'null'],
      description: 'Deploy detail page in the Netlify UI — the link to show a human.',
    },
    deploy_url: { type: ['string', 'null'], description: 'Public URL this deploy is served at.' },
    created_at: { type: ['string', 'null'] },
  },
  required: ['site_id', 'deploy_id', 'state'],
  additionalProperties: false,
} as const;

const FORM_SUBMISSION_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    site_id: { type: 'string' },
    submission_id: { type: 'string' },
    form_id: { type: ['string', 'null'] },
    form_name: { type: ['string', 'null'] },
    created_at: { type: ['string', 'null'] },
    // `data` is caller-authored form content of unknown shape. Passed through
    // (size-capped by the relay) because projecting it would defeat the point.
    data: { type: 'object', additionalProperties: true },
  },
  required: ['site_id', 'submission_id'],
  additionalProperties: false,
} as const;

const SPLIT_TEST_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    site_id: { type: 'string' },
    split_test_id: { type: 'string' },
    name: { type: ['string', 'null'] },
    active: { type: ['boolean', 'null'] },
    branches: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['site_id', 'split_test_id'],
  additionalProperties: false,
} as const;

const DEV_SERVER_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    site_id: { type: 'string' },
    dev_server_id: { type: 'string' },
    state: { type: ['string', 'null'] },
    branch: { type: ['string', 'null'] },
    url: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
  },
  required: ['site_id', 'dev_server_id'],
  additionalProperties: false,
} as const;

const DEPLOY_CAP = 'deploy_url_hooks';

export const EVENT_DEFINITIONS: Record<string, EventDefinition> = {
  'deploy.failed': {
    netlifyEvent: 'deploy_failed',
    requiresCapability: DEPLOY_CAP,
    payloadKind: 'deploy',
    description:
      'A deploy failed for the given site. Fires on EVERY failure, so a site that stays ' +
      'broken keeps notifying — prefer deploy.started_failing to hear only about the ' +
      'transition from working to broken.',
  },
  'deploy.started_failing': {
    netlifyEvent: 'deploy_failed_after_succeeding',
    requiresCapability: DEPLOY_CAP,
    payloadKind: 'deploy',
    description:
      'A deploy failed for the given site after the previous one succeeded — i.e. the site ' +
      'just broke. The best default for "tell me when my deploys break": one notification ' +
      'per breakage rather than one per failed build.',
  },
  'deploy.recovered': {
    netlifyEvent: 'deploy_succeeded_after_failing',
    requiresCapability: DEPLOY_CAP,
    payloadKind: 'deploy',
    description: 'A deploy succeeded for the given site after the previous one failed — the site is fixed.',
  },
  'deploy.succeeded': {
    netlifyEvent: 'deploy_created',
    requiresCapability: DEPLOY_CAP,
    payloadKind: 'deploy',
    description:
      'A deploy finished successfully and is live. High volume on an active site — narrow it ' +
      'with the context filter (e.g. "production") unless every deploy preview is wanted.',
  },
  'deploy.building': {
    netlifyEvent: 'deploy_building',
    requiresCapability: DEPLOY_CAP,
    payloadKind: 'deploy',
    description: 'A deploy started building for the given site.',
  },
  'deploy.locked': {
    netlifyEvent: 'deploy_locked',
    requiresCapability: DEPLOY_CAP,
    payloadKind: 'deploy',
    description: 'A deploy was locked, pinning the published version and stopping auto-publish.',
  },
  'deploy.unlocked': {
    netlifyEvent: 'deploy_unlocked',
    requiresCapability: DEPLOY_CAP,
    payloadKind: 'deploy',
    description: 'A deploy was unlocked, resuming auto-publish.',
  },
  'deploy.deleted': {
    netlifyEvent: 'deploy_deleted',
    payloadKind: 'deploy',
    // No `requiresCapability`: in bitballoon deploy_deleted carries `visible_if`
    // only, and `restricted_for?` keys off `available_if` — so it is hidden from
    // the UI list on some plans but never blocked from firing.
    description: 'A deploy was deleted for the given site.',
  },
  'deploy.restored': {
    netlifyEvent: 'deploy_restored',
    payloadKind: 'deploy',
    description: 'A previous deploy was restored (rolled back to) for the given site.',
  },
  'deploy_request.pending': {
    netlifyEvent: 'deploy_request_pending',
    payloadKind: 'deploy',
    description: 'A deploy is awaiting review before it can be built (deploy request pending).',
  },
  'deploy_request.accepted': {
    netlifyEvent: 'deploy_request_accepted',
    payloadKind: 'deploy',
    description: 'A pending deploy request was accepted and will build.',
  },
  'deploy_request.rejected': {
    netlifyEvent: 'deploy_request_rejected',
    payloadKind: 'deploy',
    description: 'A pending deploy request was rejected.',
  },
  'form.submission_created': {
    netlifyEvent: 'submission_created',
    payloadKind: 'form_submission',
    description: 'A form submission was received for the given site.',
  },
  'split_test.activated': {
    netlifyEvent: 'split_test_activated',
    payloadKind: 'split_test',
    description: 'A split test (A/B test) was activated for the given site.',
  },
  'split_test.deactivated': {
    netlifyEvent: 'split_test_deactivated',
    payloadKind: 'split_test',
    description: 'A split test was deactivated for the given site.',
  },
  'split_test.modified': {
    netlifyEvent: 'split_test_modified',
    payloadKind: 'split_test',
    description: 'A split test\'s branch configuration or weighting changed.',
  },
  'dev_server.created': {
    netlifyEvent: 'dev_server_created',
    requiresSiteSetting: 'dev_server',
    payloadKind: 'dev_server',
    description: 'A dev server was created for the given site. Requires dev servers enabled on the site.',
  },
  'dev_server.live': {
    netlifyEvent: 'dev_server_live',
    requiresSiteSetting: 'dev_server',
    payloadKind: 'dev_server',
    description: 'A dev server became live for the given site. Requires dev servers enabled on the site.',
  },
  'dev_server.failed': {
    netlifyEvent: 'dev_server_failed',
    requiresSiteSetting: 'dev_server',
    payloadKind: 'dev_server',
    description: 'A dev server failed for the given site. Requires dev servers enabled on the site.',
  },
  'dev_server.stopped': {
    netlifyEvent: 'dev_server_stopped',
    requiresSiteSetting: 'dev_server',
    payloadKind: 'dev_server',
    description: 'A dev server stopped for the given site. Requires dev servers enabled on the site.',
  },
};

/** Reverse index: Netlify's event name -> our name. Used by the relay. */
export const MCP_EVENT_BY_NETLIFY_EVENT: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT_DEFINITIONS).map(([name, def]) => [def.netlifyEvent, name]),
);

export function getEventDefinition(name: string): EventDefinition | undefined {
  return EVENT_DEFINITIONS[name];
}

function inputSchemaFor(def: EventDefinition) {
  return def.payloadKind === 'deploy' ? DEPLOY_INPUT_SCHEMA : SITE_ONLY_INPUT_SCHEMA;
}

function payloadSchemaFor(def: EventDefinition) {
  switch (def.payloadKind) {
    case 'deploy':
      return DEPLOY_PAYLOAD_SCHEMA;
    case 'form_submission':
      return FORM_SUBMISSION_PAYLOAD_SCHEMA;
    case 'split_test':
      return SPLIT_TEST_PAYLOAD_SCHEMA;
    case 'dev_server':
      return DEV_SERVER_PAYLOAD_SCHEMA;
  }
}

/**
 * The `events/list` result. Static: the extension's `events/list` takes no
 * arguments, so it cannot be scoped to a site or a plan. Entitlement and site
 * access are therefore checked in `events/subscribe`, where we know the site.
 */
export function listEvents() {
  return {
    events: Object.entries(EVENT_DEFINITIONS).map(([name, def]) => ({
      name,
      description: def.description,
      delivery: ['webhook'] as const,
      inputSchema: inputSchemaFor(def),
      payloadSchema: payloadSchemaFor(def),
    })),
  };
}
