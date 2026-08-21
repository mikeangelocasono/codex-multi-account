/**
 * The default screen: a numbered account list plus single-key actions.
 *
 * It loops. After Codex exits you land back here, which is what makes the
 * "work under one account, exit, switch, resume" flow a couple of keystrokes
 * rather than three commands.
 */

import { CmaError, describeError } from '../utils/errors.js';
import { overview, createAccount, loginAccount, removeAccount, useAccount } from '../accounts/account-manager.js';
import type { Overview } from '../accounts/account-manager.js';
import { coerceToSlug } from '../security/validation.js';
import { runCodex } from '../codex/codex-runner.js';
import { latestSession, listSessions } from '../codex/session-manager.js';
import { cmdSessions } from './commands/codex-commands.js';
import { cmdInfo } from './commands/account-commands.js';
import { confirm, isInteractive, question, readKey } from './prompt.js';
import { failure, info, log, relativeDay, safe, shortenPath, style, success, warn } from './ui.js';

const ACTIONS = [
  { key: 'Enter', label: 'Launch Codex' },
  { key: 'S', label: 'Switch account' },
  { key: 'A', label: 'Add account' },
  { key: 'R', label: 'Resume session' },
  { key: 'L', label: 'List sessions' },
  { key: 'D', label: 'Remove account' },
  { key: 'I', label: 'Account info' },
  { key: 'Q', label: 'Quit' },
];

function render(state: Overview): void {
  log('');
  log(style.bold(style.white('Codex Multi-Account')));
  log('');

  log(style.dim('Active account:'));
  const active = state.profiles.find((profile) => profile.slug === state.active);
  if (active) {
    log(`${style.green('*')} ${style.bold(active.name)} ${style.dim(`(${active.slug})`)}`);
  } else {
    log(`${style.yellow('!')} ${style.yellow('none selected')}`);
  }
  log('');

  log(style.dim('Accounts:'));
  log('');
  if (state.profiles.length === 0) {
    log(`  ${style.dim('none yet - press [A] to add one')}`);
  }
  state.profiles.forEach((profile, index) => {
    const marker = profile.slug === state.active ? style.green('  <- active') : '';
    const needsLogin = profile.authenticated ? '' : style.yellow('  needs login');
    log(`  ${index + 1}. ${style.white(safe(profile.name, 28))}${marker}${needsLogin}`);
  });
  log('');

  if (state.activeWriters.length > 0) {
    for (const writer of state.activeWriters) {
      warn(`Codex is running under "${writer.profile}" (pid ${writer.pid}). Exit it before switching.`);
    }
    log('');
  }

  log(style.dim('Actions:'));
  log('');
  for (const action of ACTIONS) {
    log(`  ${style.cyan(`[${action.key}]`)} ${action.label}`);
  }
  log('');
}

export async function runInteractiveMenu(): Promise<number> {
  if (!isInteractive()) {
    throw new CmaError('INVALID_ARGUMENT', 'The interactive menu needs a terminal.', {
      hint: 'Try `cma list`, `cma use <name>` or `cma codex` instead.',
    });
  }

  for (;;) {
    const state = overview();
    render(state);
    log(style.dim('  Press a key, or a number to switch account.'));

    let key;
    try {
      key = await readKey();
    } catch (error) {
      failure(describeError(error));
      return 1;
    }

    if (key.ctrl && key.name === 'c') return 130;
    const name = (key.name ?? '').toLowerCase();
    const sequence = key.sequence ?? '';

    try {
      if (name === 'return' || name === 'enter') {
        const code = await launch(state);
        if (code !== 0) warn(`Codex exited with code ${code}.`);
        continue;
      }

      if (/^[1-9]$/.test(sequence)) {
        await selectByIndex(state, Number.parseInt(sequence, 10));
        continue;
      }

      switch (name) {
        case 'q':
        case 'escape':
          log('');
          return 0;
        case 's':
          await switchFlow(state);
          break;
        case 'a':
          await addFlow();
          break;
        case 'r':
          await resumeFlow(state);
          break;
        case 'l':
          cmdSessions([]);
          await pause();
          break;
        case 'd':
          await removeFlow(state);
          break;
        case 'i':
          if (state.active) cmdInfo([state.active]);
          else warn('No account is selected.');
          await pause();
          break;
        default:
          break;
      }
    } catch (error) {
      failure(describeError(error));
      if (error instanceof CmaError && error.hint) log(style.dim(error.hint));
      await pause();
    }
  }
}

