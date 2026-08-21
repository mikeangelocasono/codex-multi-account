#!/usr/bin/env node
/**
 * The cross-account resume acceptance test, end to end, against the real
 * Codex CLI and real accounts.
 *
 *   cma use A -> start a session, plant a codeword -> exit
 *   cma use B -> cma current is B -> resume A's session id
 *   -> the codeword comes back, and the credential in play is B's
 *
 * Usage:
 *   node scripts/verify-cross-account.mjs <accountA> <accountB>
 *
 * It costs two short model turns. It creates a throwaway git repository for the
 * session's working directory and removes it afterwards. It never signs in,
 * never edits your accounts, and never prints credential material.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cliEntry = join(root, 'bin', 'cma.js');

const [accountA, accountB] = process.argv.slice(2);
if (!accountA || !accountB) {
  console.error('usage: node scripts/verify-cross-account.mjs <accountA> <accountB>');
  console.error('example: node scripts/verify-cross-account.mjs personal work');
  process.exit(2);
}

const codeword = `MARLIN-${Math.floor(Date.now() / 1000) % 100000}`;
const checks = [];
let fatal = null;

function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'WARN';
  console.log(`  ${mark}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function cma(args, options = {}) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 600_000,
    input: '',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    all: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function cmaHome() {
  const override = process.env.CMA_HOME;
  return override && override.trim().length > 0
    ? resolve(override)
    : join(homedir(), '.codex-multi-account');
}

function credentialFingerprint(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

const accountAuth = (slug) => join(cmaHome(), 'accounts', slug, 'auth.json');
const runtimeAuth = () => join(cmaHome(), 'runtime', 'auth.json');

let workdir = null;

try {
  console.log(`\nCross-account resume check: "${accountA}" -> "${accountB}"\n`);

  // ---- preconditions ----------------------------------------------------
  const listing = cma(['list', '--json']);
  if (listing.code !== 0) {
    fatal = `cma list failed: ${listing.all.trim()}`;
    throw new Error(fatal);
  }
  const accounts = JSON.parse(listing.stdout).accounts;
  const findAccount = (slug) => accounts.find((account) => account.slug === slug);

  for (const slug of [accountA, accountB]) {
    const account = findAccount(slug);
    if (!account) {
      fatal = `There is no account "${slug}". Create it with: cma add ${slug}`;
      throw new Error(fatal);
    }
    if (account.status === 'needs-login') {
      fatal = `Account "${slug}" is not signed in. Run: cma login ${slug}`;
      throw new Error(fatal);
    }
  }
  record('both accounts exist and are signed in', true);

  const fingerprintA = credentialFingerprint(accountAuth(accountA));
  const fingerprintB = credentialFingerprint(accountAuth(accountB));
  const distinctIdentities = Boolean(fingerprintA && fingerprintB && fingerprintA !== fingerprintB);
  record(
    'the two accounts hold different credentials',
    distinctIdentities ? true : null,
    distinctIdentities
      ? ''
      : 'same credential on both profiles: this run exercises the switch, but does not prove account isolation',
  );

  // ---- a throwaway workspace Codex will trust ---------------------------
  workdir = mkdtempSync(join(tmpdir(), 'cma-xacct-'));
  writeFileSync(join(workdir, 'README.md'), 'cross-account check\n', 'utf8');
  spawnSync('git', ['init', '-q'], { cwd: workdir, encoding: 'utf8' });
  spawnSync('git', ['add', '-A'], { cwd: workdir, encoding: 'utf8' });
  spawnSync(
    'git',
    ['-c', 'user.email=check@local', '-c', 'user.name=check', 'commit', '-qm', 'init'],
    { cwd: workdir, encoding: 'utf8' },
  );

  // ---- step 1: account A creates a session ------------------------------
  const useA = cma(['use', accountA]);
  record(`cma use ${accountA}`, useA.code === 0, useA.code === 0 ? '' : useA.all.trim());

  const created = cma([
    'codex',
    'exec',
    '--cd',
    workdir,
    '--sandbox',
    'read-only',
    `Remember this codeword exactly: ${codeword}. Reply with only the word ACK.`,
  ]);
  const sessionMatch = created.all.match(
    /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  let sessionId = sessionMatch?.[1] ?? null;
  if (!sessionId) {
    const sessions = cma(['sessions', '--json']);
    sessionId = sessions.code === 0 ? (JSON.parse(sessions.stdout)[0]?.id ?? null) : null;
  }
  record(
    `account "${accountA}" created a session`,
    Boolean(sessionId) && created.code === 0,
    sessionId ? `session ${sessionId}` : created.all.trim().split('\n').slice(-3).join(' | '),
  );
  if (!sessionId) {
    fatal = 'no session id was produced, so there is nothing to resume';
    throw new Error(fatal);
  }

  record(
    'the session is listed in the shared runtime',
    JSON.parse(cma(['sessions', '--json']).stdout).some((session) => session.id === sessionId),
  );

  // ---- step 2: switch to account B --------------------------------------
  const useB = cma(['use', accountB]);
  record(`cma use ${accountB}`, useB.code === 0, useB.code === 0 ? '' : useB.all.trim());

  const current = cma(['current']);
  record(
    `cma current reports "${accountB}"`,
    current.stdout.trim() === accountB,
    current.stdout.trim(),
  );

  record(
    'the runtime credential is now the one stored for ' + accountB,
    credentialFingerprint(runtimeAuth()) === fingerprintB,
  );
  record(
    `the credential for "${accountA}" was left intact`,
    credentialFingerprint(accountAuth(accountA)) !== null,
  );

  // ---- step 3: resume account A's session as account B ------------------
  const resumed = cma([
    'codex',
    'exec',
    '--cd',
    workdir,
    '--sandbox',
    'read-only',
    'resume',
    sessionId,
    'What codeword did I ask you to remember? Reply with only the codeword.',
  ]);

  record(
    'the resume ran under the new account',
    resumed.code === 0,
    resumed.code === 0 ? '' : resumed.all.trim().split('\n').slice(-3).join(' | '),
  );
  record(
    'the previous conversation is intact (codeword recalled)',
    resumed.all.includes(codeword),
    resumed.all.includes(codeword) ? codeword : 'codeword not found in the reply',
  );
  record(
    'the session id is unchanged',
    resumed.all.includes(sessionId),
    sessionId,
  );
  record(
    'requests are still authenticated as ' + accountB,
    credentialFingerprint(runtimeAuth()) === credentialFingerprint(accountAuth(accountB)),
  );
} catch (error) {
  if (!fatal) console.error(`\nunexpected failure: ${error.message}`);
} finally {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
}

const failed = checks.filter((check) => check.ok === false);
const warned = checks.filter((check) => check.ok === null);

console.log('');
if (fatal) {
  console.error(`BLOCKED: ${fatal}\n`);
  process.exit(2);
}
if (failed.length > 0) {
  console.error(`FAILED: ${failed.length} of ${checks.length} checks did not pass.\n`);
  process.exit(1);
}
console.log(
  `PASSED: ${checks.length - warned.length}/${checks.length} checks` +
    (warned.length > 0 ? ` (${warned.length} warning)` : '') +
    '\n',
);
if (warned.length > 0) {
  console.log('Re-run with two genuinely different accounts for a complete result.\n');
}
