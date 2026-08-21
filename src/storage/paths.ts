/**
 * Every path codex-multi-account touches is derived here.
 *
 * Nothing in the codebase hard-codes `C:\Users\...` or `/home/...`: the root is
 * `os.homedir()` unless `CMA_HOME` overrides it, which is what the test suite
 * uses to run against a throwaway directory.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const APP_NAME = 'codex-multi-account';
export const APP_DIR_NAME = '.codex-multi-account';

/** Root of everything this tool owns. */
export function cmaHome(): string {
  const override = process.env.CMA_HOME;
  if (override && override.trim().length > 0) return resolve(override);
  return join(homedir(), APP_DIR_NAME);
}

/**
 * The `CODEX_HOME` handed to every Codex process this tool launches.
 *
 * This directory is shared by all profiles. It holds sessions, thread history,
 * config and skills. Only `auth.json` inside it is profile-specific, and it is
 * materialised from the active profile immediately before Codex starts.
 */
export function runtimeHome(): string {
  return join(cmaHome(), 'runtime');
}

export function runtimeAuthPath(): string {
  return join(runtimeHome(), 'auth.json');
}

export function runtimeConfigPath(): string {
  return join(runtimeHome(), 'config.toml');
}

export function runtimeSessionsDir(): string {
  return join(runtimeHome(), 'sessions');
}

export function accountsDir(): string {
  return join(cmaHome(), 'accounts');
}

export function accountDir(slug: string): string {
  return join(accountsDir(), slug);
}

export function accountAuthPath(slug: string): string {
  return join(accountDir(slug), 'auth.json');
}

export function accountMetadataPath(slug: string): string {
  return join(accountDir(slug), 'metadata.json');
}

/** Registry of profiles. Renaming and ordering live here. */
export function configPath(): string {
  return join(cmaHome(), 'config.json');
}

/** Which profile is active, and which profile owns the credential in `runtime/`. */
export function statePath(): string {
  return join(cmaHome(), 'state.json');
}

/** Guards mutations of the runtime credential. */
export function runtimeLockPath(): string {
  return join(cmaHome(), 'runtime.lock');
}

/** One file per live Codex process launched through this tool. */
export function writersDir(): string {
  return join(cmaHome(), 'locks', 'writers');
}

export function backupsDir(): string {
  return join(cmaHome(), 'backups');
}

export function importHistoryPath(): string {
  return join(cmaHome(), 'import-history.json');
}

/**
 * The Codex home the user had before installing this tool.
 * `CODEX_HOME` wins if the user already points Codex elsewhere.
 */
export function defaultCodexHome(): string {
  const override = process.env.CODEX_HOME;
  if (override && override.trim().length > 0) return resolve(override);
  return join(homedir(), '.codex');
}
