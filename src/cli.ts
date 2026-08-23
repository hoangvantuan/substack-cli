import { groups } from './commands.js';
import type { Env } from './env/types.js';
import { EXIT_FAILURE, EXIT_RATE_LIMIT, EXIT_USAGE, RateLimitedError, UsageError } from './exit.js';

/**
 * The whole CLI as a pure function: takes an argument vector (the arguments
 * after node and the script path) and an environment, returns the exit code.
 */
export async function runCli(argv: string[], env: Env): Promise<number> {
  try {
    return await dispatch(argv, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    env.stderr.write(`substackctl: ${message}\n`);
    if (error instanceof RateLimitedError) {
      return EXIT_RATE_LIMIT;
    }
    return EXIT_FAILURE;
  }
}

async function dispatch(argv: string[], env: Env): Promise<number> {
  const [head, ...rest] = argv;
  if (head === undefined) {
    printTopUsage(env);
    return EXIT_USAGE;
  }
  const group = groups.find((candidate) => candidate.name === head);
  if (group === undefined) {
    env.stderr.write(`unknown command: ${head}\n`);
    printTopUsage(env);
    return EXIT_USAGE;
  }
  const [subName, ...args] = rest;
  if (subName === undefined) {
    env.stderr.write(`missing subcommand\n${group.usage}\n`);
    return EXIT_USAGE;
  }
  const subcommand = group.subcommands.find((candidate) => candidate.name === subName);
  if (subcommand === undefined) {
    env.stderr.write(`unknown subcommand: ${group.name} ${subName}\n${group.usage}\n`);
    return EXIT_USAGE;
  }
  try {
    return await subcommand.run(args, env);
  } catch (error) {
    if (error instanceof UsageError) {
      env.stderr.write(`${error.message}\n${subcommand.usage}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

function printTopUsage(env: Env): void {
  const lines = ['usage: substackctl <command> [options]', '', 'commands:'];
  for (const group of groups) {
    lines.push(`  ${group.name.padEnd(8)}${group.description}`);
  }
  env.stderr.write(lines.join('\n') + '\n');
}
