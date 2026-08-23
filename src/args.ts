import { UsageError } from './exit.js';

export interface ArgSpec {
  /** Options that take a value, e.g. --limit 5 or --limit=5. */
  strings?: readonly string[];
  /** Options that are flags, e.g. --json. */
  booleans?: readonly string[];
}

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string | boolean>;
}

/**
 * Minimal long-option parser: supports --flag, --flag value, --flag=value,
 * and an explicit -- separator. Anything unknown is a usage error.
 */
export function parseArgv(argv: readonly string[], spec: ArgSpec): ParsedArgs {
  const strings = new Set(spec.strings ?? []);
  const booleans = new Set(spec.booleans ?? []);
  const values = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let flagsDone = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i++]!;
    if (flagsDone || !arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      flagsDone = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === '') {
      throw new UsageError(`unknown option ${arg}`);
    }
    if (!strings.has(name) && !booleans.has(name)) {
      throw new UsageError(`unknown option --${name}`);
    }
    if (booleans.has(name)) {
      if (eq !== -1) {
        throw new UsageError(`option --${name} does not take a value`);
      }
      values.set(name, true);
      continue;
    }
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      if (i >= argv.length) {
        throw new UsageError(`option --${name} requires a value`);
      }
      value = argv[i++]!;
    }
    values.set(name, value);
  }
  return { positionals, values };
}
