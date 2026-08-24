import { groups, type CommandGroup } from './commands.js';
import type { Env } from './env/types.js';
import {
  EXIT_FAILURE,
  EXIT_RATE_LIMIT,
  EXIT_SUCCESS,
  EXIT_USAGE,
  RateLimitedError,
  UsageError,
} from './exit.js';
import { cliVersion } from './version.js';
import { warnIfUpdateAvailable } from './update/check.js';
import { runUpdate } from './update/update.js';

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

/**
 * The bin entry point: runs the CLI, then follows real commands (never
 * help, version, update, or usage errors) with the daily update notice.
 * The notice can never change the exit code.
 */
export async function runCliWithUpdateNotice(argv: string[], env: Env): Promise<number> {
  const code = await runCli(argv, env);
  const [head] = argv;
  if (head !== undefined && groups.some((group) => group.name === head)) {
    await warnIfUpdateAvailable(env);
  }
  return code;
}

async function dispatch(argv: string[], env: Env): Promise<number> {
  const [head, ...rest] = argv;
  if (head === undefined) {
    printTopUsage(env);
    return EXIT_USAGE;
  }
  if (head === '--version' || head === 'version') {
    const [extra] = rest;
    if (extra !== undefined) {
      env.stderr.write(`unexpected argument: ${extra}\n`);
      return EXIT_USAGE;
    }
    env.stdout.write(`${cliVersion()}\n`);
    return EXIT_SUCCESS;
  }
  if (head === '--help' || head === 'help') {
    return helpTopic(rest, env);
  }
  if (head === 'update') {
    return runUpdate(rest, env);
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
  if (subName === 'help' || subName === '--help') {
    const [extra] = args;
    if (extra !== undefined) {
      env.stderr.write(`unexpected argument: ${extra}\n`);
      return EXIT_USAGE;
    }
    printGroupHelp(group, env);
    return EXIT_SUCCESS;
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

/** Handles `substackctl help` and `substackctl help <command>`. */
function helpTopic(topics: string[], env: Env): number {
  const [topic, ...extra] = topics;
  if (extra.length > 0) {
    env.stderr.write(`unexpected argument: ${extra[0]}\n`);
    return EXIT_USAGE;
  }
  if (topic === undefined) {
    printTopHelp(env);
    return EXIT_SUCCESS;
  }
  const group = groups.find((candidate) => candidate.name === topic);
  if (group === undefined) {
    env.stderr.write(`unknown command: ${topic}\n`);
    printTopUsage(env);
    return EXIT_USAGE;
  }
  printGroupHelp(group, env);
  return EXIT_SUCCESS;
}

function printTopHelp(env: Env): void {
  const width = Math.max(...groups.map((group) => group.name.length), 'update'.length);
  const lines = ['usage: substackctl <command> [options]', '', 'commands:'];
  for (const group of groups) {
    lines.push(`  ${group.name.padEnd(width)}  ${group.description}`);
  }
  lines.push(`  ${'update'.padEnd(width)}  self-update to the latest npm release`);
  lines.push('', 'options:', '  --help     show this help', '  --version  print the version');
  env.stdout.write(lines.join('\n') + '\n');
}

function printGroupHelp(group: CommandGroup, env: Env): void {
  const width = Math.max(...group.subcommands.map((subcommand) => subcommand.name.length));
  const lines = [group.usage, '', 'subcommands:'];
  for (const subcommand of group.subcommands) {
    lines.push(`  ${subcommand.name.padEnd(width)}  ${subcommand.description}`);
  }
  env.stdout.write(lines.join('\n') + '\n');
}
