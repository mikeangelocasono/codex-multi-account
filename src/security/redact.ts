/**
 * Redaction helpers.
 *
 * Nothing derived from a credential is ever printed. These helpers exist so
 * that diagnostics can still say something useful ("the token changed",
 * "account ...a565ae") without the value itself reaching a terminal, a log
 * file or a crash report.
 */

import { createHash } from 'node:crypto';

const SECRET_KEY_PATTERN = /(token|secret|key|password|credential|cookie|authorization)/i;

/** Short, stable, non-reversible identifier for a credential blob. */
export function fingerprint(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/** Show only the tail of an identifier, e.g. an account id. Never a token. */
export function maskTail(value: string | null | undefined, keep = 6): string {
  if (!value) return 'unknown';
  if (value.length <= keep) return '*'.repeat(value.length);
  return `...${value.slice(-keep)}`;
}

/**
 * Deep-clone a JSON value with every secret-looking field replaced.
 * Used for `cma info --json` and for anything written to a log.
 */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return '<deep>';
  if (Array.isArray(value)) return value.map((item) => redactJson(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = item === null || item === undefined ? item : '<redacted>';
      continue;
    }
    out[key] = redactJson(item, depth + 1);
  }
  return out;
}

/**
 * Last line of defence for text that is about to be printed: strip anything
 * that looks like a JWT or an OpenAI-style key.
 */
export function redactText(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted-jwt>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<redacted-key>')
    .replace(/\b(gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '<redacted-token>');
}
