/**
 * Test fixtures.
 *
 * Every suite runs against a throwaway `CMA_HOME` and a stub Codex, so no test
 * can touch the developer's real accounts, sessions or credentials.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetCodexResolution, resetCodexVersion } from '../src/codex/codex-cli.js';

export interface Sandbox {
  root: string;
  cmaHome: string;
  codexLog: string;
  fakeCodex: string;
  cleanup(): void;
}

const FAKE_CODEX = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME ?? '';
const log = process.env.FAKE_CODEX_LOG;
const authPath = join(home, 'auth.json');

const record = (event) => {
  if (!log) return;
  appendFileSync(log, JSON.stringify(event) + '\\n');
};

const writeAuth = (token) => {
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'id-' + token,
        access_token: 'access-' + token,
        refresh_token: 'refresh-' + token,
        account_id: process.env.FAKE_CODEX_ACCOUNT ?? 'acct-' + token,
      },
      last_refresh: new Date().toISOString(),
    }),
  );
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

record({ args, codexHome: home, cwd: process.cwd(), profile: process.env.CMA_ACTIVE_PROFILE });

if (args[0] === '--version') {
  process.stdout.write('codex-cli 9.9.9\\n');
  process.exit(0);
}

if (args[0] === 'login' && args[1] === 'status') {
  if (existsSync(authPath)) {
    process.stdout.write('Logged in using ChatGPT\\n');
    process.exit(0);
  }
  process.stdout.write('Not logged in\\n');
  process.exit(1);
}

if (args[0] === 'login') {
  if (process.env.FAKE_CODEX_LOGIN_FAILS === '1') process.exit(1);
  writeAuth(process.env.FAKE_CODEX_TOKEN ?? 'initial');
  process.exit(0);
}

if (args[0] === 'logout') {
  rmSync(authPath, { force: true });
  process.exit(0);
}

// Simulate an OAuth refresh mid-session, then confirm whether the mirror
// picked it up before this process exited.
if (process.env.FAKE_CODEX_REFRESH_TO) {
  writeAuth(process.env.FAKE_CODEX_REFRESH_TO);
  const watched = process.env.FAKE_CODEX_WATCH_PROFILE_AUTH;
  if (watched) {
    sleep(Number(process.env.FAKE_CODEX_REFRESH_WAIT_MS ?? '3000'));
    let mirrored = false;
    try {
      mirrored = readFileSync(watched, 'utf8').includes('access-' + process.env.FAKE_CODEX_REFRESH_TO);
    } catch {
      mirrored = false;
    }
    record({ mirroredBeforeExit: mirrored });
  }
}

if (process.env.FAKE_CODEX_SLEEP_MS) sleep(Number(process.env.FAKE_CODEX_SLEEP_MS));

process.exit(Number(process.env.FAKE_CODEX_EXIT ?? '0'));
`;

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'cma-test-'));
  const cmaHome = join(root, 'home');
  const codexLog = join(root, 'codex-calls.jsonl');
  const fakeCodex = join(root, 'fake-codex.mjs');

  mkdirSync(cmaHome, { recursive: true });
  writeFileSync(fakeCodex, FAKE_CODEX, 'utf8');
  writeFileSync(codexLog, '', 'utf8');

  process.env.CMA_HOME = cmaHome;
  process.env.CMA_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_LOG = codexLog;
  // ACL tightening spawns icacls per file; skip it so suites stay fast.
  process.env.CMA_SKIP_ACL = '1';
  delete process.env.FAKE_CODEX_EXIT;
  delete process.env.FAKE_CODEX_REFRESH_TO;
  delete process.env.FAKE_CODEX_WATCH_PROFILE_AUTH;
  delete process.env.FAKE_CODEX_LOGIN_FAILS;
  delete process.env.FAKE_CODEX_SLEEP_MS;
  delete process.env.FAKE_CODEX_TOKEN;
  delete process.env.FAKE_CODEX_ACCOUNT;

  resetCodexResolution();
  resetCodexVersion();

  return {
    root,
    cmaHome,
    codexLog,
    fakeCodex,
    cleanup(): void {
      delete process.env.CMA_HOME;
      delete process.env.CMA_CODEX_BIN;
      delete process.env.FAKE_CODEX_LOG;
      delete process.env.CMA_SKIP_ACL;
      resetCodexResolution();
      resetCodexVersion();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface CodexCall {
  args?: string[];
  codexHome?: string;
  cwd?: string;
  profile?: string;
  mirroredBeforeExit?: boolean;
}

export function codexCalls(sandbox: Sandbox): CodexCall[] {
  const raw = readFileSync(sandbox.codexLog, 'utf8').trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as CodexCall);
}

/** A structurally valid credential, with a distinguishable token. */
export function fakeAuth(token: string, accountId = `acct-${token}`): string {
  return JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: `id-${token}`,
        access_token: `access-${token}`,
        refresh_token: `refresh-${token}`,
        account_id: accountId,
      },
      last_refresh: new Date().toISOString(),
    },
    null,
    2,
  );
}

export function writeFile(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
