/**
 * `cma doctor` - one screen that answers "where is everything, and what is wrong?".
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';

import { overview } from '../../accounts/account-manager.js';
import { codexVersion, resolveCodex } from '../../codex/codex-cli.js';
import { sqliteAvailable } from '../../codex/sqlite.js';
import { listSessions } from '../../codex/session-manager.js';
import { stateDbPath, threadHistoryDbPath } from '../../codex/codex-home.js';
import { permissionModel, permissionWarnings } from '../../security/permissions.js';
import { describeError } from '../../utils/errors.js';
import { cmaHome, defaultCodexHome, runtimeHome } from '../../storage/paths.js';
import { listBackups } from '../../storage/backup.js';
import { previousImports } from '../../storage/migration.js';
import { hasFlag, parseArgs } from '../args.js';
import { info, log, out, renderTable, style, success, warn } from '../ui.js';

export function cmdDoctor(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  const problems: string[] = [];
  const notes: string[] = [];

  let codexPath = 'not found';
  let version = 'unknown';
  try {
    codexPath = resolveCodex().resolvedPath;
    version = codexVersion().raw || 'unknown';
  } catch (error) {
    problems.push(describeError(error));
  }

  const state = overview();
  const runtime = runtimeHome();
  const runtimeExists = existsSync(runtime);
  const stateDb = runtimeExists ? stateDbPath(runtime) : null;
  const historyDb = runtimeExists ? threadHistoryDbPath(runtime) : null;

  let sessionCount = 0;
  try {
    sessionCount = listSessions({ includeArchived: true, includeSubagents: true }).length;
  } catch (error) {
    problems.push(`Could not read the session index: ${describeError(error)}`);
  }

  // A directory ACL without inheritable entries leaves new files unreadable on
  // Windows. It is invisible until Codex refuses to start, so check it here.
  const unreadable = unreadableRuntimeFiles(runtime);
  if (unreadable.length > 0) {
    problems.push(
      `Codex cannot read ${unreadable.join(', ')} in the shared runtime (permission denied). Repair with:\n` +
        `  icacls "${runtime}" /reset /T /C /Q`,
    );
  }

  if (state.profiles.length === 0) problems.push('No accounts are configured.');
  if (!state.active && state.profiles.length > 0) problems.push('No account is selected.');
  if (state.active && state.runtimeOwner && state.active !== state.runtimeOwner) {
    problems.push(
      `The active account is "${state.active}" but the runtime credential belongs to "${state.runtimeOwner}". Run \`cma use ${state.active}\`.`,
    );
  }
  if (!stateDb && sessionCount === 0) {
    notes.push('The shared runtime has no sessions yet. `cma import` can bring in an existing Codex home.');
  }
  if (process.env.CODEX_SQLITE_HOME) {
    notes.push(
      'CODEX_SQLITE_HOME is set in your environment; Codex will keep its databases there rather than in the shared runtime.',
    );
  }
  if (!sqliteAvailable()) {
    notes.push(
      'node:sqlite is unavailable, so session listings fall back to reading rollout files. Resume itself is unaffected.',
    );
  }

  const imports = previousImports();
  const payload = {
    version,
    codexPath,
    cmaHome: cmaHome(),
    runtimeHome: runtime,
    runtimeExists,
    stateDb,
    threadHistoryDb: historyDb,
    originalCodexHome: defaultCodexHome(),
    accounts: state.profiles.length,
    active: state.active,
    runtimeOwner: state.runtimeOwner,
    sessions: sessionCount,
    activeCodexProcesses: state.activeWriters.length,
    permissions: permissionModel(),
    backups: listBackups().slice(0, 5),
    lastImport: imports[imports.length - 1] ?? null,
    problems,
    notes: [...notes, ...permissionWarnings()],
  };

  if (hasFlag(parsed, 'json')) {
    out(JSON.stringify(payload, null, 2));
    return problems.length === 0 ? 0 : 1;
  }

  log('');
  log(style.bold('Codex Multi-Account doctor'));
  log('');
  renderTable(
    [{ header: 'item' }, { header: 'value' }],
    [
      ['codex', `${version}  ${style.dim(codexPath)}`],
      ['cma home', payload.cmaHome],
      ['shared runtime (CODEX_HOME)', payload.runtimeHome],
      ['thread index', stateDb ?? style.dim('none yet')],
      ['thread history', historyDb ?? style.dim('none yet')],
      ['your original codex home', payload.originalCodexHome],
      ['accounts', String(payload.accounts)],
      ['active account', payload.active ?? style.dim('none')],
      ['runtime credential owner', payload.runtimeOwner ?? style.dim('none')],
      ['sessions', String(sessionCount)],
      ['live codex processes', String(payload.activeCodexProcesses)],
      ['credential permissions', permissionModel().mode],
      ['backups', String(listBackups().length)],
    ],
    log,
  );
  log('');

  for (const note of payload.notes) info(note);
  for (const problem of problems) warn(problem);

  if (problems.length === 0) {
    success('No problems detected.');
    log('');
    return 0;
  }
  log('');
  return 1;
}

/** Where the runtime keeps a given file, for error messages elsewhere. */
export function runtimeFile(name: string): string {
  return join(runtimeHome(), name);
}

/** Files Codex reads at startup that this process cannot open. */
function unreadableRuntimeFiles(runtime: string): string[] {
  const broken: string[] = [];
  for (const name of ['config.toml', 'auth.json', 'AGENTS.md']) {
    const path = join(runtime, name);
    if (!existsSync(path)) continue;
    try {
      accessSync(path, constants.R_OK);
    } catch {
      broken.push(name);
    }
  }
  return broken;
}
