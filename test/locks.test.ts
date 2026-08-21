import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { createSandbox } from './helpers.js';
import type { Sandbox } from './helpers.js';
import {
  assertNoActiveWriters,
  isProcessAlive,
  listActiveWriters,
  registerWriter,
  unregisterWriter,
  withRuntimeLock,
} from '../src/storage/locks.js';
import { ensureDir } from '../src/storage/atomic.js';
import { runtimeLockPath, writersDir } from '../src/storage/paths.js';
import { ensureHomeLayout } from '../src/accounts/profile-store.js';

let sandbox: Sandbox;

/** A pid that is almost certainly not running. */
const DEAD_PID = 0x7ffffffe;

beforeEach(() => {
  sandbox = createSandbox();
  ensureHomeLayout();
});

afterEach(() => {
  sandbox.cleanup();
});

describe('process liveness', () => {
  it('recognises the current process and rejects nonsense pids', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('runtime lock', () => {
  it('runs the critical section and releases afterwards', () => {
    const value = withRuntimeLock(() => {
      expect(existsSync(runtimeLockPath())).toBe(true);
      return 42;
    });
    expect(value).toBe(42);
    expect(existsSync(runtimeLockPath())).toBe(false);
  });

  it('releases the lock even when the body throws', () => {
    expect(() =>
      withRuntimeLock(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(runtimeLockPath())).toBe(false);
  });

  it('refuses a concurrent operation held by a live process', () => {
    writeFileSync(
      runtimeLockPath(),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        operation: 'use:work',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    expect(() => withRuntimeLock(() => 1, { timeoutMs: 200 })).toThrow(/operation is in progress/i);
    // The other holder's lock is left alone.
    expect(existsSync(runtimeLockPath())).toBe(true);
  });

  it('reclaims a lock left behind by a crashed process', () => {
    writeFileSync(
      runtimeLockPath(),
      JSON.stringify({
        pid: DEAD_PID,
        host: hostname(),
        operation: 'use:work',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    expect(withRuntimeLock(() => 'recovered', { timeoutMs: 500 })).toBe('recovered');
    expect(existsSync(runtimeLockPath())).toBe(false);
  });

  it('reclaims a lock whose file is unreadable', () => {
    writeFileSync(runtimeLockPath(), 'garbage', 'utf8');
    expect(withRuntimeLock(() => 'recovered', { timeoutMs: 500 })).toBe('recovered');
  });

  it('reclaims a very old lock even if a live pid still matches', () => {
    writeFileSync(
      runtimeLockPath(),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        operation: 'hung',
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
      'utf8',
    );
    expect(withRuntimeLock(() => 'recovered', { timeoutMs: 500, staleMs: 1000 })).toBe('recovered');
  });
});

describe('writer registry', () => {
  it('tracks a live session and forgets it on unregister', () => {
    const record = registerWriter('work', 'codex');
    expect(listActiveWriters().map((w) => w.profile)).toEqual(['work']);

    unregisterWriter(record);
    expect(listActiveWriters()).toEqual([]);
  });

  it('prunes entries left behind by a killed process', () => {
    ensureDir(writersDir());
    writeFileSync(
      join(writersDir(), 'stale.json'),
      JSON.stringify({
        id: 'stale',
        pid: DEAD_PID,
        host: hostname(),
        profile: 'work',
        command: 'codex',
        cwd: process.cwd(),
        startedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    expect(listActiveWriters()).toEqual([]);
    expect(readdirSync(writersDir())).toEqual([]);
  });

  it('prunes unparseable entries', () => {
    ensureDir(writersDir());
    writeFileSync(join(writersDir(), 'broken.json'), 'not json', 'utf8');
    expect(listActiveWriters()).toEqual([]);
  });

  it('blocks switching while another account is running', () => {
    const record = registerWriter('personal', 'codex');
    try {
      expect(() => assertNoActiveWriters('switch accounts')).toThrow(
        /currently using account "personal"/,
      );
      // Re-launching the same account is allowed: the credential does not change.
      expect(() => assertNoActiveWriters('launch Codex', 'personal')).not.toThrow();
    } finally {
      unregisterWriter(record);
    }
  });

  it('allows switching once the session is gone', () => {
    const record = registerWriter('personal', 'codex');
    unregisterWriter(record);
    expect(() => assertNoActiveWriters('switch accounts')).not.toThrow();
  });
});
