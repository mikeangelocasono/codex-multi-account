import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { createSandbox, fakeAuth } from './helpers.js';
import type { Sandbox } from './helpers.js';
import {
  clearRuntimeAuth,
  forgetProfileAuth,
  inspectAuthBuffer,
  materializeProfile,
  syncRuntimeAuthBack,
} from '../src/accounts/auth-manager.js';
import { createAccount } from '../src/accounts/account-manager.js';
import { readState, writeState } from '../src/accounts/profile-store.js';
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

describe('credential inspection', () => {
  it('accepts a ChatGPT credential and summarises it without tokens', () => {
    const result = inspectAuthBuffer(Buffer.from(fakeAuth('abc', 'acct-123456789')));
    expect(result.ok).toBe(true);
    expect(result.summary?.mode).toBe('chatgpt');
    expect(result.summary?.accountIdSuffix).toBe('...456789');
    expect(JSON.stringify(result.summary)).not.toContain('access-abc');
  });

  it('accepts an API-key credential', () => {
    const result = inspectAuthBuffer(
      Buffer.from(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-key-value' })),
    );
    expect(result.ok).toBe(true);
    expect(result.summary?.mode).toBe('apikey');
  });

  it('rejects empty, malformed and token-less files with a reason', () => {
    expect(inspectAuthBuffer(Buffer.alloc(0)).reason).toMatch(/empty/);
    expect(inspectAuthBuffer(Buffer.from('{')).reason).toMatch(/not valid JSON/);
    expect(inspectAuthBuffer(Buffer.from('[]')).reason).toMatch(/neither/);
    expect(inspectAuthBuffer(Buffer.from('{"tokens":{}}')).reason).toMatch(/neither/);
  });
});

describe('materialisation', () => {
  it('copies the profile credential into the runtime and records ownership', () => {
    createAccount('work');
    signIn('work', 'w1');

    const result = materializeProfile('work');
    expect(result.authenticated).toBe(true);
    expect(readFileSync(runtimeAuthPath(), 'utf8')).toBe(readFileSync(accountAuthPath('work'), 'utf8'));

    const state = readState();
    expect(state.runtimeOwner).toBe('work');
    expect(state.runtimeAuthFingerprint).toBeTruthy();
  });

  it('refuses to materialise a corrupt credential', () => {
    createAccount('work');
    signIn('work');
    writeFileSync(accountAuthPath('work'), 'not json', 'utf8');
    expect(() => materializeProfile('work')).toThrow(/not usable/);
  });

  it('flushes the previous owner before swapping', () => {
    createAccount('a');
    createAccount('b');
    signIn('a', 'a1');
    signIn('b', 'b1');

    materializeProfile('a');
    // Simulate Codex refreshing the token while account "a" was active.
    writeFileSync(runtimeAuthPath(), fakeAuth('a2'), 'utf8');

    materializeProfile('b');

    expect(readFileSync(accountAuthPath('a'), 'utf8')).toContain('access-a2');
    expect(readFileSync(runtimeAuthPath(), 'utf8')).toContain('access-b1');
    expect(readState().runtimeOwner).toBe('b');
  });
});

describe('write-back', () => {
  it('does nothing when the credential has not changed', () => {
    createAccount('work');
    signIn('work');
    materializeProfile('work');

    expect(syncRuntimeAuthBack().action).toBe('noop');
  });

  it('saves a refreshed credential to the owning profile only', () => {
    createAccount('work');
    createAccount('other');
    signIn('work', 'w1');
    signIn('other', 'o1');
    materializeProfile('work');

    writeFileSync(runtimeAuthPath(), fakeAuth('w2'), 'utf8');
    const result = syncRuntimeAuthBack();

    expect(result.action).toBe('updated');
    expect(result.profile).toBe('work');
    expect(readFileSync(accountAuthPath('work'), 'utf8')).toContain('access-w2');
    // The account that does not own the runtime is never touched.
    expect(readFileSync(accountAuthPath('other'), 'utf8')).toContain('access-o1');
  });

  it('never overwrites a good credential with a broken runtime copy', () => {
    createAccount('work');
    signIn('work', 'good');
    materializeProfile('work');

    writeFileSync(runtimeAuthPath(), '{"tokens":{}}', 'utf8');
    const result = syncRuntimeAuthBack();

    expect(result.action).toBe('skipped');
    expect(readFileSync(accountAuthPath('work'), 'utf8')).toContain('access-good');
  });

  it('never overwrites a good credential with an empty runtime file', () => {
    createAccount('work');
    signIn('work', 'good');
    materializeProfile('work');

    writeFileSync(runtimeAuthPath(), '', 'utf8');
    expect(syncRuntimeAuthBack().action).toBe('skipped');
    expect(readFileSync(accountAuthPath('work'), 'utf8')).toContain('access-good');
  });

  it('mirrors a sign-out performed inside Codex', () => {
    createAccount('work');
    signIn('work');
    materializeProfile('work');

    rmSync(runtimeAuthPath(), { force: true });
    const result = syncRuntimeAuthBack();

    expect(result.action).toBe('cleared');
    expect(existsSync(accountAuthPath('work'))).toBe(false);
  });

  it('does nothing when no profile owns the runtime credential', () => {
    createAccount('work');
    signIn('work');
    writeFileSync(runtimeAuthPath(), fakeAuth('stray'), 'utf8');
    writeState({ runtimeOwner: null, runtimeAuthFingerprint: null });

    expect(syncRuntimeAuthBack().action).toBe('noop');
    expect(readFileSync(accountAuthPath('work'), 'utf8')).toContain('access-work');
  });

  it('does not resurrect a credential for a deleted profile', () => {
    createAccount('work');
    signIn('work');
    materializeProfile('work');
    writeFileSync(runtimeAuthPath(), fakeAuth('later'), 'utf8');
    writeState({ runtimeOwner: 'ghost' });

    const result = syncRuntimeAuthBack();
    expect(result.action).toBe('noop');
    expect(readState().runtimeOwner).toBeNull();
  });
});

describe('clearing credentials', () => {
  it('clears only the runtime copy when preparing a login', () => {
    createAccount('work');
    createAccount('next');
    signIn('work');
    materializeProfile('work');

    clearRuntimeAuth('next');
    expect(existsSync(runtimeAuthPath())).toBe(false);
    expect(existsSync(accountAuthPath('work'))).toBe(true);
    expect(readState().runtimeOwner).toBe('next');
  });

  it('forgets a profile credential and the runtime copy it owns', () => {
    createAccount('work');
    signIn('work');
    materializeProfile('work');

    forgetProfileAuth('work');
    expect(existsSync(accountAuthPath('work'))).toBe(false);
    expect(existsSync(runtimeAuthPath())).toBe(false);
  });
});
