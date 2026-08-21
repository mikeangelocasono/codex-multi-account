/**
 * Commands that run Codex: launch, resume, list sessions, switch-and-resume.
 *
 * Arguments after the sub-command are forwarded to Codex unchanged. That is
 * deliberate - `cma codex --model x --cd project` must behave exactly like
 * `codex --model x --cd project`, only with the selected account's credential.
 */

import { CmaError } from '../../utils/errors.js';
import { assertSessionSelector } from '../../security/validation.js';
import { coerceToSlug } from '../../security/validation.js';
import { requireActiveProfile, useAccount } from '../../accounts/account-manager.js';
import { runCodex } from '../../codex/codex-runner.js';
import { latestSession, listSessions } from '../../codex/session-manager.js';
import type { SessionRecord } from '../../codex/session-manager.js';
import { hasFlag, intOption, optionValue, parseArgs } from '../args.js';
import {
  info,
  log,
  out,
  relativeDay,
  renderTable,
  safe,
  shortenPath,
  style,
  success,
  warn,
} from '../ui.js';

/** `cma codex [args...]` - launch Codex with the active account. */
export async function cmdCodex(argv: readonly string[]): Promise<number> {
  const profile = requireActiveProfile();
  const result = await runCodex({
    args: argv,
    profile: profile.slug,
    label: `codex ${argv[0] ?? ''}`.trim(),
    // `cma codex login` is a legitimate way to sign the active account in.
    allowMissingAuth: argv[0] === 'login' || argv[0] === 'logout',
  });
  return result.exitCode;
}

/**
 * `cma resume [id|--last] [args...]`.
 *
 * The session store is shared, so this resumes any session regardless of which
 * account created it - the request is simply authenticated as whoever is
 * active now.
 */
export async function cmdResume(argv: readonly string[]): Promise<number> {
  const profile = requireActiveProfile();
  const first = argv[0];

  if (first !== undefined && !first.startsWith('-')) {
    // Validate before forwarding so a malformed id fails here with a useful
    // message instead of deep inside Codex.
    assertSessionSelector(first);
  }

  const result = await runCodex({
    args: ['resume', ...argv],
    profile: profile.slug,
    label: 'codex resume',
  });
  return result.exitCode;
}

/** `cma sessions` - list what lives in the shared runtime. */
export function cmdSessions(argv: readonly string[]): number {
  const parsed = parseArgs(argv, { valueOptions: ['limit', 'cwd'] });
  const all = hasFlag(parsed, 'all', 'a');
  const limit = intOption(parsed, 'limit') ?? (all ? undefined : 20);

  const sessions = listSessions({
    includeArchived: all,
    includeSubagents: all,
    cwd: hasFlag(parsed, 'here') ? process.cwd() : optionValue(parsed, 'cwd'),
    limit,
  });

  if (hasFlag(parsed, 'json')) {
    out(
      JSON.stringify(
        sessions.map((session) => ({
          id: session.id,
          title: session.title,
          cwd: session.cwd,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
          archived: session.archived,
          source: session.source,
          model: session.model,
        })),
        null,
        2,
      ),
    );
    return 0;
  }

  if (sessions.length === 0) {
    log('');
    warn('No sessions found in the shared runtime.');
    info('Start one with:  cma codex');
    log('');
    return 0;
  }

  log('');
  renderTable(
    [{ header: 'session' }, { header: 'project' }, { header: 'updated' }, { header: 'title' }],
    sessions.map((session) => [
      session.id,
      shortenPath(session.cwd || '-', 28),
      relativeDay(session.updatedAt),
      safe(session.title || style.dim('(no title)'), 44),
    ]),
  );
  log('');
  info(`Resume one with:  cma resume ${sessions[0]!.id}`);
  log('');
  return 0;
}

/**
 * `cma switch <name> [--resume-last|--resume <id>]`.
 *
 * The safe replacement for an in-session slash command: Codex reads its
 * credential at startup, so an account change is a restart. What survives the
 * restart is the conversation.
 */
export async function cmdSwitch(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, { valueOptions: ['resume'] });
  const target = parsed.positionals[0];
  if (!target) {
    throw new CmaError('INVALID_ARGUMENT', 'Which account should become active?', {
      hint: 'For example:\n  cma switch work --resume-last',
    });
  }

  const slug = coerceToSlug(target);
  const explicitSession = optionValue(parsed, 'resume');
  const wantsLast = hasFlag(parsed, 'resume-last', 'resume') && explicitSession === undefined;

  // Pick the session before switching so "last" means the session that was
  // last used, not whatever the new account happens to see afterwards.
  let session: SessionRecord | null = null;
  if (wantsLast) {
    session = latestSession();
    if (!session) {
      warn('There is no previous session to resume.');
    }
  }

  const result = useAccount(slug);
  success(`Active account: ${style.bold(result.profile.slug)} (${result.profile.name})`);

  if (!result.authenticated) {
    warn(`"${result.profile.slug}" is not signed in yet.`);
    info(`Sign in with:  cma login ${result.profile.slug}`);
    return 1;
  }

  if (explicitSession) {
    assertSessionSelector(explicitSession);
    info(`Resuming session ${explicitSession} under "${result.profile.slug}".`);
    const run = await runCodex({
      args: ['resume', explicitSession],
      profile: result.profile.slug,
      label: 'codex resume',
    });
    return run.exitCode;
  }

  if (wantsLast && session) {
    info(`Resuming ${session.id} under "${result.profile.slug}".`);
    info(`Conversation and working directory are preserved; requests now use "${result.profile.slug}".`);
    const run = await runCodex({
      args: ['resume', session.id],
      profile: result.profile.slug,
      label: 'codex resume',
    });
    return run.exitCode;
  }

  info('Launch Codex with:  cma codex');
  return 0;
}

/** `cma sr <name>` - switch and resume the newest session in one step. */
export async function cmdSwitchResume(argv: readonly string[]): Promise<number> {
  return cmdSwitch([...argv, '--resume-last']);
}
