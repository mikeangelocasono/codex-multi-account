/**
 * Command router.
 *
 * Sub-commands that forward to Codex receive their arguments completely
 * untouched, so `cma codex --help` shows Codex's help rather than this one.
 */

import { CmaError, describeError, isCmaError } from '../utils/errors.js';
import { ensureHomeLayout } from '../accounts/profile-store.js';
import { syncRuntimeAuthBack } from '../accounts/auth-manager.js';
import { listActiveWriters } from '../storage/locks.js';
import { ENV_HELP, USAGE } from './help.js';
import { failure, log, out, style } from './ui.js';
import { runInteractiveMenu } from './interactive.js';
import {
  cmdAdd,
  cmdCurrent,
  cmdInfo,
  cmdList,
  cmdLogin,
  cmdLogout,
  cmdRemove,
  cmdRename,
  cmdUse,
} from './commands/account-commands.js';
import {
  cmdCodex,
  cmdResume,
  cmdSessions,
  cmdSwitch,
  cmdSwitchResume,
} from './commands/codex-commands.js';
import { cmdCheck } from './commands/check-command.js';
import { cmdDoctor } from './commands/doctor-command.js';
import { cmdImport } from './commands/import-command.js';

export const VERSION = '1.0.0';

const HELP_FLAGS = new Set(['-h', '--help', 'help']);
const VERSION_FLAGS = new Set(['-V', '--version', 'version']);

/**
 * Commands that must not have their arguments interpreted here.
 * Everything after the sub-command belongs to Codex.
 */
const PASSTHROUGH = new Set(['codex', 'resume', 'exec']);

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    ensureHomeLayout();
    reconcileOnStart();
    return runInteractiveMenu();
  }

  if (HELP_FLAGS.has(command)) {
    out(USAGE);
    out(ENV_HELP);
    return 0;
  }

  if (VERSION_FLAGS.has(command)) {
    out(VERSION);
    return 0;
  }

  ensureHomeLayout();
  if (!PASSTHROUGH.has(command)) reconcileOnStart();

  switch (command) {
    case 'add':
      return cmdAdd(rest);
    case 'login':
    case 'relogin':
      return cmdLogin(rest);
    case 'logout':
      return cmdLogout(rest);
    case 'list':
    case 'ls':
      return cmdList(rest);
    case 'use':
    case 'select':
      return cmdUse(rest);
    case 'current':
    case 'active':
      return cmdCurrent(rest);
    case 'info':
    case 'show':
      return cmdInfo(rest);
    case 'rename':
      return cmdRename(rest);
    case 'remove':
    case 'rm':
    case 'delete':
      return cmdRemove(rest);
    case 'check':
      return cmdCheck(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'import':
      return cmdImport(rest);
    case 'codex':
    case 'run':
      return cmdCodex(rest);
    case 'exec':
      return cmdCodex(['exec', ...rest]);
    case 'resume':
      return cmdResume(rest);
    case 'sessions':
      return cmdSessions(rest);
    case 'switch':
      return cmdSwitch(rest);
    case 'sr':
      return cmdSwitchResume(rest);
    default:
      throw new CmaError('INVALID_ARGUMENT', `Unknown command "${command}".`, {
        hint: 'Run `cma help` to see the available commands.',
        exitCode: 2,
      });
  }
}

/**
 * Catch up on anything a previous run left behind.
 *
 * If Codex refreshed its token and the process died before the mirror ran, the
 * runtime credential is newer than the profile's. Reconciling here means the
 * very next command repairs it, rather than the change being lost at the next
 * account switch.
 */
function reconcileOnStart(): void {
  try {
    if (listActiveWriters().length > 0) return; // a live session owns the file
    syncRuntimeAuthBack();
  } catch {
    // Reconciliation is opportunistic; a failure here must not block the
    // command the user actually asked for.
  }
}

/** Entry point used by bin/cma.js. */
export async function run(argv: readonly string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (error) {
    failure(describeError(error));
    if (isCmaError(error) && error.hint) {
      log('');
      log(style.dim(error.hint));
      log('');
    }
    return isCmaError(error) ? error.exitCode : 1;
  }
}
