# Markdown headings are shifted down one level

A Substack post already renders its title as the top-level heading of the page.
A body heading written as `#` would therefore produce a second top-level
heading competing with the title.

Markdown headings are shifted down one level on the way in: `#` becomes H2,
`##` becomes H3, and so on through H6. `######` has no room left to shift and
is rejected rather than silently flattened.

## Consequences

This looks like an off-by-one bug to anyone reading the converter without this
context. It is deliberate. Do not "fix" it.
