# Post state picks the command: update for drafts, revise for published posts

`post update` used to accept any post id. On a published post it silently did
the wrong thing: subtitle and section changes land in staged fields that never
go live, while a slug change goes live at once and freezes the old URL on a
stale copy (see `docs/api-observations.md`, "Revising a published post"). The
command printed "updated" either way.

We could have kept one command and added an unlock flag such as
`--force-published`, mirroring `post delete`. Instead the post's state picks
the command:

- `post update` works on drafts and scheduled posts only, and refuses a
  published post with a pointer to `post revise`.
- `post revise` works on published posts only. It changes content (from a
  Markdown file) and metadata, then republishes with `send:false` so the change
  actually goes live. Like `post publish` (ADR 0004), it ignores the default
  profile and requires `--profile` and `--yes`.

## Why not a flag

A flag gives two doors into the same public, unrecoverable action, each with
its own checks to keep in sync. Revising also needs steps a draft edit never
does: a backup of the live version, a refusal when the post has pending
changes from the web editor, and the republish itself. Putting those behind a
flag on `update` would make `update` two commands sharing one name.

## Consequences

An agent or script that edits a post must know the post's state before picking
the command. Both commands read the state first and name the right command when
refused, so a wrong guess costs one round trip, never a silent no-op.
