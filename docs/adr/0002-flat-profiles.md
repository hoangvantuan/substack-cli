# A profile is a flat pair of cookie and publication

A Substack cookie authenticates a *user account*, and one account can own
several publications. We could therefore have modelled two layers, accounts
holding cookies and publications pointing at them, so that one expired cookie
could be replaced once for every publication behind it.

We chose the flat model instead: a profile is one cookie plus one publication
URL, with no shared account entity.

## Consequences

An owner of several publications stores the same cookie once per profile, and
must re-paste it once per profile when it expires, which happens every one to
two weeks. This was accepted knowingly in exchange for a configuration file
that can be read at a glance and commands that never have to explain which
layer they act on.

Two mitigations exist. `profile check` verifies a cookie is still alive, and
each profile records `cookieUpdatedAt` so the CLI can warn before a cookie is
likely to expire rather than surfacing an opaque `400 Invalid value`.

If the number of profiles grows past a handful, revisit this: `profile login`
was deliberately given a shape that can later accept several profile names in
one invocation without breaking its syntax.
