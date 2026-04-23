// MCP Obsidian Server
// Read and write notes in an Obsidian vault (markdown files)
// Requires: OBSIDIAN_VAULT_PATH environment variable

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import * as path from 'path';

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ?? '';

interface VaultResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

function formatResult<T>(result: VaultResult<T>): {
    content: Array<{ type: 'text'; text: string }>;
} {
    if (!result.success) {
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }],
        };
    }
    return {
        content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
    };
}

function isMarkdown(filename: string): boolean {
    return filename.endsWith('.md');
}

function isHidden(name: string): boolean {
    return name.startsWith('.');
}

async function getVaultPath(): Promise<string> {
    if (!VAULT_PATH) {
        throw new Error('OBSIDIAN_VAULT_PATH not set');
    }
    // Verify vault exists
    const stat = await fs.stat(VAULT_PATH);
    if (!stat.isDirectory()) {
        throw new Error(`OBSIDIAN_VAULT_PATH is not a directory: ${VAULT_PATH}`);
    }
    return VAULT_PATH;
}

function sanitizePath(notePath: string): string {
    // Prevent path traversal
    const normalized = path.normalize(notePath).replace(/^(\.\.(\/|\\|$))+/, '');
    return normalized;
}

async function walkDir(
    dir: string,
    baseDir: string,
): Promise<Array<{ path: string; name: string; stat: Stats }>> {
    const results: Array<{ path: string; name: string; stat: Stats }> = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        if (isHidden(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);

        if (entry.isDirectory()) {
            results.push(...(await walkDir(fullPath, baseDir)));
        } else if (entry.isFile() && isMarkdown(entry.name)) {
            const stat = await fs.stat(fullPath);
            results.push({ path: relativePath, name: entry.name, stat });
        }
    }

    return results;
}

interface NoteMetadata {
    path: string;
    name: string;
    folder: string;
    size: number;
    created: string;
    modified: string;
}

