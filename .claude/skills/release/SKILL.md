---
name: release
description: "Cut a new release of @tuanhv/sub-cli (this repo): pick the next version from the commits since the last release, write the CHANGELOG entry, bump package.json and the lockfile, tag vX.Y.Z, push so the Release workflow publishes to npm, then create the GitHub Release. Use whenever the maintainer says release, ship, publish to npm, cut a version, bump the version, tag a release, or asks whether there is anything worth releasing, even without naming this skill."
---

# Release @tuanhv/sub-cli

A release is one commit (`Release X.Y.Z`) and one annotated tag (`vX.Y.Z`).
Pushing a `v*` tag triggers [release.yml](../../../.github/workflows/release.yml),
which runs `npm test` and `npm publish` through npm trusted publishing (OIDC).
Nobody runs `npm publish` locally, and no npm token is involved.

A published npm version can never be reused, even after an unpublish. That is
why the one approval gate below sits before anything is committed or pushed,
and why every step after the gate stops on the first surprise.

## 1. Preconditions

Check all of these and report failures together, instead of fixing them
silently:

- On `main`, working tree clean (`git status --porcelain` empty). Uncommitted
  changes would either be left out of the release or slip into the release
  commit; the maintainer decides which, not you.
- Up to date with the remote: `git fetch origin` then `main` equals
  `origin/main`.
- CI is green for `HEAD`:
  `gh run list --workflow ci.yml --commit $(git rev-parse HEAD) --json status,conclusion`.
  No run for `HEAD` counts as unknown, say so.
- `gh auth status` works (needed for the GitHub Release at the end).

## 2. Find the baseline

The baseline is the commit of the version currently on npm:

```bash
npm view @tuanhv/sub-cli version          # what users can install
node -p "require('./package.json').version"
git describe --tags --abbrev=0            # last tag
```

Usually the npm version, `package.json`, and the last tag agree, and the
baseline is that tag. When they disagree, explain it before going on. Known
case: 0.4.0 was published by hand at the rename and has no `v0.4.0` tag, so
its baseline is the commit that set `"version": "0.4.0"`:

```bash
git log -1 --format=%h -S'"version": "0.4.0"' -- package.json
```

Do not backfill a missing tag with a push: any pushed `v*` tag starts the
Release workflow, which fails trying to republish an existing version.

## 3. Decide what changed and propose a version

Read `git log <baseline>..HEAD` and, where titles are vague, the diffs.
Sort each change by what an installed CLI user notices:

- Shipped: anything under `src/`, `bin/`, `package.json` dependencies or
  `engines`. Only `dist/` (built from these) goes into the npm tarball.
- Not shipped: `skills/`, `docs/`, `test/`, README, CI config. These do not
  need an npm release by themselves. If nothing shipped changed, say there is
  nothing to release and stop.

The package is pre-1.0, so:

- **minor** (0.4.0 → 0.5.0): a new command or flag, a behaviour change, or
  anything breaking (renamed flag, changed output, raised Node version).
- **patch** (0.4.0 → 0.4.1): bug fixes and internal changes only.

Propose one version and give the one-line reason. The maintainer decides.

## 4. Draft the CHANGELOG entry

`CHANGELOG.md` lives at the repo root in Keep a Changelog style. If it does
not exist yet, create it with this header and only the new entry; do not
reconstruct older versions unless asked:

```markdown
# Changelog

All notable changes to `@tuanhv/sub-cli` are listed here. Versions follow
semantic versioning; before 1.0, a minor bump can contain breaking changes.
```

New entries go right under the header, newest first:

```markdown
## [0.5.0] - 2026-09-25

### Added
- `post update <id> --file post.md` replaces the title and body of a draft
  from a markdown file.

### Changed
- **Breaking:** `post update` refuses published posts; it only edits drafts.

### Fixed
- ...
```

Write for someone running the CLI, not for someone reading the git log: name
the command and flag, say what now happens. Merge commits, refactors, tests,
and doc-only changes are left out. Put breaking changes first in their
section and start them with **Breaking:**. Use only the headings that have
entries (Added, Changed, Fixed, Removed). Date is today, `YYYY-MM-DD`.

## 5. Approval gate

Show the maintainer, in one message:

- baseline → new version, and why that bump
- the commits in range (short hash + title)
- the full CHANGELOG entry
- a `skills/sub-cli` note (see below)
- the steps that follow: commit, tag, push `main`, push tag (publishes to
  npm), create the GitHub Release

Wait for an explicit yes. A change to the version or wording means showing
the revised plan again. The approval covers exactly this plan; if a later
step fails or anything changes, stop and come back.

**`skills/sub-cli` note.** That skill states the minimum CLI version it needs
("Requires `sub-cli` 0.4.0 or later"), and README repeats it. If the skill
now relies on a flag or command introduced in this release, both lines
should say the new version. Check `git log <baseline>..HEAD -- skills/` and
say whether the minimum needs raising; if it does, the edit goes into the
release commit.

## 6. Bump, verify, commit, tag

```bash
npm version X.Y.Z --no-git-tag-version   # package.json + package-lock.json
npm run typecheck
npm test                                 # pretest builds dist/
```

`--no-git-tag-version` matters: plain `npm version` makes its own commit and
lightweight tag, which does not match this repo's annotated `Release X.Y.Z`
tags. If typecheck or tests fail, stop and report; do not tag a broken tree.

```bash
git add package.json package-lock.json CHANGELOG.md   # + skill/README if raised
git commit -m "Release X.Y.Z"      # add the session's attribution trailer, if any
git tag -a vX.Y.Z -m "Release X.Y.Z"
```

## 7. Push and watch the publish

Push `main` first, then the tag, as two commands. If `main` is rejected, the
tag has not left the machine and nothing is published yet.

```bash
git push origin main
git push origin vX.Y.Z
```

Find and follow the Release run for the tag (a tag push shows the tag as the
run's branch):

```bash
gh run list --workflow release.yml --branch vX.Y.Z --json databaseId,status,conclusion
gh run watch <databaseId> --exit-status
```

Then confirm npm serves it. The registry can lag a minute behind the run:

```bash
npm view @tuanhv/sub-cli version   # expect X.Y.Z
```

## 8. GitHub Release

Only after npm shows the new version, so a GitHub Release never announces a
version users cannot install. Use the CHANGELOG entry body (without its
`## [X.Y.Z]` heading) as the notes:

```bash
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file <entry.md>
```

Write the entry to a temp file in the scratchpad, not the repo. Report the
npm version and the release URL to the maintainer.

## When the Release workflow fails

Read the failed step with `gh run view <id> --log-failed`, then check npm:

- **Not on npm** (tests or publish failed): the version is still free. Fix on
  `main` with a normal commit. Moving a pushed tag rewrites public history,
  so ask before `git push --delete origin vX.Y.Z` and re-tagging the fixed
  commit. The CHANGELOG entry stays as written.
- **Already on npm** (a later step failed, or you are unsure): the version is
  used up. Never delete and re-push the same tag. Finish the missing steps by
  hand, or release the fix as the next patch.
