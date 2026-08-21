/**
 * Persistence for the profile registry and the runtime pointer.
 *
 * Two files, two responsibilities:
 *
 *   config.json  - which profiles exist, and what they are called.
 *   state.json   - which profile is active, and which profile's credential is
 *                  currently materialised in `runtime/auth.json`.
 *
 * They are deliberately separate. `runtimeOwner` must survive a crash even if
 * the registry is edited by hand, because it is what stops a token refresh
 * from being written back to the wrong account.
 */

import { rmSync } from 'node:fs';

import { CmaError } from '../utils/errors.js';
import { assertValidSlug, truncateForDisplay } from '../security/validation.js';
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from '../storage/atomic.js';
import {
  accountAuthPath,
  accountDir,
  accountMetadataPath,
  accountsDir,
  cmaHome,
  configPath,
  runtimeHome,
  statePath,
  writersDir,
} from '../storage/paths.js';

export const CONFIG_VERSION = 1;

export interface ProfileEntry {
  /** Human-facing label. Free text; the slug is the identifier. */
  name: string;
  createdAt: string;
  /** Display order in the picker. Stable across renames. */
  order: number;
}

export interface CmaConfig {
  version: number;
  profiles: Record<string, ProfileEntry>;
}

export interface CmaState {
  version: number;
  /** Profile selected by the user. `null` before the first profile is added. */
  activeProfile: string | null;
  /** Profile whose credential currently sits in `runtime/auth.json`. */
  runtimeOwner: string | null;
  /** Fingerprint of that credential, so a refresh can be detected. */
  runtimeAuthFingerprint: string | null;
  updatedAt: string;
}

export interface ProfileMetadata {
  slug: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastAuthSyncAt: string | null;
  /** `chatgpt`, `apikey`, or null when the profile has never been logged in. */
  authMode: string | null;
  /** Tail of the ChatGPT account id. Enough to tell accounts apart, useless as a credential. */
  accountIdSuffix: string | null;
  /** Codex version present when the credential was last written. */
  codexVersion: string | null;
}

export interface Profile extends ProfileEntry {
  slug: string;
  metadata: ProfileMetadata;
  /** Does this profile have a credential on disk? */
  authenticated: boolean;
}

const emptyConfig = (): CmaConfig => ({ version: CONFIG_VERSION, profiles: {} });

const emptyState = (): CmaState => ({
  version: CONFIG_VERSION,
  activeProfile: null,
  runtimeOwner: null,
  runtimeAuthFingerprint: null,
  updatedAt: new Date().toISOString(),
});

/** Create the directory skeleton. Safe to call repeatedly. */
export function ensureHomeLayout(): void {
  ensureDir(cmaHome());
  ensureDir(runtimeHome());
  ensureDir(accountsDir(), { secret: true });
  ensureDir(writersDir());
}

export function readConfig(): CmaConfig {
  const raw = readJsonFile<Partial<CmaConfig>>(configPath());
  if (!raw) return emptyConfig();

  if (typeof raw.profiles !== 'object' || raw.profiles === null) {
    throw new CmaError('STATE_CORRUPT', `${configPath()} is missing its "profiles" object.`, {
      hint: 'Delete the file to start from an empty registry. Credentials under accounts/ are untouched.',
    });
  }

  const profiles: Record<string, ProfileEntry> = {};
  let order = 0;
  for (const [slug, entry] of Object.entries(raw.profiles)) {
    // A hand-edited or hostile registry must not be able to point at a path
    // outside accounts/, so slugs are re-validated on read.
    assertValidSlug(slug, 'Profile key in config.json');
    const value = entry as Partial<ProfileEntry> | undefined;
    order += 1;
    profiles[slug] = {
      name: typeof value?.name === 'string' && value.name.length > 0 ? value.name : slug,
      createdAt:
        typeof value?.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
      order: typeof value?.order === 'number' ? value.order : order,
    };
  }

  return { version: typeof raw.version === 'number' ? raw.version : CONFIG_VERSION, profiles };
}

export function writeConfig(config: CmaConfig): void {
  ensureHomeLayout();
  writeJsonFile(configPath(), config, { mode: 0o600 });
}

