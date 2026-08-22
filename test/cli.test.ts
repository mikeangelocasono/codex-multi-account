import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { codexCalls, createSandbox } from './helpers.js';
import type { Sandbox } from './helpers.js';
import { run } from '../src/cli/main.js';
import { accountAuthPath, runtimeAuthPath, runtimeHome } from '../src/storage/paths.js';
import { activeProfileSlug, readState } from '../src/accounts/profile-store.js';
import { openDatabase, sqliteAvailable } from '../src/codex/sqlite.js';
import { registerWriter, unregisterWriter } from '../src/storage/locks.js';
import { sessionIdFromArgs } from '../src/cli/commands/codex-commands.js';

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.cleanup();
});

/** Run a command while capturing what it printed. */
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = await run(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe('cli basics', () => {
  it('prints help and exits cleanly', async () => {
    const result = await cli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Codex Multi-Account');
    expect(result.stdout).toContain('resume');
    expect(result.stdout).toContain('CMA_CODEX_BIN');
  });

  it('prints a version', async () => {
    const result = await cli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects an unknown command with exit code 2', async () => {
    const result = await cli(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command');
  });

  it('reports that nothing is selected yet', async () => {
    const result = await cli(['current']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No account is selected');
  });
});

describe('account lifecycle through the CLI', () => {
  it('adds, lists, switches and reports the active account', async () => {
    expect((await cli(['add', 'personal'])).code).toBe(0);
    expect((await cli(['add', 'work'])).code).toBe(0);

    const list = await cli(['list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('personal');
    expect(list.stdout).toContain('work');

    expect((await cli(['use', 'work'])).code).toBe(0);
    const current = await cli(['current']);
    expect(current.stdout.trim()).toBe('work');
    expect(activeProfileSlug()).toBe('work');
  });

  it('emits machine-readable output without credentials', async () => {
    await cli(['add', 'work']);
    const result = await cli(['list', '--json']);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { accounts: Array<{ slug: string }> };
    expect(parsed.accounts.map((account) => account.slug)).toEqual(['work']);
    expect(result.stdout).not.toContain('access-');
    expect(result.stdout).not.toContain('refresh-');
  });

  it('shows account details without leaking token material', async () => {
    await cli(['add', 'work']);
    const info = await cli(['info', 'work', '--json']);
    expect(info.code).toBe(0);
    expect(info.stdout).not.toContain('access-');
    expect(JSON.parse(info.stdout)).toMatchObject({ slug: 'work', authenticated: true });
  });

  it('renames an account label without changing its slug', async () => {
    await cli(['add', 'work']);
    expect((await cli(['rename', 'work', 'Work', '(Acme)'])).code).toBe(0);
    const info = await cli(['info', 'work', '--json']);
    expect(JSON.parse(info.stdout)).toMatchObject({ slug: 'work', name: 'Work (Acme)' });
  });

  it('checks credential health', async () => {
    await cli(['add', 'work']);
    const healthy = await cli(['check', '--json']);
    expect(healthy.code).toBe(0);
    expect(JSON.parse(healthy.stdout)).toMatchObject({
      accounts: [{ slug: 'work', valid: true }],
    });

    writeFileSync(accountAuthPath('work'), '{"tokens":{}}', 'utf8');
    const broken = await cli(['check', '--json']);
    expect(broken.code).toBe(1);
  });

  it('removes an account', async () => {
    await cli(['add', 'work']);
    await cli(['add', 'personal']);
    expect((await cli(['remove', 'work', '--force', '--yes'])).code).toBe(0);

    const list = await cli(['list', '--json']);
    const parsed = JSON.parse(list.stdout) as { accounts: Array<{ slug: string }> };
    expect(parsed.accounts.map((a) => a.slug)).toEqual(['personal']);
  });

  it('refuses a hostile profile name', async () => {
    const result = await cli(['add', '..']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not valid/);
  });
});

describe('running codex through the CLI', () => {
  it('forwards arguments verbatim', async () => {
    await cli(['add', 'work']);
    const result = await cli(['codex', '--model', 'gpt-5.6-sol', '--cd', './project']);

    expect(result.code).toBe(0);
    const call = codexCalls(sandbox).find((entry) => entry.args?.includes('--model'));
    expect(call?.args).toEqual(['--model', 'gpt-5.6-sol', '--cd', './project']);
    expect(call?.codexHome).toBe(runtimeHome());
  });

  it('validates a session id before handing it to Codex', async () => {
    await cli(['add', 'work']);
    const result = await cli(['resume', '../escape']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not a valid session id/);
  });

  it('forwards a resume request', async () => {
    await cli(['add', 'work']);
    const id = '019fdafe-2982-77b0-87aa-7b375a526b79';
    expect((await cli(['resume', id])).code).toBe(0);

    const call = codexCalls(sandbox).find((entry) => entry.args?.[0] === 'resume');
    expect(call?.args).toEqual(['resume', id]);
  });

  it('maps forwarded arguments to the session they will open', () => {
    const id = '01a01803-e02e-7722-8cb4-ec03dbad2d58';
    expect(sessionIdFromArgs(['resume', id])).toBe(id);
    expect(sessionIdFromArgs(['exec', 'resume', id])).toBe(id);
    expect(sessionIdFromArgs(['--model', 'x'])).toBeNull();
    expect(sessionIdFromArgs(['resume'])).toBeNull();
    // A uuid that is not the argument to `resume` is not a session being opened.
    expect(sessionIdFromArgs(['--cd', id])).toBeNull();
    expect(sessionIdFromArgs(['resume', 'not-a-uuid'])).toBeNull();
  });

  it('refuses a second `cma resume` on a session already open', async () => {
    await cli(['add', 'work']);
    const id = '019fdafe-2982-77b0-87aa-7b375a526b79';
    const holder = registerWriter('work', 'codex resume', id);
    try {
      const result = await cli(['resume', id]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('is already active in another Codex process');
    } finally {
      unregisterWriter(holder);
    }
  });

  it('reports the doctor view', async () => {
    await cli(['add', 'work']);
    const result = await cli(['doctor', '--json']);
    const parsed = JSON.parse(result.stdout) as { runtimeHome: string; active: string };
    expect(parsed.runtimeHome).toBe(runtimeHome());
    expect(parsed.active).toBe('work');
  });
});

describe.runIf(sqliteAvailable())('cross-account session resume', () => {
  const SESSION = '01a01803-e02e-7722-8cb4-ec03dbad2d58';

  function seedSession(): void {
    const home = runtimeHome();
    const dir = join(home, 'sessions', '2026', '08', '21');
    mkdirSync(dir, { recursive: true });
    const rollout = join(dir, `rollout-2026-08-21T10-00-00-${SESSION}.jsonl`);
    writeFileSync(
      rollout,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { session_id: SESSION, id: SESSION, cwd: process.cwd(), source: 'cli' },
      })}\n`,
      'utf8',
    );

    const db = openDatabase(join(home, 'state_5.sqlite'), { readOnly: false })!;
    db.run(`CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0, model TEXT)`);
    db.run(
      `INSERT OR REPLACE INTO threads VALUES (?, ?, 1787300000, 1787300100, 'cli', 'openai',
        ?, 'Cross-account test', 'workspace-write', 'on-request', '', 0, 'gpt-5.6-sol')`,
      SESSION,
      rollout,
      process.cwd(),
    );
    db.close();
  }

  it('resumes a session created under account A while authenticated as account B', async () => {
    // Account A signs in and starts a session.
    process.env.FAKE_CODEX_TOKEN = 'account-a';
    process.env.FAKE_CODEX_ACCOUNT = 'acct-AAAA11';
    await cli(['add', 'account-a']);
    await cli(['codex']);
    seedSession();

    // The session is visible in the shared runtime.
    const sessions = JSON.parse((await cli(['sessions', '--json'])).stdout) as Array<{ id: string }>;
    expect(sessions.map((session) => session.id)).toContain(SESSION);

    // Account B signs in.
    process.env.FAKE_CODEX_TOKEN = 'account-b';
    process.env.FAKE_CODEX_ACCOUNT = 'acct-BBBB22';
    await cli(['add', 'account-b']);
    expect((await cli(['use', 'account-b'])).code).toBe(0);
    expect((await cli(['current'])).stdout.trim()).toBe('account-b');

    // The same session id resumes under the new account.
    const resume = await cli(['resume', SESSION]);
    expect(resume.code).toBe(0);

    const call = codexCalls(sandbox)
      .filter((entry) => entry.args?.[0] === 'resume')
      .pop();
    expect(call?.args).toEqual(['resume', SESSION]);
    expect(call?.profile).toBe('account-b');
    expect(call?.codexHome).toBe(runtimeHome());

    // The credential in play is B's, and A's is untouched.
    expect(readFileSync(runtimeAuthPath(), 'utf8')).toContain('access-account-b');
    expect(readFileSync(accountAuthPath('account-a'), 'utf8')).toContain('access-account-a');
    expect(readState().runtimeOwner).toBe('account-b');

    delete process.env.FAKE_CODEX_TOKEN;
    delete process.env.FAKE_CODEX_ACCOUNT;
  });

  it('switches and resumes the newest session in one command', async () => {
    process.env.FAKE_CODEX_TOKEN = 'account-a';
    await cli(['add', 'account-a']);
    seedSession();
    process.env.FAKE_CODEX_TOKEN = 'account-b';
    await cli(['add', 'account-b']);

    const result = await cli(['sr', 'account-b']);
    expect(result.code).toBe(0);

    const call = codexCalls(sandbox)
      .filter((entry) => entry.args?.[0] === 'resume')
      .pop();
    expect(call?.args).toEqual(['resume', SESSION]);
    expect(call?.profile).toBe('account-b');

    delete process.env.FAKE_CODEX_TOKEN;
  });
});
