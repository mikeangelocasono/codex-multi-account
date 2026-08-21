/**
 * A very small argument splitter.
 *
 * Deliberately not a general-purpose parser: commands that forward to Codex
 * must not interpret Codex's own flags, so each command states exactly which
 * options belong to it and everything else is passed through untouched.
 */

export interface ParsedArgs {
  /** Positional values, in order. */
  positionals: string[];
  /** Boolean flags that were present. */
  flags: Set<string>;
  /** `--key value` and `--key=value` pairs. */
  values: Map<string, string>;
  /** Everything after a bare `--`. */
  rest: string[];
}

export interface ParseSpec {
  /** Options that take a value. Everything else is treated as a boolean flag. */
  valueOptions?: readonly string[];
  /** Stop parsing at the first positional and return the remainder verbatim. */
  stopAtFirstPositional?: boolean;
}

export function parseArgs(argv: readonly string[], spec: ParseSpec = {}): ParsedArgs {
  const valueOptions = new Set(spec.valueOptions ?? []);
  const parsed: ParsedArgs = {
    positionals: [],
    flags: new Set(),
    values: new Map(),
    rest: [],
  };

  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === '--') {
      parsed.rest.push(...argv.slice(index + 1));
      return parsed;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        parsed.values.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      if (valueOptions.has(name)) {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          parsed.values.set(name, next);
          index += 1;
          continue;
        }
      }
      parsed.flags.add(name);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      parsed.flags.add(arg.slice(1));
      continue;
    }

    parsed.positionals.push(arg);
    if (spec.stopAtFirstPositional) {
      parsed.rest.push(...argv.slice(index + 1));
      return parsed;
    }
  }

  return parsed;
}

export function hasFlag(parsed: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => parsed.flags.has(name));
}

export function optionValue(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.values.get(name);
}

export function intOption(parsed: ParsedArgs, name: string): number | undefined {
  const raw = parsed.values.get(name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
