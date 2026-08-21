/**
 * Library surface.
 *
 * The CLI is the product, but the pieces are exported so the test suite (and
 * anyone embedding this) can drive account management without spawning a
 * process.
 */

export { run, main, VERSION } from './cli/main.js';

export {
  createAccount,
  loginAccount,
  logoutAccount,
  useAccount,
  removeAccount,
  checkAccount,
  overview,
  requireActiveProfile,
} from './accounts/account-manager.js';

export {
  materializeProfile,
  syncRuntimeAuthBack,
  inspectAuthFile,
  inspectAuthBuffer,
  forgetProfileAuth,
  clearRuntimeAuth,
} from './accounts/auth-manager.js';

export {
  listProfiles,
  getProfile,
  createProfile,
  deleteProfile,
  readState,
  writeState,
  readConfig,
  writeConfig,
  activeProfileSlug,
  ensureHomeLayout,
} from './accounts/profile-store.js';

export { runCodex, codexEnv } from './codex/codex-runner.js';
export { resolveCodex, codexVersion, whichCodex } from './codex/codex-cli.js';
export { listSessions, findSession, latestSession, rewriteRolloutPaths } from './codex/session-manager.js';
export { SHARED_STATE, PROFILE_STATE, TRANSIENT_STATE } from './codex/codex-home.js';

export {
  withRuntimeLock,
  listActiveWriters,
  registerWriter,
  unregisterWriter,
  assertNoActiveWriters,
  isProcessAlive,
} from './storage/locks.js';

export { planImport, runImport, previousImports } from './storage/migration.js';
export { createBackup, listBackups } from './storage/backup.js';
export * as paths from './storage/paths.js';

export { CmaError, describeError } from './utils/errors.js';
export { slugify, isValidSlug, assertValidSlug, coerceToSlug } from './security/validation.js';
export { redactJson, redactText, fingerprint, maskTail } from './security/redact.js';
