#!/usr/bin/env tsx
/**
 * Standalone test harness — runs the proactive output schema against a
 * given model with a SHORT generic prompt OR the actual smart-pulse prompt,
 * shows whether structured output works.
 *
 * Usage:
 *   npx tsx scripts/test-structured-output.ts                 # short prompt, all models
 *   npx tsx scripts/test-structured-output.ts --full          # full smart-pulse prompt, all models
 *   npx tsx scripts/test-structured-output.ts --model zai:glm-4.7-flash
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ModelLoader, registerBuiltInProviders } from 'flopsygraph';

// ─────────────────────────────────────────────────────────────────────
// Schema — same as src/gateway/src/proactive/pipeline/executor.ts
// ─────────────────────────────────────────────────────────────────────

const reportedIdsSchema = z.object({
    emails: z.array(z.string()).optional(),
    meetings: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
    news: z.array(z.string()).optional(),
});

const proactiveOutputSchema = z.object({
    shouldDeliver: z.boolean(),
    message: z.string(),
    reason: z.string(),
    topics: z.array(z.string()).optional(),
    reportedIds: reportedIdsSchema.optional(),
    actions: z.array(z.string()).optional(),
    overlay: z.string().nullable().optional(),
});

// ─────────────────────────────────────────────────────────────────────
// Provider registration
// ─────────────────────────────────────────────────────────────────────

const loader = ModelLoader.getInstance();
registerBuiltInProviders(loader);

// ─────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────

function makePrompt(scenario: string): string {
    return `You are a proactive AI agent firing on a heartbeat.

${scenario}

Return JSON matching this schema:
{
  "shouldDeliver": boolean,
  "message": string (the text to send, or "" if not delivering),
  "reason": string (one short sentence why),
  "topics": string[] (1-3 short tags),
  "overlay": string | null (voice overlay name, or null)
}

Return valid JSON only, no surrounding prose.`;
}

// Three scenarios designed to elicit different shouldDeliver decisions.
// A correctly-working agent should pick TRUE for #1, FALSE for #2 (DND), FALSE for #3 (nothing fresh).
const SCENARIOS: ReadonlyArray<{ name: string; body: string }> = [
    {
        name: 'fresh-signal-relevant',
        body: `Context:
- User: Alex, software engineer, interested in AI tooling and Rust
- Time: 14:30 local, weekday, user is active (last message 12 min ago)
- Fresh signal: tokio 2.0 was just released 30 min ago — Alex has discussed
  tokio in 3 of the last 5 sessions and is currently debugging async code
- Today's deliveries so far: 0 (budget: 3)
- Directives: none active

Decide whether to surface this. Alex prefers concise headlines (no padding).`,
    },
    {
        name: 'dnd-active',
        body: `Context:
- User: Alex
- Time: 23:45 local, weekday — user is in DND/quiet hours (23:00–07:00)
- Fresh signal: Same tokio 2.0 release as above, would normally be relevant
- Today's deliveries: 1
- Directives: "respect quiet hours strictly — never wake me"

Decide whether to surface this RIGHT NOW.`,
    },
    {
        name: 'no-fresh-signal',
        body: `Context:
- User: Alex
- Time: 14:30 local, user is active
- Fresh signal: nothing new since last fire 30 min ago
- Today's deliveries: 0 (budget: 3)
- Directives: none

Decide whether to surface anything. There's no specific event to report —
just a routine 30-min heartbeat tick.`,
    },
];

const SHORT_PROMPT = makePrompt(SCENARIOS[0]!.body); // default = scenario 1

function loadFullPrompt(): string {
    const path =
        '/Users/munzihirwa/Documents/flopsy/FlopsyBot/.flopsy/content/prompts/heartbeats/proactive-smart-pulse-smart-pulse.md';
    return readFileSync(path, 'utf-8');
}

function loadV2Prompt(): string {
    const path =
        '/Users/munzihirwa/Documents/flopsy/FlopsyBot/scripts/test-prompts/smart-pulse-v2.md';
    return readFileSync(path, 'utf-8');
}

// Realistic scenarios that exercise the v2 prompt across MULTIPLE initiative
// types — fresh_news, callback, deadline, email, focus_or_break, etc. — and
// the suppress-correctly cases (DND, budget exhausted, truly nothing fresh).
const V2_SCENARIOS: ReadonlyArray<{ name: string; context: string }> = [
    {
        name: '1-fresh-news-on-discussed-topic (ESP-32)',
        context: `# Pre-computed context

local_time: 16:45 (Tuesday)
last_user_message_age_minutes: 95
quiet_hours_active: false
delivered_today: 0
daily_budget: 3
last_directive: none

recent_topics (last 7 days, ranked):
  1. ESP-32 (mentioned 4 times today, 6 this week)
  2. async Rust patterns (last 3 days)

active_interests:
  - embedded systems, microcontrollers
  - Rust async runtimes

fresh_signals (last 24h):
  - category: fresh_news
    title: "Espressif releases ESP-IDF 5.3 with improved Wi-Fi 6 stack"
    source: espressif.com, published 6h ago
    matches: ESP-32 (recent_topic, score 0.95)
  - category: fresh_news
    title: "tokio 1.43 released, faster runtime"
    source: github.com/tokio-rs/tokio, published 18h ago
    matches: async Rust (recent_topic, score 0.78)

open_callbacks: []`,
    },
    {
        name: '2-callback-from-earlier-thread',
        context: `# Pre-computed context

local_time: 15:30
last_user_message_age_minutes: 180
quiet_hours_active: false
delivered_today: 0
daily_budget: 3
last_directive: none

recent_topics:
  1. memory leak debugging (this morning)
  2. tokio async patterns

fresh_signals: []  (nothing fresh from external sources)

open_callbacks:
  - thread: "memory leak investigation"
    last_user_message: "let me try the heap snapshot first, talk to me in a bit"
    age_minutes: 180
    state: "user said they'd come back, hasn't"
  - thread: "tokio drop semantics"
    last_user_message: "interesting, save this for later"
    age_minutes: 220
    state: "user marked for later"`,
    },
    {
        name: '3-deadline-tomorrow',
        context: `# Pre-computed context

local_time: 16:00 (Thursday)
last_user_message_age_minutes: 60
quiet_hours_active: false
delivered_today: 1
daily_budget: 3
last_directive: none

recent_topics:
  1. SEO PR review
  2. proactive system bugs

active_interests:
  - shipping FlopsyBot features

fresh_signals:
  - category: deadline_or_calendar
    title: "User-stated deadline: SEO PR ships Friday"
    extracted_from: yesterday's session (15:42)
    age_hours_until: 18  (deadline at noon tomorrow)
  - category: fresh_news
    title: "minor TypeScript 5.9 patch released"
    source: typescriptlang.org, 4h ago
    matches: (no recent topic)

open_callbacks: []`,
    },
    {
        name: '4-email-signal-relevant',
        context: `# Pre-computed context

local_time: 09:15
last_user_message_age_minutes: 30
quiet_hours_active: false
delivered_today: 0
daily_budget: 3
last_directive: none

recent_topics:
  1. ESP-32 board procurement
  2. supplier comparisons

fresh_signals:
  - category: email_or_signal
    title: "Email from Mouser: ESP32-S3 DevKit back in stock, 12 units"
    from: orders@mouser.com
    received: 25 min ago
    matches: ESP-32 procurement (recent_topic, score 0.92)
  - category: email_or_signal
    title: "Email from LinkedIn: 3 new connection requests"
    from: linkedin
    received: 2h ago
    matches: (none)

open_callbacks:
  - thread: "ESP32-S3 procurement"
    last_user_message: "ping me when mouser has them in stock"
    age_hours: 36`,
    },
    {
        name: '5-focus-break-suggestion',
        context: `# Pre-computed context

local_time: 18:00
last_user_message_age_minutes: 5  (user is very active)
quiet_hours_active: false
delivered_today: 0
daily_budget: 3
last_directive: none

recent_topics:
  1. proactive system debugging (last 4 hours straight)
  2. memory architecture (the same)

session_telemetry:
  - continuous_session_minutes: 240  (no breaks taken)
  - context_switches_in_window: 18
  - fatigue_score: 0.78  (high)

fresh_signals: []
open_callbacks: []`,
    },
    {
        name: '6-budget-exhausted',
        context: `# Pre-computed context

local_time: 17:00
last_user_message_age_minutes: 30
quiet_hours_active: false
delivered_today: 3              ← already at budget
daily_budget: 3
last_directive: none

recent_topics:
  1. ESP-32

fresh_signals:
  - category: fresh_news
    title: "ESP32-S3 firmware update"
    source: espressif.com, 4h ago

open_callbacks: []`,
    },
    {
        name: '7-dnd-active',
        context: `# Pre-computed context

local_time: 23:45 (Tuesday)
last_user_message_age_minutes: 480
quiet_hours_active: true
delivered_today: 1
daily_budget: 3
last_directive: "respect quiet hours strictly"

recent_topics:
  1. ESP-32

fresh_signals:
  - category: fresh_news
    title: "ESP-IDF 5.3 release"
    source: espressif.com

open_callbacks: []`,
    },
    {
        name: '8-genuinely-nothing-fresh',
        context: `# Pre-computed context

local_time: 14:30
last_user_message_age_minutes: 45
quiet_hours_active: false
delivered_today: 0
daily_budget: 3
last_directive: none

recent_topics:
  1. ESP-32 (yesterday)

active_interests:
  - embedded systems

fresh_signals: []          (no news, no email, no github, nothing today)
open_callbacks: []         (all earlier threads resolved)`,
    },
];

// ─────────────────────────────────────────────────────────────────────
// Test runner
// ─────────────────────────────────────────────────────────────────────

interface TestResult {
    model: string;
    durationMs: number;
    rawResponseLength: number;
    rawResponsePreview: string;
    structuredParsed: boolean;
    structuredValue?: unknown;
    parseError?: string;
    error?: string;
}

async function testModel(modelString: string, prompt: string): Promise<TestResult> {
    const startedAt = Date.now();
    const result: TestResult = {
        model: modelString,
        durationMs: 0,
        rawResponseLength: 0,
        rawResponsePreview: '',
        structuredParsed: false,
    };

    try {
        const [provider, ...rest] = modelString.split(':');
        const modelName = rest.join(':');
        const model = await loader.from({
            provider: provider!,
            name: modelName,
            config: { temperature: 0, maxTokens: 4096 },
        });

        // Test 1 — raw invoke (no schema), see what the model emits naturally
        const rawResponse = await model.invoke(
            [{ role: 'user', content: prompt }],
            { signal: AbortSignal.timeout(180_000) }, // 3min cap per attempt
        );

        const rawText =
            typeof rawResponse.content === 'string'
                ? rawResponse.content
                : Array.isArray(rawResponse.content)
                  ? rawResponse.content
                        .filter(
                            (b): b is { type: 'text'; text: string } =>
                                (b as { type: string }).type === 'text',
                        )
                        .map((b) => b.text)
                        .join('')
                  : String(rawResponse.content);

        result.rawResponseLength = rawText.length;
        result.rawResponsePreview = rawText.slice(0, 3000);

        // Test 2 — try parsing the raw response as JSON (with code-fence fallback)
        try {
            const parsed = extractJson(rawText);
            const validated = proactiveOutputSchema.parse(parsed);
            result.structuredParsed = true;
            result.structuredValue = validated;
        } catch (err) {
            result.parseError = err instanceof Error ? err.message : String(err);
        }
    } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
    }

    result.durationMs = Date.now() - startedAt;
    return result;
}

function extractJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (match?.[1]) return JSON.parse(match[1]);
        // Try finding the first {...} block
        const obj = text.match(/\{[\s\S]*\}/);
        if (obj) return JSON.parse(obj[0]);
        throw new SyntaxError('No valid JSON found');
    }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const useFull = args.includes('--full');
    const useScenarios = args.includes('--scenarios');
    const modelArg = args.find((a) => a.startsWith('--model='))?.slice(8);

    const models = modelArg
        ? [modelArg]
        : [
              'zai:glm-4.7-flash',
              'deepseek:deepseek-chat',
          ];

    const useV2 = args.includes('--v2');

    if (useV2) {
        // Load the v2 system prompt and run it across multiple realistic
        // scenarios. Show every JSON returned so we can see what the agent
        // actually does given pre-computed context.
        const systemPrompt = loadV2Prompt();
        console.log(`\n${'═'.repeat(72)}`);
        console.log(`  Smart-Pulse v2 Test`);
        console.log(`  System prompt: ${systemPrompt.length} chars (vs 22,625 in v1)`);
        console.log(`  Scenarios: ${V2_SCENARIOS.length}`);
        console.log(`${'═'.repeat(72)}\n`);
        for (const m of models) {
            console.log(`╔═══ ${m} ═══╗\n`);
            for (const sc of V2_SCENARIOS) {
                console.log(`  ── scenario: ${sc.name} ──`);
                const fullPrompt = systemPrompt + '\n\n# Current fire context\n\n' + sc.context;
                const r = await testModel(m, fullPrompt);
                console.log(`  duration: ${(r.durationMs / 1000).toFixed(1)}s`);
                if (r.error) {
                    console.log(`  ERROR: ${r.error.slice(0, 200)}\n`);
                    continue;
                }
                if (r.structuredParsed && r.structuredValue) {
                    const sv = r.structuredValue as z.infer<typeof proactiveOutputSchema>;
                    const verdict = sv.shouldDeliver ? '📤 DELIVER' : '🔇 SUPPRESS';
                    console.log(`  ${verdict}`);
                    console.log(JSON.stringify(r.structuredValue, null, 2)
                        .split('\n').map(l => '    ' + l).join('\n'));
                } else {
                    console.log(`  ✗ parse failed: ${r.parseError}`);
                    console.log(r.rawResponsePreview.split('\n').slice(0, 10)
                        .map(l => '    ' + l).join('\n'));
                }
                console.log();
            }
        }
        return;
    }

    if (useScenarios) {
        // Run every scenario × every model, show every JSON returned.
        console.log(`\n${'═'.repeat(72)}`);
        console.log(`  Multi-scenario test — exercises BOTH true and false branches`);
        console.log(`${'═'.repeat(72)}\n`);
        for (const m of models) {
            console.log(`╔═══ ${m} ═══╗\n`);
            for (const sc of SCENARIOS) {
                console.log(`  scenario: ${sc.name}`);
                const r = await testModel(m, makePrompt(sc.body));
                console.log(`  duration: ${(r.durationMs / 1000).toFixed(1)}s`);
                if (r.error) {
                    console.log(`  ERROR: ${r.error.slice(0, 200)}\n`);
                    continue;
                }
                if (r.structuredParsed && r.structuredValue) {
                    console.log(`  RETURNED JSON (schema-valid):`);
                    console.log(JSON.stringify(r.structuredValue, null, 2)
                        .split('\n').map(l => '    ' + l).join('\n'));
                } else {
                    console.log(`  RAW (parse failed: ${r.parseError ?? 'unknown'}):`);
                    console.log(r.rawResponsePreview.split('\n').map(l => '    ' + l).join('\n'));
                }
                console.log();
            }
            console.log();
        }
        return;
    }

    const prompt = useFull ? loadFullPrompt() : SHORT_PROMPT;
    const promptLabel = useFull ? 'FULL smart-pulse prompt (446 lines)' : 'SHORT generic prompt';

    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  Structured Output Test`);
    console.log(`  Prompt: ${promptLabel} (${prompt.length} chars)`);
    console.log(`  Models: ${models.join(', ')}`);
    console.log(`${'═'.repeat(72)}\n`);

    for (const m of models) {
        console.log(`▶ ${m}`);
        const r = await testModel(m, prompt);
        console.log(`  duration:    ${(r.durationMs / 1000).toFixed(1)}s`);
        console.log(`  response len: ${r.rawResponseLength} chars`);
        console.log(`  json parsed:  ${r.structuredParsed ? '✓ yes' : '✗ no'}`);
        if (r.error) {
            console.log(`  ERROR:`);
            console.log(`    ${r.error}`);
        }
        if (!r.structuredParsed && r.parseError) {
            console.log(`  parse error: ${r.parseError}`);
        }
        if (r.structuredParsed && r.structuredValue) {
            console.log(`\n  ── parsed structured output (validated against schema) ──`);
            console.log(JSON.stringify(r.structuredValue, null, 2)
                .split('\n').map(l => '    ' + l).join('\n'));
        }
        console.log(`\n  ── raw model output (first ${Math.min(r.rawResponseLength, 2000)} chars) ──`);
        const fullPreview = r.rawResponsePreview.length < 500
            ? r.rawResponsePreview
            : r.rawResponsePreview;
        console.log(fullPreview.split('\n').map(l => '    ' + l).join('\n'));
        console.log();
    }
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
