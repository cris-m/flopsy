import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveMediaSource, resolveMediaBatch } from '@gateway/core/media-resolver';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURE_DIR = join(tmpdir(), `flopsy-media-resolver-${process.pid}`);

describe('resolveMediaSource', () => {
    beforeAll(async () => {
        await mkdir(FIXTURE_DIR, { recursive: true });
        await writeFile(join(FIXTURE_DIR, 'tiny.wav'), Buffer.from('RIFF\0\0\0\0WAVE'));
        await writeFile(join(FIXTURE_DIR, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    afterAll(async () => {
        await rm(FIXTURE_DIR, { recursive: true, force: true });
    });

    it('resolves a public HTTPS URL', async () => {
        const r = await resolveMediaSource({ type: 'image', url: 'https://example.com/x.png' });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.source.kind).toBe('remote-url');
            if (r.source.kind === 'remote-url') {
                expect(r.source.url.host).toBe('example.com');
            }
        }
    });

    it('rejects a private-IP URL via SSRF guard', async () => {
        const r = await resolveMediaSource({ type: 'image', url: 'http://192.168.1.1/x.png' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('ssrf-blocked');
    });

    it('rejects loopback', async () => {
        const r = await resolveMediaSource({ type: 'image', url: 'http://127.0.0.1/x.png' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('ssrf-blocked');
    });

    it('rejects file:// scheme as unsupported protocol', async () => {
        const r = await resolveMediaSource({ type: 'image', url: 'file:///etc/hosts' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('unsupported-protocol');
    });

    it('rejects ftp:// scheme', async () => {
        const r = await resolveMediaSource({ type: 'document', url: 'ftp://example.com/x.pdf' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('unsupported-protocol');
    });

    it('resolves an absolute local path', async () => {
        const path = join(FIXTURE_DIR, 'tiny.wav');
        const r = await resolveMediaSource({ type: 'audio', url: path });
        expect(r.ok).toBe(true);
        if (r.ok && r.source.kind === 'local-path') {
            expect(r.source.absPath).toBe(path);
            expect(r.source.size).toBeGreaterThan(0);
            expect(r.source.mime).toBe('audio/wav');
        }
    });

    it('infers MIME from extension when not provided', async () => {
        const r = await resolveMediaSource({ type: 'image', url: join(FIXTURE_DIR, 'image.png') });
        expect(r.ok).toBe(true);
        if (r.ok && r.source.kind === 'local-path') {
            expect(r.source.mime).toBe('image/png');
        }
    });

    it('honours explicit MIME over extension inference', async () => {
        const r = await resolveMediaSource({
            type: 'image',
            url: join(FIXTURE_DIR, 'image.png'),
            mimeType: 'image/heic',
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.source.kind === 'local-path') {
            expect(r.source.mime).toBe('image/heic');
        }
    });

    it('reports file-missing for nonexistent path', async () => {
        const r = await resolveMediaSource({ type: 'audio', url: '/tmp/definitely-not-there-xyz123.wav' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('file-missing');
    });

    it('reports file-too-large when local file exceeds cap', async () => {
        const r = await resolveMediaSource(
            { type: 'audio', url: join(FIXTURE_DIR, 'tiny.wav') },
            { maxBytes: 2 },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('file-too-large');
    });

    it('decodes base64 data into a buffer', async () => {
        const data = Buffer.from('hello world').toString('base64');
        const r = await resolveMediaSource({ type: 'document', data, fileName: 'hi.txt', mimeType: 'text/plain' });
        expect(r.ok).toBe(true);
        if (r.ok && r.source.kind === 'buffer') {
            expect(r.source.data.toString('utf-8')).toBe('hello world');
            expect(r.source.fileName).toBe('hi.txt');
            expect(r.source.mime).toBe('text/plain');
        }
    });

    it('reports no-source when neither url nor data is set', async () => {
        const r = await resolveMediaSource({ type: 'image' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('no-source');
    });

    it('prefers data over url when both are set (cheapest path)', async () => {
        const r = await resolveMediaSource({
            type: 'image',
            url: 'https://example.com/x.png',
            data: Buffer.from('inline').toString('base64'),
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.source.kind).toBe('buffer');
    });
});

describe('resolveMediaBatch', () => {
    it('resolves items in parallel and preserves order', async () => {
        const out = await resolveMediaBatch([
            { type: 'image', url: 'https://example.com/a.png' },
            { type: 'image', url: '/tmp/missing-xyz.png' },
            { type: 'image' },
        ]);
        expect(out).toHaveLength(3);
        expect(out[0]!.ok).toBe(true);
        expect(out[1]!.ok).toBe(false);
        expect(out[2]!.ok).toBe(false);
    });
});
