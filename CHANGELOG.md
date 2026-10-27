# Changelog

All notable changes to `@tuanhv/sub-cli` are listed here. Versions follow
semantic versioning; before 1.0, a minor bump can contain breaking changes.

## [0.6.1] - 2026-10-27

### Fixed
- Ordered list items numbered 10 or higher (`10. item`, `100. item`) with
  text on the marker line no longer fail as an "indented code block". A list
  item with up to four spaces after its marker now converts too; five or more
  spaces is still refused as indented code.
- A post containing a Markdown table is still refused, but the error now says
  how to fix it: rewrite the rows as a list or wrap the table in a fenced
  block.

## [0.6.0] - 2026-10-24

### Added
- `image upload <file>...` uploads local image files and prints one hosted
  URL per file on stdout, so a local cover can be set with
  `--cover "$(sub-cli image upload cover.png)"`. A cover that is not an
  http(s) URL is now refused with a pointer to this command.

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
