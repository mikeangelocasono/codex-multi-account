import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSandbox } from './helpers.js';
import type { Sandbox } from './helpers.js';
import { ensureDir, readJsonFile, writeFileAtomic, writeJsonFile } from '../src/storage/atomic.js';
import { createBackup, listBackups } from '../src/storage/backup.js';
import { ensureHomeLayout } from '../src/accounts/profile-store.js';
import * as paths from '../src/storage/paths.js';

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.cleanup();
});

describe('paths', () => {
  it('derives everything from CMA_HOME without hard-coded platform paths', () => {
    expect(paths.cmaHome()).toBe(sandbox.cmaHome);
    expect(paths.runtimeHome()).toBe(join(sandbox.cmaHome, 'runtime'));
    expect(paths.accountDir('work')).toBe(join(sandbox.cmaHome, 'accounts', 'work'));
    expect(paths.accountAuthPath('work')).toBe(
      join(sandbox.cmaHome, 'accounts', 'work', 'auth.json'),
    );
  });

  it('falls back to the home directory when CMA_HOME is unset', () => {
    delete process.env.CMA_HOME;
    expect(paths.cmaHome().endsWith('.codex-multi-account')).toBe(true);
    process.env.CMA_HOME = sandbox.cmaHome;
  });
});

describe('home layout', () => {
  it('creates the skeleton and is safe to repeat', () => {
    ensureHomeLayout();
    ensureHomeLayout();
    for (const dir of [paths.runtimeHome(), paths.accountsDir(), paths.writersDir()]) {
      expect(existsSync(dir), dir).toBe(true);
    }
  });
});

describe('atomic writes', () => {
  it('replaces content in one step and leaves no temp files behind', () => {
    const target = join(sandbox.root, 'data', 'value.json');
    writeFileAtomic(target, 'first');
    writeFileAtomic(target, 'second');
    expect(readFileSync(target, 'utf8')).toBe('second');

    const leftovers = readdirSync(join(sandbox.root, 'data')).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('applies restrictive permissions on POSIX', () => {
    const target = join(sandbox.root, 'secret.json');
    writeFileAtomic(target, 'x', { mode: 0o600, secret: true });
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } else {
      expect(existsSync(target)).toBe(true);
    }
  });

  it('round-trips JSON and reports corruption instead of guessing', () => {
    const target = join(sandbox.root, 'config.json');
    writeJsonFile(target, { a: 1 });
    expect(readJsonFile<{ a: number }>(target)).toEqual({ a: 1 });

    writeFileSync(target, '{ not json', 'utf8');
    expect(() => readJsonFile(target)).toThrow(/not valid JSON/);
  });

  it('returns undefined for a missing file rather than throwing', () => {
    expect(readJsonFile(join(sandbox.root, 'nope.json'))).toBeUndefined();
  });
});

describe('backups', () => {
  it('captures state but never credentials', () => {
    ensureHomeLayout();
    writeJsonFile(paths.configPath(), { version: 1, profiles: {} });
    writeJsonFile(paths.statePath(), { version: 1, activeProfile: 'work' });
    mkdirSync(paths.runtimeHome(), { recursive: true });
    writeFileSync(join(paths.runtimeHome(), 'config.toml'), 'model = "test"\n');
    writeFileSync(join(paths.runtimeHome(), 'auth.json'), '{"tokens":{"access_token":"x"}}');

    const backup = createBackup('unit');
    expect(backup.files).toContain('config.json');
    expect(backup.files).toContain('config.toml');
    expect(backup.files).not.toContain('auth.json');
    expect(existsSync(join(backup.path, 'auth.json'))).toBe(false);
    expect(listBackups().length).toBe(1);

    const manifest = readJsonFile<{ note: string }>(join(backup.path, 'manifest.json'));
    expect(manifest?.note).toMatch(/Credential files are intentionally excluded/);
  });

  it('restores by copying a captured file back', () => {
    ensureHomeLayout();
    writeJsonFile(paths.configPath(), { version: 1, profiles: { a: { name: 'A', order: 1 } } });
    const backup = createBackup('restore-test');

    writeJsonFile(paths.configPath(), { version: 1, profiles: {} });
    expect(readJsonFile<{ profiles: object }>(paths.configPath())?.profiles).toEqual({});

    const saved = readFileSync(join(backup.path, 'config.json'), 'utf8');
    writeFileAtomic(paths.configPath(), saved);
    expect(
      Object.keys(readJsonFile<{ profiles: object }>(paths.configPath())?.profiles ?? {}),
    ).toEqual(['a']);
  });
});

describe('directory permissions', () => {
  it('creates credential directories with owner-only access on POSIX', () => {
    ensureDir(join(sandbox.root, 'secret-dir'), { secret: true });
    if (process.platform !== 'win32') {
      expect(statSync(join(sandbox.root, 'secret-dir')).mode & 0o777).toBe(0o700);
    } else {
      expect(existsSync(join(sandbox.root, 'secret-dir'))).toBe(true);
    }
  });

  /**
   * Regression: a Windows ACL applied without (OI)(CI) leaves the directory
   * with no inheritable entry, so every file created inside it afterwards ends
   * up with an empty DACL - unreadable even by its owner. Codex only surfaces
   * this as "Failed to read config file ... Access is denied".
   */
  it('keeps existing files readable after the directory is hardened', () => {
    withRealAcls(() => {
      const dir = join(sandbox.root, 'hardened');
      ensureDir(dir);

      // Written while the directory still inherits from its parent, so every
      // ACE on this file is an inherited one.
      const inside = join(dir, 'config.toml');
      writeFileSync(inside, 'model = "x"\n', 'utf8');

      // Hardening the directory strips its inheritable ACEs. If the grant that
      // replaces them is not itself inheritable, the file above loses every
      // inherited ACE and becomes unreadable.
      ensureDir(dir, { secret: true });

      expect(readFileSync(inside, 'utf8')).toBe('model = "x"\n');
    });
  });

  it('does not harden the parent when writing a secret file into a shared directory', () => {
    withRealAcls(() => {
      const shared = join(sandbox.root, 'shared-runtime');
      ensureDir(shared);
      writeFileSync(join(shared, 'config.toml'), 'model = "x"\n', 'utf8');

      writeFileAtomic(join(shared, 'auth.json'), '{"tokens":{"access_token":"x"}}', {
        mode: 0o600,
        secret: true,
      });

      // Codex reads config.toml from the same directory as the credential.
      expect(readFileSync(join(shared, 'config.toml'), 'utf8')).toBe('model = "x"\n');
    });
  });
});

/** Run a block with the real permission logic instead of the test shortcut. */
function withRealAcls(body: () => void): void {
  const previous = process.env.CMA_SKIP_ACL;
  delete process.env.CMA_SKIP_ACL;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.CMA_SKIP_ACL;
    else process.env.CMA_SKIP_ACL = previous;
  }
}
