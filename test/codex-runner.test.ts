import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { codexCalls, createSandbox, fakeAuth } from './helpers.js';
import type { Sandbox } from './helpers.js';
import { codexEnv, runCodex } from '../src/codex/codex-runner.js';
import { createAccount, loginAccount, useAccount } from '../src/accounts/account-manager.js';
import { readState } from '../src/accounts/profile-store.js';
import { accountAuthPath, runtimeAuthPath, runtimeHome } from '../src/storage/paths.js';
import { ensureDir, writeFileAtomic } from '../src/storage/atomic.js';
import { registerWriter, unregisterWriter, listActiveWriters } from '../src/storage/locks.js';
import { resetCodexResolution, resolveCodex } from '../src/codex/codex-cli.js';

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.cleanup();
});

function signIn(slug: string, token = slug): void {
  ensureDir(accountAuthPath(slug).replace(/auth\.json$/, ''), { secret: true });
  writeFileAtomic(accountAuthPath(slug), fakeAuth(token), { mode: 0o600 });
}

describe('codex resolution', () => {
  it('runs a JavaScript entry point through Node, with no shell', () => {
    const codex = resolveCodex();
    expect(codex.command).toBe(process.execPath);
    expect(codex.prefixArgs).toEqual([sandbox.fakeCodex]);
  });

  it('reports a clear error when the override does not exist', () => {
    process.env.CMA_CODEX_BIN = `${sandbox.root}/missing.js`;
    // The resolution is memoised, so reset before asserting.
    resetCodexResolution();
    expect(() => resolveCodex()).toThrow(/does not exist/);
  });
});

describe('environment', () => {
  it('points CODEX_HOME at the shared runtime and names the profile', () => {
    const env = codexEnv('work');
    expect(env.CODEX_HOME).toBe(runtimeHome());
    expect(env.CMA_ACTIVE_PROFILE).toBe('work');
  });
});

describe('argument forwarding', () => {
  it('passes every argument to Codex unchanged', async () => {
    createAccount('work');
    signIn('work');
    useAccount('work');

    const args = ['--model', 'test', '--cd', 'project', '-c', 'a.b=1', '--search'];
    const result = await runCodex({ args, profile: 'work' });

    expect(result.exitCode).toBe(0);
    const call = codexCalls(sandbox).find((entry) => entry.args?.includes('--model'));
    expect(call?.args).toEqual(args);
  });

  it('does not interpret shell metacharacters in arguments', async () => {
    createAccount('work');
    signIn('work');
    useAccount('work');

    const args = ['exec', '; echo pwned > owned.txt', '$(whoami)', '&& dir'];
    await runCodex({ args, profile: 'work' });

    const call = codexCalls(sandbox).find((entry) => entry.args?.[0] === 'exec');
    expect(call?.args).toEqual(args);
    expect(existsSync(`${sandbox.root}/owned.txt`)).toBe(false);
  });

  it('runs Codex with the shared runtime as CODEX_HOME', async () => {
    createAccount('work');
    signIn('work');
    useAccount('work');

    await runCodex({ args: ['sessions'], profile: 'work' });
    const call = codexCalls(sandbox).find((entry) => entry.args?.[0] === 'sessions');
    expect(call?.codexHome).toBe(runtimeHome());
    expect(call?.profile).toBe('work');
  });

  it('propagates the Codex exit code', async () => {
    createAccount('work');
    signIn('work');
    useAccount('work');

    process.env.FAKE_CODEX_EXIT = '7';
    const result = await runCodex({ args: [], profile: 'work' });
    expect(result.exitCode).toBe(7);
  });
});

