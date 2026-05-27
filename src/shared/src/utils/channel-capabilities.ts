import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';

let cachedHostInfo: string | null = null;
export function hostInfo(): string {
    if (cachedHostInfo !== null) return cachedHostInfo;
    const archRaw = process.arch;
    const arch = archRaw === 'arm64' ? 'arm64' : archRaw === 'x64' ? 'x86_64' : archRaw;
    let label: string;
    if (process.platform === 'darwin') {
        let version = '';
        try {
            version = execFileSync('sw_vers', ['-productVersion'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
        } catch { /* sw_vers not available */ }
        label = version ? `macOS ${version}` : `macOS (Darwin ${release()})`;
    } else if (process.platform === 'win32') {
        label = `Windows (${release()})`;
    } else if (process.platform === 'linux') {
        let distro = '';
        try {
            const text = readFileSync('/etc/os-release', 'utf8');
            const m = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
            if (m) distro = m[1]!;
        } catch { /* not a standard linux */ }
        label = distro || `Linux ${release()}`;
    } else {
        label = `${process.platform} ${release()}`;
    }
    cachedHostInfo = `${label} · ${arch} · node ${process.version}`;
    return cachedHostInfo;
}

/**
 * Per-channel CAPABILITY hints (what the channel supports). Kept short — the
 * full style guide lives in CHANNEL_STYLE_HINTS below. Both are surfaced to
 * the model via `<delivery_target>` in the system prompt.
 */
export const CHANNEL_CAPABILITY_HINTS: Record<string, string> = {
    telegram: 'Hard-cap 4096 chars per message; markdown via MarkdownV2 (entities auto-escaped); links render inline; emoji ok. Avoid raw asterisks — they will render as bold.',
    discord: 'Up to 2000 chars per message (longer auto-split); markdown + embeds + code blocks supported. Mentions: <@user_id>, <#channel_id>.',
    line: 'Hard-cap 1000 chars per message; plain text only — no markdown. Use line breaks for structure; URLs auto-link.',
    imessage: 'Plain text only — no markdown. Keep messages short; longer messages should be split.',
    signal: 'Plain text only — no markdown. Be concise.',
    slack: 'mrkdwn subset; <https://example.com|label> link syntax; *bold* uses single asterisks. Mentions: <@USERID>.',
    whatsapp: 'Basic formatting (*bold*, _italic_, ~strike~, ```code```); 65536-byte cap.',
    googlechat: 'Limited markdown; cards available for structured content; otherwise plain text.',
    chat: 'TUI; plain text rendered in monospace. No markdown.',
    proactive: 'No user is present right now. Compose the deliverable in your final response; do not narrate or ask.',
};

/**
 * Per-channel RESPONSE STYLE rules — how the agent should compose for THIS
 * channel. This is where Hermes/openclaw beat us: they give the model explicit
 * structure-and-length guidance per channel (target length, when to use
 * bullets vs prose, link-back conventions) instead of leaving it to guess.
 *
 * Updated for the "Flipper One" class of question (user shares URL or asks
 * for a summary): the model should produce a scannable lead + bullets +
 * source, not a 50-word run-on sentence.
 */
export const CHANNEL_STYLE_HINTS: Record<string, string> = {
    telegram: [
        'Target length: 60–180 words for an answer; 30–60 for an acknowledgement.',
        'Structure: 1-line lead → 3–5 short bullets (use "•" or "-") → source URL on its own line.',
        'For URL/article summaries: lead with WHAT it is, then key points as bullets, then the link back. Never one giant sentence.',
        'Multi-message: for replies with distinct beats (lead, then body, then source) prefer `send_message({parts: [...]})` so the channel delivers them as separate messages with natural pacing. Use parts for: URL summaries, multi-section answers, acknowledgement+answer.',
        'Pace: line breaks between sections. A wall of text is unreadable on mobile.',
        'Tone: direct, conversational, no preamble like "Here is a summary of...". Just answer.',
    ].join(' '),
    discord: [
        'Target length: 60–250 words; longer answers ok if the question is deep.',
        'Structure: lead → bullets or short paragraphs → source links. Use `**bold**` sparingly for key terms.',
        'Use code blocks for commands, paths, identifiers. Use `> quote` to echo a user line you are addressing.',
        'For URL/article summaries: 1-line hook → 3-6 bullets → source URL.',
        'Multi-message: for distinct beats prefer `send_message({parts: [...]})` to ship 2-3 paced messages instead of one long block.',
    ].join(' '),
    slack: [
        'Target length: 40–180 words. Threading and reactions are common — be terse.',
        'Structure: lead → 2–4 bullets if multiple points; otherwise a tight paragraph.',
        'Use `<URL|label>` for links. Use `*bold*` (single asterisks) for key terms.',
        'For URL/article summaries: lead → bullets → `<URL|source>`.',
    ].join(' '),
    whatsapp: [
        'Target length: 40–150 words. Mobile-first; readers skim.',
        'Structure: lead → 3–5 short bullets (use "- " or "• ") → source URL.',
        'Use *single asterisks* for emphasis sparingly. Line breaks are your friend.',
        'For URL/article summaries: never one run-on sentence — bullets are mandatory.',
        'Multi-message: for distinct beats use `send_message({parts: [...]})` — WhatsApp UX strongly favours short paced messages over one long one.',
    ].join(' '),
    line: [
        'Target length: 30–120 words. Hard cap 1000 chars — split if you exceed.',
        'No markdown supported — use blank lines and "- " bullets for structure.',
        'For URL/article summaries: 1-line lead → 3–4 bullets → URL on its own line.',
    ].join(' '),
    imessage: [
        'Target length: 30–120 words. Plain text; iMessage readers expect SMS pacing.',
        'Use blank lines for structure. Bullets via "• " or "- ".',
        'For URL/article summaries: lead → short bullets → URL.',
    ].join(' '),
    signal: [
        'Target length: 30–100 words. Plain text; readers expect terse, secure-channel pacing.',
        'Bullets via "• " or "- "; blank lines for structure.',
    ].join(' '),
    googlechat: [
        'Target length: 40–180 words. Work context; default to bullets when summarizing.',
        'Use markdown sparingly; prefer plain text with blank-line structure.',
    ].join(' '),
    chat: [
        'TUI dev context. The CLI renders markdown — use bullets, headers, code blocks freely.',
        'Be detailed when the user is debugging; be terse when they ask a simple question.',
    ].join(' '),
    proactive: [
        'No user is present right now — you are composing the deliverable.',
        'Format depends on the job (briefing, recap, pulse) — follow the role-specific prompt.',
        'Always include sources for any factual claim.',
    ].join(' '),
};

/**
 * Returns the combined capability + style guidance for a channel — the
 * single string surfaced to the model in `<delivery_target>`.
 */
export function channelGuidance(channelName: string | undefined): string {
    if (!channelName) return 'unknown channel — treat as plain text, be concise';
    const key = channelName.toLowerCase();
    const cap = CHANNEL_CAPABILITY_HINTS[key] ?? 'unknown channel — treat as plain text';
    const style = CHANNEL_STYLE_HINTS[key] ?? 'Be concise and scannable.';
    return `CAPABILITIES: ${cap}\n\nRESPONSE STYLE: ${style}`;
}

export function channelCapabilityHint(channelName: string | undefined): string {
    if (!channelName) return 'unknown channel — treat as plain text';
    return CHANNEL_CAPABILITY_HINTS[channelName.toLowerCase()] ?? 'unknown channel — treat as plain text';
}

export function modelFamily(modelId: string | undefined): string {
    if (!modelId) return 'unknown';
    const lc = modelId.toLowerCase();
    if (lc.includes('claude') || lc.includes('anthropic') || lc.startsWith('haiku') || lc.startsWith('sonnet') || lc.startsWith('opus')) return 'anthropic';
    if (lc.includes('gpt') || lc.includes('o1') || lc.includes('o3') || lc.includes('codex')) return 'openai';
    if (lc.includes('gemini') || lc.includes('gemma')) return 'google';
    if (lc.includes('grok')) return 'xai';
    if (lc.includes('deepseek')) return 'deepseek';
    if (lc.includes('kimi') || lc.includes('moonshot')) return 'moonshot';
    if (lc.includes('qwen')) return 'qwen';
    if (lc.includes('llama')) return 'meta';
    if (lc.includes('mistral') || lc.includes('mixtral')) return 'mistral';
    if (lc.includes('nvidia')) return 'nvidia';
    if (lc.startsWith('ollama')) return 'ollama';
    if (lc.includes('glm') || lc.includes('chatglm')) return 'zai';
    return 'unknown';
}
