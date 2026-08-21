/**
 * Launching Codex under a selected account.
 *
 * The sequence matters:
 *
 *   lock -> refuse if another account's Codex is live -> materialise the
 *   credential -> register this process as a writer -> release the lock ->
 *   run Codex -> mirror credential changes while it runs -> mirror once more
 *   on exit -> deregister.
 *
 * Registration happens inside the lock so two launches on different accounts
 * cannot both pass the "is anything running?" check.
 */

import { unwatchFile, watchFile } from 'node:fs';

import { CmaError } from '../utils/errors.js';
import { assertSafeArgs } from '../security/validation.js';
import { runtimeAuthPath, runtimeHome } from '../storage/paths.js';
import { ensureDir } from '../storage/atomic.js';
import {
  assertNoActiveWriters,
  registerWriter,
  unregisterWriter,
  withRuntimeLock,
} from '../storage/locks.js';
import type { WriterRecord } from '../storage/locks.js';
import { materializeProfile, syncRuntimeAuthBack } from '../accounts/auth-manager.js';
import type { SyncResult } from '../accounts/auth-manager.js';
import { ensureHomeLayout, getProfile, writeMetadata } from '../accounts/profile-store.js';
import { codexVersion, resolveCodex } from './codex-cli.js';
import { runInteractive } from '../utils/proc.js';
import { warn } from '../cli/ui.js';

/** How often the runtime credential is polled for a refresh while Codex runs. */
const MIRROR_INTERVAL_MS = 1000;

export interface RunCodexOptions {
  /** Arguments forwarded to Codex verbatim. */
  args: readonly string[];
  profile: string;
  cwd?: string;
  /** Human label used in the writer registry and in error text. */
  label?: string;
  /** Set for `codex login`, where starting without a credential is the point. */
  allowMissingAuth?: boolean;
}

export interface RunCodexResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  /** What the final credential write-back did. */
  finalSync: SyncResult;
  authenticatedAtStart: boolean;
}

/** Build the environment Codex runs in. */
export function codexEnv(profile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_HOME: runtimeHome(),
    // Informational: lets hooks and scripts inside a session see which account
    // they are running under. Never contains credential material.
    CMA_ACTIVE_PROFILE: profile,
  };
}

/**
 * Run Codex with `profile`'s credential.
 *
 * Resolves with Codex's own exit code; the caller decides what to do with it.
 */
export async function runCodex(options: RunCodexOptions): Promise<RunCodexResult> {
  ensureHomeLayout();
  ensureDir(runtimeHome());

  const profile = getProfile(options.profile);
  const args = assertSafeArgs(options.args);
  const codex = resolveCodex();

  const setup = withRuntimeLock(
    (): { writer: WriterRecord; authenticated: boolean } => {
      assertNoActiveWriters('launch Codex under another account', profile.slug);
      const materialized = materializeProfile(profile.slug);
      reportSync(materialized.syncedBack);

      if (!materialized.authenticated && !options.allowMissingAuth) {
        throw new CmaError('AUTH_MISSING', `Account "${profile.slug}" is not authenticated.`, {
          hint: `Run:\n  cma login ${profile.slug}`,
        });
      }

      return {
        writer: registerWriter(profile.slug, options.label ?? 'codex'),
        authenticated: materialized.authenticated,
      };
    },
    { operation: `launch:${profile.slug}` },
  );

  writeMetadata(profile.slug, { lastUsedAt: new Date().toISOString() });

  const authFile = runtimeAuthPath();
  let mirroring = false;
  const mirror = (): void => {
    if (mirroring) return;
    mirroring = true;
    try {
      reportSync(syncRuntimeAuthBack());
    } catch (error) {
      // A failed mirror must not kill the user's Codex session; the sync on
      // exit gets another chance.
      warn(`Could not save the refreshed credential yet: ${(error as Error).message}`);
    } finally {
      mirroring = false;
    }
  };

  const finalize = (): SyncResult => {
    const sync = syncRuntimeAuthBack();
    reportSync(sync);
    return sync;
  };

  watchFile(authFile, { interval: MIRROR_INTERVAL_MS, persistent: false }, mirror);

  // If this process is killed outright, at least try to drop the registration.
  const exitHandler = (): void => unregisterWriter(setup.writer);
  process.once('exit', exitHandler);

  try {
    const result = await runInteractive(codex.command, [...codex.prefixArgs, ...args], {
      cwd: options.cwd,
      env: codexEnv(profile.slug),
    });

    return {
      exitCode: result.code ?? (result.signal ? 130 : 1),
      signal: result.signal,
      finalSync: finalize(),
      authenticatedAtStart: setup.authenticated,
    };
  } catch (error) {
    finalize();
    throw new CmaError('CODEX_FAILED', `Could not start Codex (${codex.resolvedPath}).`, {
      hint: `Check that it runs on its own:\n  codex --version\nDetected version: ${codexVersion().raw || 'unknown'}`,
      cause: error,
    });
  } finally {
    unwatchFile(authFile, mirror);
    process.off('exit', exitHandler);
    unregisterWriter(setup.writer);
  }
}

/** Surface credential events without ever printing credential contents. */
function reportSync(sync: SyncResult): void {
  if (sync.action === 'cleared' && sync.profile) {
    warn(
      `Account "${sync.profile}" was signed out inside Codex; its stored credential was removed.`,
    );
    return;
  }
  if (sync.action === 'skipped' && sync.profile) {
    warn(
      `Kept the stored credential for "${sync.profile}": ${sync.reason ?? 'the runtime copy was not usable'}.`,
    );
  }
}
