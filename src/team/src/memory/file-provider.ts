import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { open, rename, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
    defineTool,
    detectPromptInjection,
    detectSecret,
    hasUnicodeContamination,
    MemoryConfigError,
    type BaseTool,
    type MemoryProvider,
    type MemoryCapability,
    type MemoryWriteAction,
    type ProviderManifest,
    type IngestInput,
} from 'flopsygraph';
import { resolveWorkspacePath, resolveFlopsyHome } from '@flopsy/shared';

export interface FileMemoryProviderOptions {
    userPath: string;
    memoryPath: string;
    userCharLimit?: number;
    memoryCharLimit?: number;
    onMemoryWrite?: (
        action: MemoryWriteAction,
        target: string,
        content: string,
        metadata: Readonly<Record<string, unknown>>,
    ) => void | Promise<void>;
}

import {
    DEFAULT_USER_CHAR_LIMIT,
    DEFAULT_MEMORY_CHAR_LIMIT,
    getMemoryFilePaths,
} from './config';

const ENTRY_DELIMITER = '\n\n';

type Target = 'user' | 'memory';

function normalizeEntry(content: string): string {
    return content.trim().replace(/\n{2,}/g, '\n');
}

function readEntries(path: string): string[] {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return [];
    return raw
        .split(/\n{2,}/)
        .map((e) => e.trim())
        .filter(Boolean);
}

async function writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const fh = await open(tmp, 'wx', 0o600);
    try {
        await fh.writeFile(content, 'utf8');
        await fh.sync();
    } finally {
        await fh.close();
    }
    await rename(tmp, path);
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = `${path}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    const start = Date.now();

    while (true) {
        try {
            const fh = await open(lockPath, 'wx', 0o600);
            try {
                return await fn();
            } finally {
                try { await fh.close(); } catch { /* */ }
                try { await unlink(lockPath); } catch { /* */ }
            }
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') throw err;

            try {
                const st = await stat(lockPath);
                if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
                    await unlink(lockPath).catch(() => undefined);
                    continue;
                }
            } catch { /* */ }

            if (Date.now() - start > LOCK_TIMEOUT_MS) {
                throw new Error(
                    `memory: could not acquire lock on ${path} within ${LOCK_TIMEOUT_MS}ms`,
                );
            }
            await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        }
    }
}

function charCount(entries: readonly string[]): number {
    if (entries.length === 0) return 0;
    return entries.join(ENTRY_DELIMITER).length;
}

function usageString(entries: readonly string[], limit: number): string {
    const count = charCount(entries);
    const pct = limit > 0 ? Math.min(100, Math.floor((count / limit) * 100)) : 0;
    return `${pct}% — ${count.toLocaleString()}/${limit.toLocaleString()} chars`;
}

function scanContent(content: string): { ok: true } | { ok: false; reason: string } {
    if (hasUnicodeContamination(content)) {
        return { ok: false, reason: 'content contains invisible Unicode (possible injection)' };
    }
    const pattern = detectPromptInjection(content);
    if (pattern) {
        return { ok: false, reason: `content matches injection pattern '${pattern}'` };
    }
    const secret = detectSecret(content);
    if (secret) {
        return { ok: false, reason: `content looks like a credential (${secret}); secrets must not be stored in memory` };
    }
    return { ok: true };
}

const MEMORY_TOOL_DESCRIPTION = `Persistent memory across sessions. Entries are injected into future turns; keep them compact and lasting.

Targets:
  user   — stable facts about the user that hold across projects and time: name, location, timezone, languages, communication style.
  memory — everything else worth recalling: projects, learnings, environment facts, tool quirks, decisions, events.

A fact belongs in user only if it would still be true a year from now in any context. Project work, current focus, time-anchored notes ("today", dates), and tool- or library-specific preferences go in memory.

Actions:
  list    — return entries with indices. Use before free-form add to check for prior coverage.
  upsert  — set a keyed slot in one call. Args: key, content. Replaces an existing entry whose first line starts with "<key>:", otherwise appends. Prefer for Key: Value facts.
  add     — append a new entry. Args: content. Refused on exact-match or key-prefix collisions; the response includes the call to use instead.
  replace — overwrite a single entry matched by old_text (must be unique). Args: old_text, content.
  remove  — delete a single entry matched by old_text (must be unique). Args: old_text.

