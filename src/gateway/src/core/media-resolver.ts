/**
 * Channel-agnostic outbound media resolver.
 * Returns a tagged union for: http(s) URL (SSRF-gated), local filesystem path
 * (stat'd), or base64 data (decoded). Anything else returns a structured rejection.
 */

import { isSafeMediaUrl, resolveSafePath } from '@gateway/core/security';
import { resolveFlopsyHome, resolveWorkspacePath } from '@flopsy/shared';
import { promises as fs } from 'node:fs';
import { extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** Translate `/workspace/...` sandbox paths to host FLOPSY_HOME; refuses traversal. */
export function rewriteSandboxPath(path: string): string {
    if (!path.startsWith('/workspace')) return path;
    // Strip the leading `/workspace` prefix and resolve under FLOPSY_HOME.
    const rest = path === '/workspace' ? '' : path.slice('/workspace'.length);
    if (rest.length > 0 && rest[0] !== '/') return path; // /workspace<other> not a sandbox path
    const root = resolveWorkspacePath('');
    const candidate = resolve(root, rest.replace(/^\/+/, ''));
    // Path-traversal guard: candidate must remain inside root.
    const rel = relative(root, candidate);
    if (rel.startsWith('..') || (rel !== '' && isAbsolute(rel))) {
        return path; // suspicious — return original; resolver will report file-missing
    }
    return candidate + (path.endsWith('/') && !candidate.endsWith(sep) ? sep : '');
}

/** Inbound shape — matches the `media` array element in OutboundMessage. */
export interface MediaItem {
    type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
    url?: string;
    data?: string;          // base64
    mimeType?: string;
    fileName?: string;
    caption?: string;
}

/** Default soft cap; channels with stricter limits override via `maxBytes`. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** MIME-by-extension lookup; misses fall through to channel SDK detection. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
    // Images
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.avif': 'image/avif',

    // Video
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.3gp': 'video/3gpp',

    // Audio
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.alac': 'audio/alac',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
    '.wma': 'audio/x-ms-wma',
    '.mid': 'audio/midi',
    '.midi': 'audio/midi',

    // Office: Microsoft
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

    // Office: OpenDocument
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.odp': 'application/vnd.oasis.opendocument.presentation',

    // Documents & ebooks
    '.pdf': 'application/pdf',
    '.rtf': 'application/rtf',
    '.epub': 'application/epub+zip',
    '.mobi': 'application/x-mobipocket-ebook',

    // Plain text & markup
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.rst': 'text/x-rst',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'application/xml',

    // Data formats
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.toml': 'application/toml',
    '.ini': 'text/plain',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.sql': 'application/sql',

    // Code (text/* by convention; channels treat as documents)
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.ts': 'text/x-typescript',
    '.tsx': 'text/x-typescript',
    '.jsx': 'text/javascript',
    '.py': 'text/x-python',
    '.rb': 'text/x-ruby',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.java': 'text/x-java',
    '.kt': 'text/x-kotlin',
    '.swift': 'text/x-swift',
    '.c': 'text/x-c',
    '.h': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.hpp': 'text/x-c++',
    '.cs': 'text/x-csharp',
    '.php': 'application/x-httpd-php',
    '.sh': 'application/x-sh',
    '.bash': 'application/x-sh',
    '.zsh': 'application/x-sh',

    // Notebooks
    '.ipynb': 'application/x-ipynb+json',

    // Archives
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.tgz': 'application/gzip',
    '.bz2': 'application/x-bzip2',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar',
};

export type MediaResolutionReason =
    | 'no-source'            // neither url nor data provided
    | 'ssrf-blocked'         // http(s) URL failed isSafeMediaUrl
    | 'unsupported-protocol' // file://, ftp://, ipfs:// — restricted by design
    | 'file-missing'         // local path didn't exist or wasn't readable
    | 'file-too-large'       // exceeded `maxBytes` cap
    | 'invalid-base64'       // media.data couldn't decode
    | 'invalid-url';         // URL parse failure

/** A successfully-resolved media source the channel adapter can consume. */
export type MediaSource =
    | { kind: 'remote-url'; url: URL; mime?: string; fileName?: string }
    | { kind: 'local-path'; absPath: string; size: number; mime?: string; fileName?: string }
    | { kind: 'buffer'; data: Buffer; mime?: string; fileName?: string };

export type MediaResolution =
    | { ok: true; source: MediaSource }
    | { ok: false; reason: MediaResolutionReason; detail?: string };

export interface MediaResolverOptions {
    /** Hard size cap. Channels with tighter limits override (Line: 5MB images). */
    maxBytes?: number;
}

/** Resolve one media item; at most one fs.stat for local paths, never reads bytes. */
export async function resolveMediaSource(
    media: MediaItem,
    opts: MediaResolverOptions = {},
): Promise<MediaResolution> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

    // Base64 inline data — no I/O.
    if (media.data) {
        try {
            const buf = Buffer.from(media.data, 'base64');
            if (buf.byteLength > maxBytes) {
                return { ok: false, reason: 'file-too-large', detail: `${buf.byteLength} > ${maxBytes}` };
            }
            return {
                ok: true,
                source: {
                    kind: 'buffer',
                    data: buf,
                    ...(media.mimeType ? { mime: media.mimeType } : {}),
                    ...(media.fileName ? { fileName: media.fileName } : {}),
                },
            };
        } catch (err) {
            return {
                ok: false,
                reason: 'invalid-base64',
                detail: err instanceof Error ? err.message : String(err),
            };
        }
    }

    if (!media.url) {
        return { ok: false, reason: 'no-source' };
    }

    // Remote http(s) URL.
    if (/^https?:\/\//i.test(media.url)) {
        try {
            const url = new URL(media.url);
            if (!isSafeMediaUrl(media.url)) {
                return { ok: false, reason: 'ssrf-blocked', detail: url.host };
            }
            return {
                ok: true,
                source: {
                    kind: 'remote-url',
                    url,
                    ...(media.mimeType ? { mime: media.mimeType } : {}),
                    ...(media.fileName ? { fileName: media.fileName } : {}),
                },
            };
        } catch (err) {
            return {
                ok: false,
                reason: 'invalid-url',
                detail: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // Reject other URI schemes (file://, ftp://, ipfs://) explicitly.
    if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(media.url)) {
        return {
            ok: false,
            reason: 'unsupported-protocol',
            detail: media.url.slice(0, media.url.indexOf('://') + 3),
        };
    }

    // Local filesystem path (sandbox `/workspace/...` rewritten to FLOPSY_HOME).
    // Relative paths are anchored to FLOPSY_HOME so they can't escape via `../`.
    const rewritten = rewriteSandboxPath(media.url);
    let absPath: string;
    if (isAbsolute(rewritten)) {
        absPath = normalize(rewritten);
    } else {
        try {
            absPath = resolveSafePath(resolveFlopsyHome(), rewritten);
        } catch {
            return { ok: false, reason: 'file-missing', detail: 'path escapes FLOPSY_HOME' };
        }
    }
    try {
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) {
            return { ok: false, reason: 'file-missing', detail: `${absPath} is not a regular file` };
        }
        if (stat.size > maxBytes) {
            return { ok: false, reason: 'file-too-large', detail: `${stat.size} > ${maxBytes}` };
        }
        const mimeFromExt = MIME_BY_EXT[extname(absPath).toLowerCase()];
        return {
            ok: true,
            source: {
                kind: 'local-path',
                absPath,
                size: stat.size,
                ...(media.mimeType ? { mime: media.mimeType } : mimeFromExt ? { mime: mimeFromExt } : {}),
                ...(media.fileName ? { fileName: media.fileName } : {}),
            },
        };
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
            ok: false,
            reason: 'file-missing',
            detail: code ?? (err instanceof Error ? err.message : String(err)),
        };
    }
}

/** Resolve a batch in parallel; parallel-indexed for failure correlation. */
export async function resolveMediaBatch(
    items: readonly MediaItem[],
    opts?: MediaResolverOptions,
): Promise<MediaResolution[]> {
    return Promise.all(items.map((item) => resolveMediaSource(item, opts)));
}
