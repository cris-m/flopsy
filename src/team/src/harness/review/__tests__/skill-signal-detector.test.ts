import { describe, it, expect } from 'vitest';
import { SkillSignalDetector } from '../skill-signal-detector';
import type { BaseChatModel, ChatMessage, ChatResponse, ChatStreamChunk } from 'flopsygraph';

class StubModel {
    nextResponse = '';
    async invoke(_messages: readonly ChatMessage[]): Promise<ChatResponse> {
        return { content: this.nextResponse, stopReason: 'end' } as ChatResponse;
    }
    async *stream(): AsyncIterable<ChatStreamChunk> { yield { content: '', done: true }; }
    bindTools(): unknown { return this; }
    withStructuredOutput(): never { throw new Error('not used'); }
}

function buildConvo(turns: Array<{ role: 'user' | 'assistant'; content: string }>): ChatMessage[] {
    return turns.map((t) => ({ role: t.role, content: t.content }));
}

describe('SkillSignalDetector — structured output (not regex)', () => {
    const make = (response: string): { detector: SkillSignalDetector; model: StubModel } => {
        const model = new StubModel();
        model.nextResponse = response;
        const detector = new SkillSignalDetector({
            model: model as unknown as BaseChatModel,
            windowSize: 8,
            minConfidence: 0.7,
        });
        return { detector, model };
    };

    it('returns null when window is too short', async () => {
        const { detector } = make('{"signal_type":"none","confidence":0,"summary":"x","suggested_skill_name":null,"suggested_existing_skill":null,"reasoning":"too short"}');
        const result = await detector.detect(buildConvo([{ role: 'user', content: 'hi' }]));
        expect(result).toBe(null);
    });

    it('returns null when LLM says signal_type=none', async () => {
        const { detector } = make(JSON.stringify({
            signal_type: 'none',
            confidence: 0.4,
            summary: 'Just casual chat about the weather, no procedure or rule.',
            suggested_skill_name: null,
            suggested_existing_skill: null,
            reasoning: 'No skill-worthy signal in the conversation.',
        }));
        const result = await detector.detect(buildConvo([
            { role: 'user', content: 'hey nice weather today' },
            { role: 'assistant', content: 'yeah sunny in Tokyo' },
            { role: 'user', content: 'going for a walk' },
            { role: 'assistant', content: 'enjoy' },
        ]));
        expect(result).toBe(null);
    });

    it('returns null when confidence below threshold', async () => {
        const { detector } = make(JSON.stringify({
            signal_type: 'preference_stated',
            confidence: 0.5,
            summary: 'User mentioned they sometimes prefer X.',
            suggested_skill_name: null,
            suggested_existing_skill: null,
            reasoning: 'Wishy-washy preference, not stable.',
        }));
        const result = await detector.detect(buildConvo([
            { role: 'user', content: 'I guess I sometimes prefer Y' },
            { role: 'assistant', content: 'noted' },
            { role: 'user', content: 'maybe' },
            { role: 'assistant', content: 'ok' },
        ]));
        expect(result).toBe(null);
    });

    it('returns the signal when LLM detects a clear procedure_taught', async () => {
        const { detector } = make(JSON.stringify({
            signal_type: 'procedure_taught',
            confidence: 0.9,
            summary: 'User taught a 4-step deploy procedure: build, test, tag, push.',
            suggested_skill_name: 'deploy-to-prod',
            suggested_existing_skill: null,
            reasoning: 'Clear 4-step procedure stated explicitly by user.',
        }));
        const result = await detector.detect(buildConvo([
            { role: 'user', content: 'OK here is how we deploy. Step 1: run npm build. Step 2: run tests. Step 3: tag git. Step 4: push to main.' },
            { role: 'assistant', content: 'understood, I will follow that' },
            { role: 'user', content: 'good. always do those four in order' },
            { role: 'assistant', content: 'confirmed' },
        ]));
        expect(result).not.toBe(null);
        expect(result!.signal_type).toBe('procedure_taught');
        expect(result!.confidence).toBe(0.9);
        expect(result!.suggested_skill_name).toBe('deploy-to-prod');
    });

    it('captures correction_given signals (the "next time" pattern, but semantically not by regex)', async () => {
        const { detector } = make(JSON.stringify({
            signal_type: 'correction_given',
            confidence: 0.85,
            summary: 'User asked agent to verify Postgres version before proposing migrations going forward.',
            suggested_skill_name: 'postgres-migration-checks',
            suggested_existing_skill: null,
            reasoning: 'Rule for future: check pg version first.',
        }));
        const result = await detector.detect(buildConvo([
            { role: 'user', content: 'wait you cannot use that syntax — we are on Postgres 15' },
            { role: 'assistant', content: 'sorry, fixed' },
            { role: 'user', content: 'in the future check the Postgres version before suggesting migrations' },
            { role: 'assistant', content: 'understood' },
        ]));
        expect(result).not.toBe(null);
        expect(result!.signal_type).toBe('correction_given');
    });

    it('captures correction signals expressed WITHOUT regex-matchable phrases', async () => {
        // OpenClaw's regex would miss this — no "next time" / "always" / "from now on" wording.
        // The LLM understands the SEMANTIC equivalent.
        const { detector } = make(JSON.stringify({
            signal_type: 'correction_given',
            confidence: 0.85,
            summary: 'User established a rule that the AI must double-check timezone before scheduling.',
            suggested_skill_name: 'tz-double-check',
            suggested_existing_skill: null,
            reasoning: 'The rule is semantic ("double check ... before"), regex matching would miss it.',
        }));
        const result = await detector.detect(buildConvo([
            { role: 'user', content: 'you scheduled that for 3pm UTC but I am in JST. you keep doing that' },
            { role: 'assistant', content: 'sorry' },
            { role: 'user', content: 'just double-check timezone before scheduling, ok?' },
            { role: 'assistant', content: 'will do' },
        ]));
        expect(result).not.toBe(null);
        expect(result!.signal_type).toBe('correction_given');
    });

    it('returns existing skill name when signal should append, not create', async () => {
        const { detector } = make(JSON.stringify({
            signal_type: 'environment_quirk',
            confidence: 0.8,
            summary: 'New gotcha for the deploy procedure: must rebuild Docker after node version change.',
            suggested_skill_name: null,
            suggested_existing_skill: 'deploy-to-prod',
            reasoning: 'This is an addendum to deploy-to-prod, not a new skill.',
        }));
        const result = await detector.detect(
            buildConvo([
                { role: 'user', content: 'oh by the way after switching Node versions you have to rebuild the Docker image' },
                { role: 'assistant', content: 'noted' },
                { role: 'user', content: 'forgot to mention that earlier' },
                { role: 'assistant', content: 'will add to the deploy procedure' },
            ]),
            [{ name: 'deploy-to-prod', description: 'Production deployment procedure' }],
        );
        expect(result).not.toBe(null);
        expect(result!.suggested_existing_skill).toBe('deploy-to-prod');
        expect(result!.suggested_skill_name).toBe(null);
    });

    it('survives malformed JSON from LLM (returns null, doesnt throw)', async () => {
        const { detector } = make('not json at all');
        const result = await detector.detect(buildConvo([
            { role: 'user', content: 'something something' },
            { role: 'assistant', content: 'reply reply reply something something' },
            { role: 'user', content: 'more more more more more more' },
        ]));
        expect(result).toBe(null);
    });

    it('extracts JSON embedded in text response from LLM', async () => {
        const { detector } = make(`Here is the analysis:
\`\`\`json
{
  "signal_type": "preference_stated",
  "confidence": 0.85,
  "summary": "User stated a stable preference for concise replies.",
  "suggested_skill_name": null,
  "suggested_existing_skill": null,
  "reasoning": "Clear preference, future-facing."
}
\`\`\`
That is the signal.`);
        const result = await detector.detect(buildConvo([
            { role: 'user', content: 'I prefer short responses. always keep them under 2 sentences' },
            { role: 'assistant', content: 'understood' },
            { role: 'user', content: 'great' },
            { role: 'assistant', content: 'k' },
        ]));
        expect(result).not.toBe(null);
        expect(result!.signal_type).toBe('preference_stated');
    });

    it('returns null when LLM returns invalid schema (confidence > 1)', async () => {
        const { detector } = make(JSON.stringify({
            signal_type: 'procedure_taught',
            confidence: 1.5, // invalid
            summary: 'whatever',
            suggested_skill_name: 'x',
            suggested_existing_skill: null,
            reasoning: 'whatever',
        }));
        const result = await detector.detect(buildConvo([
            { role: 'user', content: 'do A then B then C' },
            { role: 'assistant', content: 'will do' },
            { role: 'user', content: 'always in that order' },
            { role: 'assistant', content: 'confirmed' },
        ]));
        expect(result).toBe(null);
    });
});
