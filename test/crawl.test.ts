import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpRequest, HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv, postFixture, type TestHarness } from './helpers.js';
import { htmlToMarkdown } from '../src/reading/crawl-markdown.js';

const DETAIL_URL = 'https://onestacks.substack.com/api/v1/posts/hello-world';
const FILE = 'onestacks/2026-08-01-hello-world.md';
const EXPECTED_FILE = [
  '---',
  'title: "Hello world"',
  'subtitle: "a first post"',
  'author: "Ann Author"',
  'date: "2026-08-01"',
  'source_url: "https://onestacks.substack.com/p/hello-world"',
  'publication: "onestacks"',
  '---',
  '',
  'Hello **bold** world',
  '',
].join('\n');

/** A post detail as the public post endpoint returns it. */
function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return postFixture({
    canonical_url: 'https://onestacks.substack.com/p/hello-world',
    body_html: '<p>Hello <strong>bold</strong> world</p>',
    publishedBylines: [{ id: 7, name: 'Ann Author' }],
    ...overrides,
  });
}

/** A feed item as the public feed endpoint returns it. */
function feedItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return postFixture({
    canonical_url: 'https://onestacks.substack.com/p/hello-world',
    body_html: '<p>Body</p>',
    publishedBylines: [],
    ...overrides,
  });
}

interface FileStore {
  files: Map<string, string>;
  dirs: string[];
}

/** makeEnv with a recording filesystem seeded with `existing` paths. */
function makeEnvWithFs(
  respond?: (request: HttpRequest, index: number) => HttpResponse | Promise<HttpResponse>,
  existing: string[] = [],
): TestHarness & { store: FileStore } {
  const h = makeEnv(respond);
  const store: FileStore = { files: new Map(), dirs: [] };
  const existingPaths = new Set(existing);
  h.env.fs = {
    readFile: (path) =>
      store.files.has(path)
        ? Promise.resolve(store.files.get(path)!)
        : Promise.reject(new Error(`no such file: ${path}`)),
    writeFile: (path, contents) => {
      store.files.set(path, contents);
      return Promise.resolve();
    },
    mkdir: (path) => {
      store.dirs.push(path);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(store.files.has(path) || existingPaths.has(path)),
  };
  return { ...h, store };
}

// ---------------------------------------------------------------------------
// feed crawl
// ---------------------------------------------------------------------------

test('crawl fetches the post by slug, writes it, and exits 0', async () => {
  const h = makeEnvWithFs(() => jsonResponse(detail()));
  const code = await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.url, DETAIL_URL);
  assert.deepEqual(h.sleeps, []);
  assert.deepEqual(h.store.dirs, ['onestacks']);
  assert.match(h.stderr(), /wrote onestacks\/2026-08-01-hello-world\.md/);
});

test('the written file carries the shared front matter schema', async () => {
  const h = makeEnvWithFs(() => jsonResponse(detail()));
  await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world'], h.env);
  assert.equal(h.store.files.get(FILE), EXPECTED_FILE);
});

test('a trailing slash on the post URL is accepted', async () => {
  const h = makeEnvWithFs(() => jsonResponse(detail()));
  await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world/'], h.env);
  assert.equal(h.requests[0]?.url, DETAIL_URL);
});

test('a custom domain keeps its full hostname in the directory and front matter', async () => {
  const h = makeEnvWithFs(() =>
    jsonResponse(detail({ canonical_url: 'https://blog.example.com/p/hello-world' })),
  );
  await runCli(['feed', 'crawl', 'https://blog.example.com/p/hello-world'], h.env);
  assert.equal(h.requests[0]?.url, 'https://blog.example.com/api/v1/posts/hello-world');
  const contents = h.store.files.get('blog.example.com/2026-08-01-hello-world.md') ?? '';
  assert.match(contents, /publication: "blog\.example\.com"/);
});

test('multiple bylines are joined into one author value', async () => {
  const h = makeEnvWithFs(() =>
    jsonResponse(detail({ publishedBylines: [{ name: 'Ann Author' }, { name: 'Bob Writer' }] })),
  );
  await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world'], h.env);
  assert.match(h.store.files.get(FILE) ?? '', /author: "Ann Author, Bob Writer"/);
});

