/**
 * Credential materialisation and write-back.
 *
 * Codex reads and writes exactly one credential file: `$CODEX_HOME/auth.json`.
 * Because every profile shares one runtime `CODEX_HOME` (so that sessions are
 * shared), the active profile's credential is copied into the runtime before
 * Codex starts, and any change Codex makes is copied back out.
 *
 * The write-back is not optional. ChatGPT OAuth tokens are refreshed while
 * Codex runs, and the refresh token itself rotates; a snapshot taken at launch
 * is stale by the time the session ends. Three rules keep that safe:
 *
 *   1. `state.runtimeOwner` records which profile the runtime credential
 *      belongs to. Write-back only ever targets that profile.
 *   2. A fingerprint of the materialised bytes is recorded, so an unchanged
 *      credential is never rewritten.
 *   3. Nothing is written back unless it parses as a credential. A truncated
 *      or empty file is reported, never propagated.
 */

import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';

import { CmaError, errnoCode } from '../utils/errors.js';
import { fingerprint, maskTail } from '../security/redact.js';
import { copyFileAtomic, ensureDir, fileExists, writeFileAtomic } from '../storage/atomic.js';
import { accountAuthPath, accountDir, runtimeAuthPath, runtimeHome } from '../storage/paths.js';
import {
  ensureHomeLayout,
  profileExists,
  readState,
  writeMetadata,
  writeState,
} from './profile-store.js';

export type AuthMode = 'chatgpt' | 'apikey' | 'unknown';

/** Everything we are willing to know about a credential. No token values. */
export interface AuthSummary {
  mode: AuthMode;
  accountIdSuffix: string | null;
  lastRefresh: string | null;
  fingerprint: string;
  byteLength: number;
}

export interface AuthReadResult {
  ok: boolean;
  summary?: AuthSummary;
  reason?: string;
}

interface RawAuth {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: { access_token?: unknown; refresh_token?: unknown; account_id?: unknown } | null;
  last_refresh?: unknown;
}

/**
 * Parse and validate a credential blob.
 *
 * Returns a summary or a reason - never throws for malformed input, because
 * the caller usually wants to report and continue rather than abort.
 */
export function inspectAuthBuffer(data: Buffer): AuthReadResult {
  if (data.length === 0) return { ok: false, reason: 'the file is empty' };

  let parsed: RawAuth;
  try {
    parsed = JSON.parse(data.toString('utf8')) as RawAuth;
  } catch {
    return { ok: false, reason: 'the file is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'the file does not contain a JSON object' };
  }

  const tokens = typeof parsed.tokens === 'object' && parsed.tokens !== null ? parsed.tokens : null;
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
  const apiKey = typeof parsed.OPENAI_API_KEY === 'string' ? parsed.OPENAI_API_KEY : '';

  if (accessToken.length === 0 && apiKey.length === 0) {
    return { ok: false, reason: 'it contains neither ChatGPT tokens nor an API key' };
  }

  const declaredMode = typeof parsed.auth_mode === 'string' ? parsed.auth_mode : '';
  const mode: AuthMode =
    declaredMode === 'chatgpt' || declaredMode === 'apikey'
      ? declaredMode
      : accessToken.length > 0
        ? 'chatgpt'
        : apiKey.length > 0
          ? 'apikey'
          : 'unknown';

  return {
    ok: true,
    summary: {
      mode,
      accountIdSuffix:
        typeof tokens?.account_id === 'string' ? maskTail(tokens.account_id, 6) : null,
      lastRefresh: typeof parsed.last_refresh === 'string' ? parsed.last_refresh : null,
      fingerprint: fingerprint(data),
      byteLength: data.length,
    },
  };
}

export function inspectAuthFile(path: string): AuthReadResult {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { ok: false, reason: 'no credential is stored' };
    return { ok: false, reason: `the file could not be read (${errnoCode(error) ?? 'unknown'})` };
  }
  return inspectAuthBuffer(data);
}

export interface SyncResult {
  /** What actually happened, for the caller to report. */
  action: 'noop' | 'updated' | 'cleared' | 'skipped';
  profile: string | null;
  reason?: string;
}

/**
 * Copy the runtime credential back to the profile that owns it.
 *
 * Called before every account switch, on a timer while Codex runs, and once
 * more after Codex exits.
 */
