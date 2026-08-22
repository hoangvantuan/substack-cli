# substack-cli

A command-line tool that manages posts on Substack and reads other people's
newsletters, paired with an agent skill that teaches AI agents when and how to
use it.

## Language

### Identity and configuration

**Profile**:
A named configuration holding exactly one cookie and exactly one publication
URL. Every authenticated command acts on one profile.
_Avoid_: account, workspace, context, environment

**Default profile**:
The profile used when a command names none. Set explicitly; never inferred from
the filesystem.
_Avoid_: current profile, active profile, selected profile

**Publication**:
A Substack newsletter, identified by its base URL. A profile points at exactly
one publication.
_Avoid_: blog, site, newsletter

**Cookie**:
The `substack.sid` value taken from a logged-in browser, used to authenticate
every authoring command. Expires after one to two weeks.
_Avoid_: token, credential, session key

### Posts

**Post**:
A piece of writing belonging to a publication. Substack stores every post as a
`draft` entity regardless of state, so post is the general term and state is
named separately.
_Avoid_: article, entry, story

**Draft**:
A post that is neither scheduled nor public.

**Scheduled post**:
A post with a future release time. Unscheduling returns it to a draft.

**Published post**:
A post that is public and whose email has been sent to subscribers. It cannot
be recalled.

**Section**:
A category defined by the publication owner to group posts. It can be assigned
to a draft, but only by a later update, never at creation time.
_Avoid_: category, tag, topic

**Audience**:
The recipient group of a release: `everyone`, `only_paid`, `only_free`, or
`founding`.

**Cover**:
The image shown as a post's header. Optional, and distinct from images that
appear in the body.
_Avoid_: thumbnail, hero, featured image

### Reading other newsletters

**Scan**:
Listing the posts of any publication without authentication. Returns metadata
only, never body content.
_Avoid_: fetch, index, list (reserved for one's own posts)

**Crawl**:
Downloading the full text of a public post and writing it to disk as Markdown.
_Avoid_: scrape, download, export
