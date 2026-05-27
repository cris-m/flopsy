import { describe, it, expect } from 'vitest';
import { parseMemoryConfig } from '../config';

describe('parseMemoryConfig', () => {
    it('applies all defaults when given empty config', () => {
        const cfg = parseMemoryConfig({});
        expect(cfg.enabled).toBe(true);
        expect(cfg.userProfileEnabled).toBe(true);
        expect(cfg.provider).toBe('file');
        expect(cfg.files.userCharLimit).toBe(1375);
        expect(cfg.files.memoryCharLimit).toBe(2200);
        expect(cfg.files.userPath).toMatch(/USER\.md$/);
        expect(cfg.files.memoryPath).toMatch(/MEMORY\.md$/);
        expect(cfg.embedder).toBe(null);
        expect(cfg.plugins.audit.enabled).toBe(false);
        expect(cfg.plugins.sqliteMirror.enabled).toBe(false);
        expect(cfg.plugins.sqliteMirror.mirrorOnWrite).toBe(true);
        expect(cfg.plugins.smartWriter.enabled).toBe(false);
        expect(cfg.plugins.smartWriter.model).toBe('nvidia:google/gemma-4-31b-it');
        expect(cfg.plugins.smartWriter.similarityThreshold).toBe(0.7);
        expect(cfg.plugins.smartWriter.topK).toBe(3);
        expect(cfg.plugins.mem0.enabled).toBe(false);
        expect(cfg.plugins.honcho.enabled).toBe(false);
    });

    it('reads embedder block', () => {
        const cfg = parseMemoryConfig({
            embedder: { provider: 'ollama', model: 'nomic-embed-text:v1.5' },
        });
        expect(cfg.embedder).toEqual({
            provider: 'ollama',
            model: 'nomic-embed-text:v1.5',
            config: {},
        });
    });

    it('uses files.* over legacy flat fields when both present', () => {
        const cfg = parseMemoryConfig({
            userCharLimit: 999,
            memoryCharLimit: 999,
            files: { userCharLimit: 500, memoryCharLimit: 1000 },
        });
        expect(cfg.files.userCharLimit).toBe(500);
        expect(cfg.files.memoryCharLimit).toBe(1000);
    });

    it('falls back to legacy flat fields when files.* missing', () => {
        const cfg = parseMemoryConfig({
            userCharLimit: 777,
            memoryCharLimit: 1234,
        });
        expect(cfg.files.userCharLimit).toBe(777);
        expect(cfg.files.memoryCharLimit).toBe(1234);
    });

    it('reads plugins.smartWriter config + applies its defaults', () => {
        const cfg = parseMemoryConfig({
            plugins: {
                smartWriter: {
                    enabled: true,
                    model: 'nvidia:custom/model',
                    similarityThreshold: 0.85,
                    topK: 5,
                },
            },
        });
        expect(cfg.plugins.smartWriter.enabled).toBe(true);
        expect(cfg.plugins.smartWriter.model).toBe('nvidia:custom/model');
        expect(cfg.plugins.smartWriter.similarityThreshold).toBe(0.85);
        expect(cfg.plugins.smartWriter.topK).toBe(5);
        expect(cfg.plugins.smartWriter.auditLog).toMatch(/audit\.jsonl$/);
    });

    it('reads plugins.sqliteMirror config', () => {
        const cfg = parseMemoryConfig({
            plugins: {
                sqliteMirror: { enabled: true, mirrorOnWrite: false },
            },
        });
        expect(cfg.plugins.sqliteMirror.enabled).toBe(true);
        expect(cfg.plugins.sqliteMirror.mirrorOnWrite).toBe(false);
        expect(cfg.plugins.sqliteMirror.path).toMatch(/memory\.db$/);
    });

    it('reads plugins.audit config', () => {
        const cfg = parseMemoryConfig({
            plugins: {
                audit: { enabled: true, maxQueryResults: 50 },
            },
        });
        expect(cfg.plugins.audit.enabled).toBe(true);
        expect(cfg.plugins.audit.maxQueryResults).toBe(50);
        expect(cfg.plugins.audit.logPath).toMatch(/audit\.jsonl$/);
    });

    it('reads plugins.mem0 + plugins.honcho blocks', () => {
        const cfg = parseMemoryConfig({
            plugins: {
                mem0: { enabled: true, baseUrl: 'http://localhost:8765', userId: 'alice' },
                honcho: {
                    enabled: true,
                    baseUrl: 'http://localhost:8000',
                    peerName: 'alice',
                    aiPeer: 'flopsy',
                },
            },
        });
        expect(cfg.plugins.mem0).toEqual({
            enabled: true,
            baseUrl: 'http://localhost:8765',
            userId: 'alice',
        });
        expect(cfg.plugins.honcho).toEqual({
            enabled: true,
            baseUrl: 'http://localhost:8000',
            peerName: 'alice',
            aiPeer: 'flopsy',
        });
    });

    it('rejects invalid similarityThreshold (>1)', () => {
        expect(() => parseMemoryConfig({
            plugins: { smartWriter: { similarityThreshold: 1.5 } },
        })).toThrow();
    });

    it('rejects invalid topK (negative)', () => {
        expect(() => parseMemoryConfig({
            plugins: { smartWriter: { topK: -1 } },
        })).toThrow();
    });

    it('rejects userCharLimit over hard cap', () => {
        expect(() => parseMemoryConfig({
            userCharLimit: 9999999,
        })).toThrow();
    });

    it('rejects path with null byte', () => {
        expect(() => parseMemoryConfig({
            files: { userPath: 'state/memory/\0evil.md' },
        })).toThrow();
    });

    it('passthrough preserves unknown sibling fields without rejecting', () => {
        const cfg = parseMemoryConfig({
            futureFeature: { enabled: true },
            embedder: { provider: 'ollama', model: 'test' },
        });
        expect(cfg.embedder?.provider).toBe('ollama');
    });

    it('passthrough preserves unknown plugin entries without rejecting', () => {
        const cfg = parseMemoryConfig({
            plugins: {
                audit: { enabled: true },
                customPlugin: { enabled: true, foo: 'bar' },
            },
        });
        expect(cfg.plugins.audit.enabled).toBe(true);
    });
});