describe('guard rails', () => {
  it('refuses to launch without a credential', async () => {
    createAccount('fresh');
    await expect(runCodex({ args: [], profile: 'fresh' })).rejects.toThrow(/not authenticated/);
  });

  it('allows a login even though the account has no credential yet', async () => {
    createAccount('fresh');
    const result = await runCodex({ args: ['login'], profile: 'fresh', allowMissingAuth: true });
    expect(result.exitCode).toBe(0);
  });

  it('refuses to launch while another account is running', async () => {
    createAccount('a');
    createAccount('b');
    signIn('a');
    signIn('b');

    const other = registerWriter('a', 'codex');
    try {
      await expect(runCodex({ args: [], profile: 'b' })).rejects.toThrow(
        /currently using account "a"/,
      );
    } finally {
      unregisterWriter(other);
    }
  });

  it('refuses to resume a session that is already open elsewhere', async () => {
    createAccount('work');
    signIn('work');
    useAccount('work');

    const id = '01a01803-e02e-7722-8cb4-ec03dbad2d58';
    const other = registerWriter('work', 'codex resume', id);
    try {
      await expect(
        runCodex({ args: ['resume', id], profile: 'work', sessionId: id }),
      ).rejects.toThrow(/already active in another Codex process/);
    } finally {
      unregisterWriter(other);
    }
  });

  it('records the session id so a second attempt can be refused', async () => {
    createAccount('work');
    signIn('work');
    useAccount('work');

    const id = '01a01803-e02e-7722-8cb4-ec03dbad2d58';
    const result = await runCodex({ args: ['resume', id], profile: 'work', sessionId: id });
    expect(result.exitCode).toBe(0);
    // The claim is released on exit.
    expect(listActiveWriters()).toEqual([]);
  });

  it('deregisters the session when Codex exits', async () => {
    createAccount('work');
    signIn('work');
    useAccount('work');

    await runCodex({ args: [], profile: 'work' });
    expect(listActiveWriters()).toEqual([]);
  });
});

describe('credential write-back', () => {
  it('saves a token refresh that happened during the session', async () => {
    createAccount('work');
    signIn('work', 'old');
    useAccount('work');

    process.env.FAKE_CODEX_REFRESH_TO = 'rotated';
    const result = await runCodex({ args: [], profile: 'work' });

    expect(result.finalSync.action).toBe('updated');
    expect(readFileSync(accountAuthPath('work'), 'utf8')).toContain('access-rotated');
    expect(readState().runtimeOwner).toBe('work');
  });

  it('mirrors a refresh while Codex is still running', async () => {
    createAccount('work');
    signIn('work', 'old');
    useAccount('work');

    process.env.FAKE_CODEX_REFRESH_TO = 'live';
    process.env.FAKE_CODEX_WATCH_PROFILE_AUTH = accountAuthPath('work');
    process.env.FAKE_CODEX_REFRESH_WAIT_MS = '3500';

    await runCodex({ args: [], profile: 'work' });

    const observation = codexCalls(sandbox).find(
      (entry) => entry.mirroredBeforeExit !== undefined,
    );
    expect(observation?.mirroredBeforeExit).toBe(true);

    delete process.env.FAKE_CODEX_WATCH_PROFILE_AUTH;
    delete process.env.FAKE_CODEX_REFRESH_WAIT_MS;
  });

  it('mirrors a sign-out performed inside the session', async () => {
    createAccount('work');
    signIn('work');
    useAccount('work');

    const result = await runCodex({ args: ['logout'], profile: 'work' });
    expect(result.finalSync.action).toBe('cleared');
    expect(existsSync(accountAuthPath('work'))).toBe(false);
  });
});

describe('login flow', () => {
  it('stores the credential Codex wrote and leaves other accounts alone', async () => {
    createAccount('personal');
    createAccount('work');
    signIn('personal', 'untouched');

    process.env.FAKE_CODEX_TOKEN = 'brand-new';
    const result = await loginAccount('work');

    expect(result.ok).toBe(true);
    expect(readFileSync(accountAuthPath('work'), 'utf8')).toContain('access-brand-new');
    expect(readFileSync(accountAuthPath('personal'), 'utf8')).toContain('access-untouched');
  });

  it('reports failure without inventing a credential', async () => {
    createAccount('work');
    process.env.FAKE_CODEX_LOGIN_FAILS = '1';

    const result = await loginAccount('work');
    expect(result.ok).toBe(false);
    expect(existsSync(accountAuthPath('work'))).toBe(false);
    expect(existsSync(runtimeAuthPath())).toBe(false);
  });
});
