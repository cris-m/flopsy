import { createLogger } from '@flopsy/shared';
import type { BaseChatModel } from 'flopsygraph';
import type { LearningStore, MessageRow } from '../storage';
import type { SkillCatalogEntry } from './skill-scanner';

const log = createLogger('session-extractor');

const MESSAGE_WINDOW = 30;
const MIN_MESSAGES = 4;
// Below this char count with no tool signal, extractions are reliably empty.
const MIN_SUBSTANTIVE_CHARS = 800;
const TIMEOUT_MS = 60_000;
const PER_MESSAGE_CHAR_LIMIT = 400;

// Caps prevent prompt-injection-driven output explosions.
const MAX_SUMMARY_CHARS = 500;

const MAX_LIST_ITEMS = 10;

const EXTRACTOR_SYSTEM = [
    'You are extracting durable knowledge from a closed conversation transcript.',
    '',
    'Output STRICT JSON matching this shape:',
    '{',
    '  "summary": "1-3 sentences describing what was discussed and the next step.",',
    '  "skill_proposal": null OR {"name": "kebab-case-name", "description": "one-line capability summary", "when_to_use": "1-2 sentences describing the trigger condition", "body": "markdown body of the SKILL.md (steps, pitfalls, examples)"},',
    '  "skill_lessons": [{"name": "<exact-existing-skill-name>", "lessons": ["short imperative lesson", "another lesson"]}]',
    '}',
    '',
    'Rules:',
    '- Be conservative. Most fields should be null / empty arrays.',
    '- skill_proposal is RARE. Only when the transcript shows a NON-OBVIOUS, REUSABLE PROCEDURE the assistant figured out (e.g. a multi-step workflow that worked, with specific pitfalls). One-off conversations, casual chat, simple Q&A → null. Trivial procedures already obvious from tool names → null. Do NOT propose a skill that overlaps with one already in <existing_skills>.',
    '- skill_lessons appends learnings to skills LISTED in <existing_skills>. Use when the assistant invoked or relied on an existing skill in this session AND learned something the skill author would want to know (e.g. an edge case, a better arg, a pitfall). The `name` MUST exactly match an existing skill name. Empty array if nothing was learned worth appending.',
    '- Never invent. If you didn\'t see it stated, don\'t include it.',
    '- Output JSON ONLY. No commentary. No markdown code fences.',
].join('\n');

export interface SessionExtractorConfig {
    readonly model: BaseChatModel;
    readonly store: LearningStore;
}

export interface SkillProposal {
    name: string;
    description: string;
    when_to_use: string;
    body: string;
}

export interface SkillLessonAppend {
    name: string;
    lessons: string[];
}

export interface ExtractionResult {
    summary: string;
    skill_proposal: SkillProposal | null;
    skill_lessons: SkillLessonAppend[];
}

export class SessionExtractor {
    constructor(private readonly config: SessionExtractorConfig) {}

    async extract(
        closedThreadId: string,
        _peerId?: string,
        existingSkills?: ReadonlyArray<SkillCatalogEntry>,
    ): Promise<ExtractionResult | null> {
        const messages = this.config.store.getThreadMessages(closedThreadId, MESSAGE_WINDOW);
        if (messages.length < MIN_MESSAGES) {
            log.debug(
                { threadId: closedThreadId, count: messages.length },
                'too few messages for extraction',
            );
            return null;
        }

        const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
        const hasTooling = hasToolCallSignal(messages);
        if (!hasTooling && totalChars < MIN_SUBSTANTIVE_CHARS) {
            log.debug(
                {
                    threadId: closedThreadId,
                    count: messages.length,
                    totalChars,
                    threshold: MIN_SUBSTANTIVE_CHARS,
                },
                'extractor: skipped trivial session (low char count, no tool signal)',
            );
            return null;
        }

        const transcript = formatTranscript(messages);
        const skillsBlock = formatSkillsCatalog(existingSkills);
        const promptParts: string[] = [];
        if (skillsBlock) promptParts.push(skillsBlock);
        promptParts.push(`Transcript:\n\n${transcript}\n\nExtract knowledge as JSON.`);
        const userPrompt = promptParts.join('\n\n');

        let raw: string;
        try {
            const signal = AbortSignal.timeout(TIMEOUT_MS);
            const response = await this.config.model.invoke(
                [
                    { role: 'system', content: EXTRACTOR_SYSTEM },
                    { role: 'user', content: userPrompt },
                ],
                { signal },
            );
            raw = extractText(response.content);
        } catch (err) {
            log.warn({ err, threadId: closedThreadId }, 'session extractor LLM call failed');
            return null;
        }

        const parsed = parseAndValidate(raw);
        if (!parsed) {
            log.warn(
                { threadId: closedThreadId, sample: raw.slice(0, 160) },
                'session extractor produced invalid JSON',
            );
            return null;
        }

        log.info(
            {
                threadId: closedThreadId,
                summaryChars: parsed.summary.length,
                skillProposed: parsed.skill_proposal?.name ?? null,
                skillLessons: parsed.skill_lessons.length,
            },
            'session extracted',
        );
        return parsed;
    }

}

