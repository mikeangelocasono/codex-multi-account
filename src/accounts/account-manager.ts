/**
 * Account lifecycle: add, sign in, switch, remove, health-check.
 *
 * Everything that mutates the runtime credential runs inside the runtime lock
 * and refuses to proceed while another account's Codex process is alive.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CmaError } from '../utils/errors.js';
import { capture } from '../utils/proc.js';
import { coerceToSlug } from '../security/validation.js';
import { redactText } from '../security/redact.js';
import { cmaHome, accountAuthPath, runtimeHome } from '../storage/paths.js';
import { copyFileAtomic, ensureDir, fileExists } from '../storage/atomic.js';
import { assertNoActiveWriters, listActiveWriters, withRuntimeLock } from '../storage/locks.js';
import { codexVersion, resolveCodex } from '../codex/codex-cli.js';
import { runCodex } from '../codex/codex-runner.js';
import {
  clearRuntimeAuth,
  forgetProfileAuth,
  inspectAuthFile,
  materializeProfile,
  syncRuntimeAuthBack,
} from './auth-manager.js';
import type { AuthSummary } from './auth-manager.js';
import {
  activeProfileSlug,
  createProfile,
  deleteProfile,
  ensureHomeLayout,
  getProfile,
  listProfiles,
  readState,
  writeMetadata,
  writeState,
} from './profile-store.js';
import type { Profile } from './profile-store.js';

export interface AddAccountOptions {
  /** Display name. Defaults to a title-cased form of the slug. */
  name?: string;
  /** Skip the interactive `codex login` (used by `cma import`). */
  skipLogin?: boolean;
}

