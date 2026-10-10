// The version this server reports as its MCP `serverInfo.version`.
//
// Resolved from package.json at runtime, which has to work from two different
// layouts:
//
//   dist/netlify-mcp.js  (published CLI bundle) -> package.json is ../
//   src/utils/version.ts (source / serverless)  -> package.json is ../../
//
// The original code only tried `../`, which is correct for the bundle but
// resolves to a nonexistent `src/package.json` everywhere else — so the read
// threw and the '0.0.0' fallback was what every deployed instance actually
// advertised.
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const PACKAGE_NAME = '@netlify/mcp';
// Ordered nearest-first; both layouts are tried on every call site.
const CANDIDATE_PATHS = ['../package.json', '../../package.json'];

let pkgVersion = '';

export const getPackageVersion = () => {
  if (pkgVersion) {
    return pkgVersion;
  }

  let firstVersionSeen = '';

  for (const candidate of CANDIDATE_PATHS) {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const parsed = JSON.parse(readFileSync(resolve(here, candidate), 'utf8'));
      if (typeof parsed?.version !== 'string' || !parsed.version) {
        continue;
      }
      // Prefer our own manifest. A nearest-first walk could otherwise pick up
      // an unrelated package.json if the layout ever changes again.
      if (parsed.name === PACKAGE_NAME) {
        pkgVersion = parsed.version;
        return pkgVersion;
      }
      firstVersionSeen ||= parsed.version;
    } catch {
      // Try the next layout.
    }
  }

  // A version from an unnamed/unexpected manifest still beats reporting 0.0.0.
  pkgVersion = firstVersionSeen || '0.0.0';
  return pkgVersion;
};
