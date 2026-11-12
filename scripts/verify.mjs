// Run the tests, record the real result in verification.json, then build.
// The "Inside the project" page shows this record, so it cannot claim a pass
// that did not happen.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/machine.test.ts', 'tests/scenarios.test.ts'], { cwd: root, encoding: 'utf8' });
const out = run.stdout + run.stderr;
const num = (name) => Number((out.match(new RegExp(`^# ${name} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
const result = { ranAt: new Date().toISOString().slice(0, 10), node: process.versions.node, tests: num('tests'), pass: num('pass'), fail: num('fail') };
if ([result.tests, result.pass, result.fail].some(Number.isNaN)) {
  console.error(out);
  throw new Error('Could not read the test summary.');
}
writeFileSync(join(root, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`Tests: ${result.pass}/${result.tests} passed, ${result.fail} failed.`);
const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
process.exit(result.fail === 0 && run.status === 0 && build.status === 0 ? 0 : 1);
