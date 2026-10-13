// Live check: the coding-context tool returns exactly the bytes the hosted
// skills manifest promises. Run with `npm run verify:coding-context`.
import { createHash } from 'node:crypto';
import {
  LEGACY_TOPICS,
  getCodingContextTopics,
  getNetlifyCodingContext,
  getSkillManifest,
} from '../src/context/coding-context.ts';

const NOTE_SEPARATOR = '\n\n---\nThis skill has reference files';
const failures = [];

const sha256 = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const fail = (message) => failures.push(message);

function check(label, text, expectedHash) {
  if (sha256(text) !== expectedHash) fail(`${label}: hash does not match the manifest`);
}

const manifest = await getSkillManifest();
if (!manifest) {
  console.error('FAIL: skills manifest unavailable');
  process.exit(1);
}
console.log(`Release version: ${manifest.version}`);

const skills = new Map(manifest.skills.map((s) => [s.name, s]));
const topics = await getCodingContextTopics();
if (topics.length === 0) fail('no topics returned');

for (const skill of manifest.skills.filter((s) => s.status === 'active')) {
  if (!topics.includes(skill.name)) fail(`${skill.name}: active manifest skill is not exposed as a topic`);
}

let filesVerified = 0;

for (const topic of topics) {
  const skill = skills.get(topic) ?? skills.get(LEGACY_TOPICS[topic]);
  const result = await getNetlifyCodingContext(topic);
  if (!result.ok) {
    fail(`${topic}: ${result.error}`);
    continue;
  }
  const hasReferences = Object.keys(skill.files).some((p) => p !== 'SKILL.md');
  const body = hasReferences ? result.text.split(NOTE_SEPARATOR)[0] : result.text;
  if (hasReferences && body === result.text) fail(`${topic}: reference note not found`);
  check(`${topic} SKILL.md`, body, skill.files['SKILL.md']);
  filesVerified++;
}

for (const skill of manifest.skills.filter((s) => s.status === 'active')) {
  for (const path of Object.keys(skill.files).filter((p) => p !== 'SKILL.md')) {
    const result = await getNetlifyCodingContext(skill.name, path);
    if (!result.ok) {
      fail(`${skill.name}/${path}: ${result.error}`);
      continue;
    }
    check(`${skill.name}/${path}`, result.text, skill.files[path]);
    filesVerified++;
  }
}

if (failures.length > 0) {
  console.error(`FAIL (${failures.length}):`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log(`Topics checked: ${topics.length}`);
console.log(`Files verified: ${filesVerified}`);
console.log('OK');
