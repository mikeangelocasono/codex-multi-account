/**
 * Commands that manage accounts: add, sign in, switch, inspect, remove.
 */

import { CmaError } from '../../utils/errors.js';
import { coerceToSlug } from '../../security/validation.js';
import { redactJson } from '../../security/redact.js';
import {
  createAccount,
  loginAccount,
  logoutAccount,
  overview,
  removeAccount,
  requireActiveProfile,
  useAccount,
} from '../../accounts/account-manager.js';
import {
  activeProfileSlug,
  getProfile,
  listProfiles,
  readState,
  renameProfile,
} from '../../accounts/profile-store.js';
import { accountAuthPath, accountDir } from '../../storage/paths.js';
import { inspectAuthFile } from '../../accounts/auth-manager.js';
import { hasFlag, parseArgs } from '../args.js';
import { confirm } from '../prompt.js';
import { info, log, out, renderTable, safe, style, success, warn } from '../ui.js';

export async function cmdAdd(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, { valueOptions: ['name'] });
  const raw = parsed.positionals[0];
  if (!raw) {
    throw new CmaError('INVALID_ARGUMENT', 'An account name is required.', {
      hint: 'For example:\n  cma add personal\n  cma add work',
    });
  }

  const slug = coerceToSlug(raw);
  const profile = createAccount(slug, { name: parsed.values.get('name') ?? undefined });
  success(`Created account "${profile.slug}" (${profile.name}).`);

  if (hasFlag(parsed, 'no-login')) {
    info(`Sign in later with:  cma login ${profile.slug}`);
    return 0;
  }

  log('');
  info('Starting the official Codex sign-in flow.');
  info('Codex opens your browser; codex-multi-account never sees your password.');
  log('');

  const result = await loginAccount(profile.slug);
  if (!result.ok) {
    warn(`"${profile.slug}" was created but is not signed in yet.`);
    info(`Try again with:  cma relogin ${profile.slug}`);
    return 1;
  }

  success(`"${profile.slug}" is signed in (${result.summary?.mode ?? 'unknown'} auth).`);
  if (activeProfileSlug() === profile.slug) {
    info(`It is now the active account. Launch Codex with:  cma codex`);
  } else {
    info(`Switch to it with:  cma use ${profile.slug}`);
  }
  return 0;
}

export async function cmdLogin(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, { stopAtFirstPositional: true });
  const target = parsed.positionals[0] ?? activeProfileSlug();
  if (!target) {
    throw new CmaError('INVALID_ARGUMENT', 'Which account should be signed in?', {
      hint: 'For example:  cma login work',
    });
  }

  const profile = getProfile(coerceToSlug(target));
  info(`Signing in to "${profile.slug}" with the official Codex flow.`);
  const result = await loginAccount(profile.slug, parsed.rest);
  if (!result.ok) {
    throw new CmaError('AUTH_MISSING', `Sign-in did not complete for "${profile.slug}".`, {
      hint: 'Nothing was changed. Run the command again when you are ready.',
    });
  }
  success(`"${profile.slug}" is signed in (${result.summary?.mode ?? 'unknown'} auth).`);
  return 0;
}

export async function cmdLogout(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, { valueOptions: [] });
  const target = parsed.positionals[0];
  if (!target) {
    throw new CmaError('INVALID_ARGUMENT', 'Which account should be signed out?', {
      hint: 'For example:  cma logout work',
    });
  }

  const profile = getProfile(coerceToSlug(target));
  if (!profile.authenticated) {
    info(`"${profile.slug}" has no stored credential; nothing to do.`);
    return 0;
  }

  const ok = await confirm(
    `Sign out "${profile.slug}" and delete its stored credential?`,
    { assumeYes: hasFlag(parsed, 'yes', 'y') },
  );
  if (!ok) {
    info('Left unchanged.');
    return 0;
  }

  await logoutAccount(profile.slug);
  success(`"${profile.slug}" is signed out.`);
  return 0;
}

export function cmdList(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  const state = overview();

  if (hasFlag(parsed, 'json')) {
    out(
      JSON.stringify(
        redactJson({
          active: state.active,
          runtimeOwner: state.runtimeOwner,
          runtimeHome: state.runtimeHome,
          accounts: state.profiles.map((profile) => ({
            slug: profile.slug,
            name: profile.name,
            status: statusOf(profile.slug, state.active, profile.authenticated),
            authMode: profile.metadata.authMode,
            accountIdSuffix: profile.metadata.accountIdSuffix,
            lastUsedAt: profile.metadata.lastUsedAt,
          })),
          activeSessions: state.activeWriters.map((writer) => ({
            profile: writer.profile,
            pid: writer.pid,
            startedAt: writer.startedAt,
          })),
        }),
        null,
        2,
      ),
    );
    return 0;
  }

  if (state.profiles.length === 0) {
    log('');
    warn('No accounts yet.');
    info('Add one with:  cma add personal');
    log('');
    return 0;
  }

  log('');
  renderTable(
    [{ header: 'account' }, { header: 'status' }, { header: 'auth' }, { header: 'label' }],
    state.profiles.map((profile) => [
      profile.slug,
      renderStatus(statusOf(profile.slug, state.active, profile.authenticated)),
      profile.metadata.authMode ?? style.dim('-'),
      safe(profile.name, 32),
    ]),
  );
  log('');

  for (const writer of state.activeWriters) {
    warn(`Codex is running under "${writer.profile}" (pid ${writer.pid}).`);
  }
  return 0;
}