function formatTranscript(messages: ReadonlyArray<MessageRow>): string {
    return messages
        .map((m) => {
            const role = m.role === 'user' ? 'User' : 'Assistant';
            const body = m.content.slice(0, PER_MESSAGE_CHAR_LIMIT);
            return `${role}: ${body}`;
        })
        .join('\n');
}

// Persisted assistant text loses structured tool-call blocks; match surface markers instead.
const TOOL_SIGNAL_PATTERNS: readonly RegExp[] = [
    /\[delegated to /i,
    /\[spawned background task/i,
    /\[worker reply offloaded to /i,
    /__load_tool__/,
    /\(stopped after \d+ tool calls?\)/i,
];

export function hasToolCallSignal(messages: ReadonlyArray<MessageRow>): boolean {
    for (const m of messages) {
        if (m.role !== 'assistant') continue;
        for (const re of TOOL_SIGNAL_PATTERNS) {
            if (re.test(m.content)) return true;
        }
    }
    return false;
}

export const TRIVIAL_SESSION_CHAR_THRESHOLD = MIN_SUBSTANTIVE_CHARS;

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((b): b is { type: string; text: string } =>
                b !== null &&
                typeof b === 'object' &&
                (b as Record<string, unknown>).type === 'text' &&
                typeof (b as Record<string, unknown>).text === 'string',
            )
            .map((b) => b.text)
            .join('');
    }
    return '';
}

function stripCodeFences(s: string): string {
    const trimmed = s.trim();
    const fence = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/;
    const m = trimmed.match(fence);
    return m && m[1] !== undefined ? m[1].trim() : trimmed;
}

function parseAndValidate(raw: string): ExtractionResult | null {
    const cleaned = stripCodeFences(raw);
    let json: unknown;
    try {
        json = JSON.parse(cleaned);
    } catch {
        return null;
    }
    if (!isObject(json)) return null;

    const summaryRaw = json['summary'];
    if (typeof summaryRaw !== 'string' || summaryRaw.length === 0) return null;
    const summary = summaryRaw.length > MAX_SUMMARY_CHARS
        ? summaryRaw.slice(0, MAX_SUMMARY_CHARS)
        : summaryRaw;

    const skill_proposal = sanitizeSkillProposal(json['skill_proposal']);
    const skill_lessons = sanitizeSkillLessons(json['skill_lessons']);

    return { summary, skill_proposal, skill_lessons };
}

const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_SKILL_BODY_CHARS = 8000;
const MAX_SKILL_LESSON_CHARS = 200;

function sanitizeSkillProposal(raw: unknown): SkillProposal | null {
    if (!isObject(raw)) return null;
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
    const description = typeof raw['description'] === 'string' ? raw['description'].trim() : '';
    const when_to_use = typeof raw['when_to_use'] === 'string' ? raw['when_to_use'].trim() : '';
    const body = typeof raw['body'] === 'string' ? raw['body'].trim() : '';
    if (!name || !description || !when_to_use || !body) return null;
    if (!SKILL_NAME_RE.test(name)) return null;
    return {
        name,
        description: description.slice(0, 240),
        when_to_use: when_to_use.slice(0, 480),
        body: body.slice(0, MAX_SKILL_BODY_CHARS),
    };
}

function sanitizeSkillLessons(raw: unknown): SkillLessonAppend[] {
    if (!Array.isArray(raw)) return [];
    const out: SkillLessonAppend[] = [];
    for (const item of raw) {
        if (out.length >= MAX_LIST_ITEMS) break;
        if (!isObject(item)) continue;
        const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
        if (!name || !SKILL_NAME_RE.test(name)) continue;
        const lessonsRaw = item['lessons'];
        if (!Array.isArray(lessonsRaw)) continue;
        const lessons: string[] = [];
        for (const l of lessonsRaw) {
            if (typeof l !== 'string') continue;
            const t = l.trim();
            if (t.length === 0) continue;
            lessons.push(t.slice(0, MAX_SKILL_LESSON_CHARS));
            if (lessons.length >= 5) break;
        }
        if (lessons.length === 0) continue;
        out.push({ name, lessons });
    }
    return out;
}

function formatSkillsCatalog(skills?: ReadonlyArray<SkillCatalogEntry>): string {
    if (!skills || skills.length === 0) return '';
    const SKILLS_LIMIT = 60;
    const list = skills.slice(0, SKILLS_LIMIT);
    const lines: string[] = ['<existing_skills>'];
    for (const s of list) {
        lines.push(`- ${s.name}: ${s.description}`);
    }
    if (skills.length > SKILLS_LIMIT) {
        lines.push(`(+${skills.length - SKILLS_LIMIT} more not shown)`);
    }
    lines.push('</existing_skills>');
    return lines.join('\n');
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
