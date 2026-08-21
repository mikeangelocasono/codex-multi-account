#!/usr/bin/env node
/**
 * CLI smoke test.
 *
 * Runs the built `bin/cma.js` as a real child process against a throwaway
 * CMA_HOME. This catches things unit tests cannot: a broken build output, a
 * bad bin shim, an ESM import that only fails outside the test runner.
 *
 * It never signs in and never contacts the network.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = join(root, 'bin', 'cma.js');

if (!existsSync(join(root, 'dist', 'cli', 'main.js'))) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'cma-smoke-'));
const env = { ...process.env, CMA_HOME: home, NO_COLOR: '1', CMA_SKIP_ACL: '1' };

let failures = 0;
const results = [];

function cma(args, { expect = 0 } = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const code = result.status;
  const ok = code === expect;
  if (!ok) failures += 1;
  results.push({
    command: `cma ${args.join(' ')}`,
    expected: expect,
    actual: code,
    ok,
  });
  if (!ok) {
    console.error(`FAIL cma ${args.join(' ')} -> exit ${code}, expected ${expect}`);
    if (result.stderr) console.error(result.stderr.trim().split('\n').slice(0, 6).join('\n'));
  }
  return { ...result, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function check(label, condition) {
  results.push({ command: label, expected: 'true', actual: String(condition), ok: condition });
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${label}`);
  }
}

try {
  const version = cma(['--version']);
  check('version looks like semver', /^\d+\.\d+\.\d+\s*$/.test(version.stdout));

  const help = cma(['--help']);
  check('help lists the resume command', help.stdout.includes('resume'));
  check('help lists the import command', help.stdout.includes('import'));

  cma(['frobnicate'], { expect: 2 });
  cma(['current'], { expect: 1 });
  cma(['list']);

  const doctor = cma(['doctor', '--json'], { expect: 1 });
  const doctorJson = JSON.parse(doctor.stdout);
  check('doctor reports the runtime home', doctorJson.runtimeHome.startsWith(home));
  check('doctor found a Codex CLI', doctorJson.codexPath !== 'not found');
  check('doctor reports a Codex version', typeof doctorJson.version === 'string');

  cma(['add', 'smoke-test', '--no-login']);
  const list = JSON.parse(cma(['list', '--json']).stdout);
  check('the account was created', list.accounts.some((a) => a.slug === 'smoke-test'));
  check('no credential material in list output', !JSON.stringify(list).includes('access_token'));

  cma(['use', 'smoke-test']);
  const current = cma(['current']);
  check('current reports the account', current.stdout.trim() === 'smoke-test');

  const sessions = cma(['sessions', '--json']);
  check('sessions returns JSON', Array.isArray(JSON.parse(sessions.stdout)));

  // An account with no credential is unhealthy, so a non-zero exit is correct.
  cma(['check', '--json'], { expect: 1 });

  cma(['add', '..'], { expect: 1 });
  cma(['resume', '../escape'], { expect: 1 });

  cma(['remove', 'smoke-test', '--yes']);
  const after = JSON.parse(cma(['list', '--json']).stdout);
  check('the account was removed', after.accounts.length === 0);
} finally {
  rmSync(home, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nsmoke: ${passed}/${results.length} checks passed`);
if (failures > 0) {
  console.error(`${failures} smoke check(s) failed.`);
  process.exit(1);
}
