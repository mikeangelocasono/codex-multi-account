/**
 * Profile-name validation and slugging.
 *
 * A profile slug becomes a directory name under `accounts/`, so it is the one
 * piece of user input that reaches the filesystem as a path segment. Every
 * value is validated against an allow-list before it is used; nothing is
 * sanitised in place and then trusted.
 */

import { CmaError } from '../utils/errors.js';

export const MAX_SLUG_LENGTH = 48;

/** A literal NUL, built at runtime so no control byte ever appears in source. */
const NUL_BYTE = String.fromCharCode(0);

/**
 * Anchored allow-list. Lowercase alphanumerics plus `-` and `_`, and a
 * separator may not start or end the name - a trailing dot or dash is exactly
 * the kind of edge case Windows quietly strips when creating a directory.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/** Combining marks, stripped after NFKD so "Work" survives an accented spelling. */
const COMBINING_MARKS = new RegExp(
  "[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]",
  "g",
);

/** C0 and C1 control characters, replaced before anything is printed. */
const CONTROL_CHARS = new RegExp(
  "[" +
    String.fromCharCode(0x00) + "-" + String.fromCharCode(0x1f) +
    String.fromCharCode(0x7f) + "-" + String.fromCharCode(0x9f) +
    "]",
  "g",
);

/**
 * Names Windows refuses to use as a file or directory, case-insensitively,
 * with or without an extension. Reserved here on every platform so that a
 * profile created on Linux still works when the same home is used on Windows.
 */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** Slugs that would collide with directories codex-multi-account manages itself. */
const RESERVED_SLUGS = new Set(['runtime', 'backups', 'locks', 'accounts', 'config', 'state']);

export function isValidSlug(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_SLUG_LENGTH) return false;
  if (!SLUG_PATTERN.test(value)) return false;
  if (WINDOWS_RESERVED.has(value)) return false;
  if (RESERVED_SLUGS.has(value)) return false;
  return true;
}

/**
 * Turn a human display name into a slug.
 *
 * Returns `null` when nothing usable survives, rather than inventing a name -
 * the caller decides what to do with unusable input.
 */
export function slugify(input: string): string | null {
  if (typeof input !== 'string') return null;

  const slug = input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-_]+$/, '');

  if (!isValidSlug(slug)) {
    if (slug.length > 0 && SLUG_PATTERN.test(slug) && WINDOWS_RESERVED.has(slug)) {
      // "con" -> "con-1" keeps the user's intent without breaking Windows.
      const patched = `${slug}-1`;
      return isValidSlug(patched) ? patched : null;
    }
    return null;
  }
  return slug;
}

/** Validate a slug supplied on the command line, or throw a user-facing error. */
export function assertValidSlug(value: string, label = 'Profile name'): string {
  if (isValidSlug(value)) return value;

  const reason = describeSlugProblem(value);
  throw new CmaError('INVALID_ARGUMENT', `${label} "${truncateForDisplay(value)}" is not valid.`, {
    hint: `${reason}\nUse lowercase letters, digits, "-" and "_" (max ${MAX_SLUG_LENGTH} characters), starting with a letter or digit.`,
  });
}

/**
 * Accept either an exact slug or a human name that slugs cleanly.
 * Used by `cma add "Work Laptop"` so users are not forced to type slugs.
 */
export function coerceToSlug(value: string, label = 'Profile name'): string {
  if (isValidSlug(value)) return value;
  const slug = slugify(value);
  if (slug) return slug;
  return assertValidSlug(value, label);
}

function describeSlugProblem(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return 'It is empty.';
  if (value.length > MAX_SLUG_LENGTH) return `It is longer than ${MAX_SLUG_LENGTH} characters.`;
  if (/[/\\]/.test(value) || value.includes('..')) {
    return 'Path separators and ".." are rejected: a profile name must be a single directory-safe token.';
  }
  if (WINDOWS_RESERVED.has(value.toLowerCase())) return 'It is a name Windows reserves for devices.';
  if (RESERVED_SLUGS.has(value.toLowerCase())) return 'It is reserved by codex-multi-account.';
  return 'It contains characters that are not allowed.';
}

/** Keep hostile input from painting the terminal with control characters. */
export function truncateForDisplay(value: unknown, max = 60): string {
  const text = typeof value === 'string' ? value : String(value);
  const clean = text.replace(CONTROL_CHARS, '?');
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/**
 * Reject arguments that cannot be passed through to a child process safely.
 *
 * Arguments are always delivered as an argv array (never a shell string), so
 * quoting is not a concern; embedded NULs are, because they truncate the
 * argument at the OS boundary.
 */
export function assertSafeArgs(args: readonly string[]): readonly string[] {
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new CmaError('INVALID_ARGUMENT', 'Arguments passed to Codex must be strings.');
    }
    if (arg.includes(NUL_BYTE)) {
      throw new CmaError(
        'INVALID_ARGUMENT',
        'An argument contains a NUL byte and cannot be forwarded to Codex.',
      );
    }
  }
  return args;
}

/** Session ids are UUIDs; names are a looser but still constrained token. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSessionId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function assertSessionSelector(value: string): string {
  if (isSessionId(value) || SESSION_NAME_PATTERN.test(value)) return value;
  throw new CmaError(
    'INVALID_ARGUMENT',
    `"${truncateForDisplay(value)}" is not a valid session id or session name.`,
    { hint: 'Run `cma sessions` to see the available session ids.' },
  );
}
