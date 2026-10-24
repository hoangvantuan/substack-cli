import { parseArgv } from '../args.js';
import type { CommandGroup, Subcommand } from '../commands.js';
import { EXIT_AUTH, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { AuthError, SubstackClient } from './api.js';
import { IMAGE_UPLOAD_PACE_MS, resolveImageSrc, uploadImageFile } from './images.js';

export const IMAGE_GROUP_USAGE = 'usage: sub-cli image <subcommand> [options]';

export const imageUploadUsage = 'usage: sub-cli image upload <file>... [--profile <name>]';

/**
 * Uploads local image files to the publication's image host and prints one
 * hosted URL per file on stdout, in argument order, so the output can feed
 * `--cover` or a Markdown image directly. Every file is checked before the
 * first byte is uploaded.
 */
const uploadCommand: Subcommand = {
  name: 'upload',
  description: 'upload local image files and print their hosted URLs (for --cover)',
  usage: imageUploadUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, { strings: ['profile'] });
    if (parsed.positionals.length === 0) {
      throw new UsageError('missing <file>');
    }
    const paths = parsed.positionals.map((file) => resolveImageSrc(file, '.'));
    for (const path of paths) {
      if (!(await env.fs.exists(path))) {
        throw new Error(`image not found: ${path}`);
      }
    }
    const config = await loadConfig(env);
    const profileName = typeof parsed.values.get('profile') === 'string'
      ? (parsed.values.get('profile') as string)
      : undefined;
    const profile = resolveProfile(env, config, profileName);
    warnIfCookieStale(env, profile);
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      for (const [index, path] of paths.entries()) {
        if (index > 0) {
          await env.sleep(IMAGE_UPLOAD_PACE_MS);
        }
        const hosted = await uploadImageFile(env, client, path);
        env.stdout.write(`${hosted.url}\n`);
      }
      return EXIT_SUCCESS;
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`sub-cli: ${error.message}\n`);
        return EXIT_AUTH;
      }
      throw error;
    }
  },
};

export const imageGroup: CommandGroup = {
  name: 'image',
  description: 'upload images to your publication',
  usage: IMAGE_GROUP_USAGE,
  subcommands: [uploadCommand],
};
