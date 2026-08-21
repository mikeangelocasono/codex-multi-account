/**
 * Process helpers.
 *
 * Everything here uses `spawn`/`spawnSync` with an argv array and
 * `shell: false`. No command string is ever assembled, so there is no path by
 * which a session id, profile name or forwarded flag can become shell syntax.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export interface CaptureResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxBuffer?: number;
}

/** Run a command to completion and capture its output. Never uses a shell. */
export function capture(
  command: string,
  args: readonly string[],
  options: CaptureOptions = {},
): CaptureResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true,
    shell: false,
    input: options.input,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? undefined,
  };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called once the child is running, so callers can start watchers. */
  onSpawn?: (pid: number | undefined) => void;
}

/**
 * Run an interactive child with inherited stdio and wait for it.
 *
 * SIGINT/SIGTERM/SIGHUP are forwarded rather than acted on: with inherited
 * stdio the child usually receives the console signal directly, and a parent
 * that exits first would orphan a Codex still holding the credential.
 */
export function runInteractive(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    windowsHide: false,
    shell: false,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], spawnOptions);
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    const forward = (signal: NodeJS.Signals) => () => {
      if (child.killed || child.exitCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        /* the child may already be gone */
      }
    };
    const handlers = signals.map((signal) => {
      const handler = forward(signal);
      process.on(signal, handler);
      return { signal, handler };
    });

    const cleanup = () => {
      for (const { signal, handler } of handlers) process.off(signal, handler);
    };

    child.on('error', (error) => {
      cleanup();
      reject(error);
    });

    child.on('spawn', () => options.onSpawn?.(child.pid));

    child.on('exit', (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}
