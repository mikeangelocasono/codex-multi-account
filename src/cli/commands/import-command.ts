/**
 * `cma import` - adopt an existing Codex home.
 *
 * The source is treated as read-only. Sessions, config, skills and the thread
 * index are copied into the shared runtime; the credential found there becomes
 * a normal account. Running it twice copies only what is missing.
 */

import { join, resolve } from 'node:path';

import { CmaError } from '../../utils/errors.js';
import { coerceToSlug } from '../../security/validation.js';
import { looksLikeCodexHome } from '../../codex/codex-home.js';
import { inspectAuthFile, materializeProfile } from '../../accounts/auth-manager.js';
import {
  activeProfileSlug,
  createProfile,
  ensureHomeLayout,
  isAuthenticated,
  profileExists,
  writeMetadata,
  writeState,
} from '../../accounts/profile-store.js';
import { accountAuthPath, cmaHome, defaultCodexHome, runtimeHome } from '../../storage/paths.js';
import { copyFileAtomic, ensureDir } from '../../storage/atomic.js';
import { createBackup } from '../../storage/backup.js';
import { withRuntimeLock, assertNoActiveWriters } from '../../storage/locks.js';
import { formatBytes, planImport, previousImports, runImport } from '../../storage/migration.js';
import { codexVersion } from '../../codex/codex-cli.js';
import { hasFlag, optionValue, parseArgs } from '../args.js';
import { confirm } from '../prompt.js';
import { info, log, out, renderTable, style, success, warn } from '../ui.js';

export async function cmdImport(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, { valueOptions: ['from', 'profile', 'name'] });
  ensureHomeLayout();

  const source = resolve(optionValue(parsed, 'from') ?? defaultCodexHome());
  const includeSessions = !hasFlag(parsed, 'no-sessions');
  const includePlugins = !hasFlag(parsed, 'no-plugins');
  const force = hasFlag(parsed, 'force');
  const assumeYes = hasFlag(parsed, 'yes', 'y');
  const dryRun = hasFlag(parsed, 'dry-run');

  if (resolve(source) === resolve(cmaHome()) || resolve(source) === resolve(runtimeHome())) {
    throw new CmaError('INVALID_ARGUMENT', 'The source cannot be a codex-multi-account directory.', {
      hint: 'Point --from at your original Codex home, e.g. ~/.codex.',
    });
  }

  if (!looksLikeCodexHome(source)) {
    throw new CmaError('NOT_FOUND', `${source} does not look like a Codex home.`, {
      hint: 'Expected to find auth.json, config.toml, sessions/ or a state database there.\nPass a different directory with --from.',
    });
  }

  const plan = planImport({ source, includeSessions, includePlugins });
  const history = previousImports();

  log('');
  log(style.bold('Import plan'));
  log('');
  renderTable(
    [{ header: 'item' }, { header: 'size' }, { header: 'kind' }],
    plan.entries.map((entry) => [entry.name, formatBytes(entry.bytes), entry.kind]),
    log,
  );
  log('');
  info(`From: ${plan.source}`);
  info(`Into: ${plan.target}`);
  info(`Total: ${formatBytes(plan.totalBytes)}${includeSessions ? '' : ' (sessions excluded)'}`);
  if (includeSessions && plan.sessionBytes > 512 * 1024 * 1024) {
    warn(
      `Transcripts alone are ${formatBytes(plan.sessionBytes)}. Use --no-sessions to skip them if disk space is tight.`,
    );
  }
  const plugins = plan.entries.find((entry) => entry.name === 'plugins');
  if (plugins && plugins.bytes > 128 * 1024 * 1024) {
    warn(`Plugins are ${formatBytes(plugins.bytes)}. Use --no-plugins to skip them.`);
  }
  if (history.length > 0) {
    info(`Previously imported ${history.length} time(s); only missing files are copied.`);
  }
  info('Your original Codex home is never modified.');
  log('');

  if (dryRun) {
    if (hasFlag(parsed, 'json')) out(JSON.stringify(plan, null, 2));
    info('Dry run: nothing was copied.');
    return 0;
  }

  const proceed = await confirm('Continue?', { assumeYes });
  if (!proceed) {
    info('Import cancelled.');
    return 0;
  }

  const backup = createBackup('import');
  info(`Backup of the current runtime state: ${backup.path}`);

  const result = await runImport({
    plan,
    force,
    onProgress: (message) => info(message),
  });

  success(
    `Copied ${result.copiedFiles} file(s) (${formatBytes(result.copiedBytes)}), skipped ${result.skippedFiles} already present.`,
  );
  if (result.rolloutPathsRewritten > 0) {
    success(`Re-pointed ${result.rolloutPathsRewritten} thread(s) at the imported transcripts.`);
  }

  const authImported = importCredential(source, parsed.values.get('profile'), force);
  log('');
  if (authImported) {
    success(`Imported the existing credential as account "${authImported}".`);
    info(`Active account: ${activeProfileSlug() ?? 'none'}`);
  } else {
    info('No credential was imported; add accounts with `cma add <name>`.');
  }
  info('Check the result with:  cma sessions');
  log('');
  return 0;
}

/**
 * Adopt the credential found in the source home as an account.
 * Returns the slug, or null when there was nothing usable to import.
 */
function importCredential(source: string, requestedSlug: string | undefined, force: boolean): string | null {
  const sourceAuth = join(source, 'auth.json');
  const inspected = inspectAuthFile(sourceAuth);
  if (!inspected.ok || !inspected.summary) return null;

  const slug = coerceToSlug(requestedSlug ?? 'personal');

  if (profileExists(slug) && isAuthenticated(slug) && !force) {
    warn(`Account "${slug}" already has a credential; it was left untouched.`);
    warn('Re-run with --force to overwrite it, or pass --profile <name> to import under a new name.');
    return null;
  }

  if (!profileExists(slug)) {
    createProfile(slug, slug.charAt(0).toUpperCase() + slug.slice(1));
  }

  ensureDir(join(accountAuthPath(slug), '..'), { secret: true });
  copyFileAtomic(sourceAuth, accountAuthPath(slug), { mode: 0o600, secret: true });
  writeMetadata(slug, {
    authMode: inspected.summary.mode,
    accountIdSuffix: inspected.summary.accountIdSuffix,
    codexVersion: codexVersion().version,
    lastAuthSyncAt: new Date().toISOString(),
  });

  if (activeProfileSlug() === null) {
    withRuntimeLock(
      () => {
        assertNoActiveWriters('import an account');
        materializeProfile(slug);
        writeState({ activeProfile: slug });
      },
      { operation: `import:${slug}` },
    );
  }

  return slug;
}
