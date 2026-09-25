# Changelog

All notable changes to `@tuanhv/sub-cli` are listed here. Versions follow
semantic versioning; before 1.0, a minor bump can contain breaking changes.

## [0.5.0] - 2026-09-25

### Added
- `post revise <id> [file]` changes a published post's title, subtitle, body,
  section, cover, or slug and makes the change live without re-emailing
  subscribers or moving its publish date. Like `post publish`, it requires
  `--profile` and `--yes`; `--dry-run` needs only `--profile`. Before writing
  it saves the live post as Markdown under `<config>/backups/`, and it refuses
  a slug change unless `--change-url` is given.
- `post update <id> --file post.md` replaces the title and body of a draft or
  scheduled post from a Markdown file, local images included.
- `post update` accepts `--cover <url>` and `--dry-run`.

### Changed
- **Breaking:** `post update` refuses published posts and points to
  `post revise`, including under `--dry-run`.
- `section set` skips published posts with a pointer to `post revise`,
  instead of reporting success for a section change that never goes live.
