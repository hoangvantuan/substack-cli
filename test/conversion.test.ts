import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMarkdownToDocument, ConversionError } from '../src/conversion/markdown.js';
import { validateDocument } from '../src/conversion/schema.js';
import type { SubstackDocument } from '../src/conversion/types.js';

function convert(markdown: string): SubstackDocument {
  const { document } = convertMarkdownToDocument(markdown);
  const violations = validateDocument(document);
  assert.deepEqual(violations, [], 'converted document must satisfy the declared schema');
  return document;
}

function reject(markdown: string, construct: string): void {
  try {
    convertMarkdownToDocument(markdown);
  } catch (error) {
    if (error instanceof ConversionError) {
      assert.match(error.message, new RegExp(construct, 'i'));
      return;
    }
    throw error;
  }
  assert.ok(false, `expected conversion to reject: ${construct}`);
}

test('a paragraph of plain text converts to a doc with one paragraph', () => {
  assert.deepEqual(convert('Hello world.'), {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world.' }] }],
  });
});

test('soft line breaks within a paragraph become spaces', () => {
  assert.deepEqual(convert('first line\nsecond line'), {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first line second line' }] }],
  });
});

test('a trailing double space becomes a hard break node', () => {
  assert.deepEqual(convert('first  \nsecond'), {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'first' }, { type: 'hard_break' }, { type: 'text', text: 'second' }],
      },
    ],
  });
});

