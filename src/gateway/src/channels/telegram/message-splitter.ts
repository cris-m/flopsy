/**
 * Splits a long body into chunks under `maxLength`. Algorithm:
 *   - Code-fence carry: when a break lands inside ```block, close it on
 *     this chunk and reopen with language on the next so Telegram doesn't
 *     render broken halves as literal backticks.
 *   - Inline-backtick guard: retreat before the last unpaired backtick
 *     (skipped inside fences where backticks are literal).
 *   - Greedy line-first, space-fallback, hard-slice last resort.
 *   - Appends (N/M) markers when chunks > 1.
 *
 * Caller handles platform-specific Markdown escape on the markers.
 */

export const TELEGRAM_MAX_LENGTH = 4096;
export const DISCORD_MAX_LENGTH  = 2000;

// Budget reserve for " (NN/NN)" marker + "\n```" fence close.
const INDICATOR_RESERVE = 10;
const FENCE_CLOSE       = '\n```';

const FENCE_OPEN_RE = /^(\s*)```(\w*)\s*$/;

interface FenceState {
    open:  boolean;
    lang:  string;
}

function detectOpenFence(chunkBody: string): FenceState {
    let open = false;
    let lang = '';
    for (const line of chunkBody.split('\n')) {
        const m = line.match(FENCE_OPEN_RE);
        if (!m) continue;
        if (open) {
            open = false;
            lang = '';
        } else {
            open = true;
            lang = m[2] ?? '';
        }
    }
    return { open, lang };
}

function findLastUnescapedBacktick(s: string): number {
    for (let i = s.length - 1; i >= 0; i--) {
        if (s[i] === '`' && (i === 0 || s[i - 1] !== '\\')) return i;
    }
    return -1;
}

function countUnescapedBackticks(s: string): number {
    let count = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '`' && (i === 0 || s[i - 1] !== '\\')) count++;
    }
    return count;
}

export function splitMessage(content: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
    if (content.length <= maxLength) return [content];

    const chunks: string[] = [];
    let remaining = content;
    let carryLang: string | null = null;

    // Paranoia bound — each iteration shrinks `remaining` by ≥1 char.
    const safetyLimit = Math.ceil(content.length / Math.max(1, maxLength - INDICATOR_RESERVE)) + 4;
    for (let i = 0; i < safetyLimit && remaining.length > 0; i++) {
        const prefix = carryLang !== null ? `\`\`\`${carryLang}\n` : '';
        const headroom = maxLength - INDICATOR_RESERVE - prefix.length - FENCE_CLOSE.length;

        // Must clear `remaining` so the post-loop fallback doesn't re-emit.
        if (prefix.length + remaining.length <= maxLength - INDICATOR_RESERVE) {
            chunks.push(prefix + remaining);
            remaining = '';
            break;
        }

        const region = remaining.slice(0, headroom);

        // Prefer a line break; fall back to whitespace; hard-cut otherwise.
        let splitAt = region.lastIndexOf('\n');
        if (splitAt < headroom / 2) {
            const sp = region.lastIndexOf(' ');
            if (sp > splitAt) splitAt = sp;
        }
        if (splitAt < 1) splitAt = headroom;

        let chunkBody = region.slice(0, splitAt);

        // Detect fence FIRST — inside a fence, backticks are literal and the
        // inline-backtick guard would mistakenly retreat across ``` openers.
        const fence = detectOpenFence(prefix + chunkBody);

        if (!fence.open && countUnescapedBackticks(chunkBody) % 2 === 1) {
            const back = findLastUnescapedBacktick(chunkBody);
            if (back > 0) {
                chunkBody = chunkBody.slice(0, back);
                splitAt   = back;
            }
        }
        let fullChunk = prefix + chunkBody;
        if (fence.open) {
            fullChunk += FENCE_CLOSE;
            carryLang = fence.lang;
        } else {
            carryLang = null;
        }

        chunks.push(fullChunk);
        remaining = remaining.slice(splitAt);
        // Don't full-trim — we may resume inside a code block where
        // leading spaces are meaningful.
        if (remaining.startsWith('\n')) remaining = remaining.slice(1);
    }

    // Final hard-slice fallback — never silently drop bytes.
    if (remaining.length > 0) {
        for (let i = 0; i < remaining.length; i += maxLength - INDICATOR_RESERVE) {
            chunks.push(remaining.slice(i, i + maxLength - INDICATOR_RESERVE));
        }
    }

    if (chunks.length > 1) {
        const total = chunks.length;
        return chunks.map((c, i) => `${c} (${i + 1}/${total})`);
    }
    return chunks;
}

export const splitForTelegram = splitMessage;
