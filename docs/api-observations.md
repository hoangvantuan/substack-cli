# Observed Substack API behaviour

**This document records observations from building and running `substackctl`
against the live platform. It is not a specification:** Substack does not
publish one, every statement below was learned empirically, and any of it may
change without notice. Verify against the live API before relying on a detail
this document does not cover.

Last verified: 2026-08, CLI 0.1.0.

## Conventions

- Publication-scoped calls go to `https://<publication>.substack.com/api/v1/...`.
- Authoring calls need the cookie header `substack.sid=<value>`; the value is
  an express-style session starting with `s%3A`. Reader-side calls on
  substack.com use the same cookie.
- Errors are express-style bodies: `{"errors":[{"location","param","msg"}]}` —
  except rate limiting, which is `text/plain` with no useful headers (below).
- A browser-like `User-Agent` is sometimes required; default script runtimes
  can be blocked outright at the edge (HTTP 403 / Cloudflare error 1010).

## Reading (no authentication)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/posts?limit=&offset=` | Public feed/archive listing. `limit` accepted up to 49 (50 answers 400). Each entry carries full `body_html`, `publishedBylines[].name`, metadata. |
| GET | `/api/v1/posts/{slug}` | Full post object incl. `body_html`. Numeric ids answer 404 (`{"error":"Post not found"}`); slugs are required. |

## Rate limiting

- 429 responses are `text/plain` and carry neither `Retry-After` nor any
  `x-ratelimit-*` header. The only practical strategy is a fixed increasing
  backoff ladder.
- The limiter punishes sustained activity across minutes, not single bursts:
  spaced-out requests succeed right after a burst that tripped it.

## Drafts

| Method | Path | Payload | Notes |
|---|---|---|---|
| GET | `/api/v1/drafts?limit=&offset=` | — | `{posts, hasMore, nextCursor}`; `nextCursor` equals the next offset. `limit` max 49. Returns drafts **and** published/scheduled posts; filter client-side via `is_published` / `post_date`. Listing entries expose `draft_section_name` but may lag behind the detail endpoint after assignment. |
| POST | `/api/v1/drafts` | `{draft_title, draft_subtitle, draft_body (stringified ProseMirror doc), draft_bylines:[{id, is_guest:false}], type:"newsletter", audience, cover_image?}` | `draft_bylines[0].id` must be a real user id (see below); `null` is rejected with 400. |
| GET | `/api/v1/drafts/{id}` | — | Detail object. `draft_section_id` is populated here; `section_id`/`section_name`/`section_slug` always read null. |
| PUT | `/api/v1/drafts/{id}` | Partial patch: `{slug?, draft_subtitle?, draft_section_id?, section_chosen?: boolean}` | Several fields ride one request. `slug` must be unique across the publication ("There is already another post with this slug"). |
| DELETE | `/api/v1/drafts/{id}` | — | 200 `{}`; a follow-up GET answers 404. |

### Bylines

`GET /api/v1/publication/users` lists the account's users with numeric `id`,
`role`, `is_byline_only`. The owner id for bylines is the admin entry with
`is_byline_only: false`.

### Sections

- `GET /api/v1/publication/sections` — sections as the owner sees them.
- `POST /api/v1/publication/sections` `{name, description}` — both fields are
  required (missing `description` answers 400). Returns `{section:{...}}`.
- `DELETE /api/v1/publication/sections/{id}` — returns `200` with body `"1"`.

Scheduling requires the draft to have been saved once with
`{section_chosen: true}` (a boolean; sending the section id in that field
answers 400) or the release endpoint answers 400
`{"error":"Please choose a section."}`. The assigned `draft_section_id`
itself does not satisfy the check.

### Field trap

`section_id`, `section_name`, and `section_slug` read null everywhere even
when a section is assigned. The populated fields are `draft_section_id`
(detail endpoint) and `draft_section_name` (post-management listings).

## Scheduling and publishing

| Method | Path | Payload | Notes |
|---|---|---|---|
| GET | `/api/v1/drafts/{id}/scheduled_release` | — | `[]` when clear; otherwise `[{trigger_at, post_audience, email_audience}]`. |
| POST | `/api/v1/drafts/{id}/scheduled_release` | `{trigger_at, post_audience}` | The dedicated release endpoint. Accepts UTC-Z and offset timestamps, normalises to UTC. Never publishes by itself. Requires `section_chosen` saved first (above). Substack rejects trigger times further than ~3 months out. |
| DELETE | `/api/v1/drafts/{id}/scheduled_release` | — | Removes the pending release; the post returns to draft state. |
| GET | `/api/v1/post_management/{drafts\|scheduled\|published}?offset=&limit=&order_by=draft_updated_at&order_direction=desc` | — | Requires both ordering params (400 without them). `limit` max 50. Response: `{isCapped, limit, offset, posts, total}`. |
| GET | `/api/v1/drafts/{id}/prepublish` | — | `{errors[], suggestions[]}`. Flaky in practice; treat failures as advisory. |
| POST | `/api/v1/drafts/{id}/publish` | `{send: boolean, share_automatically: false}` | Irreversible. `send:false` publishes to web only (`should_send_email:false`). |

## Images

| Method | Path | Payload | Notes |
|---|---|---|---|
| POST | `/api/v1/image` | form-urlencoded field `image`: a data URI (`data:image/png;base64,...`) or an http(s) URL to re-host | Single-step upload answering `{id, url, contentType, bytes, imageWidth, imageHeight}`; `url` is a permanent `substack-post-media.s3.amazonaws.com/...` link. Missing/empty field answers 400. The multi-step media-upload + S3 PUT flow some libraries use was not observed (404). |

## Session notes

- `substack.sid` values start `s%3A`; pasted copies often include the cookie
  name or surrounding quotes, so trim before use.
- The auxiliary cookie `substack.lli` (a JWT carrying userId/iat/exp/aud) does
  not authenticate the authoring endpoints on its own.
