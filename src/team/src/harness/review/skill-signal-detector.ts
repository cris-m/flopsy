import { z } from 'zod';
import { createLogger } from '@flopsy/shared';
import type { BaseChatModel, ChatMessage } from 'flopsygraph';

const log = createLogger('skill-signal-detector');

const SignalTypeEnum = z.enum([
    'procedure_taught',
    'correction_given',
    'workflow_demonstrated',
    'preference_stated',
    'environment_quirk',
    'none',
]);

export const SkillSignalSchema = z.object({
    signal_type: SignalTypeEnum.describe(
        'What kind of skill-worthy moment occurred in the recent turns. ' +
            '`procedure_taught` = user taught a multi-step procedure. ' +
            '`correction_given` = user corrected an agent action with new rule ("next time", "from now on", or paraphrases). ' +
            '`workflow_demonstrated` = a working sequence was completed that would be reusable. ' +
            '`preference_stated` = stable preference declared. ' +
            '`environment_quirk` = config/tool/version-specific gotcha. ' +
            '`none` = nothing skill-worthy in this window.',
    ),
    confidence: z
        .number()
        .min(0)
        .max(1)
        .describe(
            'How confident you are the signal is real and reusable. ' +
                '0.8+ = unambiguous, well-formed, would trust next time. ' +
                '0.5-0.7 = signal is there but partial. <0.5 = vague.',
        ),
    summary: z
        .string()
        .min(10)
        .max(400)
        .describe('One-sentence factual summary of what the signal IS. No speculation.'),
    suggested_skill_name: z
        .string()
        .min(0)
        .max(80)
        .nullable()
        .describe(
            'kebab-case name for the skill if one should be created. null when signal_type is `none` ' +
                'OR confidence < 0.5 OR it should append to an existing skill instead of creating.',
        ),
    suggested_existing_skill: z
        .string()
        .min(0)
        .max(80)
        .nullable()
        .describe(
            'Name of an existing skill (from the list provided in the prompt) that this signal should APPEND lessons to. ' +
                'null when no existing skill applies. Mutually relevant with suggested_skill_name.',
        ),
    reasoning: z
        .string()
        .min(10)
        .max(400)
        .describe('Why you picked this signal_type + confidence. One short paragraph.'),
});

export type SkillSignal = z.infer<typeof SkillSignalSchema>;

export interface SkillSignalDetectorOptions {
    readonly model: BaseChatModel;
    readonly windowSize: number;
    readonly minConfidence: number;
}

const DEFAULT_WINDOW = 8;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const MAX_TURN_CHARS = 800;

const SYSTEM_PROMPT = `You analyze recent conversation turns and detect whether the user just gave the agent a SKILL-WORTHY signal.

Output STRICT JSON matching the schema. Do not add commentary. Use structured output exactly.

What counts as a signal:
- procedure_taught: the user explicitly walked the agent through a multi-step procedure ("first do X, then Y, then Z")
- correction_given: the user corrected the agent and gave a rule that should apply going forward ("next time, before suggesting Y, check Z"; "we always use X for this"; "from now on prefer A over B")
- workflow_demonstrated: a multi-step sequence completed successfully that the agent could repeat ("we figured out you need to do A, then B, then call C")
- preference_stated: a stable preference declared ("I prefer concise replies"; "always cite sources")
- environment_quirk: a config/version-specific gotcha worth remembering ("this only works on Node 20+"; "macOS needs --no-sandbox")
- none: just normal conversation, Q&A, or task work without reusable signal

What does NOT count:
- session-specific progress ("we got the test passing") unless the SEQUENCE is generalizable
- one-off questions
- the agent's own deductions or suggestions
- emotional reactions
- clarifying questions

Calibration:
- confidence 0.9+ is rare. Use only for unambiguous, clearly-worded signals.
- confidence 0.7-0.85 = clear signal, well-formed, would be useful.
- confidence 0.5-0.7 = signal is there but might not be reusable.
- below 0.5 = drop it; return signal_type 'none'.

Bias: when in doubt, return 'none'. False positives clog the skill catalog with noise.`;

function truncate(text: string, max: number): string {
    return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((b): b is { type: 'text'; text: string } =>
                typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text',
            )
            .map((b) => b.text)
            .join('');
    }
    return '';
}

export class SkillSignalDetector {
    private readonly model: BaseChatModel;
    private readonly windowSize: number;
    private readonly minConfidence: number;

    constructor(opts: SkillSignalDetectorOptions) {
        this.model = opts.model;
        this.windowSize = opts.windowSize;
        this.minConfidence = opts.minConfidence;
    }

    async detect(
        messages: ReadonlyArray<ChatMessage>,
        existingSkills: ReadonlyArray<{ name: string; description: string }> = [],
    ): Promise<SkillSignal | null> {
        const recent = messages.slice(-this.windowSize).filter(
            (m) => m.role === 'user' || m.role === 'assistant',
        );
        if (recent.length < 2) return null;

        const transcript = recent
            .map((m) => {
                const text = truncate(extractText(m.content), MAX_TURN_CHARS).trim();
                if (!text) return null;
                return `${m.role.toUpperCase()}: ${text}`;
            })
            .filter((s): s is string => s !== null)
            .join('\n\n');

        if (transcript.length < 100) return null;

        const existingList = existingSkills.length
            ? `\n\nExisting skills (use suggested_existing_skill to append):\n${existingSkills
                .slice(0, 25)
                .map((s) => `- ${s.name}: ${s.description}`)
                .join('\n')}`
            : '';

        const userPrompt =
            `Analyze the following ${recent.length}-turn window for skill-worthy signals. ` +
            `Return STRICT JSON matching the schema.${existingList}\n\n` +
            `TRANSCRIPT:\n${transcript}`;

        let raw: string;
        try {
            const response = await this.model.invoke([
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ]);
            raw = extractText(response.content);
        } catch (err) {
            log.warn({ err: (err as Error).message }, 'detector LLM call failed');
            return null;
        }

        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch {
            const m = raw.match(/\{[\s\S]*\}/);
            if (!m) {
                log.debug({ rawSample: raw.slice(0, 120) }, 'detector returned non-JSON');
                return null;
            }
            try { parsed = JSON.parse(m[0]); }
            catch {
                log.debug({ rawSample: raw.slice(0, 120) }, 'detector JSON unparseable even after extraction');
                return null;
            }
        }

        const result = SkillSignalSchema.safeParse(parsed);
        if (!result.success) {
            log.debug(
                { error: result.error.message.slice(0, 200), parsedSample: JSON.stringify(parsed).slice(0, 200) },
                'detector output failed schema',
            );
            return null;
        }

        const signal = result.data;
        if (signal.signal_type === 'none') return null;
        if (signal.confidence < this.minConfidence) {
            log.debug(
                { signal_type: signal.signal_type, confidence: signal.confidence, threshold: this.minConfidence },
                'signal below threshold — ignoring',
            );
            return null;
        }
        return signal;
    }
}

export const SKILL_SIGNAL_DEFAULTS = {
    WINDOW_SIZE: DEFAULT_WINDOW,
    MIN_CONFIDENCE: DEFAULT_MIN_CONFIDENCE,
} as const;
