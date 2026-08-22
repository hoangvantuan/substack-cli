# Publishing requires an explicit profile and confirmation flag

Every other command falls back to the default profile, so `post publish` could
have done the same. But publishing is the only irreversible action in the tool:
the post goes public and the email reaches subscribers with no way to recall
it, and publishing to the wrong publication cannot be undone.

`post publish` therefore ignores the default profile and requires both
`--profile` and `--yes`.

## Consequences

The command is deliberately inconsistent with the rest of the CLI. The
inconsistency is the point: it costs two flags on one command, and it makes the
one action that cannot be taken back impossible to trigger absent-mindedly.

The agent skill also instructs agents to ask the user before publishing, but
that is a soft brake: an agent can forget it, and an agent without the skill
installed never sees it. This ADR records the hard brake.