test('bold, italic, and bold italic become strong, em, and both marks', () => {
  const doc = convert('**bold** and *italic* and ***both***');
  assert.deepEqual(doc.content[0]?.content, [
    { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
    { type: 'text', text: ' and ' },
    { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
    { type: 'text', text: ' and ' },
    { type: 'text', text: 'both', marks: [{ type: 'em' }, { type: 'strong' }] },
  ]);
});

test('underscore emphasis matches asterisk emphasis', () => {
  const doc = convert('__bold__ and _italic_');
  assert.deepEqual(doc.content[0]?.content, [
    { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
    { type: 'text', text: ' and ' },
    { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
  ]);
});

test('emphasis does not fire on intraword underscores', () => {
  const doc = convert('snake_case_name stays literal');
  assert.deepEqual(doc.content[0]?.content, [{ type: 'text', text: 'snake_case_name stays literal' }]);
});

test('a link becomes a text node with a link mark', () => {
  const doc = convert('see [the docs](https://example.com) now');
  assert.deepEqual(doc.content[0]?.content, [
    { type: 'text', text: 'see ' },
    { type: 'text', text: 'the docs', marks: [{ type: 'link', attrs: { href: 'https://example.com', title: null } }] },
    { type: 'text', text: ' now' },
  ]);
});

test('a link title is carried in the link mark', () => {
  const doc = convert('[docs](https://example.com "Example")');
  assert.deepEqual(doc.content[0]?.content, [
    {
      type: 'text',
      text: 'docs',
      marks: [{ type: 'link', attrs: { href: 'https://example.com', title: 'Example' } }],
    },
  ]);
});

test('bold wrapping a link produces one text node with both marks', () => {
  const doc = convert('**[text](https://target.com)**');
  assert.deepEqual(doc.content[0]?.content, [
    {
      type: 'text',
      text: 'text',
      marks: [
        { type: 'strong' },
        { type: 'link', attrs: { href: 'https://target.com', title: null } },
      ],
    },
  ]);
});

test('an autolink becomes a link whose text is the url', () => {
  const doc = convert('go to <https://example.com> today');
  assert.deepEqual(doc.content[0]?.content, [
    { type: 'text', text: 'go to ' },
    {
      type: 'text',
      text: 'https://example.com',
      marks: [{ type: 'link', attrs: { href: 'https://example.com', title: null } }],
    },
    { type: 'text', text: ' today' },
  ]);
});

test('inline code becomes a text node with the code mark', () => {
  const doc = convert('run `npm test` now');
  assert.deepEqual(doc.content[0]?.content, [
    { type: 'text', text: 'run ' },
    { type: 'text', text: 'npm test', marks: [{ type: 'code' }] },
    { type: 'text', text: ' now' },
  ]);
});

test('code spans take priority over emphasis inside them', () => {
  const doc = convert('`a *b* c`');
  assert.deepEqual(doc.content[0]?.content, [
    { type: 'text', text: 'a *b* c', marks: [{ type: 'code' }] },
  ]);
});

test('strikethrough becomes a strikethrough mark', () => {
  const doc = convert('~~gone~~ but not forgotten');
  assert.deepEqual(doc.content[0]?.content, [
    { type: 'text', text: 'gone', marks: [{ type: 'strikethrough' }] },
    { type: 'text', text: ' but not forgotten' },
  ]);
});

test('backslash escapes suppress markdown meaning', () => {
  const doc = convert('\\*not emphasis\\*');
  assert.deepEqual(doc.content[0]?.content, [{ type: 'text', text: '*not emphasis*' }]);
});

test('headings shift down one level: # becomes level 2', () => {
  assert.deepEqual(convert('# Title'), {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    ],
  });
  assert.deepEqual(convert('## Section').content[0]?.attrs, { level: 3 });
  assert.deepEqual(convert('##### Deep').content[0]?.attrs, { level: 6 });
});

test('a sixth-level heading is rejected, not flattened', () => {
  reject('###### Too deep', 'sixth-level heading');
});

test('a setext heading is rejected by name', () => {
  reject('Title\n=====', 'setext heading');
});

test('a thematic break becomes a horizontal_rule', () => {
  assert.deepEqual(convert('above\n\n---\n\nbelow').content[1], { type: 'horizontal_rule' });
});

test('a bullet list becomes bullet_list of list_item paragraphs', () => {
  const doc = convert('- one\n- two');
  assert.deepEqual(doc.content, [
    {
      type: 'bullet_list',
      content: [
        { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
      ],
    },
  ]);
});

test('an ordered list becomes ordered_list and keeps a non-1 start in attrs.order', () => {
  assert.deepEqual(convert('1. first\n2. second').content, [
    {
      type: 'ordered_list',
      content: [
        { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
        { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
      ],
    },
  ]);
  const started = convert('4. fourth');
  assert.deepEqual(started.content[0]?.attrs, { order: 4 });
});

test('a nested list nests inside its parent list item', () => {
  const doc = convert('- outer\n  - inner');
  assert.deepEqual(doc.content, [
    {
      type: 'bullet_list',
      content: [
        {
          type: 'list_item',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'outer' }] },
            {
              type: 'bullet_list',
              content: [
                { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] },
              ],
            },
          ],
        },
      ],
    },
  ]);
});

test('list items may be multi-line paragraphs', () => {
  const doc = convert('- first line\n  second line');
  const item = doc.content[0]?.content?.[0];
  assert.deepEqual(item?.content, [
    { type: 'paragraph', content: [{ type: 'text', text: 'first line second line' }] },
  ]);
});

test('a blockquote wraps paragraphs and keeps inline marks', () => {
  const doc = convert('> quoted **bold** text');
  assert.deepEqual(doc.content, [
    {
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'quoted ' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' text' },
          ],
        },
      ],
    },
  ]);
});
test('a blockquote with a blank line keeps both paragraphs', () => {
  const quote = convert('> first\n>\n> second').content[0];
  assert.equal(quote?.content?.length, 2);
  assert.deepEqual(quote?.content?.[1]?.content, [{ type: 'text', text: 'second' }]);
});

test('a fenced code block becomes highlighted_code_block with language attrs', () => {
  const doc = convert('```python\nprint("hi")\n```');
  assert.deepEqual(doc.content, [
    {
      type: 'highlighted_code_block',
      attrs: { language: 'python', nodeId: null },
      content: [{ type: 'text', text: 'print("hi")' }],
    },
  ]);
});

