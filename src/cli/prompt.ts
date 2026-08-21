/**
 * Terminal prompts.
 *
 * Prompts read from stdin and write to stderr, so a piped `cma list` is never
 * polluted. When stdin is not a terminal every prompt refuses rather than
 * silently choosing for the user - except where an explicit `--yes` was given.
 *
 * Nothing here ever asks for a password. Signing in is always delegated to
 * `codex login`, which opens the official browser flow.
 */

import { createInterface } from 'node:readline';
import { emitKeypressEvents } from 'node:readline';

import { CmaError } from '../utils/errors.js';

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function question(text: string): Promise<string> {
  if (!isInteractive()) {
    throw new CmaError('INVALID_ARGUMENT', 'This command needs an interactive terminal.', {
      hint: 'Pass the value as an argument instead, or run the command from a terminal.',
    });
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => rl.question(text, resolve));
  } finally {
    rl.close();
  }
}

export async function confirm(text: string, options: { assumeYes?: boolean } = {}): Promise<boolean> {
  if (options.assumeYes) return true;
  if (!isInteractive()) {
    throw new CmaError('USER_ABORTED', 'Confirmation is required but the terminal is not interactive.', {
      hint: 'Re-run with --yes to confirm without a prompt.',
    });
  }
  const answer = (await question(`${text} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export interface MenuAction {
  key: string;
  label: string;
  hidden?: boolean;
}

export interface KeyEvent {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

/**
 * Wait for a single keypress.
 *
 * Raw mode is restored in `finally` so a thrown error cannot leave the
 * terminal unusable.
 */
export function readKey(): Promise<KeyEvent> {
  if (!isInteractive()) {
    return Promise.reject(
      new CmaError('INVALID_ARGUMENT', 'The interactive menu needs a terminal.', {
        hint: 'Use the non-interactive commands instead, for example `cma list`.',
      }),
    );
  }

  const stdin = process.stdin;
  emitKeypressEvents(stdin);
  const hadRawMode = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<KeyEvent>((resolve) => {
    const onKey = (_str: string, key: KeyEvent) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(hadRawMode);
      stdin.pause();
      resolve(key ?? {});
    };
    stdin.on('keypress', onKey);
  });
}