async function listNotes(folder?: string, limit = 100): Promise<VaultResult<NoteMetadata[]>> {
    try {
        const vault = await getVaultPath();
        const searchDir = folder ? path.join(vault, sanitizePath(folder)) : vault;

        const files = await walkDir(searchDir, vault);

        // Sort by modified date, newest first
        files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

        const notes: NoteMetadata[] = files.slice(0, limit).map((f) => ({
            path: f.path,
            name: path.basename(f.name, '.md'),
            folder: path.dirname(f.path) || '/',
            size: f.stat.size,
            created: f.stat.birthtime.toISOString(),
            modified: f.stat.mtime.toISOString(),
        }));

        return { success: true, data: notes };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function readNote(
    notePath: string,
): Promise<VaultResult<{ path: string; name: string; content: string; metadata: NoteMetadata }>> {
    try {
        const vault = await getVaultPath();
        let safePath = sanitizePath(notePath);

        // Add .md extension if not present
        if (!safePath.endsWith('.md')) {
            safePath += '.md';
        }

        const fullPath = path.join(vault, safePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        const stat = await fs.stat(fullPath);

        return {
            success: true,
            data: {
                path: safePath,
                name: path.basename(safePath, '.md'),
                content,
                metadata: {
                    path: safePath,
                    name: path.basename(safePath, '.md'),
                    folder: path.dirname(safePath) || '/',
                    size: stat.size,
                    created: stat.birthtime.toISOString(),
                    modified: stat.mtime.toISOString(),
                },
            },
        };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function searchNotes(
    query: string,
    limit = 20,
): Promise<VaultResult<Array<NoteMetadata & { preview: string }>>> {
    try {
        const vault = await getVaultPath();
        const files = await walkDir(vault, vault);
        const queryLower = query.toLowerCase();

        // Parallel search — read all files concurrently instead of sequentially.
        // Sequential reads on a large vault (1000+ notes) easily exceed 30s;
        // parallel I/O keeps total time bounded by the slowest single file.
        const results = await Promise.all(
            files.map(async (file) => {
                const nameLower = file.name.toLowerCase();
                const nameMatched = nameLower.includes(queryLower);
                const fullPath = path.join(vault, file.path);
                let preview = '';
                let matched = nameMatched;

                try {
                    const content = await fs.readFile(fullPath, 'utf-8');
                    if (!nameMatched) {
                        const contentLower = content.toLowerCase();
                        const idx = contentLower.indexOf(queryLower);
                        if (idx !== -1) {
                            matched = true;
                            const start = Math.max(0, idx - 50);
                            const end = Math.min(content.length, idx + query.length + 100);
                            preview =
                                (start > 0 ? '...' : '') +
                                content.slice(start, end).replace(/\n/g, ' ') +
                                (end < content.length ? '...' : '');
                        }
                    } else {
                        preview =
                            content.slice(0, 150).replace(/\n/g, ' ') +
                            (content.length > 150 ? '...' : '');
                    }
                } catch {
                    // Unreadable file — skip silently
                }

                if (!matched) return null;
                return {
                    path: file.path,
                    name: path.basename(file.name, '.md'),
                    folder: path.dirname(file.path) || '/',
                    size: file.stat.size,
                    created: file.stat.birthtime.toISOString(),
                    modified: file.stat.mtime.toISOString(),
                    preview,
                };
            }),
        );

        const matches = results
            .filter((r): r is NonNullable<typeof r> => r !== null)
            .slice(0, limit);

        return { success: true, data: matches };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function createNote(notePath: string, content: string): Promise<VaultResult<NoteMetadata>> {
    try {
        const vault = await getVaultPath();
        let safePath = sanitizePath(notePath);

        // Add .md extension if not present
        if (!safePath.endsWith('.md')) {
            safePath += '.md';
        }

        const fullPath = path.join(vault, safePath);

        // Ensure parent directory exists
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });

        // Check if file already exists
        try {
            await fs.access(fullPath);
            return { success: false, error: `Note already exists: ${safePath}` };
        } catch {
            // File doesn't exist, good to create
        }

        await fs.writeFile(fullPath, content, 'utf-8');
        const stat = await fs.stat(fullPath);

        return {
            success: true,
            data: {
                path: safePath,
                name: path.basename(safePath, '.md'),
                folder: path.dirname(safePath) || '/',
                size: stat.size,
                created: stat.birthtime.toISOString(),
                modified: stat.mtime.toISOString(),
            },
        };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function updateNote(notePath: string, content: string): Promise<VaultResult<NoteMetadata>> {
    try {
        const vault = await getVaultPath();
        let safePath = sanitizePath(notePath);

        if (!safePath.endsWith('.md')) {
            safePath += '.md';
        }

        const fullPath = path.join(vault, safePath);

        // Verify file exists
        await fs.access(fullPath);

        await fs.writeFile(fullPath, content, 'utf-8');
        const stat = await fs.stat(fullPath);

        return {
            success: true,
            data: {
                path: safePath,
                name: path.basename(safePath, '.md'),
                folder: path.dirname(safePath) || '/',
                size: stat.size,
                created: stat.birthtime.toISOString(),
                modified: stat.mtime.toISOString(),
            },
        };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function appendToNote(notePath: string, content: string): Promise<VaultResult<NoteMetadata>> {
    try {
        const vault = await getVaultPath();
        let safePath = sanitizePath(notePath);

        if (!safePath.endsWith('.md')) {
            safePath += '.md';
        }

        const fullPath = path.join(vault, safePath);

        // Read existing content
        let existing = '';
        try {
            existing = await fs.readFile(fullPath, 'utf-8');
        } catch {
            // File doesn't exist, will create
        }

        const newContent = existing ? existing + '\n' + content : content;
        await fs.writeFile(fullPath, newContent, 'utf-8');
        const stat = await fs.stat(fullPath);

        return {
            success: true,
            data: {
                path: safePath,
                name: path.basename(safePath, '.md'),
                folder: path.dirname(safePath) || '/',
                size: stat.size,
                created: stat.birthtime.toISOString(),
                modified: stat.mtime.toISOString(),
            },
        };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function listFolders(): Promise<
    VaultResult<Array<{ path: string; name: string; noteCount: number }>>
> {
    try {
        const vault = await getVaultPath();
        const folders: Array<{ path: string; name: string; noteCount: number }> = [];

        async function walkFolders(dir: string, baseDir: string) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            let noteCount = 0;

            for (const entry of entries) {
                if (isHidden(entry.name)) continue;

                if (entry.isDirectory()) {
                    const fullPath = path.join(dir, entry.name);
                    const relativePath = path.relative(baseDir, fullPath);
                    const subFolders = await walkFolders(fullPath, baseDir);
                    folders.push({
                        path: relativePath,
                        name: entry.name,
                        noteCount: subFolders,
                    });
                } else if (entry.isFile() && isMarkdown(entry.name)) {
                    noteCount++;
                }
            }

            return noteCount;
        }

        const rootCount = await walkFolders(vault, vault);
        folders.unshift({ path: '/', name: 'Root', noteCount: rootCount });

        return { success: true, data: folders };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function deleteNote(
    notePath: string,
): Promise<VaultResult<{ deleted: boolean; path: string }>> {
    try {
        const vault = await getVaultPath();
        let safePath = sanitizePath(notePath);

        if (!safePath.endsWith('.md')) {
            safePath += '.md';
        }

        const fullPath = path.join(vault, safePath);

        // Verify file exists
        await fs.access(fullPath);
        await fs.unlink(fullPath);

        return { success: true, data: { deleted: true, path: safePath } };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function createObsidianMcpServer() {
    const server = new McpServer({
        name: 'obsidian-server',
        version: '1.0.0',
    });

    server.registerTool(
        'obsidian_list',
        {
            title: 'List Notes',
            description: `List notes in the Obsidian vault (local markdown files).
Use this when user mentions Obsidian, their vault, or local markdown notes.
For Apple Notes app, use notes_list instead. For Google Docs, use drive_list.
Requires OBSIDIAN_VAULT_PATH env variable. Sorted by modification date.`,
            inputSchema: {
                folder: z
                    .string()
                    .optional()
                    .describe(
                        "Folder path relative to vault root (e.g., 'Projects' or 'Daily Notes'). Omit for all notes",
                    ),
                limit: z
                    .number()
                    .min(1)
                    .max(500)
                    .default(100)
                    .describe('Maximum notes to return (1-500, default: 100)'),
            },
        },
        async ({ folder, limit }) => {
            const result = await listNotes(folder, limit);
            return formatResult(result);
        },
    );

    server.registerTool(
        'obsidian_read',
        {
            title: 'Read Note',
            description: 'Read the full content of a note by its path.',
            inputSchema: {
                path: z
                    .string()
                    .describe(
                        "Note path relative to vault root (e.g., 'folder/note.md' or 'note')",
                    ),
            },
        },
        async ({ path: notePath }) => {
            const result = await readNote(notePath);
            return formatResult(result);
        },
    );

    server.registerTool(
        'obsidian_search',
        {
            title: 'Search Notes',
            description:
                'Search notes by filename or content. Returns matching notes with preview snippets.',
            inputSchema: {
                query: z.string().describe('Search query (searches filenames and content)'),
                limit: z.number().default(20).describe('Maximum results (default: 20)'),
            },
        },
        async ({ query, limit }) => {
            const result = await searchNotes(query, limit);
            return formatResult(result);
        },
    );

    server.registerTool(
        'obsidian_create',
        {
            title: 'Create Note',
            description: 'Create a new note in the vault. Creates parent folders if needed.',
            inputSchema: {
                path: z
                    .string()
                    .describe(
                        "Note path relative to vault root (e.g., 'folder/new-note.md' or 'new-note')",
                    ),
                content: z.string().describe('Note content (Markdown)'),
            },
        },
        async ({ path: notePath, content }) => {
            const result = await createNote(notePath, content);
            return formatResult(result);
        },
    );

    server.registerTool(
        'obsidian_update',
        {
            title: 'Update Note',
            description: 'Replace the entire content of an existing note.',
            inputSchema: {
                path: z.string().describe('Note path to update'),
                content: z.string().describe('New note content (replaces existing)'),
            },
        },
        async ({ path: notePath, content }) => {
            const result = await updateNote(notePath, content);
            return formatResult(result);
        },
    );

    server.registerTool(
        'obsidian_append',
        {
            title: 'Append to Note',
            description: "Append content to an existing note (or create if doesn't exist).",
            inputSchema: {
                path: z.string().describe('Note path to append to'),
                content: z.string().describe('Content to append'),
            },
        },
        async ({ path: notePath, content }) => {
            const result = await appendToNote(notePath, content);
            return formatResult(result);
        },
    );

    server.registerTool(
        'obsidian_delete',
        {
            title: 'Delete Note',
            description: 'Permanently delete a note from the vault.',
            inputSchema: {
                path: z.string().describe('Note path to delete'),
            },
        },
        async ({ path: notePath }) => {
            const result = await deleteNote(notePath);
            return formatResult(result);
        },
    );

    server.registerTool(
        'obsidian_folders',
        {
            title: 'List Folders',
            description: 'List all folders in the vault with note counts.',
            inputSchema: {},
        },
        async () => {
            const result = await listFolders();
            return formatResult(result);
        },
    );

    server.registerResource(
        'obsidian_recent',
        'obsidian://recent',
        {
            title: 'Recent Notes',
            description: '10 most recently modified notes',
            mimeType: 'application/json',
        },
        async () => {
            const result = await listNotes(undefined, 10);
            return {
                contents: [
                    {
                        uri: 'obsidian://recent',
                        mimeType: 'application/json',
                        text: JSON.stringify(
                            result.success ? result.data : { error: result.error },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    return server;
}

async function main() {
    if (!VAULT_PATH) {
        console.error('[MCP Obsidian Server] Error: OBSIDIAN_VAULT_PATH not set');
        process.exit(1);
    }

    const server = createObsidianMcpServer();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP] Obsidian started');
}

// Run if executed directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().catch((error) => {
        console.error('[MCP Obsidian Server] Fatal error:', error);
        process.exit(1);
    });
}