test('a post without a date lands in an undated file', async () => {
  const h = makeEnvWithFs(() => jsonResponse(detail({ post_date: null })));
  await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world'], h.env);
  assert.ok(h.store.files.has('onestacks/undated-hello-world.md'));
});

test('a post without a body writes front matter only and says so', async () => {
  const h = makeEnvWithFs(() => jsonResponse(detail({ body_html: null })));
  const code = await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world'], h.env);
  assert.equal(code, 0);
  const contents = h.store.files.get(FILE);
  assert.ok(contents !== undefined && contents.endsWith('---\n'));
  assert.match(h.stderr(), /no body in the post; wrote front matter only/);
});

test('an already-crawled file is skipped on the error stream, never silently', async () => {
  const h = makeEnvWithFs(() => jsonResponse(detail()), [FILE]);
  const code = await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world'], h.env);
  assert.equal(code, 0);
  assert.equal(h.store.files.size, 0);
  assert.deepEqual(h.store.dirs, []);
  assert.match(h.stderr(), /skipped onestacks\/2026-08-01-hello-world\.md \(already crawled\)/);
  assert.ok(!/wrote/.test(h.stderr()));
});

test('--overwrite refreshes an existing file', async () => {
  const h = makeEnvWithFs(() => jsonResponse(detail()), [FILE]);
  const code = await runCli(
    ['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world', '--overwrite'],
    h.env,
  );
  assert.equal(code, 0);
  assert.equal(h.store.files.get(FILE), EXPECTED_FILE);
  assert.match(h.stderr(), /wrote/);
});

test('--out writes under the given directory', async () => {
  const h = makeEnvWithFs(() => jsonResponse(detail()));
  await runCli(
    ['feed', 'crawl', 'https://onestacks.substack.com/p/hello-world', '--out', 'data'],
    h.env,
  );
  assert.ok(h.store.files.has('data/onestacks/2026-08-01-hello-world.md'));
  assert.deepEqual(h.store.dirs, ['data/onestacks']);
});