function defaultDisplayName(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Create a profile. Does not sign in. */
export function createAccount(rawName: string, options: AddAccountOptions = {}): Profile {
  ensureHomeLayout();
  const slug = coerceToSlug(rawName);
  const profile = createProfile(slug, options.name ?? defaultDisplayName(slug));

  // The first account added becomes the active one, so `cma codex` works
  // immediately after `cma add`.
  if (activeProfileSlug() === null) writeState({ activeProfile: slug });
  return profile;
}

/**
 * Run the official `codex login` flow with the runtime pointed at `slug`.
 *
 * The credential is cleared first so a failed login cannot silently leave the
 * previous account's tokens in place and look like success.
 */
export async function loginAccount(
  slug: string,
  extraArgs: readonly string[] = [],
): Promise<{ ok: boolean; summary?: AuthSummary }> {
  const profile = getProfile(slug);

  withRuntimeLock(
    () => {
      assertNoActiveWriters('sign in to another account', profile.slug);
      // Persist whatever the current owner has before wiping the runtime copy.
      syncRuntimeAuthBack();
      clearRuntimeAuth(profile.slug);
    },
    { operation: `login:${profile.slug}` },
  );

  const result = await runCodex({
    args: ['login', ...extraArgs],
    profile: profile.slug,
    label: 'codex login',
    allowMissingAuth: true,
  });

  const inspected = inspectAuthFile(accountAuthPath(profile.slug));
  if (result.exitCode !== 0 && !inspected.ok) {
    return { ok: false };
  }
  if (!inspected.ok || !inspected.summary) {
    return { ok: false };
  }

  writeMetadata(profile.slug, {
    authMode: inspected.summary.mode,
    accountIdSuffix: inspected.summary.accountIdSuffix,
    codexVersion: codexVersion().version,
    lastAuthSyncAt: new Date().toISOString(),
  });

  return { ok: true, summary: inspected.summary };
}

/** Sign an account out, locally and (where Codex supports it) remotely. */
export async function logoutAccount(slug: string): Promise<void> {
  const profile = getProfile(slug);

  const wasMaterialized = readState().runtimeOwner === profile.slug;
  if (wasMaterialized && fileExists(accountAuthPath(profile.slug))) {
    // Let Codex revoke the session properly rather than only deleting the file.
    await runCodex({
      args: ['logout'],
      profile: profile.slug,
      label: 'codex logout',
      allowMissingAuth: true,
    });
  }

  withRuntimeLock(
    () => {
      assertNoActiveWriters('sign an account out', profile.slug);
      forgetProfileAuth(profile.slug);
    },
    { operation: `logout:${profile.slug}` },
  );
}

export interface UseAccountResult {
  profile: Profile;
  authenticated: boolean;
  previous: string | null;
}

/** Make `slug` the active account and materialise its credential. */
export function useAccount(slug: string): UseAccountResult {
  ensureHomeLayout();
  const profile = getProfile(slug);
  const previous = activeProfileSlug();

  const authenticated = withRuntimeLock(
    () => {
      assertNoActiveWriters('switch accounts');
      const result = materializeProfile(profile.slug);
      writeState({ activeProfile: profile.slug });
      return result.authenticated;
    },
    { operation: `use:${profile.slug}` },
  );

  writeMetadata(profile.slug, { lastUsedAt: new Date().toISOString() });
  return { profile: getProfile(profile.slug), authenticated, previous };
}

export interface RemoveAccountOptions {
  force?: boolean;
}

export function removeAccount(slug: string, options: RemoveAccountOptions = {}): void {
  const profile = getProfile(slug);

  withRuntimeLock(
    () => {
      assertNoActiveWriters('remove an account');
      if (!options.force && profile.authenticated) {
        throw new CmaError(
          'CONFLICT',
          `Account "${profile.slug}" still has a stored credential.`,
          {
            hint: `Sign it out first:\n  cma logout ${profile.slug}\nOr delete it and its credential in one step:\n  cma remove ${profile.slug} --force`,
          },
        );
      }
      // Flush any pending refresh before the profile disappears.
      syncRuntimeAuthBack();
      deleteProfile(profile.slug);
    },
    { operation: `remove:${profile.slug}` },
  );

  // Keep a usable active account if the removed one was selected.
  if (activeProfileSlug() === null) {
    const remaining = listProfiles();
    const next = remaining.find((candidate) => candidate.authenticated) ?? remaining[0];
    if (next) writeState({ activeProfile: next.slug });
  }
}

export interface HealthReport {
  slug: string;
  name: string;
  hasCredential: boolean;
  /** Local structural check. */
  valid: boolean;
  reason?: string;
  summary?: AuthSummary;
  /** Result of asking Codex itself, when `deep` was requested. */
  codexStatus?: { ok: boolean; message: string };
  active: boolean;
  runtimeOwner: boolean;
}

/**
 * Check a profile without exposing its credential.
 *
 * The deep check copies the credential into a throwaway `CODEX_HOME` and asks
 * Codex for its own verdict, so validation never depends on this tool parsing
 * tokens it should not be reading.
 */
export function checkAccount(slug: string, options: { deep?: boolean } = {}): HealthReport {
  const profile = getProfile(slug);
  const state = readState();
  const authPath = accountAuthPath(profile.slug);
  const inspected = inspectAuthFile(authPath);

  const report: HealthReport = {
    slug: profile.slug,
    name: profile.name,
    hasCredential: fileExists(authPath),
    valid: inspected.ok,
    reason: inspected.reason,
    summary: inspected.summary,
    active: state.activeProfile === profile.slug,
    runtimeOwner: state.runtimeOwner === profile.slug,
  };

  if (options.deep && inspected.ok) {
    report.codexStatus = probeWithCodex(authPath);
  }
  return report;
}

/** Ask Codex whether a credential is usable, in an isolated CODEX_HOME. */
function probeWithCodex(authPath: string): { ok: boolean; message: string } {
  ensureDir(join(cmaHome(), '.probe'), { secret: true });
  const probe = mkdtempSync(join(cmaHome(), '.probe', 'check-'));
  try {
    copyFileAtomic(authPath, join(probe, 'auth.json'), { mode: 0o600, secret: true });
    const codex = resolveCodex();
    const result = capture(codex.command, [...codex.prefixArgs, 'login', 'status'], {
      env: { ...process.env, CODEX_HOME: probe },
      timeoutMs: 60_000,
    });
    const message = redactText(`${result.stdout}${result.stderr}`.trim()) || 'no output';
    return { ok: result.status === 0, message };
  } catch (error) {
    return { ok: false, message: redactText((error as Error).message) };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

export interface Overview {
  profiles: Profile[];
  active: string | null;
  runtimeOwner: string | null;
  runtimeHome: string;
  activeWriters: ReturnType<typeof listActiveWriters>;
}

export function overview(): Overview {
  ensureHomeLayout();
  const state = readState();
  return {
    profiles: listProfiles(),
    active: activeProfileSlug(),
    runtimeOwner: state.runtimeOwner,
    runtimeHome: runtimeHome(),
    activeWriters: listActiveWriters(),
  };
}

/**
 * The account a command should act on.
 * Throws with guidance rather than guessing when nothing is selected.
 */
export function requireActiveProfile(): Profile {
  const slug = activeProfileSlug();
  if (!slug) {
    const profiles = listProfiles();
    throw new CmaError('NOT_FOUND', 'No account is selected.', {
      hint:
        profiles.length === 0
          ? 'Add one first:\n  cma add personal'
          : `Pick one:\n  cma use ${profiles[0]!.slug}`,
    });
  }
  return getProfile(slug);
}
