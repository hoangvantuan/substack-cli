# Rewrite in TypeScript, calling the Substack HTTP API directly

The prior implementation was a Python script built on `python-substack`, but it
had already bypassed most of that library: sections were fetched through
`api._session.get()`, scheduling used `scheduled_release` instead of the
library's dead `schedule` endpoint, and the Markdown conversion was patched at
runtime. Only cookie-based session setup was still being used.

We rewrote the tool in TypeScript so it publishes to npm and runs under `npx`
with no Python or `uv` on the user's machine, and we call the Substack HTTP API
directly rather than through any client library.

## Considered options

Wrapping the Python script inside an npm package was rejected: it would require
both runtimes on every machine and spread bugs across two layers.

Reusing an existing npm client was investigated and found impossible.
`substack-api` (v4.0.2) reads posts and writes Notes but cannot create,
schedule, or publish a post, and its author has marked it as no longer
developed. `substack-sdk` (v1.1.1) covers only image upload, notes, and
subscribers. No published package supports the authoring surface this tool
needs.

## Consequences

We own the API surface, including the undocumented endpoints recorded in
`docs/substack-api.md`. When Substack changes them, nothing upstream will fix
it for us.
