import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePromptPath, type PromptKind } from '@flopsy/shared';

export type { PromptKind };

interface CacheEntry {
    content: string;
    loadedAt: number;
}

/**
 * Reads prompt files from the workspace, namespaced by schedule kind:
 *   heartbeat → <FLOPSY_HOME>/proactive/heartbeats/<file>
 *   cron      → <FLOPSY_HOME>/proactive/cron/<file>
 * Absolute paths bypass namespacing entirely (escape hatch).
 * Results are cached with a 60s TTL so edits propagate without restart.
 *
 * `baseDir` is retained for legacy callers that pass relative (un-kinded)
 * paths — new code should always pass `kind` and let the workspace util
 * resolve the path.
 */
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
        const absPath = kind
            ? resolvePromptPath(filePath, kind)
            : filePath.startsWith('/')
              ? filePath
              : join(this.baseDir, filePath);

        const cached = this.cache.get(absPath);
        if (cached && Date.now() - cached.loadedAt < this.ttlMs) {
            return cached.content;
        }
        const content = await readFile(absPath, 'utf8');
        this.cache.set(absPath, { content, loadedAt: Date.now() });
        return content;
    }
}