test('a URL that is not a post URL is a usage error', async () => {
  const h = makeEnvWithFs();
  const code = await runCli(['feed', 'crawl', 'https://onestacks.substack.com/about'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /not a post URL/);
});

test('a URL that does not parse is a usage error', async () => {
  const h = makeEnvWithFs();
  const code = await runCli(['feed', 'crawl', 'not-a-url'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /invalid post URL/);
});

test('crawl usage errors: missing url, extra positional, unknown option', async () => {
  const missing = makeEnvWithFs();
  assert.equal(await runCli(['feed', 'crawl'], missing.env), 2);
  assert.match(missing.stderr(), /missing <url>/);
  const extra = makeEnvWithFs();
  assert.equal(
    await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/a', 'b'], extra.env),
    2,
  );
  const unknown = makeEnvWithFs();
  assert.equal(
    await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/a', '--bogus'], unknown.env),
    2,
  );
});

test('a missing post exits 1 with a not-found message', async () => {
  const h = makeEnvWithFs(() => jsonResponse({ error: 'Post not found' }, 404));
  const code = await runCli(['feed', 'crawl', 'https://onestacks.substack.com/p/gone'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /post not found/);
  assert.equal(h.store.files.size, 0);
});

// ---------------------------------------------------------------------------
// feed crawl-all
// ---------------------------------------------------------------------------

test('crawl-all crawls the recent feed in a single request without pacing', async () => {
  const h = makeEnvWithFs(() =>
    jsonResponse([feedItem(), feedItem({ id: 2, slug: 'second-post', title: 'Second' })]),
  );
  const code = await runCli(['feed', 'crawl-all', 'onestacks'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.url, 'https://onestacks.substack.com/api/v1/posts?limit=10&offset=0');
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.store.files.size, 2);
  assert.match(h.store.files.get(FILE) ?? '', /title: "Hello world"/);
});

test('--limit bounds the requested feed', async () => {
  const h = makeEnvWithFs(() => jsonResponse([feedItem()]));
  await runCli(['feed', 'crawl-all', 'onestacks', '--limit', '1'], h.env);
  assert.equal(h.requests[0]?.url, 'https://onestacks.substack.com/api/v1/posts?limit=1&offset=0');
});

test('--all walks every page of the archive with pacing between requests', async () => {
  const pageOne = Array.from({ length: 25 }, (_, i) =>
    feedItem({ id: i + 1, slug: `post-${i + 1}`, title: `Post ${i + 1}` }),
  );
  const pageTwo = [feedItem({ id: 26, slug: 'post-26' }), feedItem({ id: 27, slug: 'post-27' })];
  const h = makeEnvWithFs((_request, index) =>
    jsonResponse(index === 0 ? pageOne : pageTwo),
  );
  const code = await runCli(['feed', 'crawl-all', 'onestacks', '--all'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(
    h.requests.map((r) => r.url),
    [
      'https://onestacks.substack.com/api/v1/posts?limit=25&offset=0',
      'https://onestacks.substack.com/api/v1/posts?limit=25&offset=25',
    ],
  );
  assert.deepEqual(h.sleeps, [500]);
  assert.equal(h.store.files.size, 27);
});

test('skips inside a batch are noted while the rest is still written', async () => {
  const h = makeEnvWithFs(
    () => jsonResponse([feedItem(), feedItem({ id: 2, slug: 'second-post', title: 'Second' })]),
    [FILE],
  );
  const code = await runCli(['feed', 'crawl-all', 'onestacks'], h.env);
  assert.equal(code, 0);
  assert.equal(h.store.files.size, 1);
  assert.ok(h.store.files.has('onestacks/2026-08-01-second-post.md'));
  assert.match(h.stderr(), /skipped onestacks\/2026-08-01-hello-world\.md \(already crawled\)/);
  assert.match(h.stderr(), /wrote onestacks\/2026-08-01-second-post\.md/);
});

test('an empty feed writes nothing and says so', async () => {
  const h = makeEnvWithFs(() => jsonResponse([]));
  const code = await runCli(['feed', 'crawl-all', 'onestacks'], h.env);
  assert.equal(code, 0);
  assert.equal(h.store.files.size, 0);
  assert.match(h.stderr(), /no posts found/);
});

test('crawl-all usage errors mirror scan', async () => {
  const missing = makeEnvWithFs();
  assert.equal(await runCli(['feed', 'crawl-all'], missing.env), 2);
  assert.match(missing.stderr(), /missing <publication>/);
  const conflict = makeEnvWithFs();
  assert.equal(
    await runCli(['feed', 'crawl-all', 'onestacks', '--all', '--limit', '5'], conflict.env),
    2,
  );
  assert.match(conflict.stderr(), /--limit cannot be combined with --all/);
  const badLimit = makeEnvWithFs();
  assert.equal(
    await runCli(['feed', 'crawl-all', 'onestacks', '--limit', '0'], badLimit.env),
    2,
  );
});

test('a missing publication exits 1', async () => {
  const h = makeEnvWithFs(() => jsonResponse({ error: 'Not found' }, 404));
  const code = await runCli(['feed', 'crawl-all', 'no-such-publication'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /publication not found/);
});

// ---------------------------------------------------------------------------
// html to markdown conversion (pure seam)
// ---------------------------------------------------------------------------

test('body headings shift one level up, matching the post heading offset', () => {
  assert.equal(
    htmlToMarkdown('<h2>Section</h2><h3>Sub</h3><h4>Minor</h4>'),
    '# Section\n\n## Sub\n\n### Minor',
  );
});

test('inline emphasis maps both tag spellings', () => {
  assert.equal(
    htmlToMarkdown('<p>Some <strong>bold</strong> and <em>italic</em> and <b>bold2</b> <i>it2</i> text</p>'),
    'Some **bold** and *italic* and **bold2** *it2* text',
  );
});

test('links keep their href', () => {
  assert.equal(
    htmlToMarkdown('<p>See <a href="https://example.com/a?b=1">the docs</a></p>'),
    'See [the docs](https://example.com/a?b=1)',
  );
});

test('unordered and ordered lists render with nesting', () => {
  assert.equal(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
  assert.equal(htmlToMarkdown('<ol><li>first</li><li>second</li></ol>'), '1. first\n2. second');
  assert.equal(
    htmlToMarkdown('<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>'),
    '- a\n  - a1\n- b',
  );
});

test('paragraphs inside list items render as plain item text', () => {
  assert.equal(
    htmlToMarkdown('<ol><li><p><span>Step one</span></p></li><li><p>Step two</p></li></ol>'),
    '1. Step one\n2. Step two',
  );
});

test('blockquotes keep their paragraphs', () => {
  assert.equal(
    htmlToMarkdown('<blockquote><p>Quoted.</p><p>More.</p></blockquote>'),
    '> Quoted.\n>\n> More.',
  );
});

test('code blocks are fenced, with the language when present', () => {
  assert.equal(htmlToMarkdown('<pre><code>let x = 1;</code></pre>'), '```\nlet x = 1;\n```');
  assert.equal(
    htmlToMarkdown('<pre><code class="language-ts">let x = 1;</code></pre>'),
    '```ts\nlet x = 1;\n```',
  );
});

test('inline code is spanned with backticks', () => {
  assert.equal(htmlToMarkdown('<p>Use <code>npm test</code> now</p>'), 'Use `npm test` now');
});

test('hr and br render as markdown', () => {
  assert.equal(htmlToMarkdown('<p>a</p><hr><p>b</p>'), 'a\n\n---\n\nb');
  assert.equal(htmlToMarkdown('<p>line one<br>line two</p>'), 'line one  \nline two');
});

test('a Substack figure becomes an image with its caption, URL untouched', () => {
  const src = 'https://substackcdn.com/image/fetch/w_1456/https%3A%2F%2Fexample.com%2Fa.png';
  const html =
    '<div class="captioned-image-container"><figure>' +
    '<a class="image-link image2 is-viewable-img" target="_blank" href="https://substackcdn.com/image/fetch/full/https%3A%2F%2Fexample.com%2Fa.png">' +
    '<div class="image2-inset"><picture><source type="image/webp" srcset="x 424w"></source>' +
    `<img src="${src}" width="872" height="580" data-attrs="{}">` +
    '</picture></div></a>' +
    '<figcaption class="image-caption">A caption</figcaption>' +
    '</figure></div>';
  assert.equal(htmlToMarkdown(html), `![](${src})\n\n*A caption*`);
});

test('unknown embed blocks are kept as raw HTML', () => {
  const embed =
    '<div class="twitter-embed" data-attrs="{&quot;url&quot;:&quot;https://x.com/1&quot;}"></div>';
  assert.equal(htmlToMarkdown(`<p>Before</p>${embed}<p>After</p>`), `Before\n\n${embed}\n\nAfter`);
});

test('a bare divider div still yields a markdown rule', () => {
  assert.equal(htmlToMarkdown('<div><hr></div>'), '---');
});

test('entities are decoded in text', () => {
  assert.equal(
    htmlToMarkdown('<p>Tom &amp; Jerry &#8212; &#39;quotes&#39;</p>'),
    "Tom & Jerry — 'quotes'",
  );
});

test('markdown-significant characters in text are escaped', () => {
  assert.equal(
    htmlToMarkdown('<p>a * b _ c [ d ] e &lt; f ` g</p>'),
    'a \\* b \\_ c \\[ d \\] e \\< f \\` g',
  );
  assert.equal(htmlToMarkdown('<p>#1 reason</p>'), '\\#1 reason');
});

test('relative image URLs resolve against the publication base', () => {
  const md = htmlToMarkdown('<p><img src="/img/x.png" alt="pic"></p><img src="//cdn.example.com/a.webp">', {
    baseUrl: 'https://on.substack.com',
  });
  assert.equal(md, '![pic](https://on.substack.com/img/x.png)\n\n![](https://cdn.example.com/a.webp)');
});
