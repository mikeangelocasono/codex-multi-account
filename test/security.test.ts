import { describe, expect, it } from 'vitest';

import {
  assertSafeArgs,
  assertSessionSelector,
  assertValidSlug,
  coerceToSlug,
  isValidSlug,
  slugify,
  truncateForDisplay,
} from '../src/security/validation.js';
import { fingerprint, maskTail, redactJson, redactText } from '../src/security/redact.js';
import { permissionModel } from '../src/security/permissions.js';

describe('profile name validation', () => {
  it('accepts ordinary names', () => {
    for (const name of ['personal', 'work', 'client-2', 'a', 'my_account']) {
      expect(isValidSlug(name)).toBe(true);
    }
  });

  it('rejects path traversal in every shape', () => {
    const hostile = [
      '../../something',
      '..',
      '.',
      '../etc/passwd',
      'a/b',
      'a\\b',
      'C:\\Windows',
      '/absolute',
      './relative',
      '..\\..\\windows\\system32',
    ];
    for (const value of hostile) {
      expect(isValidSlug(value), value).toBe(false);
      expect(() => assertValidSlug(value)).toThrow();
    }
  });

  it('rejects Windows device names', () => {
    for (const value of ['con', 'nul', 'com1', 'lpt9', 'aux', 'prn']) {
      expect(isValidSlug(value), value).toBe(false);
    }
  });

  it('rejects names reserved by the tool itself', () => {
    for (const value of ['runtime', 'backups', 'locks', 'accounts']) {
      expect(isValidSlug(value), value).toBe(false);
    }
  });

  it('rejects control characters, spaces and unicode tricks', () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    for (const value of [`a${nul}b`, `a${bell}`, 'has space', 'UPPER', '-leading', 'trailing-']) {
      expect(isValidSlug(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects over-long names', () => {
    expect(isValidSlug('a'.repeat(49))).toBe(false);
    expect(isValidSlug('a'.repeat(48))).toBe(true);
  });

  it('slugs human names without ever producing a traversal', () => {
    expect(slugify('Work Laptop')).toBe('work-laptop');
    expect(slugify('  Client (Acme) ')).toBe('client-acme');
    expect(slugify('../../evil')).toBe('evil');
    expect(slugify('C:\\Users\\bob')).toBe('c-users-bob');
    expect(slugify('...')).toBeNull();
    expect(slugify('///')).toBeNull();
    expect(slugify('con')).toBe('con-1');
  });

  it('coerces display names but still refuses unusable input', () => {
    expect(coerceToSlug('Work Laptop')).toBe('work-laptop');
    expect(() => coerceToSlug('..')).toThrow();
  });

  it('keeps hostile text out of the terminal', () => {
    const escape = String.fromCharCode(27);
    const painted = `${escape}[31mred${escape}[0m`;
    expect(truncateForDisplay(painted)).not.toContain(escape);
    expect(truncateForDisplay('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('argument forwarding safety', () => {
  it('passes ordinary Codex arguments through untouched', () => {
    const args = ['--model', 'gpt-5.6-sol', '--cd', 'C:\\Projects\\My App', '-c', 'foo.bar=1'];
    expect(assertSafeArgs(args)).toEqual(args);
  });

  it('does not treat shell metacharacters as special', () => {
    // Arguments go into an argv array, so these are just strings.
    const args = ['; rm -rf /', '$(whoami)', '`id`', '&& shutdown', '|| echo', '> out.txt'];
    expect(assertSafeArgs(args)).toEqual(args);
  });

  it('rejects embedded NUL bytes', () => {
    expect(() => assertSafeArgs([`--model${String.fromCharCode(0)}evil`])).toThrow(/NUL/);
  });
});

describe('session selectors', () => {
  it('accepts uuids and names', () => {
    expect(assertSessionSelector('01a01803-e02e-7722-8cb4-ec03dbad2d58')).toBeTruthy();
    expect(assertSessionSelector('my-session.1')).toBeTruthy();
  });

  it('rejects anything that could become a path or a flag', () => {
    for (const value of ['../x', 'a/b', '-rf', '']) {
      expect(() => assertSessionSelector(value)).toThrow();
    }
  });
});

describe('redaction', () => {
  it('replaces secret-shaped fields at any depth', () => {
    const redacted = redactJson({
      auth_mode: 'chatgpt',
      account_id: 'acct-1',
      tokens: { access_token: 'secret', refresh_token: 'secret', account_id: 'acct-1' },
      nested: [{ api_key: 'sk-abc', label: 'visible' }],
    }) as Record<string, unknown>;

    const text = JSON.stringify(redacted);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('sk-abc');
    // A container whose own name is secret-shaped is redacted wholesale.
    expect(redacted.tokens).toBe('<redacted>');
    // Non-secret fields survive.
    expect(text).toContain('acct-1');
    expect(text).toContain('chatgpt');
    expect(text).toContain('visible');
  });

  it('strips token-shaped strings from free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactText(`token=${jwt}`)).not.toContain(jwt);
    expect(redactText('key=sk-abcdefghijklmnopqrstuvwx')).toContain('<redacted-key>');
  });

  it('fingerprints without revealing the input', () => {
    const value = fingerprint('super-secret');
    expect(value).toHaveLength(16);
    expect(value).not.toContain('secret');
    expect(fingerprint('super-secret')).toBe(value);
    expect(fingerprint('other')).not.toBe(value);
  });

  it('masks identifiers to their tail', () => {
    expect(maskTail('c7033e90-fdd1-44c5-9530-9d15c4a565ae')).toBe('...a565ae');
    expect(maskTail(null)).toBe('unknown');
    expect(maskTail('abc')).toBe('***');
  });
});

describe('permission model', () => {
  it('reports a platform-appropriate strategy', () => {
    const model = permissionModel();
    expect(model.mode).toBe(process.platform === 'win32' ? 'windows-acl' : 'posix');
    expect(model.note.length).toBeGreaterThan(0);
  });
});
