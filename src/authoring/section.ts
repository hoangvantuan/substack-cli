import { parseArgv } from '../args.js';
import type { CommandGroup, Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { AuthError, SubstackClient, type SectionSummary } from './api.js';

export const SECTION_GROUP_USAGE = 'usage: substackctl section <subcommand> [options]';

/** Milliseconds paced between assignment requests when filing many posts. */
export const SECTION_SET_PACE_MS = 500;

const listCommand: Subcommand = {
  name: 'list',
  description: "list the publication's sections",
  usage: 'usage: substackctl section list [--json] [--profile <name>]',
  async run(argv, env) {
    const parsed = parseArgv(argv, { booleans: ['json'], strings: ['profile'] });
    if (parsed.positionals.length > 0) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[0]}`);
    }
    const config = await loadConfig(env);
    const profileName = typeof parsed.values.get('profile') === 'string'
      ? (parsed.values.get('profile') as string)
      : undefined;
    const profile = resolveProfile(env, config, profileName);
    warnIfCookieStale(env, profile);
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      const sections = await client.listSections();
      if (parsed.values.get('json') === true) {
        env.stdout.write(JSON.stringify(sections, null, 2) + '\n');
      } else if (sections.length === 0) {
        env.stdout.write('no sections are configured\n');
      } else {
        const header = ['ID', 'NAME', 'SLUG'];
        const rows = sections.map((section) => [
          String(section.id),
          section.name,
          section.slug,
        ]);
        const widths = header.map((label, column) =>
          Math.max(label.length, ...rows.map((row) => row[column]!.length)),
        );
        const lines = [
          header.map((label, column) => label.padEnd(widths[column]!)).join('  ').trimEnd(),
          ...rows.map((row) =>
            row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd(),
          ),
        ];
        env.stdout.write(lines.join('\n') + '\n');
      }
      return EXIT_SUCCESS;
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`substackctl: ${error.message}\n`);
        return 3;
      }
      throw error;
    }
  },
};

const setCommand: Subcommand = {
  name: 'set',
  description: 'assign a section to several posts in one command',
  usage: 'usage: substackctl section set <section-name> <id...> [--profile <name>] [--no-retry]',
  async run(argv, env) {
    const parsed = parseArgv(argv, { strings: ['profile'], booleans: ['no-retry'] });
    const sectionName = parsed.positionals[0];
    if (sectionName === undefined) {
      throw new UsageError('missing <section-name>');
    }
    const ids = parsed.positionals.slice(1);
    if (ids.length === 0) {
      throw new UsageError('missing <id>: name at least one post to file');
    }
    for (const id of ids) {
      if (!/^\d+$/.test(id)) {
        throw new UsageError(`<id> must be a positive integer: ${id}`);
      }
    }
    const config = await loadConfig(env);
    const profileName = typeof parsed.values.get('profile') === 'string'
      ? (parsed.values.get('profile') as string)
      : undefined;
    const profile = resolveProfile(env, config, profileName);
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `substackctl: setting section "${sectionName}" on ${ids.length} post(s) on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      const sections = await client.listSections();
      const section = matchSection(sections, sectionName);
      if (section === undefined) {
        const available = sections.length === 0
          ? 'the publication has no sections'
          : `available sections: ${sections.map((entry) => entry.name).join(', ')}`;
        throw new UsageError(`unknown section "${sectionName}" (${available})`);
      }
      let failures = 0;
      for (let index = 0; index < ids.length; index += 1) {
        const id = Number(ids[index]);
        if (index > 0) {
          await env.sleep(SECTION_SET_PACE_MS);
        }
        await client.updateDraft(id, { draft_section_id: section.id });
        const fields = await client.draftFields(id);
        if (fields.draft_section_id !== section.id) {
          failures += 1;
          env.stderr.write(
            `substackctl: post ${id}: section did not stick (draft_section_id is empty)\n`,
          );
        }
        env.stdout.write(`filed ${id} under ${section.name}\n`);
      }
      return failures === 0 ? EXIT_SUCCESS : EXIT_FAILURE;
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`substackctl: ${error.message}\n`);
        return 3;
      }
      throw error;
    }
  },
};

function matchSection(sections: SectionSummary[], name: string): SectionSummary | undefined {
  return sections.find((entry) => entry.name === name || entry.slug === name);
}

export const sectionGroup: CommandGroup = {
  name: 'section',
  description: 'manage the publication\'s sections',
  usage: SECTION_GROUP_USAGE,
  subcommands: [listCommand, setCommand],
};
