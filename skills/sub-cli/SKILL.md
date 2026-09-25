---
name: sub-cli
description: Manage posts on your Substack publication and read other people's newsletters from the command line. Use when creating, listing, updating, scheduling, publishing, or deleting posts; filing posts into sections; or scanning and crawling public Substack content.
---

# sub-cli

Requires `sub-cli` 0.4.0 or later. The skill is installed by hand and not
version-locked to the package: if a flag below is rejected as unknown, the
installed CLI is older than this skill assumes, fall back to the usage line
the command prints and confirm the difference with the human.

## Core principles

1. **Optimistic execution**: run the command you need directly. Do NOT
   pre-check auth with `profile check` or `profile list` before every
   command. The exit code already tells you whether auth failed (code 3).
   Pre-checking wastes a round trip on every invocation when the cookie is
   almost always still valid. Run the real command first; handle errors after.
2. **Profile discovery**: the first time you need a profile name and do not
   know it, run `sub-cli profile list` once per conversation to learn the
   available names. Cache the result, do not re-run it.
3. Always pass `--profile <name>` explicitly on every authoring command
   (`post`, `section`). Never rely on the default profile.
4. Prefer `--json` for machine-readable output; parse stdout only. Progress,
   warnings, and errors go to stderr.

## Error handling

Read the exit code, not stderr text, to decide what to do:

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Continue. |
| 1 | General failure | Read stderr, fix the input or retry later. |
| 2 | Usage error | You invoked the command wrong. Fix arguments from the printed usage line. Do not retry unchanged. |
| 3 | Auth expired | Cookie is dead. Ask the human to run `sub-cli profile login <name>`. Nothing else will fix it, do not retry the command until they confirm login succeeded. |
| 4 | Rate limited | Back off. Wait a few minutes before retrying, do not hammer. |

`--no-retry` disables the CLI's built-in retry/backoff for transient network
errors. Use it when you want fast failure instead of waiting (e.g. in
`--dry-run` or when you will retry at a higher level yourself).

## What an agent may do alone

- Read anything public (no cookie needed): `feed scan`, `feed crawl`,
  `feed crawl-all`. These never touch profiles.
- Create drafts: `post create <file>` (add `--dry-run` first to preview the
  exact request). Drafts are private and reversible.
- Adjust drafts and scheduled posts: `post update`, `section set`,
  `post unschedule`. Read the publication's sections with `section list`.
  `post update` and `section set` refuse a published post (its fields would be
  staged and never go live); changing a published post is `post revise`'s
  job, which this release does not have yet.
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
sub-cli profile list                       # show all profiles
sub-cli profile use / remove / login
```

Cookies expire after one to two weeks; exit code 3 means refresh via
`profile login`.

Reserve `profile check` for when the human explicitly asks to verify a
cookie, or after a login to confirm it worked. It is not a prerequisite for
running commands.

## Command surface

### Reading (no profile, no cookie)

These commands access public RSS/HTML and never need authentication. Do not
look up or pass `--profile`.

```
sub-cli feed scan <publication> [--limit n] [--all] [--json] [--no-retry]
sub-cli feed crawl <url> [--out dir] [--overwrite] [--no-retry]
sub-cli feed crawl-all <publication> [--limit n] [--all] [--out dir] [--overwrite] [--no-retry]
```

### Authoring (always pass `--profile <name>`)

```
sub-cli post create <file> --profile <name> [--dry-run] [--title t] [--subtitle s] [--section name] [--cover url] [--audience a] [--slug slug]
sub-cli post list --profile <name> [--state draft|scheduled|published] [--limit n] [--json] [--no-retry]
sub-cli post update <id> --profile <name> [--file path] [--section name] [--subtitle s] [--cover url] [--slug slug] [--dry-run]
sub-cli post schedule <file> <time> --profile <name> [--audience a]
sub-cli post unschedule <id> --profile <name>
sub-cli post publish <file|--id id> --profile <name> --yes [--no-send] [--audience a]
sub-cli post delete <id> --profile <name> --yes [--force-published]
sub-cli section list --profile <name> [--json]
sub-cli section add <name> <description> --profile <name>
sub-cli section remove <name-or-id> --profile <name> --yes
sub-cli section set <section-name> <id...> --profile <name> [--no-retry]
```

### Self-maintenance

```
sub-cli update   # installs the latest npm release of the CLI
```

After real commands the CLI may print a one-line "update available" notice
on stderr, at most once a day. Silence it with SUB_CLI_NO_UPDATE_CHECK=1.
Neither the notice nor `update` touches posts or profiles.

## Common workflows

### Create and publish a post

1. Write the Markdown file with front matter (`title` required).
2. Preview: `sub-cli post create <file> --profile p --dry-run`
3. Create draft: `sub-cli post create <file> --profile p`
   (returns the draft ID on stdout)
4. Confirm with the human, then publish the draft:
   `sub-cli post publish --id <draft-id> --profile p --yes`

Publishing via `--id` preserves the slug, section, and cover that
`post create` already applied. Publishing directly from a file with
`post publish <file>` only applies `title`, `subtitle`, and `audience`,
and warns about the three it drops (`slug`, `section`, `cover`).

### Replace a draft's content

1. Edit the Markdown file (`title` required; the body replaces the draft's).
2. Preview: `sub-cli post update <id> --file <file> --profile p --dry-run`
3. Send: `sub-cli post update <id> --file <file> --profile p`

Title and body always come from the file. Subtitle, cover, section, and slug
change only when the front matter or a flag names them; otherwise they keep
their current value. `audience` in the front matter is ignored with a warning.

### Schedule a post

1. Write the file, confirm time and audience with the human.
2. `sub-cli post schedule <file> <ISO-time> --profile p`
3. To cancel: `sub-cli post unschedule <id> --profile p`

### Crawl a newsletter and remix

1. `sub-cli feed crawl <url> --out ./drafts`
2. Crawled files use extra front matter keys (`author`, `date`, `source_url`,
   `publication`) that `post create` warns about and ignores, so a crawled
   piece is a valid starting draft for your own writing.
3. Edit the file, then `post create` as above.

## Post file format

A post file is Markdown with YAML-ish front matter carrying all metadata:
`title` (required), plus `subtitle`, `section`, `cover`, `audience`
(`everyone|only_paid|only_free|founding`), and `slug`. The body is Markdown;
unsupported constructs fail loudly instead of being dropped.

`cover` is the header image and only ever a hosted http(s) URL; it never
appears in the body. Body images written as local paths (relative to the
Markdown file) are uploaded by every sending command and rewritten to hosted
URLs, so keep the image files next to the post. A missing file stops the
command instead of producing a post with a broken image, and `--dry-run`
reports what would be uploaded without uploading it.
