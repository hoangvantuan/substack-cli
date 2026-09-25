import { parseArgv } from '../args.js';
import type { CommandGroup, Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { AuthError, SubstackClient, type SectionSummary } from './api.js';

export const SECTION_GROUP_USAGE = 'usage: sub-cli section <subcommand> [options]';

/** Milliseconds paced between assignment requests when filing many posts. */
export const SECTION_SET_PACE_MS = 500;

const listCommand: Subcommand = {
  name: 'list',
  description: "list the publication's sections",
  usage: 'usage: sub-cli section list [--json] [--profile <name>]',
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
        env.stderr.write(`sub-cli: ${error.message}\n`);
        return 3;
      }
      throw error;
    }
  },
};

const addCommand: Subcommand = {
  name: 'add',
  description: 'create a section on the publication',
  usage: 'usage: sub-cli section add <name> <description> [--profile <name>]',
  async run(argv, env) {
    const parsed = parseArgv(argv, { strings: ['profile'] });
    const name = parsed.positionals[0];
    if (name === undefined || name === '') {
      throw new UsageError('missing <name>');
    }
    // Substack answers 400 for a missing or empty description, so the
    // command asks for one rather than letting the API refuse the call.
    const description = parsed.positionals[1];
    if (description === undefined || description === '') {
      throw new UsageError('missing <description>: Substack refuses a section without one');
    }
    if (parsed.positionals.length > 2) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[2]}`);
    }
    const config = await loadConfig(env);
    const profile = resolveProfile(env, config, profileFlag(parsed.values.get('profile')));
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `sub-cli: adding section "${name}" on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      // The duplicate is caught here so the failure names the collision; the
      // API only answers "You already have a section with that name".
      const existing = await client.listSections();
      if (existing.some((section) => section.name === name)) {
        throw new UsageError(`section already exists: ${name}`);
      }
      const created = await client.createSection(name, description);
      env.stdout.write(`section ${created.id}\n`);
      env.stdout.write(`name: ${created.name}\n`);
      env.stdout.write(`slug: ${created.slug}\n`);
      return EXIT_SUCCESS;
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`sub-cli: ${error.message}\n`);
        return 3;
      }
      throw error;
    }
  },
};

const removeCommand: Subcommand = {
  name: 'remove',
  description: 'delete a section from the publication',
  usage: 'usage: sub-cli section remove <name-or-id> --yes [--profile <name>]',
  async run(argv, env) {
    const parsed = parseArgv(argv, { strings: ['profile'], booleans: ['yes'] });
    const target = parsed.positionals[0];
    if (target === undefined || target === '') {
      throw new UsageError('missing <name-or-id>');
    }
    if (parsed.positionals.length > 1) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
    }
    // Posts survive their section's removal, but the grouping does not come
    // back and every post filed under it loses its section, so the command
    // asks for the same confirmation `post delete` does.
    if (parsed.values.get('yes') !== true) {
      throw new UsageError('refusing to delete a section without --yes; the section cannot be restored');
    }
    const config = await loadConfig(env);
    const profile = resolveProfile(env, config, profileFlag(parsed.values.get('profile')));
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `sub-cli: removing section "${target}" on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      const sections = await client.listSections();
      const section = matchSection(sections, target) ??
        (/^\d+$/.test(target)
          ? sections.find((entry) => entry.id === Number(target))
          : undefined);
      if (section === undefined) {
        const available = sections.length === 0
          ? 'the publication has no sections'
          : `available sections: ${sections.map((entry) => entry.name).join(', ')}`;
        throw new UsageError(`unknown section "${target}" (${available})`);
      }
      await client.deleteSection(section.id);
      env.stdout.write(`removed ${section.id} (${section.name})\n`);
      return EXIT_SUCCESS;
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`sub-cli: ${error.message}\n`);
        return 3;
      }
      throw error;
    }
  },
};

const setCommand: Subcommand = {
  name: 'set',
  description: 'assign a section to several drafts or scheduled posts in one command',
  usage: 'usage: sub-cli section set <section-name> <id...> [--profile <name>] [--no-retry]',
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
      `sub-cli: setting section "${sectionName}" on ${ids.length} post(s) on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
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
        // On a published post draft_section_id is staged: the PUT answers
        // 200 but the live section never changes (docs/api-observations.md).
        if ((await client.draftState(id)).published) {
          failures += 1;
          env.stderr.write(
            `sub-cli: post ${id} is published; its section would be staged and never go live. ` +
              `Skipped. To change it, use: sub-cli post revise ${id} --section "${section.name}"\n`,
          );
          continue;
        }
        await client.updateDraft(id, { draft_section_id: section.id });
        const fields = await client.draftFields(id);
        if (fields.draft_section_id !== section.id) {
          failures += 1;
          env.stderr.write(
            `sub-cli: post ${id}: section did not stick (draft_section_id is empty)\n`,
          );
        }
        env.stdout.write(`filed ${id} under ${section.name}\n`);
      }
      return failures === 0 ? EXIT_SUCCESS : EXIT_FAILURE;
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`sub-cli: ${error.message}\n`);
        return 3;
      }
      throw error;
    }
  },
};

function matchSection(sections: SectionSummary[], name: string): SectionSummary | undefined {
  return sections.find((entry) => entry.name === name || entry.slug === name);
}

/** Reads the --profile flag, which every subcommand in this group accepts. */
function profileFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export const sectionGroup: CommandGroup = {
  name: 'section',
  description: 'manage the publication\'s sections',
  usage: SECTION_GROUP_USAGE,
  subcommands: [listCommand, addCommand, removeCommand, setCommand],
};
