# Rename the package to @tuanhv/sub-cli

The tool shipped as `substackctl` for its first four releases (0.1.0 to
0.3.0), all published within a few hours of each other and with no external
users. The repository had been called `substack-cli` all along, so the
package name, the command people type, and the repo name disagreed.

From 0.4.0 the package is `@tuanhv/sub-cli` and the command is `sub-cli`.

The rename is a clean break, deliberately:

- the binary is renamed with no deprecated `substackctl` alias;
- profiles are not migrated: the CLI now reads and writes
  `~/.config/sub-cli/` and the old `~/.config/substackctl/` directory is
  left in place, untouched;
- `SUBSTACKCTL_NO_UPDATE_CHECK` becomes `SUB_CLI_NO_UPDATE_CHECK`;
- `SUBSTACK_PUBLICATION_URL` and `SUBSTACK_COOKIE` keep their names,
  because they describe the external Substack service, not this tool.

## Consequences

The old package was unpublished from npm rather than deprecated, inside
npm's 72-hour window (it had no downloaders and no dependents). That frees
the name `substackctl` for anyone to register later; the risk was accepted
because the package was hours old. Should a stranger ever publish under
that name, it has nothing to do with this project.

Fresh 0.4.0 had to be bootstrapped with a manual publish again, and
trusted publishing (OIDC) re-pointed at the new package name; from 0.5.0
the tag-push release flow works as before. Users of the old name find
nothing on npm and must discover this repository, which at this size is
the honest state of the world.
