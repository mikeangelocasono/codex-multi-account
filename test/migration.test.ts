import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSandbox, fakeAuth } from './helpers.js';
import type { Sandbox } from './helpers.js';
import { planImport, previousImports, runImport } from '../src/storage/migration.js';
import { openDatabase, sqliteAvailable } from '../src/codex/sqlite.js';
import { listSessions } from '../src/codex/session-manager.js';
import { runtimeHome } from '../src/storage/paths.js';
import { ensureHomeLayout } from '../src/accounts/profile-store.js';
import { run } from '../src/cli/main.js';
import { accountAuthPath } from '../src/storage/paths.js';
import { activeProfileSlug, listProfiles } from '../src/accounts/profile-store.js';

let sandbox: Sandbox;
let source: string;

const SESSION_ID = '019fdafe-2982-77b0-87aa-7b375a526b79';

beforeEach(() => {
  sandbox = createSandbox();
  ensureHomeLayout();
  source = join(sandbox.root, 'dot-codex');
  buildSourceHome(source);
});

afterEach(() => {
  sandbox.cleanup();
});

function buildSourceHome(home: string): void {
  mkdirSync(join(home, 'sessions', '2026', '08', '07'), { recursive: true });
  mkdirSync(join(home, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(home, 'cache'), { recursive: true });
  mkdirSync(join(home, '.tmp'), { recursive: true });

  const rollout = join(
    home,
    'sessions',
    '2026',
    '08',
    '07',
    `rollout-2026-08-07T14-51-57-${SESSION_ID}.jsonl`,
  );
  writeFileSync(
    rollout,
    `${JSON.stringify({
      timestamp: '2026-08-07T06:51:58.702Z',
      type: 'session_meta',
      payload: { session_id: SESSION_ID, id: SESSION_ID, cwd: 'C:\\Projects\\Alpha', source: 'cli' },
    })}\n`,
    'utf8',
  );

  writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.6-sol"\n', 'utf8');
  writeFileSync(join(home, 'history.jsonl'), '{"text":"hello"}\n', 'utf8');
  writeFileSync(join(home, 'AGENTS.md'), '# House rules\n', 'utf8');
  writeFileSync(join(home, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8');
  writeFileSync(join(home, 'auth.json'), fakeAuth('imported'), 'utf8');
  writeFileSync(join(home, 'installation_id'), 'abc-123', 'utf8');
  // Transient state that must not be copied.
  writeFileSync(join(home, 'cache', 'junk.bin'), 'junk', 'utf8');
  writeFileSync(join(home, 'logs_2.sqlite'), 'huge', 'utf8');
  writeFileSync(join(home, '.tmp', 'scratch'), 'scratch', 'utf8');

  if (sqliteAvailable()) {
    const db = openDatabase(join(home, 'state_5.sqlite'), { readOnly: false })!;
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0, model TEXT)`);
    db.run(
      `INSERT INTO threads VALUES (?, ?, 1787000000, 1787000100, 'cli', 'openai',
        'C:\\Projects\\Alpha', 'Imported session', 'workspace-write', 'on-request', '', 0, 'gpt-5.6-sol')`,
      SESSION_ID,
      rollout,
    );
    db.close();
  }
}

describe('import planning', () => {
  it('includes shared state and excludes credentials and caches', () => {
    const plan = planImport({ source });
    const names = plan.entries.map((entry) => entry.name);

    expect(names).toContain('sessions');
    expect(names).toContain('config.toml');
    expect(names).toContain('history.jsonl');
    expect(names).toContain('skills');
    expect(names).toContain('AGENTS.md');
    expect(names).not.toContain('auth.json');
    expect(names).not.toContain('cache');
    expect(names).not.toContain('logs_2.sqlite');
    expect(plan.hasAuth).toBe(true);
  });

  it('can leave transcripts and their indexes behind', () => {
    const names = planImport({ source, includeSessions: false }).entries.map((e) => e.name);
    expect(names).not.toContain('sessions');
    // Importing the index without the transcripts would list unresumable sessions.
    expect(names).not.toContain('state_5.sqlite');
    expect(names).toContain('config.toml');
    expect(names).toContain('skills');
  });

  it('refuses to import the runtime into itself', () => {
    expect(() => planImport({ source: runtimeHome() })).toThrow(/runtime home itself/);
  });
});

describe('import execution', () => {
  it('copies shared state and leaves the source untouched', async () => {
    const plan = planImport({ source });
    const result = await runImport({ plan });

    expect(result.copiedFiles).toBeGreaterThan(0);
    expect(existsSync(join(runtimeHome(), 'config.toml'))).toBe(true);
    expect(existsSync(join(runtimeHome(), 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(runtimeHome(), 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(runtimeHome(), 'cache', 'junk.bin'))).toBe(false);
    expect(existsSync(join(runtimeHome(), 'auth.json'))).toBe(false);

    // Source is intact.
    expect(existsSync(join(source, 'config.toml'))).toBe(true);
    expect(existsSync(join(source, 'sessions'))).toBe(true);
    expect(readFileSync(join(source, 'auth.json'), 'utf8')).toContain('access-imported');
  });

  it('is idempotent', async () => {
    const first = await runImport({ plan: planImport({ source }) });
    const second = await runImport({ plan: planImport({ source }) });

    expect(first.copiedFiles).toBeGreaterThan(0);
    expect(second.copiedFiles).toBe(0);
    expect(second.skippedFiles).toBeGreaterThan(0);
    expect(previousImports()).toHaveLength(2);
  });

  it.runIf(sqliteAvailable())('re-points the thread index at the copied transcripts', async () => {
    const result = await runImport({ plan: planImport({ source }) });
    expect(result.rolloutPathsRewritten).toBe(1);

    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(SESSION_ID);
    expect(sessions[0]!.rolloutPath?.startsWith(join(runtimeHome(), 'sessions'))).toBe(true);
    expect(existsSync(sessions[0]!.rolloutPath!)).toBe(true);
  });
});

describe('cma import command', () => {
  it('imports state, adopts the credential and activates it', async () => {
    const code = await run(['import', '--from', source, '--yes']);
    expect(code).toBe(0);

    expect(listProfiles().map((profile) => profile.slug)).toEqual(['personal']);
    expect(readFileSync(accountAuthPath('personal'), 'utf8')).toContain('access-imported');
    expect(activeProfileSlug()).toBe('personal');
    expect(existsSync(join(runtimeHome(), 'config.toml'))).toBe(true);
  });

  it('does not clobber an existing credential on a second run', async () => {
    await run(['import', '--from', source, '--yes']);
    writeFileSync(accountAuthPath('personal'), fakeAuth('local-newer'), 'utf8');

    await run(['import', '--from', source, '--yes']);
    expect(readFileSync(accountAuthPath('personal'), 'utf8')).toContain('access-local-newer');
  });

  it('rejects a directory that is not a Codex home', async () => {
    const empty = join(sandbox.root, 'not-codex');
    mkdirSync(empty, { recursive: true });
    const code = await run(['import', '--from', empty, '--yes']);
    expect(code).toBe(1);
  });

  it('supports a dry run that copies nothing', async () => {
    const code = await run(['import', '--from', source, '--dry-run']);
    expect(code).toBe(0);
    expect(existsSync(join(runtimeHome(), 'config.toml'))).toBe(false);
  });
});