Style:
  - Save proactively on corrections, preferences, stable facts, environment details, and reusable lessons.
  - Skip task progress, session logs, completed-work summaries, and anything easily re-derived.
  - Prefer "Key: Value" entries for atomic facts so upsert and prefix-collision detection work.
  - Keep entries terse. Memory budget is shared across all future turns.`;

const memorySchema = z.object({
    action: z
        .enum(['list', 'add', 'upsert', 'replace', 'remove'])
        .describe('The action to perform.'),
    target: z
        .enum(['user', 'memory'])
        .describe(
            'Which memory store: "memory" for personal notes, "user" for user profile.',
        ),
    content: z
        .string()
        .optional()
        .describe('The entry content. Required for "add", "upsert", and "replace".'),
    old_text: z
        .string()
        .optional()
        .describe(
            'Short unique substring identifying the entry to replace or remove. ' +
                'Must match exactly one entry; ambiguous matches are refused.',
        ),
    key: z
        .string()
        .optional()
        .describe(
            'For action=upsert: the slot to update. The tool looks for an existing ' +
                'entry whose first line starts with "<key>:" (case-insensitive). ' +
                'If found, replaces it; if not, appends a new entry. ' +
                'Examples: "Location", "Name", "Primary channel".',
        ),
});

/**
 * Pull the lead key from a `Key: Value` shaped entry. Returns the
 * lowercased key, or `null` for free-form entries. Used by the
 * duplicate-detection guard on `add` to recognize that
 * "Location: Congo" and "Location: Kinshasa" are the same *slot* even
 * though their text differs.
 */
function extractKeyPrefix(entry: string): string | null {
    const firstLine = entry.split('\n', 1)[0] ?? '';
    const colon = firstLine.indexOf(':');
    if (colon <= 0 || colon > 40) return null;
    const key = firstLine.slice(0, colon).trim();
    if (key.length === 0 || key.length > 40) return null;
    if (!/^[A-Za-z][A-Za-z0-9 _-]*$/.test(key)) return null;
    return key.toLowerCase();
}

function previewEntry(entry: string, max = 80): string {
    const oneLine = entry.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

type EntryMatch =
    | { kind: 'none' }
    | { kind: 'one'; index: number }
    | { kind: 'ambiguous'; indices: number[] };

function locateEntry(entries: readonly string[], needle: string): EntryMatch {
    const exact = entries.indexOf(needle);
    if (exact >= 0) return { kind: 'one', index: exact };
    const indices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
        if (entries[i]!.includes(needle)) indices.push(i);
    }
    if (indices.length === 0) return { kind: 'none' };
    if (indices.length === 1) return { kind: 'one', index: indices[0]! };
    return { kind: 'ambiguous', indices };
}

/**
 * Detect content shapes that should almost always live in MEMORY.md, not
 * USER.md — project context, time-stamped events, ongoing work. Returns
 * a list of signals when something looks misplaced.
 *
 * Soft-mode by design: the tool still writes the entry but appends a
 * warning to the success response. The model sees the warning and
 * (hopefully) re-evaluates on the next call. We avoid hard refusal
 * because false positives are common: "I prefer concise replies" is a
 * legitimate USER.md preference even though "I prefer" sometimes
 * signals project-scoped choice.
 *
 * Empty array means "no obvious miscategorization signals" — not a
 * positive verdict, just absence of red flags.
 */
function detectMisplacedSignals(content: string, target: Target): string[] {
    if (target !== 'user') return [];
    const signals: string[] = [];
    const lower = content.toLowerCase();

    if (/\b(this\s+morning|today|yesterday|tomorrow|tonight|last\s+(week|month|year))\b/.test(lower)) {
        signals.push('time anchor');
    }
    if (/\b20\d{2}-\d{2}-\d{2}\b/.test(lower)) {
        signals.push('date');
    }
    if (/\b(building|developing|working on|started|launched|shipped|deploying|migrating)\b/.test(lower)) {
        signals.push('project verb');
    }
    if (/\b(cancelled|canceled|paused|sunset|deprecated|killed)\b/.test(lower)) {
        signals.push('lifecycle verb');
    }
    if (/\b(service|endpoint|schema|database|api|microservice|backend|frontend service)\b/.test(lower)
        && !/\b(role|i am|i'm|career|profession)\b/.test(lower)) {
        signals.push('technical vocabulary');
    }

    return signals;
}

function buildMemoryTool(opts: FileMemoryProviderOptions): BaseTool {
    const userPath = opts.userPath;
    const memoryPath = opts.memoryPath;
    const userLimit = opts.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT;
    const memoryLimit = opts.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;

    const pathFor = (t: Target): string => (t === 'user' ? userPath : memoryPath);
    const limitFor = (t: Target): number => (t === 'user' ? userLimit : memoryLimit);

    const serialize = (entries: readonly string[]): string =>
        entries.length === 0 ? '' : entries.join(ENTRY_DELIMITER) + '\n';

    const fireOnWrite = async (
        action: MemoryWriteAction,
        target: Target,
        content: string,
        extra?: Record<string, unknown>,
    ): Promise<void> => {
        if (!opts.onMemoryWrite) return;
        try {
            await opts.onMemoryWrite(action, target, content, {
                ts: Date.now(),
                source: 'file-provider',
                ...extra,
            });
        } catch { /* */ }
    };

    return defineTool({
        name: 'memory',
        description: MEMORY_TOOL_DESCRIPTION,
        schema: memorySchema,
        execute: async ({ action, target, content, old_text, key }) => {
            const path = pathFor(target);
            const limit = limitFor(target);

            return withFileLock(path, async () => {
            try {
                const entries = readEntries(path);

                if (action === 'list') {
                    return JSON.stringify({
                        success: true,
                        target,
                        entry_count: entries.length,
                        usage: usageString(entries, limit),
                        entries: entries.map((e, i) => ({
                            index: i,
                            preview: previewEntry(e),
                        })),
                    });
                }

                if (action === 'add') {
                    if (!content || !content.trim()) {
                        return JSON.stringify({
                            success: false,
                            error: 'content is required for action=add',
                        });
                    }
                    const clean = normalizeEntry(content);
                    const scan = scanContent(clean);
                    if (!scan.ok) {
                        return JSON.stringify({
                            success: false,
                            error: `blocked: ${scan.reason}`,
                        });
                    }

                    // Duplicate detection: refuse the add and tell the model the
                    // exact replace call to make next. Two-tier check —
                    // (1) exact-match: same trimmed text already exists,
                    // (2) key-prefix collision: "Location: Congo" vs "Location: Kinshasa"
                    //     (only when both entries follow the "Key: Value" shape).
                    for (let i = 0; i < entries.length; i++) {
                        if (entries[i] === clean) {
                            return JSON.stringify({
                                success: false,
                                error: `exact duplicate at index ${i}; no write performed`,
                                existing: previewEntry(entries[i]!),
                            });
                        }
                    }
                    const newKey = extractKeyPrefix(clean);
                    if (newKey) {
                        for (let i = 0; i < entries.length; i++) {
                            const existingKey = extractKeyPrefix(entries[i]!);
                            if (existingKey && existingKey === newKey) {
                                return JSON.stringify({
                                    success: false,
                                    error: `key "${newKey}" already exists at index ${i}; use action=replace or action=upsert`,
                                    existing: previewEntry(entries[i]!),
                                    suggested_call: {
                                        action: 'replace',
                                        target,
                                        old_text: previewEntry(entries[i]!, 40),
                                        content: clean,
                                    },
                                });
                            }
                        }
                    }

                    const projected = [...entries, clean];
                    const projectedChars = charCount(projected);
                    if (projectedChars > limit) {
                        // First check: does the content actually belong in the
                        // OTHER target? If yes, propose the migration instead
                        // of suggesting a shrink-in-place, which would otherwise
                        // entrench the wrong-target choice.
                        const misplacedAtBudget = detectMisplacedSignals(clean, target);
                        if (misplacedAtBudget.length > 0) {
                            return JSON.stringify({
                                success: false,
                                error: `${target}.md over budget (${projectedChars}/${limit}) and content shape suggests target=memory; retarget instead of evicting`,
                                current_usage: usageString(entries, limit),
                                signals: misplacedAtBudget,
                                suggested_call: {
                                    action: 'add',
                                    target: target === 'user' ? 'memory' : 'user',
                                    content: clean,
                                },
                            });
                        }

                        // Otherwise the content does belong here — suggest a
                        // shrink-in-place against the longest existing entry.
                        let longestIdx = 0;
                        for (let i = 1; i < entries.length; i++) {
                            if (entries[i]!.length > entries[longestIdx]!.length) longestIdx = i;
                        }
                        const longest = entries[longestIdx];
                        return JSON.stringify({
                            success: false,
                            error: `${target}.md over budget (${projectedChars}/${limit}); replace a stale entry, remove one, or shorten the new content`,
                            current_usage: usageString(entries, limit),
                            suggested_call: longest
                                ? {
                                      action: 'replace',
                                      target,
                                      old_text: previewEntry(longest, 40),
                                      content: clean,
                                  }
                                : undefined,
                        });
                    }
                    await writeAtomic(path, serialize(projected));
                    await fireOnWrite('add', target, clean);
                    const misplaced = detectMisplacedSignals(clean, target);
                    return JSON.stringify({
                        success: true,
                        target,
                        message: 'Entry added.',
                        entry_count: projected.length,
                        usage: usageString(projected, limit),
                        ...(misplaced.length > 0
                            ? {
                                  warning: `entry shape suggests target=memory (signals: ${misplaced.join(', ')}); consider remove + add target=memory`,
                              }
                            : {}),
                    });
                }

                if (action === 'upsert') {
                    if (!key || !key.trim()) {
                        return JSON.stringify({
                            success: false,
                            error: 'key is required for action=upsert',
                        });
                    }
                    if (!content || !content.trim()) {
                        return JSON.stringify({
                            success: false,
                            error: 'content is required for action=upsert',
                        });
                    }
                    const slotKey = key.trim().toLowerCase();
                    if (!/^[a-z][a-z0-9 _-]{0,39}$/.test(slotKey)) {
                        return JSON.stringify({
                            success: false,
                            error: `invalid key "${key}"; must be 1-40 chars, start with a letter, [A-Za-z0-9 _-] only`,
                        });
                    }
                    const clean = normalizeEntry(content);
                    const scan = scanContent(clean);
                    if (!scan.ok) {
                        return JSON.stringify({
                            success: false,
                            error: `blocked: ${scan.reason}`,
                        });
                    }

                    const existingPrefix = extractKeyPrefix(clean);
                    const expectedPrefix = `${key.trim()}:`.toLowerCase();
                    const firstLineLower = (clean.split('\n', 1)[0] ?? '').toLowerCase();
                    const alreadyHasOurKey = firstLineLower.startsWith(expectedPrefix);
                    const finalEntry = (alreadyHasOurKey || existingPrefix !== null)
                        ? clean
                        : `${key.trim()}: ${clean}`;

                    // Find the existing slot, if any.
                    let slotIdx = -1;
                    for (let i = 0; i < entries.length; i++) {
                        if (extractKeyPrefix(entries[i]!) === slotKey) {
                            slotIdx = i;
                            break;
                        }
                    }

                    const projected =
                        slotIdx >= 0
                            ? entries.map((e, i) => (i === slotIdx ? finalEntry : e))
                            : [...entries, finalEntry];
                    const projectedChars = charCount(projected);
                    if (projectedChars > limit) {
                        return JSON.stringify({
                            success: false,
                            error: `${target}.md over budget (${projectedChars}/${limit}); list and remove a stale entry first`,
                            current_usage: usageString(entries, limit),
                        });
                    }
                    await writeAtomic(path, serialize(projected));
                    await fireOnWrite('upsert', target, finalEntry, { key: key.trim(), index: slotIdx });
                    const misplacedUpsert = detectMisplacedSignals(finalEntry, target);
                    return JSON.stringify({
                        success: true,
                        target,
                        message:
                            slotIdx >= 0
                                ? `Entry replaced (key="${key.trim()}", index=${slotIdx}).`
                                : `Entry added (key="${key.trim()}", new slot).`,
                        action_taken: slotIdx >= 0 ? 'replaced' : 'added',
                        entry_count: projected.length,
                        usage: usageString(projected, limit),
                        ...(misplacedUpsert.length > 0
                            ? {
                                  warning: `slot shape suggests target=memory (signals: ${misplacedUpsert.join(', ')}); consider remove + upsert target=memory`,
                              }
                            : {}),
                    });
                }

                if (action === 'replace') {
                    if (!old_text || !old_text.trim()) {
                        return JSON.stringify({
                            success: false,
                            error: 'old_text is required for action=replace',
                        });
                    }
                    if (!content || !content.trim()) {
                        return JSON.stringify({
                            success: false,
                            error: 'content is required for action=replace',
                        });
                    }
                    const needle = old_text.trim();
                    const clean = normalizeEntry(content);
                    const scan = scanContent(clean);
                    if (!scan.ok) {
                        return JSON.stringify({
                            success: false,
                            error: `blocked: ${scan.reason}`,
                        });
                    }
                    const matchIdx = locateEntry(entries, needle);
                    if (matchIdx.kind === 'none') {
                        return JSON.stringify({
                            success: false,
                            error: `No entry matched "${needle}".`,
                        });
                    }
                    if (matchIdx.kind === 'ambiguous') {
                        return JSON.stringify({
                            success: false,
                            error: `Multiple entries matched "${needle}". Pass the full entry text to disambiguate.`,
                            matches: matchIdx.indices.map((i) => previewEntry(entries[i]!)),
                        });
                    }
                    const idx = matchIdx.index;
                    const projected = [...entries];
                    projected[idx] = clean;
                    const projectedChars = charCount(projected);
                    if (projectedChars > limit) {
                        return JSON.stringify({
                            success: false,
                            error: `would exceed char limit (${projectedChars}/${limit})`,
                        });
                    }
                    await writeAtomic(path, serialize(projected));
                    await fireOnWrite('replace', target, clean, { old_text: needle });
                    return JSON.stringify({
                        success: true,
                        target,
                        message: 'Entry replaced.',
                        entry_count: projected.length,
                        usage: usageString(projected, limit),
                    });
                }

                if (action === 'remove') {
                    if (!old_text || !old_text.trim()) {
                        return JSON.stringify({
                            success: false,
                            error: 'old_text is required for action=remove',
                        });
                    }
                    const needle = old_text.trim();
                    const matchIdx = locateEntry(entries, needle);
                    if (matchIdx.kind === 'none') {
                        return JSON.stringify({
                            success: false,
                            error: `No entry matched "${needle}".`,
                        });
                    }
                    if (matchIdx.kind === 'ambiguous') {
                        return JSON.stringify({
                            success: false,
                            error: `Multiple entries matched "${needle}". Pass the full entry text to disambiguate.`,
                            matches: matchIdx.indices.map((i) => previewEntry(entries[i]!)),
                        });
                    }
                    const idx = matchIdx.index;
                    const removedEntry = entries[idx]!;
                    const projected = entries.filter((_, i) => i !== idx);
                    await writeAtomic(path, serialize(projected));
                    await fireOnWrite('remove', target, removedEntry, { index: idx });
                    return JSON.stringify({
                        success: true,
                        target,
                        message: 'Entry removed.',
                        entry_count: projected.length,
                        usage: usageString(projected, limit),
                    });
                }

                return JSON.stringify({
                    success: false,
                    error: `unknown action: ${action as string}`,
                });
            } catch (err) {
                return JSON.stringify({
                    success: false,
                    error: `memory tool failed: ${(err as Error).message}`,
                });
            }
            });
        },
    });
}

export class FileMemoryProvider implements MemoryProvider {
    readonly name = 'file';
    readonly capabilities: readonly MemoryCapability[] = ['keyword_search'];
    readonly card =
        'Markdown-file memory: USER.md (user profile) + MEMORY.md (agent notes). ' +
        'Surgical add/replace/remove via the single `memory` tool. ' +
        'Entries separated by blank lines. Atomic writes. Char-limit enforced. ' +
        'Content scanned for injection patterns and credentials before write. ' +
        'Single-user: one FLOPSY_HOME serves one principal.';

    private opts: FileMemoryProviderOptions;
    private memoryTool: BaseTool;

    constructor(opts: FileMemoryProviderOptions) {
        this.opts = opts;
        mkdirSync(dirname(opts.userPath), { recursive: true });
        mkdirSync(dirname(opts.memoryPath), { recursive: true });
        this.memoryTool = buildMemoryTool(opts);
    }

    setOnMemoryWrite(
        cb: NonNullable<FileMemoryProviderOptions['onMemoryWrite']>,
    ): void {
        this.opts = { ...this.opts, onMemoryWrite: cb };
        this.memoryTool = buildMemoryTool(this.opts);
    }

    async ping(): Promise<{ ok: boolean; reason?: string }> {
        try {
            await stat(dirname(this.opts.userPath));
            await stat(dirname(this.opts.memoryPath));
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: (err as Error).message };
        }
    }

    getTools(): readonly BaseTool[] {
        return [this.memoryTool];
    }

    readonly archetype = 'store' as const;

    async contributeContext(): Promise<string> {
        const userLimit = this.opts.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT;
        const memoryLimit = this.opts.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;
        const sections: string[] = [];
        for (const [label, path, limit] of [
            ['/memory/USER.md', this.opts.userPath, userLimit] as const,
            ['/memory/MEMORY.md', this.opts.memoryPath, memoryLimit] as const,
        ]) {
            const entries = readEntries(path);
            if (entries.length === 0) continue;
            let body = entries.join(ENTRY_DELIMITER);
            if (limit > 0 && body.length > limit) body = body.slice(0, limit);
            sections.push(`<!-- ${label} -->\n${body}`);
        }
        return sections.join('\n\n');
    }

    async ingest(input: IngestInput): Promise<void> {
        if (input.kind !== 'facts') return;
        const path = this.opts.memoryPath;
        const limit = this.opts.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;
        const entries = readEntries(path);
        let changed = false;
        for (const raw of input.facts) {
            const clean = normalizeEntry(raw);
            if (!clean) continue;
            if (!scanContent(clean).ok) continue;
            if (entries.some((e) => e === clean)) continue;
            if (limit > 0 && charCount([...entries, clean]) > limit) continue;
            entries.push(clean);
            changed = true;
        }
        if (!changed) return;
        const serialized = entries.length === 0 ? '' : entries.join(ENTRY_DELIMITER) + '\n';
        await writeAtomic(path, serialized);
    }
}

export function createFileMemoryProvider(
    opts: FileMemoryProviderOptions,
): FileMemoryProvider {
    return new FileMemoryProvider(opts);
}

export function createMemoryTool(opts: FileMemoryProviderOptions): BaseTool {
    mkdirSync(dirname(opts.userPath), { recursive: true });
    mkdirSync(dirname(opts.memoryPath), { recursive: true });
    return buildMemoryTool(opts);
}

export type FileProviderManifestConfig = Partial<Omit<FileMemoryProviderOptions, 'onMemoryWrite'>>;

/**
 * Registry manifest for the markdown-file memory backend. Lets FlopsyBot
 * load the file provider through flopsygraph's `getMemoryRegistry().load()`
 * the same way it would load `local` (sqlite) or any external provider —
 * the file provider is just the default `provider: "file"`.
 */
export const fileMemoryProviderManifest: ProviderManifest<FileProviderManifestConfig> = {
    name: 'file',
    version: '1.0.0',
    capabilities: ['keyword_search'],
    validateConfig(raw: unknown): FileProviderManifestConfig {
        const c = (raw ?? {}) as Record<string, unknown>;
        const home = resolveFlopsyHome();
        const containedPath = (v: unknown, field: string): string | undefined => {
            if (v === undefined) return undefined;
            if (typeof v !== 'string') {
                throw new MemoryConfigError('file', field, `${field} must be a string`);
            }
            const abs = resolve(v.replace(/^~(?=$|[\\/])/, homedir()));
            if (abs !== home && !abs.startsWith(home + sep)) {
                throw new MemoryConfigError('file', field, `${field} must stay within FLOPSY_HOME (${home})`);
            }
            return abs;
        };
        const positiveInt = (v: unknown, field: string): number | undefined => {
            if (v === undefined) return undefined;
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
                throw new MemoryConfigError('file', field, `${field} must be a positive number`);
            }
            return v;
        };
        return {
            userPath: containedPath(c.userPath, 'userPath'),
            memoryPath: containedPath(c.memoryPath, 'memoryPath'),
            userCharLimit: positiveInt(c.userCharLimit, 'userCharLimit'),
            memoryCharLimit: positiveInt(c.memoryCharLimit, 'memoryCharLimit'),
        };
    },
    factory(config: FileProviderManifestConfig): MemoryProvider {
        const paths = getMemoryFilePaths(
            config.userPath || config.memoryPath
                ? {
                      ...(config.userPath ? { userPath: config.userPath } : {}),
                      ...(config.memoryPath ? { memoryPath: config.memoryPath } : {}),
                  }
                : undefined,
        );
        return new FileMemoryProvider({
            userPath: paths.user,
            memoryPath: paths.memory,
            userCharLimit: config.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT,
            memoryCharLimit: config.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT,
        });
    },
};
