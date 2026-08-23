---
name: substackctl
description: Manage posts on your Substack publication and read other people's newsletters from the command line. Use when creating, listing, updating, scheduling, publishing, or deleting posts; filing posts into sections; or scanning and crawling public Substack content.
---

# substackctl

Requires `substackctl` 0.1.0 or later. The skill is installed by hand and not
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
     `substackctl profile login <name>`. Nothing else will fix it.
   - `4` rate limited — the ladder was exhausted. Wait a few minutes before
     retrying; do not hammer.

## What an agent may do alone

- Read anything public: `feed scan`, `feed crawl`, `feed crawl-all`.
- Inspect profiles: `profile list`, `profile check <name>`.
- Create drafts: `post create <file>` (add `--dry-run` first to preview the
  exact request). Drafts are private and reversible.
- Adjust drafts: `post update`, `section set`, `post unschedule`.
- Delete drafts and scheduled posts: `post delete <id> --yes`.

## What needs human confirmation first

- **Publishing** (`post publish`) is irreversible: it cannot be recalled and
  may email subscribers. The tool also demands an explicit `--profile` and
  `--yes`; treat those as a second lock, not permission to skip asking.
- **Deleting a published post** (`post delete <id> --yes --force-published`)
  removes it for every subscriber. Always ask.
- **Scheduling** (`post schedule`) sends email at the trigger time. Confirm
  the time and audience with the human before running it.

When in doubt about audience, timing, or content, ask before writing.

## Profiles

A profile pairs a name with one publication URL and one cookie.

```
substackctl profile add <name> <publication>   # prompts for the cookie
substackctl profile check <name>               # proves the cookie is alive
substackctl profile list / use / remove / login
```

Cookies expire after one to two weeks; exit code 3 means refresh via login.

## Command surface

Reading (no cookie needed):

```
substackctl feed scan <publication> [--limit n] [--all] [--json]
substackctl feed crawl <url> [--out dir] [--overwrite]
substackctl feed crawl-all <publication> [--limit n] [--all] [--out dir]
```

Authoring:

```
substackctl post create <file> [--dry-run] [--title t] [--subtitle s] [--section name] [--cover url] [--audience a] [--slug slug]
substackctl post list [--state draft|scheduled|published] [--limit n] [--json]
substackctl post update <id> [--section name] [--subtitle s] [--slug slug]
substackctl post schedule <file> <time> [--audience a]
substackctl post unschedule <id>
substackctl post publish <file|--id id> --profile p --yes [--no-send] [--audience a]
substackctl post delete <id> --yes [--force-published]
substackctl section list [--json]
substackctl section set <section-name> <id...>
```

A post file is Markdown with YAML-ish front matter carrying all metadata —
`title` (required), plus `subtitle`, `section`, `cover`, `audience`
(`everyone|only_paid|only_free|founding`), and `slug`. The body is Markdown;
unsupported constructs fail loudly instead of being dropped.

Crawled files use extra front matter keys (`author`, `date`, `source_url`,
`publication`) that `post create` warns about and ignores, so a crawled piece
is a valid starting draft for your own writing.