export function syncRuntimeAuthBack(): SyncResult {
  const state = readState();
  const owner = state.runtimeOwner;
  if (!owner) return { action: 'noop', profile: null };

  if (!profileExists(owner)) {
    // The owning profile was removed; its credential went with it.
    writeState({ runtimeOwner: null, runtimeAuthFingerprint: null });
    return { action: 'noop', profile: owner, reason: 'the owning account no longer exists' };
  }

  const runtimePath = runtimeAuthPath();

  if (!fileExists(runtimePath)) {
    // A credential we materialised has disappeared. The only thing that does
    // that is `codex logout`, so mirror the sign-out instead of silently
    // keeping a revoked credential around.
    if (state.runtimeAuthFingerprint === null) {
      return { action: 'noop', profile: owner };
    }
    rmSync(accountAuthPath(owner), { force: true });
    writeState({ runtimeAuthFingerprint: null });
    writeMetadata(owner, {
      authMode: null,
      accountIdSuffix: null,
      lastAuthSyncAt: new Date().toISOString(),
    });
    return {
      action: 'cleared',
      profile: owner,
      reason: 'Codex signed this account out',
    };
  }

  let data: Buffer;
  try {
    data = readFileSync(runtimePath);
  } catch (error) {
    return {
      action: 'skipped',
      profile: owner,
      reason: `the runtime credential could not be read (${errnoCode(error) ?? 'unknown'})`,
    };
  }

  const inspected = inspectAuthBuffer(data);
  if (!inspected.ok || !inspected.summary) {
    // Never overwrite a good stored credential with a broken runtime one.
    return {
      action: 'skipped',
      profile: owner,
      reason: `the runtime credential is not usable: ${inspected.reason ?? 'unknown reason'}`,
    };
  }

  if (inspected.summary.fingerprint === state.runtimeAuthFingerprint) {
    return { action: 'noop', profile: owner };
  }

  ensureDir(accountDir(owner), { secret: true });
  writeFileAtomic(accountAuthPath(owner), data, { mode: 0o600, secret: true });
  writeState({ runtimeAuthFingerprint: inspected.summary.fingerprint });
  writeMetadata(owner, {
    authMode: inspected.summary.mode,
    accountIdSuffix: inspected.summary.accountIdSuffix,
    lastAuthSyncAt: new Date().toISOString(),
  });

  return { action: 'updated', profile: owner };
}

export interface MaterializeResult {
  profile: string;
  /** True when a credential was placed in the runtime; false when the profile has none. */
  authenticated: boolean;
  syncedBack: SyncResult;
}

/**
 * Make `slug`'s credential the one Codex will use.
 *
 * Must be called with the runtime lock held. Callers are also responsible for
 * checking that no Codex process is live, since a running process would keep
 * writing to the credential we are about to replace.
 */
export function materializeProfile(slug: string): MaterializeResult {
  ensureHomeLayout();
  ensureDir(runtimeHome());

  const syncedBack = syncRuntimeAuthBack();
  const state = readState();
  const source = accountAuthPath(slug);
  const target = runtimeAuthPath();

  if (!fileExists(source)) {
    // No stored credential: clear the runtime so Codex prompts for a login
    // rather than silently reusing the previous account.
    if (state.runtimeOwner !== slug) {
      rmSync(target, { force: true });
    } else if (fileExists(target)) {
      rmSync(target, { force: true });
    }
    writeState({ runtimeOwner: slug, runtimeAuthFingerprint: null });
    return { profile: slug, authenticated: false, syncedBack };
  }

  const data = readFileSync(source);
  const inspected = inspectAuthBuffer(data);
  if (!inspected.ok || !inspected.summary) {
    throw new CmaError(
      'AUTH_INVALID',
      `The stored credential for "${slug}" is not usable: ${inspected.reason ?? 'unknown reason'}.`,
      { hint: `Run \`cma relogin ${slug}\` to sign in again.` },
    );
  }

  copyFileAtomic(source, target, { mode: 0o600, secret: true });
  writeState({ runtimeOwner: slug, runtimeAuthFingerprint: inspected.summary.fingerprint });
  writeMetadata(slug, {
    authMode: inspected.summary.mode,
    accountIdSuffix: inspected.summary.accountIdSuffix,
  });

  return { profile: slug, authenticated: true, syncedBack };
}

/**
 * Remove the runtime credential without touching any profile.
 * Used before `codex login` so the flow starts from a clean slate.
 */
export function clearRuntimeAuth(newOwner: string): void {
  ensureDir(runtimeHome());
  rmSync(runtimeAuthPath(), { force: true });
  writeState({ runtimeOwner: newOwner, runtimeAuthFingerprint: null });
}

/** Delete a profile's stored credential, and the runtime copy if it owns it. */
export function forgetProfileAuth(slug: string): void {
  rmSync(accountAuthPath(slug), { force: true });
  const state = readState();
  if (state.runtimeOwner === slug) {
    rmSync(runtimeAuthPath(), { force: true });
    writeState({ runtimeAuthFingerprint: null });
  }
  writeMetadata(slug, {
    authMode: null,
    accountIdSuffix: null,
    lastAuthSyncAt: new Date().toISOString(),
  });
}
