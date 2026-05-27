import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '@flopsy/shared';
import { NvidiaChatModel, OllamaChatModel } from 'flopsygraph';
import type {
    BaseChatModel,
    ChatMessage,
    CheckpointStore,
    Interceptor,
    InterceptorTurnContext,
} from 'flopsygraph';
import { SkillSignalDetector, type SkillSignal } from './skill-signal-detector';

const log = createLogger('skill-signal-interceptor');

export interface SkillSignalInterceptorOptions {
    readonly model: string;
    readonly apiKey?: string;
    readonly checkpointer: CheckpointStore;
    readonly proposalsPath: string;
    readonly checkEveryNTurns: number;
    readonly windowSize: number;
    readonly minConfidence: number;
    readonly existingSkills?: () => ReadonlyArray<{ name: string; description: string }>;
    readonly modelInstance?: BaseChatModel;
}

interface PersistedSignal extends SkillSignal {
    ts: number;
    threadId: string;
    turnNumber: number;
}

interface ExtractorMessage {
    role: string;
    content: unknown;
}

function toChat(m: ExtractorMessage): ChatMessage | null {
    if (m.role !== 'user' && m.role !== 'assistant') return null;
    return { role: m.role as 'user' | 'assistant', content: m.content as ChatMessage['content'] };
}

function buildModel(modelId: string, apiKey?: string): BaseChatModel {
    const idx = modelId.indexOf(':');
    if (idx <= 0) throw new Error(`skill-signal: bad model id "${modelId}" — expected "provider:name"`);
    const provider = modelId.slice(0, idx);
    const name = modelId.slice(idx + 1);
    if (provider === 'nvidia') {
        if (!apiKey) throw new Error('skill-signal: NVIDIA_API_KEY required for nvidia: model');
        return new NvidiaChatModel(name, { temperature: 0 }, apiKey);
    }
    if (provider === 'ollama') {
        return new OllamaChatModel(name, { temperature: 0 }, undefined, 'http://localhost:11434/v1');
    }
    throw new Error(`skill-signal: unknown provider "${provider}"`);
}

export function createSkillSignalInterceptor(opts: SkillSignalInterceptorOptions): Interceptor {
    let cachedModel: BaseChatModel | null = opts.modelInstance ?? null;
    const getModel = (): BaseChatModel => {
        if (!cachedModel) cachedModel = buildModel(opts.model, opts.apiKey);
        return cachedModel;
    };

    let cachedDetector: SkillSignalDetector | null = null;
    const getDetector = (): SkillSignalDetector => {
        if (!cachedDetector) {
            cachedDetector = new SkillSignalDetector({
                model: getModel(),
                windowSize: opts.windowSize,
                minConfidence: opts.minConfidence,
            });
        }
        return cachedDetector;
    };

    const lastCheckedByThread = new Map<string, number>();

    const persist = async (signal: PersistedSignal): Promise<void> => {
        try {
            if (!existsSync(dirname(opts.proposalsPath))) {
                await mkdir(dirname(opts.proposalsPath), { recursive: true });
            }
            await appendFile(opts.proposalsPath, JSON.stringify(signal) + '\n', 'utf8');
        } catch (err) {
            log.debug({ err, proposalsPath: opts.proposalsPath }, 'failed to persist skill signal');
        }
    };

    return {
        name: 'skill-signal-detector',
        priority: 15,

        async onTurnEnd(ctx: InterceptorTurnContext, _finalReply: string) {
            const threadId = ctx.threadId;
            const lastChecked = lastCheckedByThread.get(threadId) ?? 0;
            const turnsSinceLast = ctx.turnNumber - lastChecked;
            if (turnsSinceLast < opts.checkEveryNTurns) return;

            lastCheckedByThread.set(threadId, ctx.turnNumber);

            let messages: ChatMessage[];
            try {
                const raw = await opts.checkpointer.getThreadMessages<ExtractorMessage>(
                    threadId,
                    { limit: Math.max(opts.windowSize, 16) },
                );
                messages = raw
                    .map(toChat)
                    .filter((m): m is ChatMessage => m !== null);
            } catch (err) {
                log.debug({ err, threadId }, 'failed to fetch messages — skipping detector run');
                return;
            }
            if (messages.length < 2) return;

            const existing = opts.existingSkills?.() ?? [];
            let signal: SkillSignal | null = null;
            try {
                signal = await getDetector().detect(messages, existing);
            } catch (err) {
                log.debug({ err, threadId }, 'detector threw — continuing');
                return;
            }
            if (!signal) return;

            const persisted: PersistedSignal = {
                ...signal,
                ts: Date.now(),
                threadId,
                turnNumber: ctx.turnNumber,
            };
            await persist(persisted);
            log.info(
                {
                    threadId,
                    turnNumber: ctx.turnNumber,
                    signal_type: signal.signal_type,
                    confidence: signal.confidence,
                    suggested: signal.suggested_skill_name ?? signal.suggested_existing_skill ?? '(none)',
                },
                'skill signal detected — appended to proposals',
            );
        },
    };
}