export function readState(): CmaState {
  const raw = readJsonFile<Partial<CmaState>>(statePath());
  if (!raw) return emptyState();

  const coerceSlug = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length === 0) return null;
    assertValidSlug(value, 'Profile reference in state.json');
    return value;
  };

  return {
    version: typeof raw.version === 'number' ? raw.version : CONFIG_VERSION,
    activeProfile: coerceSlug(raw.activeProfile),
    runtimeOwner: coerceSlug(raw.runtimeOwner),
    runtimeAuthFingerprint:
      typeof raw.runtimeAuthFingerprint === 'string' ? raw.runtimeAuthFingerprint : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export function writeState(patch: Partial<Omit<CmaState, 'version' | 'updatedAt'>>): CmaState {
  ensureHomeLayout();
  const next: CmaState = {
    ...readState(),
    ...patch,
    version: CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(statePath(), next, { mode: 0o600 });
  return next;
}

const emptyMetadata = (slug: string, name: string): ProfileMetadata => ({
  slug,
  name,
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
  lastAuthSyncAt: null,
  authMode: null,
  accountIdSuffix: null,
  codexVersion: null,
});

export function readMetadata(slug: string, fallbackName?: string): ProfileMetadata {
  const raw = readJsonFile<Partial<ProfileMetadata>>(accountMetadataPath(slug));
  const base = emptyMetadata(slug, fallbackName ?? slug);
  if (!raw) return base;
  return {
    slug,
    name: typeof raw.name === 'string' ? raw.name : base.name,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt,
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
    lastAuthSyncAt: typeof raw.lastAuthSyncAt === 'string' ? raw.lastAuthSyncAt : null,
    authMode: typeof raw.authMode === 'string' ? raw.authMode : null,
    accountIdSuffix: typeof raw.accountIdSuffix === 'string' ? raw.accountIdSuffix : null,
    codexVersion: typeof raw.codexVersion === 'string' ? raw.codexVersion : null,
  };
}

export function writeMetadata(slug: string, patch: Partial<ProfileMetadata>): ProfileMetadata {
  assertValidSlug(slug);
  ensureDir(accountDir(slug), { secret: true });
  const next: ProfileMetadata = { ...readMetadata(slug), ...patch, slug };
  writeJsonFile(accountMetadataPath(slug), next, { mode: 0o600 });
  return next;
}

export function profileExists(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(readConfig().profiles, slug);
}

export function isAuthenticated(slug: string): boolean {
  return fileExists(accountAuthPath(slug));
}

export function listProfiles(): Profile[] {
  const config = readConfig();
  return Object.entries(config.profiles)
    .map(([slug, entry]) => ({
      slug,
      ...entry,
      metadata: readMetadata(slug, entry.name),
      authenticated: isAuthenticated(slug),
    }))
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

export function getProfile(slug: string): Profile {
  const config = readConfig();
  const entry = config.profiles[slug];
  if (!entry) {
    const known = Object.keys(config.profiles);
    throw new CmaError('NOT_FOUND', `There is no account named "${truncateForDisplay(slug)}".`, {
      hint:
        known.length > 0
          ? `Known accounts: ${known.join(', ')}\nAdd one with \`cma add ${truncateForDisplay(slug, 24)}\`.`
          : 'You have no accounts yet. Add one with `cma add personal`.',
    });
  }
  return {
    slug,
    ...entry,
    metadata: readMetadata(slug, entry.name),
    authenticated: isAuthenticated(slug),
  };
}

export function createProfile(slug: string, name: string): Profile {
  assertValidSlug(slug);
  const config = readConfig();
  if (config.profiles[slug]) {
    throw new CmaError('CONFLICT', `An account named "${slug}" already exists.`, {
      hint: `Use \`cma relogin ${slug}\` to sign in again, or pick a different name.`,
    });
  }

  const order = Object.values(config.profiles).reduce((max, p) => Math.max(max, p.order), 0) + 1;
  config.profiles[slug] = { name, createdAt: new Date().toISOString(), order };
  writeConfig(config);

  ensureDir(accountDir(slug), { secret: true });
  writeMetadata(slug, { name, createdAt: config.profiles[slug].createdAt });

  return getProfile(slug);
}

export function renameProfile(slug: string, name: string): Profile {
  const config = readConfig();
  const entry = config.profiles[slug];
  if (!entry) return getProfile(slug); // throws with a helpful message
  entry.name = name;
  writeConfig(config);
  writeMetadata(slug, { name });
  return getProfile(slug);
}

/**
 * Remove a profile and its credential.
 *
 * The runtime credential is only cleared when the removed profile owns it -
 * otherwise another account's live session would lose its tokens.
 */
export function deleteProfile(slug: string): void {
  const config = readConfig();
  if (!config.profiles[slug]) return;
  delete config.profiles[slug];
  writeConfig(config);

  const state = readState();
  const patch: Partial<CmaState> = {};
  if (state.activeProfile === slug) patch.activeProfile = null;
  if (state.runtimeOwner === slug) {
    patch.runtimeOwner = null;
    patch.runtimeAuthFingerprint = null;
  }
  if (Object.keys(patch).length > 0) writeState(patch);

  rmSync(accountDir(slug), { recursive: true, force: true });
}

export function activeProfileSlug(): string | null {
  const state = readState();
  if (!state.activeProfile) return null;
  // A profile can be removed out from under the pointer.
  return profileExists(state.activeProfile) ? state.activeProfile : null;
}
