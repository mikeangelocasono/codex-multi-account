import { style } from './ui.js';

export const USAGE = `${style.bold('Codex Multi-Account')} - run the Codex CLI with several accounts.

${style.bold('USAGE')}
  cma                          Interactive account menu
  cma <command> [options]

${style.bold('ACCOUNTS')}
  add [name]                   Create an account and sign in with Codex
                               (asks for the name when omitted)
  list, ls                     Show every account and its status
  use <name>                   Make an account active
  current                      Print the active account name
  info [name]                  Show details for one account
  rename <name> <label...>     Change an account's display label
  login <name>                 Sign in to an existing account
  relogin <name>               Sign in again after a credential expires
  logout <name>                Sign an account out and forget its credential
  remove <name> [--force]      Delete an account (--force also drops its credential)
  check [name] [--deep]        Report credential health without revealing it

${style.bold('RUNNING CODEX')}
  codex [args...]              Launch Codex with the active account
  resume [id|--last] [args...] Resume a session (any account can resume any session)
  sessions [--all] [--here]    List sessions in the shared runtime
  switch <name> [--resume-last]
                               Switch account, optionally resuming straight away
  sr <name>                    Shorthand for: switch <name> --resume-last

${style.bold('MAINTENANCE')}
  import [--from DIR]          Copy an existing Codex home into the shared runtime
                               (--no-sessions, --no-plugins, --dry-run, --force)
  doctor                       Show paths, versions and anything that looks wrong
  help, version

${style.bold('OPTIONS')}
  --json                       Machine-readable output (list, info, sessions, check, doctor)
  --no-color                   Disable colour (NO_COLOR is also honoured)
  -h, --help                   Show this help
  -V, --version                Show the version

${style.bold('EXAMPLES')}
  cma add personal             Create "personal" and sign in
  cma use work                 Switch to the "work" account
  cma codex --model gpt-5.6-sol
                               Every argument after "codex" goes to Codex unchanged
  cma resume --last            Continue the newest session under the active account
  cma sr work                  Switch to "work" and resume where you left off

${style.dim('Sessions live in one shared runtime, so any account can resume any session.')}
${style.dim('Credentials never are: each account keeps its own auth.json under accounts/.')}
`;

export const ENV_HELP = `${style.bold('ENVIRONMENT')}
  CMA_HOME         Override ~/.codex-multi-account (used by the test suite)
  CMA_CODEX_BIN    Path to the Codex executable when it is not on PATH
  CMA_SKIP_ACL     Set to 1 to skip Windows ACL tightening
  NO_COLOR         Disable colour output
`;
