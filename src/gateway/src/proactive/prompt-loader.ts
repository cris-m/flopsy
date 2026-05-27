import { readFile } from 'node:fs/promises';
import { resolvePromptPath, type PromptKind } from '@flopsy/shared';

export type { PromptKind };

interface CacheEntry {
    content: string;
    loadedAt: number;
}

export class PromptLoader {
    private readonly cache = new Map<string, CacheEntry>();

    constructor(
        private readonly baseDir: string,
        private readonly ttlMs = 60_000,
    ) {}

    async resolve(prompt?: string, promptFile?: string, kind?: PromptKind): Promise<string> {
        if (promptFile) {
            return this.loadFile(promptFile, kind);
        }
        return prompt ?? '';
    }

    private async loadFile(filePath: string, kind?: PromptKind): Promise<string> {
        if (!kind && !filePath.startsWith('/')) {
            throw new Error(
                `PromptLoader.loadFile: relative filePath "${filePath}" requires a PromptKind ` +
                    `("heartbeat" or "cron") to resolve under <FLOPSY_HOME>/content/prompts/<kind>/.`,
            );
        }
        const absPath = kind
            ? resolvePromptPath(filePath, kind)
            : filePath;

        const cached = this.cache.get(absPath);
        if (cached && Date.now() - cached.loadedAt < this.ttlMs) {
            return cached.content;
        }
        const content = await readFile(absPath, 'utf8');
        this.cache.set(absPath, { content, loadedAt: Date.now() });
        return content;
    }
}
