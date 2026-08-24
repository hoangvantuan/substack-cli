# sub-cli

A command-line tool that manages posts on your Substack publication and reads
other people's newsletters. Ships with an agent skill that teaches AI agents
when and how to use it safely.

Requires Node.js 24 or later. No runtime dependencies.

## Installation

```
npm install -g @tuanhv/sub-cli
```

Or run it without a global install:

```
npx @tuanhv/sub-cli <command> ...
```

For hacking on the tool itself, see [Development](#development) below.

## Profile setup

Authoring commands act on a *profile*: a named pair of one publication URL and
one cookie.

1. Get your cookie:
   - Log in to [substack.com](https://substack.com) in a browser.
   - Open DevTools (`Cmd+Option+I`) → Application → Cookies → `https://substack.com`.
   - Copy the **Value** of the cookie named exactly `substack.sid` (it starts
     with `s%3A`). Don't confuse it with `substack.lli`, which will not work.
2. Register a profile (the terminal prompts for the cookie without echoing):

   ```
   sub-cli profile add mypub https://mypub.substack.com
   ```

   Tip: you can pipe it instead — `pbpaste | sub-cli profile add mypub ...`.

3. Check it works:

   ```
   sub-cli profile check mypub     # exit 0 = alive, exit 3 = expired
   sub-cli profile use mypub       # make it the default
   ```

Profiles live in `$XDG_CONFIG_HOME/sub-cli/config.json`
(`~/.config/sub-cli/config.json`), written owner-readable only. Cookies
expire after one to two weeks; refresh with `sub-cli profile login <name>`.
The environment variables `SUBSTACK_PUBLICATION_URL` and `SUBSTACK_COOKIE`
override any stored profile when both are set.

## Command surface

General:

```
sub-cli help [command]   # top-level help, or one command group's help
sub-cli --version
sub-cli update           # self-update to the latest npm release
```

After a real command the CLI may print a one-line "update available" notice
on stderr, checked at most once a day and cached under the config directory.
Set `SUB_CLI_NO_UPDATE_CHECK=1` to silence it. `sub-cli update`
installs the latest release when the CLI lives in an npm install; otherwise
it prints the exact command to run.

Reading — no cookie, works on any public publication:

```
sub-cli feed scan <publication> [--limit n] [--all] [--json] [--no-retry]
sub-cli feed crawl <url> [--out dir] [--overwrite] [--no-retry]
sub-cli feed crawl-all <publication> [--limit n] [--all] [--out dir] [--overwrite] [--no-retry]
```

Writing — uses a profile:

```
sub-cli post create <file> [--dry-run] [--title t] [--subtitle s]
                              [--section name] [--cover url] [--audience a] [--slug slug]
sub-cli post list [--state draft|scheduled|published] [--limit n] [--json] [--no-retry]
sub-cli post update <id> [--section name] [--subtitle s] [--slug slug]
sub-cli post schedule <file> <time> [--audience a]
sub-cli post unschedule <id>
sub-cli post delete <id> --yes [--force-published]
sub-cli section list [--json]
sub-cli section add <name> <description>
sub-cli section remove <name-or-id> --yes
sub-cli section set <section-name> <id...> [--no-retry]
```

Publishing — irreversible, guarded twice per ADR-0004:

```
sub-cli post publish <file> --profile p --yes [--no-send] [--audience a]
sub-cli post publish --id <n> --profile p --yes [--no-send] [--audience a]
```

Commands that talk to the API retry on rate limits with a paced backoff
ladder, then exit 4. Pass `--no-retry` to make a single attempt instead;
the reading commands, `post list`, `section set`, and `profile check`
accept it.

### Post files

A post file is Markdown with front matter carrying all metadata:

```markdown
---
title: My post title        # required here or via --title
subtitle: Optional subtitle
section: Essays             # must already exist on the publication
cover: https://.../img.png  # optional, http(s) only
audience: everyone          # everyone | only_paid | only_free | founding
slug: my-post-slug          # lowercase words separated by hyphens
---

Body in Markdown. Local images referenced from the body are uploaded
automatically when the post is sent.
```

Local image paths resolve against the directory of the Markdown file. Every
command that sends a post (`post create`, `post schedule`, `post publish`)
uploads them and rewrites the references to the hosted URLs before the draft
exists; a missing file stops the command naming it, so no post is ever
created with a broken image. Images already referenced by an http(s) URL are
left untouched, and `--dry-run` uploads nothing.

`post create` and `post schedule` honour every field above. `post publish`
honours `title`, `subtitle`, and `audience`, and warns that it is dropping
`slug`, `section`, and `cover`: prepare those with `post create`, then publish
the draft with `--id`. A command that cannot finish what the file asks for
removes the draft it had just created rather than leaving a half-made post
behind.

Headings shift down one level on import (`#` becomes an H2); a sixth-level
heading is rejected rather than flattened, as are tables and other constructs
Substack's schema has no node for.

### Exit codes

| Code | Meaning | Recovery |
|---|---|---|
| 0 | success | — |
| 1 | general failure | read stderr |
| 2 | usage error | fix the command line |
| 3 | authentication failed | refresh the cookie: `post`-less `profile login` |
| 4 | rate limited | wait a few minutes, retry |

## Agent skill

The repository ships `skills/sub-cli/SKILL.md`, a skill file that teaches
AI coding agents the CLI's judgement calls: which operations are safe to run
unattended, which need human confirmation (publishing, deleting published
posts), what each exit code calls for, and the habit of passing `--profile`
explicitly and reading `--json`.

Install it by hand by copying the directory into your agent's skill folder:

- Claude Code: `~/.claude/skills/sub-cli/SKILL.md`
- Any agent that reads markdown skills: point it at the file.

The skill assumes CLI 0.4.0 or later and is versioned independently of the
package.

## Development

```
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # unit tests (node:test), no network needed
npm run test:integration   # real-API suite; needs SUBSTACK_COOKIE +
                           # SUBSTACK_PUBLICATION_URL (see .env.example);
                           # never runs under npm test or CI
```
## Releasing

The package was renamed from `substackctl` to `@tuanhv/sub-cli` at 0.4.0
(ADR-0005); the old name was unpublished from npm. 0.4.0 itself was
bootstrapped with a manual, 2FA-protected `npm publish --access public`.
Later releases go through CI with trusted publishing (OIDC): in the
package's npmjs.com Settings, Trusted publishing points at GitHub Actions
for `hoangvantuan/substack-cli` with workflow filename `release.yml`. After
that one-time setup, every release is just `git tag vX.Y.Z &&
git push origin vX.Y.Z`; the workflow publishes with a short-lived OIDC
credential and a provenance attestation, no npm token secret involved.
Once it works, set Publishing access to "Require two-factor authentication
and disallow tokens".

## Documentation

- [`docs/api-observations.md`](docs/api-observations.md) — maintainer notes on
  the undocumented Substack API endpoints this tool exercises.
- [`docs/adr/`](docs/adr/) — architecture decision records.
- [`CONTEXT.md`](CONTEXT.md) — the project's domain vocabulary.
