import { describe, it, expect } from 'vitest';
import { markdownToTelegramHtml } from '../src/channels/telegram/markdown-html';

describe('markdownToTelegramHtml', () => {
    it('converts bold, italic, and strikethrough', () => {
        expect(markdownToTelegramHtml('**b** *i* ~~s~~')).toBe('<b>b</b> <i>i</i> <s>s</s>');
    });

    it('converts __bold__ and _italic_', () => {
        expect(markdownToTelegramHtml('__b__ _i_')).toBe('<b>b</b> <i>i</i>');
    });

    it('escapes < > & in plain text', () => {
        expect(markdownToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    });

    it('escapes special chars but does not require MarkdownV2 escaping', () => {
        expect(markdownToTelegramHtml('a.b-c!d(e)')).toBe('a.b-c!d(e)');
    });

    it('renders inline code and escapes its contents without formatting', () => {
        expect(markdownToTelegramHtml('use `a < b && *x*` here')).toBe(
            'use <code>a &lt; b &amp;&amp; *x*</code> here',
        );
    });

    it('renders a fenced code block with a language', () => {
        expect(markdownToTelegramHtml('```js\nconst x = a < b;\n```')).toBe(
            '<pre><code class="language-js">const x = a &lt; b;</code></pre>',
        );
    });

    it('renders a fenced code block without a language', () => {
        expect(markdownToTelegramHtml('```\nplain & <code>\n```')).toBe(
            '<pre>plain &amp; &lt;code&gt;</pre>',
        );
    });

    it('does not apply markdown inside code blocks', () => {
        expect(markdownToTelegramHtml('```\n**not bold** _not italic_\n```')).toBe(
            '<pre>**not bold** _not italic_</pre>',
        );
    });

    it('converts links and escapes quotes in the url', () => {
        expect(markdownToTelegramHtml('[text](https://x.com/a?b=1&c=2)')).toBe(
            '<a href="https://x.com/a?b=1&amp;c=2">text</a>',
        );
    });

    it('converts headings to bold', () => {
        expect(markdownToTelegramHtml('# Title\n## Sub')).toBe('<b>Title</b>\n<b>Sub</b>');
    });

    it('converts unordered list items to bullets', () => {
        expect(markdownToTelegramHtml('- one\n* two\n+ three')).toBe('• one\n• two\n• three');
    });

    it('leaves snake_case identifiers untouched', () => {
        expect(markdownToTelegramHtml('call my_func_name now')).toBe('call my_func_name now');
    });

    it('converts spoilers', () => {
        expect(markdownToTelegramHtml('||secret||')).toBe('<tg-spoiler>secret</tg-spoiler>');
    });

    it('passes the chunk (N/M) marker through unchanged', () => {
        expect(markdownToTelegramHtml('hello (1/2)')).toBe('hello (1/2)');
    });

    it('handles bold and a link together on one line', () => {
        expect(markdownToTelegramHtml('see **[docs](https://x.io)** now')).toBe(
            'see <b><a href="https://x.io">docs</a></b> now',
        );
    });

    it('renders a blockquote line', () => {
        expect(markdownToTelegramHtml('> quoted')).toBe('<blockquote>quoted</blockquote>');
    });
});