test('a fenced code block without a language defaults to plaintext', () => {
  const doc = convert('```\nplain\n```');
  assert.deepEqual(doc.content[0]?.attrs, { language: 'plaintext', nodeId: null });
  assert.deepEqual(doc.content[0]?.content, [{ type: 'text', text: 'plain' }]);
});

test('an image alone in a paragraph becomes a captionedImage with the full image2 attrs', () => {
  const doc = convert('![A chart](https://example.com/chart.png "Figure 1")');
  assert.deepEqual(doc.content, [
    {
      type: 'captionedImage',
      content: [
        {
          type: 'image2',
          attrs: {
            src: 'https://example.com/chart.png',
            srcNoWatermark: null,
            fullscreen: null,
            imageSize: 'normal',
            height: null,
            width: null,
            resizeWidth: null,
            bytes: null,
            alt: 'A chart',
            title: null,
            type: null,
            href: null,
            belowTheFold: false,
            topImage: false,
            internalRedirect: null,
            isProcessing: false,
            align: null,
            offset: false,
          },
        },
        { type: 'caption', content: [{ type: 'text', text: 'Figure 1' }] },
      ],
    },
  ]);
});

test('an image wrapped in a link puts the link on image2.href', () => {
  const doc = convert('[![badge](https://example.com/b.png)](https://target.com)');
  const image = doc.content[0]?.content?.[0];
  assert.equal(image?.type, 'image2');
  assert.equal(image?.attrs?.['href'], 'https://target.com');
});

test('an image without alt text converts and warns', () => {
  const { document, warnings } = convertMarkdownToDocument('![](https://example.com/x.png)');
  assert.equal(document.content[0]?.type, 'captionedImage');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /alt/);
});

test('an image mixed with other paragraph content is rejected by name', () => {
  reject('text before ![img](https://example.com/i.png) text after', 'image inside a paragraph');
});

test('a local image src is rejected because upload is not available', () => {
  reject('![local](./diagram.png)', 'local image');
});

test('a table is rejected by name', () => {
  reject('| a | b |\n| --- | --- |\n| 1 | 2 |', 'table');
});

test('a footnote reference is rejected by name', () => {
  reject('claim[^1]', 'footnote');
});

test('a footnote definition is rejected by name', () => {
  reject('[^1]: the note', 'footnote');
});

test('an indented code block is rejected in favour of fenced code', () => {
  reject('    code here', 'indented code block');
});

test('a raw html block is rejected by name', () => {
  reject('<div>nope</div>', 'raw html');
});

test('raw inline html is rejected by name', () => {
  reject('text with <b>tags</b> inside', 'raw html');
});

test('a reference link definition is rejected with a hint', () => {
  reject('[docs]: https://example.com', 'reference link');
});

test('a reference-style link is rejected with a hint', () => {
  reject('see [docs][1] now', 'reference link');
});

test('an empty body is rejected', () => {
  reject('', 'empty');
});

test('a document mixing every supported block stays schema-valid', () => {
  const doc = convert(
    [
      '# Title',
      '',
      'Intro with **bold**, *italic*, `code`, ~~strike~~, and a [link](https://example.com).',
      '',
      '> A quote.',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '![Alt](https://example.com/i.png "Cap")',
      '',
      '---',
      '',
      'Closing paragraph.',
    ].join('\n'),
  );
  const types = doc.content.map((node) => node.type);
  assert.deepEqual(types, [
    'heading',
    'paragraph',
    'blockquote',
    'highlighted_code_block',
    'bullet_list',
    'ordered_list',
    'captionedImage',
    'horizontal_rule',
    'paragraph',
  ]);
});

test('the local validator catches documents outside the declared schema', () => {
  const violations = validateDocument({
    type: 'doc',
    content: [{ type: 'table', content: [] }],
  });
  assert.ok(violations.some((message) => message.includes('unknown node type')));
});
