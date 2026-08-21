/**
 * Locating and describing the user's own Codex CLI.
 *
 * This tool never bundles, patches or replaces Codex. It finds whatever the
 * user installed and runs it as a child process.
 *
 * On Windows the entry on PATH is usually `codex.cmd`, a batch shim. Batch
 * files cannot be spawned without a shell, and a shell would mean building a
 * command string out of user-supplied arguments. Instead the npm layout is
 * walked to find the real `bin/codex.js`, which is executed with the current
 * Node binary - keeping every argument in an argv array.
 */

import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import { CmaError } from '../utils/errors.js';
import { capture } from '../utils/proc.js';

export interface CodexCommand {
  /** Executable to spawn. */
  command: string;
  /** Arguments that always come first (e.g. the path to `codex.js`). */
  prefixArgs: string[];
  /** The entry point that was discovered, for diagnostics. */
  resolvedPath: string;
  /** How it was found. */
  source: 'env' | 'path' | 'node-entry' | 'shell-shim';
}

const isWindows = process.platform === 'win32';

/** Entry points Node can execute directly, keeping the argv array intact. */
function isNodeScript(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathExtensions(): string[] {
  if (!isWindows) return [''];
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(delimiter)
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
}

/** Minimal `which`, with no shell and no dependency. */
export function whichCodex(name = 'codex'): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathValue.split(delimiter).filter((dir) => dir.length > 0);

  for (const dir of dirs) {
    if (isWindows) {
      for (const ext of pathExtensions()) {
        const candidate = join(dir, name + ext);
        if (isFile(candidate)) return candidate;
      }
    } else {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * From a shim such as `%APPDATA%\npm\codex.cmd`, find the package's JS entry.
 * npm puts the shim next to `node_modules/`; on POSIX it is one level up in
 * `lib/node_modules/`.
 */
function findNodeEntry(shimPath: string): string | null {
  const shimDir = dirname(shimPath);
  const candidates = [
    join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(shimDir, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(shimDir, '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  for (const candidate of candidates) {
    const full = resolve(candidate);
    if (isFile(full)) return full;
  }
  return null;
}

let cached: CodexCommand | null | undefined;

/** Resolve the Codex entry point, or throw an actionable error. */
export function resolveCodex(): CodexCommand {
  if (cached !== undefined) {
    if (cached === null) throw codexNotFound();
    return cached;
  }

  const override = process.env.CMA_CODEX_BIN;
  if (override && override.trim().length > 0) {
    const path = isAbsolute(override) ? override : resolve(override);
    if (!existsSync(path)) {
      cached = null;
      throw new CmaError('CODEX_NOT_FOUND', `CMA_CODEX_BIN points at ${path}, which does not exist.`, {
        hint: 'Unset CMA_CODEX_BIN to fall back to the `codex` on your PATH.',
      });
    }
    cached = isNodeScript(path)
      ? { command: process.execPath, prefixArgs: [path], resolvedPath: path, source: 'env' }
      : { command: path, prefixArgs: [], resolvedPath: path, source: 'env' };
    return cached;
  }

  const found = whichCodex();
  if (!found) {
    cached = null;
    throw codexNotFound();
  }

  const lower = found.toLowerCase();
  if (isNodeScript(found)) {
    cached = { command: process.execPath, prefixArgs: [found], resolvedPath: found, source: 'node-entry' };
    return cached;
  }

  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const entry = findNodeEntry(found);
    if (entry) {
      cached = {
        command: process.execPath,
        prefixArgs: [entry],
        resolvedPath: entry,
        source: 'node-entry',
      };
      return cached;
    }
    // Last resort: run the shim through the command processor. Arguments are
    // still passed as an argv array, so nothing is re-parsed as shell syntax
    // beyond what cmd.exe does for its own argument list.
    cached = {
      command: process.env.ComSpec ?? 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', found],
      resolvedPath: found,
      source: 'shell-shim',
    };
    return cached;
  }

  cached = { command: found, prefixArgs: [], resolvedPath: found, source: 'path' };
  return cached;
}

/** Test seam: forget the memoised lookup. */
export function resetCodexResolution(): void {
  cached = undefined;
}

function codexNotFound(): CmaError {
  return new CmaError('CODEX_NOT_FOUND', 'Codex CLI was not found.', {
    hint: [
      'Install Codex before using Codex Multi-Account:',
      '  npm install -g @openai/codex',
      '',
      'If it is installed somewhere unusual, point at it explicitly:',
      '  CMA_CODEX_BIN=/path/to/codex',
    ].join('\n'),
  });
}

export interface CodexVersion {
  raw: string;
  version: string | null;
}

let cachedVersion: CodexVersion | undefined;

/** `codex --version` prints e.g. `codex-cli 0.148.0`. */
export function codexVersion(): CodexVersion {
  if (cachedVersion) return cachedVersion;
  const codex = resolveCodex();
  const result = capture(codex.command, [...codex.prefixArgs, '--version'], { timeoutMs: 30_000 });
  const raw = `${result.stdout}${result.stderr}`.trim();
  const match = raw.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  cachedVersion = { raw, version: match?.[1] ?? null };
  return cachedVersion;
}

export function resetCodexVersion(): void {
  cachedVersion = undefined;
}