async function pause(): Promise<void> {
  log(style.dim('  Press any key to continue.'));
  await readKey();
}

async function launch(state: Overview): Promise<number> {
  if (!state.active) {
    warn('No account is selected. Press [S] to pick one, or [A] to add one.');
    await pause();
    return 0;
  }
  const result = await runCodex({ args: [], profile: state.active, label: 'codex' });
  return result.exitCode;
}

async function selectByIndex(state: Overview, index: number): Promise<void> {
  const profile = state.profiles[index - 1];
  if (!profile) {
    warn(`There is no account ${index}.`);
    await pause();
    return;
  }
  const result = useAccount(profile.slug);
  success(`Active account: ${result.profile.name} (${result.profile.slug})`);
  if (!result.authenticated) {
    warn('This account is not signed in.');
    const shouldLogin = await confirm('Sign in now?');
    if (shouldLogin) await loginAccount(profile.slug);
  }
}

async function switchFlow(state: Overview): Promise<void> {
  if (state.profiles.length === 0) {
    warn('No accounts yet. Press [A] to add one.');
    await pause();
    return;
  }
  const answer = (await question('  Account number or name: ')).trim();
  if (answer.length === 0) return;

  if (/^\d+$/.test(answer)) {
    await selectByIndex(state, Number.parseInt(answer, 10));
    return;
  }
  const result = useAccount(coerceToSlug(answer));
  success(`Active account: ${result.profile.name} (${result.profile.slug})`);
}

async function addFlow(): Promise<void> {
  const answer = (await question('  New account name (e.g. work): ')).trim();
  if (answer.length === 0) {
    info('Cancelled.');
    return;
  }
  const profile = createAccount(answer);
  success(`Created "${profile.slug}".`);
  info('Codex will open your browser to sign in.');
  const result = await loginAccount(profile.slug);
  if (result.ok) success(`"${profile.slug}" is signed in.`);
  else warn(`"${profile.slug}" was created but is not signed in.`);
}

async function resumeFlow(state: Overview): Promise<void> {
  if (!state.active) {
    warn('No account is selected.');
    await pause();
    return;
  }

  const sessions = listSessions({ limit: 9 });
  if (sessions.length === 0) {
    warn('No sessions to resume yet.');
    await pause();
    return;
  }

  log('');
  log(style.dim('  Recent sessions:'));
  log('');
  sessions.forEach((session, index) => {
    log(
      `  ${index + 1}. ${style.dim(session.id.slice(0, 8))}  ${shortenPath(session.cwd || '-', 24)}  ${style.dim(relativeDay(session.updatedAt))}  ${safe(session.title, 36)}`,
    );
  });
  log('');
  const answer = (await question('  Session number, id, or blank for the Codex picker: ')).trim();

  const chosen =
    /^[1-9]$/.test(answer) && sessions[Number.parseInt(answer, 10) - 1]
      ? sessions[Number.parseInt(answer, 10) - 1]!.id
      : answer.length > 0
        ? answer
        : null;

  const args = chosen ? ['resume', chosen] : ['resume'];
  const result = await runCodex({ args, profile: state.active, label: 'codex resume' });
  if (result.exitCode !== 0) warn(`Codex exited with code ${result.exitCode}.`);
}

async function removeFlow(state: Overview): Promise<void> {
  if (state.profiles.length === 0) {
    warn('No accounts to remove.');
    await pause();
    return;
  }
  const answer = (await question('  Account number or name to remove: ')).trim();
  if (answer.length === 0) return;

  const profile = /^\d+$/.test(answer)
    ? state.profiles[Number.parseInt(answer, 10) - 1]
    : state.profiles.find((candidate) => candidate.slug === coerceToSlug(answer));

  if (!profile) {
    warn('No such account.');
    await pause();
    return;
  }

  const ok = await confirm(`  Delete "${profile.slug}" and its stored credential?`);
  if (!ok) {
    info('Left unchanged.');
    return;
  }
  removeAccount(profile.slug, { force: true });
  success(`Removed "${profile.slug}".`);
}

/** Exposed for the resume shortcut used by `cma sr`. */
export function newestSessionId(): string | null {
  return latestSession()?.id ?? null;
}
