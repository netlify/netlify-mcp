/**
 * Canonical Netlify REST API response types.
 *
 * These are re-exported from `@netlify/open-api`, the generated TypeScript view
 * of Netlify's own OpenAPI definition (the same package `@netlify/api` builds
 * its client on). Using it means the shapes we annotate API responses with stay
 * in step with the API itself instead of drifting from hand-written guesses.
 *
 * A few endpoints return fields the published spec does not (yet) document. Where
 * this server actually reads such a field, the canonical schema is intersected
 * with a small, explicitly documented extension below rather than widened with a
 * cast — so the undocumented surface we depend on is visible in one place and can
 * be deleted as the spec catches up.
 */
import type { components } from '@netlify/open-api';

type Schemas = components['schemas'];

/** Deploy — `GET /api/v1/deploys/{deploy_id}`, `GET /api/v1/sites/{site_id}/deploys/{deploy_id}`. */
export type NetlifyDeployResponse = Schemas['deploy'];

/** Environment variable — `GET /api/v1/sites/{site_id}/env`, `GET|POST|PATCH /api/v1/accounts/{account_id}/env`. */
export type NetlifyEnvVarResponse = Schemas['envVar'];

/** Form — `GET /api/v1/sites/{site_id}/forms`. */
export type NetlifyFormResponse = Schemas['form'];

/** Form submission — `GET /api/v1/forms/{form_id}/submissions`, `GET /api/v1/sites/{site_id}/submissions`. */
export type NetlifySubmissionResponse = Schemas['submission'];

/** Current user — `GET /api/v1/user`. */
export type NetlifyUserResponse = Schemas['user'];

/**
 * Site — `GET /api/v1/sites`, `GET|PUT /api/v1/sites/{site_id}`, `POST /api/v1/sites`.
 *
 * Extensions over the published `site` schema, all of which this server reads:
 * - `claimed`, `has_password`, `password_context`, `sso_login`, `sso_login_context`
 *   back the visitor-access-control tooling.
 * - `deploy_ssl_url` is the branch/preview URL counterpart of `deploy_url`.
 * - `processing_settings.ignore_html_forms` is the forms on/off switch; the spec
 *   currently documents only `processing_settings.html`.
 */
export type NetlifySiteResponse = Omit<Schemas['site'], 'processing_settings'> & {
  claimed?: boolean;
  has_password?: boolean;
  password_context?: 'all' | 'non_production';
  sso_login?: boolean;
  sso_login_context?: 'all' | 'non_production';
  deploy_ssl_url?: string;
  processing_settings?: NonNullable<Schemas['site']['processing_settings']> & {
    ignore_html_forms?: boolean;
  };
};

/**
 * Team — `GET /api/v1/accounts`, `GET /api/v1/accounts/{account_id}`. Netlify calls
 * these "accounts" in the API and "teams" in the UI.
 *
 * Extensions over the published `accountMembership` schema: `members_count`,
 * `enforce_mfa`, and `role` (the calling user's role on the team) are all returned
 * by the endpoint and surfaced to the model, but are not in the spec.
 */
export type NetlifyAccountResponse = Schemas['accountMembership'] & {
  members_count?: number;
  enforce_mfa?: boolean;
  role?: string;
};

/**
 * Agent runner — `GET/POST /api/v1/agent_runners…`.
 *
 * Extensions over the published `agentRunner` schema: `site_name` is filled only
 * by the snapshot endpoint, and the state fields back the run summary the model
 * sees.
 */
export type NetlifyAgentRunnerResponse = Schemas['agentRunner'] & {
  site_name?: string | null;
  latest_session_state?: string;
  publishing_state?: string;
  preview_state?: string | null;
};

/** One entry of a session's `interactions` — a question, or an authorization request. */
export type NetlifyAgentRunnerInteraction = {
  type?: string;
  status?: 'pending' | 'answered' | 'skipped';
  payload?: unknown[];
};

/**
 * Agent runner session — `GET /api/v1/agent_runners/{id}/sessions`, `POST …/sessions`.
 *
 * Extensions over the published `agentRunnerSession` schema: the mode, interruption
 * and credit-limit fields, and the interactions the agent is waiting on.
 */
export type NetlifyAgentRunnerSessionResponse = Schemas['agentRunnerSession'] & {
  mode?: string;
  interrupt_reason?: string | null;
  credit_limit_exceeded_message?: string | null;
  interactions?: Record<string, NetlifyAgentRunnerInteraction>;
};

/** `GET /api/v1/agent_runners/{id}/snapshot` — not in the published spec. */
export type NetlifyAgentRunnerSnapshotResponse = {
  state_version?: number;
  activity_state?: 'active' | 'idle' | 'terminal';
  agent_runner?: NetlifyAgentRunnerResponse;
  /** Oldest first. */
  sessions?: NetlifyAgentRunnerSessionResponse[];
  deploys?: { id?: string; state?: string; deploy_ssl_url?: string; context?: string; error_message?: string | null }[];
};
