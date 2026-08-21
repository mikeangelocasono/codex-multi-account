/**
 * `cma check` - credential health, without ever showing a credential.
 *
 * The shallow check is structural and offline. `--deep` copies the credential
 * into a throwaway CODEX_HOME and lets Codex give its own verdict, so the
 * answer comes from the tool that owns the format rather than from guesswork
 * about token expiry.
 */

import { checkAccount, overview } from '../../accounts/account-manager.js';
import type { HealthReport } from '../../accounts/account-manager.js';
import { coerceToSlug } from '../../security/validation.js';
import { permissionModel, permissionWarnings } from '../../security/permissions.js';
import { hasFlag, parseArgs } from '../args.js';
import { info, log, out, renderTable, style, success, warn } from '../ui.js';

export function cmdCheck(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  const deep = hasFlag(parsed, 'deep');
  const state = overview();

  const targets = parsed.positionals[0]
    ? [coerceToSlug(parsed.positionals[0])]
    : state.profiles.map((profile) => profile.slug);

  if (targets.length === 0) {
    warn('No accounts to check.');
    info('Add one with:  cma add personal');
    return 1;
  }

  const reports = targets.map((slug) => checkAccount(slug, { deep }));

  if (hasFlag(parsed, 'json')) {
    out(
      JSON.stringify(
        {
          permissions: permissionModel(),
          warnings: permissionWarnings(),
          accounts: reports.map((report) => ({
            slug: report.slug,
            name: report.name,
            hasCredential: report.hasCredential,
            valid: report.valid,
            reason: report.reason ?? null,
            authMode: report.summary?.mode ?? null,
            accountIdSuffix: report.summary?.accountIdSuffix ?? null,
            lastRefresh: report.summary?.lastRefresh ?? null,
            active: report.active,
            runtimeOwner: report.runtimeOwner,
            codex: report.codexStatus ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return reports.every(healthy) ? 0 : 1;
  }

  log('');
  renderTable(
    [
      { header: 'account' },
      { header: 'credential' },
      { header: 'auth' },
      { header: 'account id' },
      ...(deep ? [{ header: 'codex' }] : []),
    ],
    reports.map((report) => [
      report.active ? `${report.slug} ${style.dim('(active)')}` : report.slug,
      verdict(report),
      report.summary?.mode ?? style.dim('-'),
      report.summary?.accountIdSuffix ?? style.dim('-'),
      ...(deep ? [report.codexStatus ? renderCodexStatus(report) : style.dim('-')] : []),
    ]),
  );
  log('');

  for (const report of reports) {
    if (!report.hasCredential) {
      warn(`"${report.slug}" is not authenticated.`);
      info(`Run:\n  cma login ${report.slug}`);
      continue;
    }
    if (!report.valid) {
      warn(`The stored credential for "${report.slug}" is no longer valid: ${report.reason}.`);
      info(`Run:\n  cma relogin ${report.slug}`);
      continue;
    }
    if (report.codexStatus && !report.codexStatus.ok) {
      warn(`Codex rejected the credential for "${report.slug}": ${report.codexStatus.message}`);
      info(`Run:\n  cma relogin ${report.slug}`);
    }
  }

  for (const message of permissionWarnings()) warn(message);

  const stale = state.activeWriters;
  if (stale.length > 0) {
    log('');
    for (const writer of stale) {
      info(`Codex is running under "${writer.profile}" (pid ${writer.pid}, started ${writer.startedAt}).`);
    }
    info('Account switching is blocked while a Codex session is live.');
  }

  if (reports.every(healthy)) {
    log('');
    success('All accounts look healthy.');
    log('');
    return 0;
  }
  log('');
  return 1;
}

function healthy(report: HealthReport): boolean {
  if (!report.hasCredential || !report.valid) return false;
  if (report.codexStatus && !report.codexStatus.ok) return false;
  return true;
}

function verdict(report: HealthReport): string {
  if (!report.hasCredential) return style.yellow('missing');
  if (!report.valid) return style.red('invalid');
  return style.green('ok');
}

function renderCodexStatus(report: HealthReport): string {
  if (!report.codexStatus) return style.dim('-');
  return report.codexStatus.ok
    ? style.green(report.codexStatus.message.split('\n')[0] ?? 'ok')
    : style.red('rejected');
}
