const SENTINEL = String.fromCharCode(0xe000);

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function transformBlockLine(line: string): string {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*\S)\s*$/);
    if (heading) return `<b>${heading[2]}</b>`;

    const quote = line.match(/^\s{0,3}&gt;\s?(.*)$/);
    if (quote) return `<blockquote>${quote[1]}</blockquote>`;

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return '—';

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) return `${bullet[1]}• ${bullet[2]}`;

    return line;
}

function applyInline(s: string): string {
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) =>
        `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`,
    );
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/__(.+?)__/g, '<b>$1</b>');
    s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
    s = s.replace(/\|\|(.+?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
    s = s.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '<i>$1</i>');
    s = s.replace(/(?<!\w)_(?!_)([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
    return s;
}

// Code spans are stashed before the inline pass so their literal * _ ` survive, then spliced back. SENTINEL is a private-use codepoint escapeHtml + the regexes leave untouched.
export function markdownToTelegramHtml(md: string): string {
    const slots: string[] = [];
    const stash = (html: string): string => {
        slots.push(html);
        return `${SENTINEL}${slots.length - 1}${SENTINEL}`;
    };

    let s = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
        const escaped = escapeHtml(body.replace(/\n$/, ''));
        return stash(
            lang
                ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
                : `<pre>${escaped}</pre>`,
        );
    });
    s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => stash(`<code>${escapeHtml(body)}</code>`));

    s = escapeHtml(s);
    s = s.split('\n').map(transformBlockLine).join('\n');
    s = applyInline(s);

    s = s.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g'), (_m, i: string) => slots[Number(i)] ?? '');
    return s;
}