type Status = 'active' | 'ready' | 'needs-login';

function statusOf(slug: string, active: string | null, authenticated: boolean): Status {
  if (!authenticated) return 'needs-login';
  return slug === active ? 'active' : 'ready';
}

function renderStatus(status: Status): string {
  switch (status) {
    case 'active':
      return style.green('active');
    case 'ready':
      return 'ready';
    default:
      return style.yellow('needs-login');
  }
}

export function cmdUse(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  const target = parsed.positionals[0];
  if (!target) {
    const profiles = listProfiles();
    throw new CmaError('INVALID_ARGUMENT', 'Which account should become active?', {
      hint:
        profiles.length > 0
          ? `Known accounts: ${profiles.map((p) => p.slug).join(', ')}`
          : 'You have no accounts yet. Add one with `cma add personal`.',
    });
  }

  const result = useAccount(coerceToSlug(target));
  if (result.previous === result.profile.slug) {
    info(`"${result.profile.slug}" was already active.`);
  } else {
    success(`Active account: ${style.bold(result.profile.slug)} (${result.profile.name})`);
  }

  if (!result.authenticated) {
    warn(`"${result.profile.slug}" is not signed in yet.`);
    info(`Sign in with:  cma login ${result.profile.slug}`);
  }
  return 0;
}

export function cmdCurrent(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  const slug = activeProfileSlug();

  if (hasFlag(parsed, 'json')) {
    const state = readState();
    out(
      JSON.stringify(
        {
          active: slug,
          runtimeOwner: state.runtimeOwner,
          authenticated: slug ? getProfile(slug).authenticated : false,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!slug) {
    warn('No account is selected.');
    info('Pick one with:  cma use <name>');
    return 1;
  }
  out(slug);
  return 0;
}

export function cmdInfo(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  const slug = parsed.positionals[0] ? coerceToSlug(parsed.positionals[0]) : requireActiveProfile().slug;
  const profile = getProfile(slug);
  const state = readState();
  const inspected = inspectAuthFile(accountAuthPath(slug));

  const payload = {
    slug: profile.slug,
    name: profile.name,
    active: state.activeProfile === slug,
    runtimeOwner: state.runtimeOwner === slug,
    authenticated: profile.authenticated,
    authMode: inspected.summary?.mode ?? profile.metadata.authMode,
    accountIdSuffix: inspected.summary?.accountIdSuffix ?? profile.metadata.accountIdSuffix,
    credentialFingerprint: inspected.summary?.fingerprint ?? null,
    lastTokenRefresh: inspected.summary?.lastRefresh ?? null,
    createdAt: profile.createdAt,
    lastUsedAt: profile.metadata.lastUsedAt,
    lastAuthSyncAt: profile.metadata.lastAuthSyncAt,
    codexVersionAtLogin: profile.metadata.codexVersion,
    directory: accountDir(slug),
    problem: inspected.ok ? null : inspected.reason,
  };

  if (hasFlag(parsed, 'json')) {
    out(JSON.stringify(redactJson(payload), null, 2));
    return 0;
  }

  log('');
  log(style.bold(`${payload.name}  ${style.dim(`(${payload.slug})`)}`));
  log('');
  const rows: string[][] = [
    ['status', payload.active ? style.green('active') : 'inactive'],
    ['signed in', payload.authenticated ? style.green('yes') : style.yellow('no')],
    ['auth mode', payload.authMode ?? style.dim('-')],
    ['account id', payload.accountIdSuffix ?? style.dim('-')],
    ['credential id', payload.credentialFingerprint ?? style.dim('-')],
    ['last refresh', payload.lastTokenRefresh ?? style.dim('-')],
    ['last used', payload.lastUsedAt ?? style.dim('never')],
    ['credential saved', payload.lastAuthSyncAt ?? style.dim('never')],
    ['owns runtime auth', payload.runtimeOwner ? 'yes' : 'no'],
    ['directory', payload.directory],
  ];
  renderTable([{ header: 'field' }, { header: 'value' }], rows, log);
  if (payload.problem) {
    log('');
    warn(`Credential problem: ${payload.problem}`);
    info(`Fix with:  cma relogin ${slug}`);
  }
  log('');
  return 0;
}

export async function cmdRemove(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const target = parsed.positionals[0];
  if (!target) {
    throw new CmaError('INVALID_ARGUMENT', 'Which account should be removed?', {
      hint: 'For example:  cma remove client',
    });
  }

  const slug = coerceToSlug(target);
  const profile = getProfile(slug);
  const force = hasFlag(parsed, 'force', 'f');

  const ok = await confirm(
    force
      ? `Delete account "${slug}" and its stored credential?`
      : `Delete account "${slug}"?`,
    { assumeYes: hasFlag(parsed, 'yes', 'y') },
  );
  if (!ok) {
    info('Left unchanged.');
    return 0;
  }

  removeAccount(slug, { force });
  success(`Removed "${profile.slug}".`);
  const next = activeProfileSlug();
  if (next) info(`Active account is now "${next}".`);
  return 0;
}

export function cmdRename(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  const [target, ...rest] = parsed.positionals;
  if (!target || rest.length === 0) {
    throw new CmaError('INVALID_ARGUMENT', 'A profile name and a new label are required.', {
      hint: 'For example:  cma rename work "Work (Acme)"',
    });
  }
  const profile = renameProfile(coerceToSlug(target), rest.join(' '));
  success(`"${profile.slug}" is now labelled "${profile.name}".`);
  return 0;
}
