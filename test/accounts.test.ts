import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { createSandbox, fakeAuth } from './helpers.js';
import type { Sandbox } from './helpers.js';
import {
  checkAccount,
  createAccount,
  overview,
  removeAccount,
  requireActiveProfile,
  useAccount,
} from '../src/accounts/account-manager.js';
import {
  activeProfileSlug,
  getProfile,
  listProfiles,
  readState,
} from '../src/accounts/profile-store.js';
import { accountAuthPath, runtimeAuthPath } from '../src/storage/paths.js';
import { ensureDir, writeFileAtomic } from '../src/storage/atomic.js';

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

describe('account management', () => {
  it('adds accounts and makes the first one active', () => {
    const personal = createAccount('personal');
    expect(personal.slug).toBe('personal');
    expect(personal.name).toBe('Personal');
    expect(activeProfileSlug()).toBe('personal');

    createAccount('work');
    expect(activeProfileSlug()).toBe('personal');
    expect(listProfiles().map((p) => p.slug)).toEqual(['personal', 'work']);
  });

  it('derives a display label but keeps the slug canonical', () => {
    const profile = createAccount('Work Laptop');
    expect(profile.slug).toBe('work-laptop');
    expect(getProfile('work-laptop').name).toBe('Work Laptop');
  });

  it('refuses duplicate accounts', () => {
    createAccount('work');
    expect(() => createAccount('work')).toThrow(/already exists/);
    expect(listProfiles()).toHaveLength(1);
  });

  it('refuses invalid names before touching the filesystem', () => {
    expect(() => createAccount('../../escape')).not.toThrow(); // slugs to "escape"
    expect(listProfiles().map((p) => p.slug)).toEqual(['escape']);
    expect(() => createAccount('..')).toThrow();
    expect(() => createAccount('con')).not.toThrow(); // becomes "con-1"
    expect(listProfiles().map((p) => p.slug)).toContain('con-1');
  });

  it('reports a helpful error for an unknown account', () => {
    createAccount('personal');
    expect(() => getProfile('nope')).toThrow(/no account named/i);
  });

  it('selects accounts and materialises the right credential', () => {
    createAccount('personal');
    createAccount('work');
    signIn('personal', 'p-token');
    signIn('work', 'w-token');

    useAccount('personal');
    expect(activeProfileSlug()).toBe('personal');
    expect(readFileSync(runtimeAuthPath(), 'utf8')).toContain('access-p-token');
    expect(readState().runtimeOwner).toBe('personal');

    useAccount('work');
    expect(activeProfileSlug()).toBe('work');
    expect(readFileSync(runtimeAuthPath(), 'utf8')).toContain('access-w-token');
    expect(readState().runtimeOwner).toBe('work');
  });

  it('keeps credentials isolated per account', () => {
    createAccount('a');
    createAccount('b');
    signIn('a', 'aaa');
    signIn('b', 'bbb');

    useAccount('a');
    expect(readFileSync(accountAuthPath('a'), 'utf8')).toContain('access-aaa');
    expect(readFileSync(accountAuthPath('b'), 'utf8')).toContain('access-bbb');
    expect(readFileSync(accountAuthPath('b'), 'utf8')).not.toContain('access-aaa');
  });

  it('clears the runtime credential when switching to an account with none', () => {
    createAccount('a');
    createAccount('fresh');
    signIn('a');

    useAccount('a');
    expect(existsSync(runtimeAuthPath())).toBe(true);

    const result = useAccount('fresh');
    expect(result.authenticated).toBe(false);
    expect(existsSync(runtimeAuthPath())).toBe(false);
    // The other account's credential is untouched.
    expect(existsSync(accountAuthPath('a'))).toBe(true);
  });

  it('removes accounts, refusing to drop a credential without --force', () => {
    createAccount('personal');
    createAccount('work');
    signIn('work');

    expect(() => removeAccount('work')).toThrow(/still has a stored credential/);
    removeAccount('work', { force: true });

    expect(listProfiles().map((p) => p.slug)).toEqual(['personal']);
    expect(existsSync(accountAuthPath('work'))).toBe(false);
  });

  it('picks a new active account when the active one is removed', () => {
    createAccount('personal');
    createAccount('work');
    signIn('personal', 'p');
    signIn('work', 'w');
    useAccount('personal');

    removeAccount('personal', { force: true });
    expect(activeProfileSlug()).toBe('work');
    // The runtime must never be left holding a credential nobody owns.
    expect(readState().runtimeOwner).toBe('work');
    expect(readFileSync(runtimeAuthPath(), 'utf8')).toContain('access-w');
  });

  it('clears the runtime credential when the last account is removed', () => {
    createAccount('only');
    signIn('only');
    useAccount('only');

    removeAccount('only', { force: true });
    expect(activeProfileSlug()).toBeNull();
    expect(readState().runtimeOwner).toBeNull();
    expect(existsSync(runtimeAuthPath())).toBe(false);
  });

  it('explains what to do when nothing is selected', () => {
    expect(() => requireActiveProfile()).toThrow(/No account is selected/);
  });
});

describe('health checks', () => {
  it('reports a missing credential', () => {
    createAccount('work');
    const report = checkAccount('work');
    expect(report.hasCredential).toBe(false);
    expect(report.valid).toBe(false);
  });

  it('reports a corrupt credential without exposing it', () => {
    createAccount('work');
    signIn('work');
    writeFileSync(accountAuthPath('work'), '{"tokens":{}}', 'utf8');

    const report = checkAccount('work');
    expect(report.valid).toBe(false);
    expect(report.reason).toMatch(/neither ChatGPT tokens nor an API key/);
  });

  it('summarises a healthy credential with no token material', () => {
    createAccount('work');
    signIn('work', 'abc');
    const report = checkAccount('work');

    expect(report.valid).toBe(true);
    expect(report.summary?.mode).toBe('chatgpt');
    expect(JSON.stringify(report)).not.toContain('access-abc');
    expect(JSON.stringify(report)).not.toContain('refresh-abc');
  });

  it('asks Codex itself when a deep check is requested', () => {
    createAccount('work');
    signIn('work');
    const report = checkAccount('work', { deep: true });
    expect(report.codexStatus?.ok).toBe(true);
    expect(report.codexStatus?.message).toContain('Logged in');
  });
});

describe('overview', () => {
  it('summarises accounts, the active one and the runtime owner', () => {
    createAccount('personal');
    createAccount('work');
    signIn('work');
    useAccount('work');

    const state = overview();
    expect(state.profiles).toHaveLength(2);
    expect(state.active).toBe('work');
    expect(state.runtimeOwner).toBe('work');
    expect(state.activeWriters).toEqual([]);
  });
});
