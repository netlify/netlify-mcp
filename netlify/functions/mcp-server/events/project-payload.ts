// Project a Netlify hook payload down to the shape we advertise in
// `events/list`'s `payloadSchema`.
//
// This is a correctness requirement, not tidying. Netlify posts the full
// DeploySerializer (~70 attributes), which includes `file_configuration` — the
// parsed contents of the site's netlify.toml — and `required` /
// `required_functions` / `required_edge_functions`, arrays of file digests that
// on a large site run to thousands of entries. Forwarding that both leaks build
// configuration to a third party and can exceed the extension's 256 KiB
// per-event limit.

import type { EventDefinition } from './registry.ts';
import type { EventFilters } from './subscription.ts';

/** Max bytes of JSON we will hand to a client, per the extension's limit. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function projectDeploy(raw: Record<string, any>) {
  return {
    site_id: str(raw.site_id) ?? '',
    site_name: str(raw.name),
    deploy_id: str(raw.id) ?? '',
    state: str(raw.state) ?? 'unknown',
    error_message: str(raw.error_message),
    branch: str(raw.branch),
    context: str(raw.context),
    commit_ref: str(raw.commit_ref),
    commit_url: str(raw.commit_url),
    committer: str(raw.committer),
    deploy_time: num(raw.deploy_time),
    admin_url: str(raw.admin_url),
    deploy_url: str(raw.deploy_ssl_url) ?? str(raw.deploy_url),
    created_at: str(raw.created_at),
  };
}

function projectFormSubmission(raw: Record<string, any>) {
  return {
    site_id: str(raw.site_id) ?? '',
    submission_id: str(raw.id) ?? '',
    form_id: str(raw.form_id),
    form_name: str(raw.form_name),
    created_at: str(raw.created_at),
    // Caller-authored content of unknown shape. Passed through rather than
    // projected — the submission body is the reason to subscribe.
    data: (raw.data && typeof raw.data === 'object') ? raw.data : {},
  };
}

export function projectPayload(def: EventDefinition, raw: Record<string, any>): Record<string, unknown> {
  switch (def.payloadKind) {
    case 'deploy':
      return projectDeploy(raw);
    case 'form_submission':
      return projectFormSubmission(raw);
  }
}

/**
 * Apply the filters Netlify cannot: a site hook fires for every deploy of that
 * site, so `branch` and `context` narrowing happens here. Without it, a user who
 * asked about production failures also hears about every deploy preview.
 */
export function matchesFilters(
  def: EventDefinition,
  projected: Record<string, unknown>,
  filters: EventFilters,
): boolean {
  if (def.payloadKind !== 'deploy') return true;
  if (filters.branch && projected.branch !== filters.branch) return false;
  if (filters.context && projected.context !== filters.context) return false;
  return true;
}

/**
 * Serialize a delivery, refusing to send one that exceeds the extension's size
 * limit. Only reachable via a form submission's pass-through `data`; every other
 * projected payload is bounded by construction.
 */
export function serializeDelivery(envelope: Record<string, unknown>): { body: string; oversize: boolean } {
  const body = JSON.stringify(envelope);
  return { body, oversize: Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES };
}
