/**
 * Restrictive permissions for credential files.
 *
 * POSIX gets `chmod`. Windows has no mode bits, so the equivalent is an ACL
 * that removes inheritance and grants the current user only - applied with
 * `icacls` through an argv array, never a shell string.
 *
 * Every operation here is best-effort: a filesystem that cannot express the
 * permission (FAT32, a network share, WSL interop) must not break the tool.
 * Failures are recorded so `cma check` can report them.
 */

import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

const warnings: string[] = [];

export function permissionWarnings(): readonly string[] {
  return warnings;
}

function note(message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

/** Best-effort 0600 (owner read/write only). */
export function applyFilePermissions(path: string): void {
  if (isWindows) {
    restrictWindowsAcl(path, 'file');
    return;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    note(`Could not set 0600 permissions on ${path}.`);
  }
}

/** Best-effort 0700 (owner traverse only). */
export function applyDirPermissions(path: string): void {
  if (isWindows) {
    restrictWindowsAcl(path, 'dir');
    return;
  }
  try {
    chmodSync(path, 0o700);
  } catch {
    note(`Could not set 0700 permissions on ${path}.`);
  }
}

let cachedPrincipal: string | null | undefined;

/**
 * The identity to grant. `USERNAME`/`USERDOMAIN` are used when present because
 * they avoid spawning a process; `whoami` is the fallback.
 */
function windowsPrincipal(): string | null {
  if (cachedPrincipal !== undefined) return cachedPrincipal;

  const user = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  if (user && user.length > 0) {
    cachedPrincipal = domain && domain.length > 0 ? `${domain}\\${user}` : user;
    return cachedPrincipal;
  }

  const result = spawnSync('whoami', [], { encoding: 'utf8', windowsHide: true });
  const out = result.status === 0 ? result.stdout.trim() : '';
  cachedPrincipal = out.length > 0 ? out : null;
  return cachedPrincipal;
}

function restrictWindowsAcl(path: string, kind: 'file' | 'dir'): void {
  if (process.env.CMA_SKIP_ACL === '1') return;

  const principal = windowsPrincipal();
  if (!principal) {
    note('Could not determine the current Windows user; ACLs were left as inherited.');
    return;
  }

  // A directory grant must carry (OI)(CI) so files created inside inherit it.
  // Without those flags the directory ends up with no inheritable ACE and every
  // file created in it gets an empty DACL - unreadable even by its owner.
  const rights = kind === 'dir' ? '(OI)(CI)(F)' : '(F)';

  // Arguments are an argv array: `path` and `principal` are never parsed by a shell.
  const result = spawnSync(
    'icacls',
    [path, '/inheritance:r', '/grant:r', `${principal}:${rights}`, '/Q', '/C'],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );

  if (result.error || result.status !== 0) {
    note(
      `Could not tighten the Windows ACL on ${path}; it still inherits the parent folder's permissions.`,
    );
  }
}

/**
 * Describe how well the platform can protect credentials, for `cma check`.
 */
export function permissionModel(): { mode: 'posix' | 'windows-acl'; note: string } {
  if (isWindows) {
    return {
      mode: 'windows-acl',
      note: 'Credential files use an inheritance-free ACL granting only the current Windows user.',
    };
  }
  return {
    mode: 'posix',
    note: 'Credential files are 0600 and credential directories are 0700.',
  };
}
