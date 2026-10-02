import { createHash } from 'node:crypto';
import { unauthenticatedFetch } from '../utils/api-networking.ts';
import { log } from '../../netlify/functions/mcp-server/logger.js';

export const SKILLS_HOST = 'https://www.netlify.com/context-files';

export interface SkillManifest {
  schema_version: number;
  version: string;
  skills: SkillEntry[];
}

export interface SkillEntry {
  name: string;
  status: 'active' | 'deprecated';
  prior_names: string[];
  description: string;
  files: Record<string, string>;
}

// The topic names MCP offered before skills existed. Clients may have cached
// them, so each still resolves to the skill that replaced it.
export const LEGACY_TOPICS: Record<string, string> = {
  serverless: 'netlify-functions',
  'edge-functions': 'netlify-edge-functions',
  blobs: 'netlify-blobs',
  'image-cdn': 'netlify-image-cdn',
  forms: 'netlify-forms',
  db: 'netlify-database',
};

export type CodingContextResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SKILL_FILE = 'SKILL.md';
const REFERENCES_PREFIX = 'references/';

let cachedManifest: { data: SkillManifest; timestamp: number } | undefined;
const fileCache = new Map<string, string>();

/** Test-only: clears the manifest and file caches. */
export function resetCodingContextCachesForTests() {
  cachedManifest = undefined;
  fileCache.clear();
}

export async function getSkillManifest(): Promise<SkillManifest | undefined> {
  if (cachedManifest && Date.now() - cachedManifest.timestamp < TEN_MINUTES_MS) {
    return cachedManifest.data;
  }

  try {
    const response = await unauthenticatedFetch(`${SKILLS_HOST}/manifest.json`);
    if (!response.ok) {
      log.error('Skills manifest request failed', { status: response.status });
      return undefined;
    }
    const data = (await response.json()) as SkillManifest;
    if (data?.schema_version !== 1 || !Array.isArray(data.skills)) {
      log.error('Skills manifest has an unsupported shape', { schemaVersion: data?.schema_version });
      return undefined;
    }
    cachedManifest = { data, timestamp: Date.now() };
    return data;
  } catch (error) {
    log.error('Error fetching skills manifest', { err: error });
    return undefined;
  }
}

function activeSkills(manifest: SkillManifest): Map<string, SkillEntry> {
  return new Map(manifest.skills.filter((s) => s.status === 'active').map((s) => [s.name, s]));
}

export async function getCodingContextTopics(): Promise<string[]> {
  const manifest = await getSkillManifest();
  if (!manifest) return [];

  const active = activeSkills(manifest);
  const legacy = Object.keys(LEGACY_TOPICS).filter((name) => active.has(LEGACY_TOPICS[name]));
  return [...active.keys(), ...legacy];
}

// Files come from the versioned path, which is immutable per release, so the
// cache needs no TTL and a cached manifest can never pair with another
// release's bytes. The hash is checked before anything enters the cache.
async function fetchSkillFile(
  version: string,
  skillName: string,
  path: string,
  expectedHash: string,
): Promise<string> {
  const cacheKey = `${version}/${skillName}/${path}`;
  const cached = fileCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const response = await unauthenticatedFetch(`${SKILLS_HOST}/v/${version}/skills/${skillName}/${path}`);
  if (!response.ok) {
    throw new Error(`Request for ${skillName}/${path} failed with status ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actualHash !== expectedHash) {
    throw new Error(`Hash mismatch for ${skillName}/${path}`);
  }

  const text = bytes.toString('utf8');
  fileCache.set(cacheKey, text);
  return text;
}

export async function getNetlifyCodingContext(
  topic: string,
  reference?: string,
): Promise<CodingContextResult> {
  const manifest = await getSkillManifest();
  if (!manifest) {
    return { ok: false, error: 'Netlify coding context is temporarily unavailable. Try again later.' };
  }

  const active = activeSkills(manifest);
  const skill = active.get(topic) ?? active.get(LEGACY_TOPICS[topic] ?? '');
  if (!skill) {
    return { ok: false, error: `Unknown topic "${topic}". Available: ${[...active.keys()].join(', ')}` };
  }

  const referencePaths = Object.keys(skill.files).filter((path) => path !== SKILL_FILE);

  try {
    if (reference !== undefined) {
      // Matched only against manifest keys, never used to build a URL directly,
      // so it cannot reach outside the skill.
      const path = referencePaths.find((p) => p === reference || p === `${REFERENCES_PREFIX}${reference}`);
      if (!path) {
        const available = referencePaths.length ? referencePaths.join(', ') : 'none';
        return {
          ok: false,
          error: `Unknown reference "${reference}" for ${skill.name}. Available: ${available}`,
        };
      }
      return { ok: true, text: await fetchSkillFile(manifest.version, skill.name, path, skill.files[path]) };
    }

    const skillHash = skill.files[SKILL_FILE];
    if (!skillHash) {
      return { ok: false, error: `Skill ${skill.name} has no ${SKILL_FILE}.` };
    }
    const body = await fetchSkillFile(manifest.version, skill.name, SKILL_FILE, skillHash);
    if (referencePaths.length === 0) return { ok: true, text: body };

    const note = [
      '---',
      'This skill has reference files with more detail. To read one, call this tool again with the same creationType and set `reference` to its path:',
      ...referencePaths.map((p) => `- ${p}`),
    ].join('\n');
    return { ok: true, text: `${body}\n\n${note}` };
  } catch (error) {
    log.error('Error fetching skill file', { err: error });
    return {
      ok: false,
      error: `Unable to load context for ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
