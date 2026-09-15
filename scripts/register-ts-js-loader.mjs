// Source files use `.js`-suffixed relative imports pointing at `.ts` siblings
// (required for NodeNext module resolution in the tsup/tsc build). Node's
// native TS type-stripping loads .ts files directly but does not remap those
// `.js` specifiers to their `.ts` sibling, so importing such a file straight
// from `node --test` fails with ERR_MODULE_NOT_FOUND.
//
// This hook retries resolution with `.ts` whenever a relative `.js` specifier
// can't be found. Test-only — never referenced by the built output.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-js-resolve-hooks.mjs', import.meta.url);
