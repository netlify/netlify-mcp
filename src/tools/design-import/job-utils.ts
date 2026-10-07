// Pure helpers for the Claude Design import tool. No I/O, node builtins only —
// kept separate so they can be unit-tested without loading the deploy/network stack.

import { createHash } from 'node:crypto';

// A short, deterministic token derived from the Claude Design project id. It is
// embedded in the site's subdomain so a re-send can find the existing site with a
// single server-side name-filtered lookup (GET /sites?name=<marker>) instead of
// listing every site the user can see. Hashed rather than raw so the public URL
// does not expose the project id.
export function projectMarker(projectId: string): string {
  return `cd-${createHash('sha256').update(projectId).digest('hex').slice(0, 10)}`;
}

// Site name for a fresh import: the readable title slug, suffixed with the
// project marker when a stable project id is available.
export function importSiteName(title?: string, projectId?: string): string | undefined {
  const slug = slugify(title);
  if (!projectId) return slug;
  const marker = projectMarker(projectId);
  return slug ? `${slug}-${marker}` : marker;
}

// Fallback name for when the primary name is already taken (subdomains are
// globally unique — e.g. the same design project imported from a different
// Netlify account). It keeps the marker so a re-send can still find this site
// via the name lookup; the suffix restores uniqueness.
export function fallbackImportSiteName(projectId: string, suffix: string): string {
  return `${projectMarker(projectId)}-${suffix}`;
}

export function slugify(title?: string): string | undefined {
  if (!title) return undefined;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || undefined;
}

export type TeamRef = { slug?: string; name?: string };

// Matches a caller-supplied team hint against the user's teams, on slug or name
// (the caller may pass either), case-insensitively. Returns the canonical slug
// when found; otherwise an explanatory note so the deploy can fall back to the
// default team and still tell the caller what happened, instead of failing.
export function matchTeam(teams: TeamRef[], requested: string): { slug?: string; note?: string } {
  const wanted = requested.toLowerCase();
  const match = teams.find((team) => team.slug?.toLowerCase() === wanted || team.name?.toLowerCase() === wanted);
  if (match?.slug) {
    return { slug: match.slug };
  }
  return {
    note: `Team "${requested}" was not found in your Netlify teams, so the design was deployed to your default team. Tell me the exact team name if you want it moved.`,
  };
}

// The job_id is the deploy id: that is all the status poll needs. It is
// interpolated into an API path (GET /api/v1/deploys/<deployId>), so validate it
// as a plain token — a value with slashes or dot segments could traverse to
// another authenticated endpoint.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function deployIdFromJob(jobId: string): string {
  if (!ID_PATTERN.test(jobId)) {
    throw new Error('invalid job_id');
  }
  return jobId;
}
