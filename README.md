# codex-multi-account

Run the [OpenAI Codex CLI](https://github.com/openai/codex) with several ChatGPT
accounts, and move a conversation between them.

```
ACCOUNT   STATUS  AUTH     LABEL
personal  active  chatgpt  Personal
work      ready   chatgpt  Work
client    ready   chatgpt  Client (Acme)
```

Each account keeps its own credential. Sessions do not: they live in one shared
Codex home, so a conversation started under `personal` can be picked up under
`work` with its full history intact.

```bash
cma use personal
cma codex                 # work for a while, then exit Codex

cma use work
cma resume --last         # same conversation, now billed to "work"
```

---

## What it does

* **Multiple accounts.** `cma add work` runs the official `codex login` flow in
  an isolated environment and stores the resulting credential under that
  profile. Your ChatGPT password is never seen, asked for, or stored by this
  tool.
* **One selected account at a time.** `cma use work` makes `work` active;
  `cma codex` launches Codex with that account's credential.
* **Sessions that outlive the account switch.** Transcripts, the thread index
  and the paginated turn history are shared, so `cma resume <id>` works no
  matter which account created the session.
* **Credentials that stay current.** Codex rotates its OAuth tokens while it
  runs. Changes are mirrored back to the owning profile as they happen and
  again when Codex exits, so a switch never resurrects a stale token.
* **A wrapper, not a fork.** Your `codex` command keeps working exactly as
  before. Nothing about the official installation is patched or replaced.

## Requirements

* Node.js 20.11 or newer (22.5+ recommended: session listings use `node:sqlite`
  when it is available, and fall back to reading transcript headers when it is
  not)
* The Codex CLI on your `PATH` — `npm install -g @openai/codex`

## Install

```bash
git clone https://github.com/Loopsmiths-labs/codex-multi-account.git
cd codex-multi-account
npm install
npm run build
npm install -g .
```

That puts two equivalent commands on your `PATH`:

```bash
cma                     # short form
codex-multi-account     # same thing
```

Check the installation:

```bash
cma doctor
```

## Bring your existing Codex home over

If you have been using Codex already, import it. The source is read-only —
nothing in `~/.codex` is moved, changed or deleted.

```bash
cma import                       # from ~/.codex, with sessions and plugins
cma import --dry-run             # show the plan and stop
cma import --no-sessions         # config, skills and credential only
cma import --no-plugins          # skip a large plugins/ directory
```

The credential found there becomes an account (named `personal` unless you pass
`--profile <name>`), and it is selected automatically. Re-running the import is
safe: it copies only what is missing and merges the thread index rather than
overwriting it.

## Add an account

```bash
cma add personal
cma add work
cma add "Client (Acme)"    # stored as the slug "client-acme"
```

Codex opens your browser for the official sign-in. When it finishes, the
credential is written to that profile and nowhere else.

## Switch

```bash
cma use work
cma current                # -> work
cma list
```

Switching is refused while a Codex process launched by this tool is still
running under another account, because that process would keep writing to the
credential being replaced:

```
x  A Codex process is currently using account "personal".

Exit that Codex session before you switch accounts.
  pid 24188  started 2026-08-21T12:41:03.144Z  cwd C:\Projects\Alpha
```

## Launch Codex

```bash
cma codex
cma codex --model gpt-5.6-sol
cma codex --cd ./project
cma codex exec "summarise the diff"
```

Everything after `codex` is forwarded to Codex unchanged, so `cma codex --help`
prints Codex's help, not this tool's.

## Resume across accounts

```bash
cma sessions                     # what is available
cma resume --last                # newest session
cma resume 01a0244c-fbd4-72e1-bb26-844e00be3a8a
```

The full flow:

```bash
cma use personal
cma codex
# ... work, then exit Codex

cma use work
cma resume --last
```

Or in one command:

```bash
cma switch work --resume-last
cma sr work                      # same thing, shorter
```

What carries over: the conversation, the previous instructions, the working
directory Codex recorded for that session, and the session id. What does not:
anything the old process was holding in memory, and the prompt cache — the
first turn after a switch re-reads the history, so it costs a little more.

### Why it is a restart, not a live swap

Codex reads its credential when it starts. No supported mechanism lets a
running Codex change accounts, and this tool does not try to invent one by
patching Codex or faking a slash command. The account change is a restart; the
conversation is what survives it.

## Interactive menu

Running `cma` with no arguments opens a menu that loops — after Codex exits you
are back at the list, one keystroke away from switching and resuming.

```
Codex Multi-Account

Active account:
* Work (work)

Accounts:

  1. Personal
  2. Work        <- active
  3. Client

Actions:

  [Enter] Launch Codex
  [S] Switch account
  [A] Add account
  [R] Resume session
  [L] List sessions
  [D] Remove account
  [I] Account info
  [Q] Quit
```

## Commands

| Command | What it does |
| --- | --- |
| `cma` | Interactive account menu |
| `cma add <name>` | Create an account and sign in (`--no-login` to skip) |
| `cma list` \| `cma ls` | Accounts and their status (`--json`) |
| `cma use <name>` | Make an account active |
| `cma current` | Print the active account's name |
| `cma info [name]` | Details for one account (`--json`) |
| `cma rename <name> <label...>` | Change the display label |
| `cma login <name>` / `cma relogin <name>` | Sign in again |
| `cma logout <name>` | Sign out and forget the credential |
| `cma remove <name> [--force]` | Delete an account |
| `cma check [name] [--deep]` | Credential health (`--deep` asks Codex itself) |
| `cma codex [args...]` | Launch Codex with the active account |
| `cma exec [args...]` | Shorthand for `cma codex exec` |
| `cma resume [id\|--last]` | Resume a session under the active account |
| `cma sessions` | Sessions in the shared runtime (`--all`, `--here`, `--limit`, `--json`) |
| `cma switch <name> [--resume-last]` | Switch, optionally resuming immediately |
| `cma sr <name>` | `switch <name> --resume-last` |
| `cma import [--from DIR]` | Adopt an existing Codex home |
| `cma doctor` | Paths, versions and anything that looks wrong (`--json`) |

## Storage layout

```
~/.codex-multi-account/
    config.json              profile registry (names, labels, ordering)
    state.json               active profile + which profile owns the runtime credential
    runtime.lock             held briefly while the credential is swapped
    import-history.json      what has been imported, so repeats are cheap

    accounts/                per-account, never shared
        personal/
            auth.json        ChatGPT tokens or API key   (0600 / owner-only ACL)
            metadata.json    display name, last used, auth mode, account-id tail
        work/
            auth.json
            metadata.json

    runtime/                 <- this is CODEX_HOME for every launch; shared by all accounts
        auth.json            materialised copy of the active account's credential
        config.toml          model, approvals, MCP servers, plugins, project trust
        AGENTS.md            global agent instructions
        sessions/            rollout transcripts
        state_*.sqlite       thread index: id, title, cwd, timestamps, rollout path
        thread_history_*.sqlite
                             paginated turn/item history - where resume reads context
        history.jsonl        cross-session prompt history
        skills/  prompts/  plugins/
        memories_*.sqlite  goals_*.sqlite  queue_*.sqlite
        secrets/  mcp-oauth-locks/

    locks/writers/           one file per live Codex process (pid, account, cwd)
    backups/<timestamp>-<label>/
                             config.json, state.json, config.toml, thread index
                             (never credentials)
```

### Shared or per-account?

| State | Where | Why |
| --- | --- | --- |
| `auth.json` | per account | The one file that identifies the account. |
| `sessions/` | shared | The conversation itself. |
| `state_*.sqlite` | shared | Thread index; holds the rollout path resume looks up. |
| `thread_history_*.sqlite` | shared | Modern Codex reads context from here, not the transcript. |
| `history.jsonl` | shared | Prompt history for the TUI. |
| `config.toml`, `AGENTS.md` | shared | Model, approvals, MCP servers, plugins, trusted projects. |
| `skills/`, `prompts/`, `plugins/` | shared | Switching accounts should not change your tooling. |
| `memories_*`, `goals_*`, `queue_*` | shared | Continuity of work, not identity. |
| `secrets/`, `mcp-oauth-locks/` | shared | MCP credentials are keyed by service, not by ChatGPT account. |
| `cache/`, `log/`, `logs_*.sqlite`, `.tmp/` | not copied | Regenerable or machine-local. |

Only `auth.json` is account-specific. Everything else in a Codex home is either
shared state or a cache, which is exactly why cross-account resume works.

## Security

* **No passwords.** Sign-in is always `codex login`, in the official browser
  flow. This tool has no code path that reads a password, a cookie or a browser
  profile.
* **No credentials in output.** `--json` output is filtered through a redactor,
  and identifiers are shown as a masked tail (`...a565ae`). Token values are
  never logged, printed or written to a backup.
* **Restrictive permissions.** Credential files are `0600` on POSIX. On Windows
  they get an inheritance-free ACL granting only the current user; directory
  grants are inheritable so the files Codex creates alongside them stay
  readable.
* **Atomic replacement.** Credentials are written to a temporary file in the
  same directory, fsynced, then renamed. A crash can never leave a half-written
  `auth.json`.
* **Ownership tracking.** `state.json` records which profile the runtime
  credential belongs to. A refreshed token is only ever written back to that
  profile, and never over a valid credential with an unparseable one.
* **No shell.** Codex is spawned with an argv array and `shell: false`, so a
  session id, profile name or forwarded flag cannot become shell syntax. On
  Windows the batch shim is bypassed in favour of the package's JavaScript
  entry point, run with the current Node binary.
* **Validated names.** Profile names are matched against an allow-list;
  `../../x`, `C:\Windows`, `con` and control characters are rejected before any
  path is built.
* **Nothing sensitive in git.** `.gitignore` excludes `auth.json`, `accounts/`,
  `runtime/`, `backups/` and lock files.

## Troubleshooting

**`Codex CLI was not found.`**
Install it with `npm install -g @openai/codex`, or point at an unusual
location with `CMA_CODEX_BIN=/path/to/codex`.

**`Account "work" is not authenticated.`**
Run `cma login work`.

**`The stored credential for "work" is no longer valid.`**
Run `cma relogin work`. The old credential is replaced only when the new
sign-in succeeds.

**`A Codex process is currently using account "personal".`**
Exit that Codex session, then switch. If the process is already gone — a closed
terminal, a crash — run `cma check`; stale entries are pruned automatically by
checking whether the recorded pid is still alive.

**`Another codex-multi-account operation is in progress.`**
Two commands tried to swap the credential at once. Wait for the first to
finish. A lock left behind by a crash is reclaimed automatically once its owner
is gone, or after five minutes.

**A session will not resume.**
Run `cma sessions --all`. If it is not listed, its transcript is not in the
shared runtime — most likely it predates `cma import`, or the import ran with
`--no-sessions`. Run `cma import` again to bring it over; the import is
incremental.

**`Failed to read config file ... Access is denied.` (Windows)**
A directory ACL lost its inheritable entry. `cma doctor` detects this and
prints the repair command:

```
icacls "%USERPROFILE%\.codex-multi-account\runtime" /reset /T /C /Q
```

**MCP servers ask to authenticate again.**
MCP OAuth grants are tied to the Codex home they were issued in. After an
import, re-authorise them once inside Codex; the new grant is then shared by
every account.

**Uninstalling.**
`npm uninstall -g codex-multi-account` removes the commands. Your original
`~/.codex` was never touched, so plain `codex` keeps working. Delete
`~/.codex-multi-account` if you also want the profiles and the shared runtime
gone — that deletes the credentials and any session that only exists there.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CMA_HOME` | Override `~/.codex-multi-account` (the test suite uses this) |
| `CMA_CODEX_BIN` | Path to the Codex executable when it is not on `PATH` |
| `CMA_SKIP_ACL` | Set to `1` to skip Windows ACL tightening |
| `CODEX_HOME` | Read only to find your original Codex home for `cma import` |
| `NO_COLOR` | Disable colour output |

Inside a session launched by this tool, `CODEX_HOME` points at the shared
runtime and `CMA_ACTIVE_PROFILE` names the account in use.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke        # drives the built CLI as a child process
npm run qa           # all of the above
```

Tests run against a throwaway `CMA_HOME` and a stub Codex, so they never touch
real accounts or sessions.

## Scope

This is a **user-controlled account selector**. It does not rotate accounts
automatically, does not react to usage limits, and does not try to work around
any account restriction. Which account is active is always something you chose.

## Credits

A derivative of
[claude-multi-account](https://github.com/Loopsmiths-labs/claude-multi-account),
rebuilt around the Codex CLI's own storage model. See `NOTICE` for what was
carried over and what is new. MIT licensed; the original copyright is preserved
in `LICENSE`.

Not affiliated with or endorsed by OpenAI.
