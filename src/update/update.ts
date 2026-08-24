import { parseArgv } from '../args.js';
import type { Env } from '../env/types.js';
import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE, UsageError } from '../exit.js';
import { cliVersion } from '../version.js';
import { compareVersions, fetchLatestVersion, recordUpdateCheck } from './check.js';

/**
 * True when this running copy lives inside an npm-managed node_modules tree.
 * The _npx cache is excluded: those users asked for a one-off run, not a
 * global install, so they get the manual instruction instead.
 */
export function npmManagedInstall(moduleUrl: string = import.meta.url): boolean {
  return moduleUrl.includes('/node_modules/') && !moduleUrl.includes('/_npx/');
}

/**
 * Handles `sub-cli update`: reports the newest release and installs it
 * over npm when this copy is an npm install. `moduleUrl` is injectable so
 * tests can stand in for the different install layouts.
 */
export async function runUpdate(argv: string[], env: Env, moduleUrl: string = import.meta.url): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(argv, {});
  } catch (error) {
    if (error instanceof UsageError) {
      env.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  if (parsed.positionals.length > 0) {
    env.stderr.write(`unexpected argument: ${parsed.positionals[0]}\n`);
    return EXIT_USAGE;
  }
  const current = cliVersion();
  const latest = await fetchLatestVersion(env);
  if (compareVersions(latest, current) <= 0) {
    env.stdout.write(`sub-cli ${current} is up to date\n`);
    await recordUpdateCheck(env, current);
    return EXIT_SUCCESS;
  }
  env.stdout.write(`sub-cli ${latest} is available (you have ${current})\n`);
  const install = `npm install -g @tuanhv/sub-cli@${latest}`;
  if (!npmManagedInstall(moduleUrl)) {
    env.stdout.write(`this copy was not installed by npm; update it with: ${install}\n`);
    return EXIT_FAILURE;
  }
  env.stdout.write('updating via npm...\n');
  const result = await env.exec.run('npm', ['install', '-g', `@tuanhv/sub-cli@${latest}`]);
  if (result.code !== 0) {
    env.stderr.write(`${result.stderr}update failed with exit code ${result.code}; run manually: ${install}\n`);
    return EXIT_FAILURE;
  }
  env.stdout.write(`updated to ${latest}\n`);
  await recordUpdateCheck(env, latest);
  return EXIT_SUCCESS;
}
