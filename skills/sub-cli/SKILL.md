---
name: sub-cli
description: Manage posts on your Substack publication and read other people's newsletters from the command line. Use when creating, listing, updating, scheduling, publishing, or deleting posts; filing posts into sections; or scanning and crawling public Substack content.
---

# sub-cli

Requires `sub-cli` 0.4.0 or later. The skill is installed by hand and not
version-locked to the package: if a flag below is rejected as unknown, the
installed CLI is older than this skill assumes — fall back to the usage line
the command prints and confirm the difference with the human.

## Golden rules

1. Always pass `--profile <name>` explicitly on authoring commands. Never rely
   on the default profile.
2. Prefer `--json` for machine-readable output; parse stdout only. Progress,
   warnings, and errors go to stderr.
3. Exit codes tell you what to do next:
   - `0` success — continue.
   - `1` general failure — read stderr; fix the input or retry later.
   - `2` usage error — you invoked the command wrong; fix the arguments from
     the printed usage line. Do not retry unchanged.
   - `3` authentication — the cookie is dead. Ask the human to refresh it with
     `sub-cli profile login <name>`. Nothing else will fix it.
   - `4` rate limited — the ladder was exhausted. Wait a few minutes before
     retrying; do not hammer.

## What an agent may do alone

- Read anything public: `feed scan`, `feed crawl`, `feed crawl-all`.
- Inspect profiles: `profile list`, `profile check <name>`.
- Create drafts: `post create <file>` (add `--dry-run` first to preview the
  exact request). Drafts are private and reversible.
- Adjust drafts: `post update`, `section set`, `post unschedule`. Read the
  publication's sections with `section list`.
- Delete drafts and scheduled posts: `post delete <id> --yes`.

## What needs human confirmation first

- **Publishing** (`post publish`) is irreversible: it cannot be recalled and
  may email subscribers. The tool also demands an explicit `--profile` and
  `--yes`; treat those as a second lock, not permission to skip asking.
- **Deleting a published post** (`post delete <id> --yes --force-published`)
  removes it for every subscriber. Always ask.
- **Changing the publication's sections** (`section add`, `section remove`)
  edits the publication's own structure, not one post. `section remove` also
  strips the grouping from every post filed under it and cannot be undone;
  ask before either.
- **Scheduling** (`post schedule`) sends email at the trigger time. Confirm
  the time and audience with the human before running it.

When in doubt about audience, timing, or content, ask before writing.

## Profiles

A profile pairs a name with one publication URL and one cookie.

```
sub-cli profile add <name> <publication>   # prompts for the cookie
sub-cli profile check <name>               # proves the cookie is alive
sub-cli profile list / use / remove / login
```

Cookies expire after one to two weeks; exit code 3 means refresh via login.

## Command surface

Reading (no cookie needed):

```
sub-cli feed scan <publication> [--limit n] [--all] [--json] [--no-retry]
sub-cli feed crawl <url> [--out dir] [--overwrite] [--no-retry]
sub-cli feed crawl-all <publication> [--limit n] [--all] [--out dir] [--overwrite] [--no-retry]
```

Authoring:

```
sub-cli post create <file> [--dry-run] [--title t] [--subtitle s] [--section name] [--cover url] [--audience a] [--slug slug]
sub-cli post list [--state draft|scheduled|published] [--limit n] [--json] [--no-retry]
sub-cli post update <id> [--section name] [--subtitle s] [--slug slug]
sub-cli post schedule <file> <time> [--audience a]
sub-cli post unschedule <id>
sub-cli post publish <file|--id id> --profile p --yes [--no-send] [--audience a]
sub-cli post delete <id> --yes [--force-published]
sub-cli section list [--json]
sub-cli section add <name> <description>
sub-cli section remove <name-or-id> --yes
sub-cli section set <section-name> <id...> [--no-retry]
```

Self-maintenance:

```
sub-cli update   # installs the latest npm release of the CLI
```

After real commands the CLI may print a one-line "update available" notice
on stderr, at most once a day. Silence it with SUB_CLI_NO_UPDATE_CHECK=1.
Neither the notice nor `update` touches posts or profiles.

A post file is Markdown with YAML-ish front matter carrying all metadata —
`title` (required), plus `subtitle`, `section`, `cover`, `audience`
(`everyone|only_paid|only_free|founding`), and `slug`. The body is Markdown;
unsupported constructs fail loudly instead of being dropped.

`post create` and `post schedule` apply every one of those fields.
`post publish` applies `title`, `subtitle`, and `audience` only, and warns
about the three it drops (`slug`, `section`, `cover`): prepare those with
`post create` and publish the draft with `--id`.

`cover` is the header image and only ever a hosted http(s) URL; it never
appears in the body. Body images written as local paths (relative to the
Markdown file) are uploaded by every sending command and rewritten to hosted
URLs, so keep the image files next to the post. A missing file stops the
command instead of producing a post with a broken image, and `--dry-run`
reports what would be uploaded without uploading it.

Crawled files use extra front matter keys (`author`, `date`, `source_url`,
`publication`) that `post create` warns about and ignores, so a crawled piece
is a valid starting draft for your own writing.
