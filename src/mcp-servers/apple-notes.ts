// MCP Apple Notes Server
// Read and write Apple Notes using JXA (JavaScript for Automation)
// macOS only - requires Notes.app access permission

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface JxaResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

async function runJxa<T = unknown>(script: string): Promise<JxaResult<T>> {
    try {
        const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024, // 10MB for large notes
        });

        try {
            const data = JSON.parse(stdout) as T;
            return { success: true, data };
        } catch {
            return { success: true, data: stdout.trim() as T };
        }
    } catch (err) {
        const error = err as Error & { stderr?: string };
        return {
            success: false,
            error: error.stderr || error.message,
        };
    }
}

function formatResult<T>(result: JxaResult<T>): { content: Array<{ type: 'text'; text: string }> } {
    if (!result.success) {
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }],
        };
    }
    return {
        content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
    };
}

/**
 * Safely escape a string for embedding in JXA code.
 * Uses JSON.stringify which handles all special characters including:
 * - Quotes (single and double)
 * - Backslashes
 * - Newlines, tabs, and other control characters
 * - Unicode characters
 */
function escapeJxaString(str: string): string {
    // JSON.stringify returns a quoted string with all chars properly escaped
    // We slice off the surrounding quotes since JXA scripts add their own
    return JSON.stringify(str).slice(1, -1);
}

const JXA_LIST_FOLDERS = `
const app = Application('Notes');
const folders = app.folders();
const result = folders.map(f => ({
    id: f.id(),
    name: f.name(),
    noteCount: f.notes.length
}));
JSON.stringify(result);
`;

const JXA_LIST_NOTES = (folderId?: string, limit = 50) => `
const app = Application('Notes');
let notes;
${
    folderId
        ? `
const folder = app.folders.byId('${escapeJxaString(folderId)}');
notes = folder.notes();
`
        : `
notes = app.notes();
`
}
const result = notes.slice(0, ${Math.min(Math.max(1, limit), 1000)}).map(n => ({
    id: n.id(),
    name: n.name(),
    creationDate: n.creationDate().toISOString(),
    modificationDate: n.modificationDate().toISOString(),
    folder: n.container().name()
}));
JSON.stringify(result);
`;

const JXA_GET_NOTE = (noteId: string) => `
const app = Application('Notes');
const note = app.notes.byId('${escapeJxaString(noteId)}');
const result = {
    id: note.id(),
    name: note.name(),
    body: note.body(),
    plaintext: note.plaintext(),
    creationDate: note.creationDate().toISOString(),
    modificationDate: note.modificationDate().toISOString(),
    folder: note.container().name()
};
JSON.stringify(result);
`;

const JXA_SEARCH_NOTES = (query: string, limit = 20) => `
const app = Application('Notes');
const notes = app.notes();
const q = '${escapeJxaString(query)}';
const qLower = q.toLowerCase();
const matches = notes.filter(n => {
    const name = n.name().toLowerCase();
    const body = n.plaintext().toLowerCase();
    return name.includes(qLower) || body.includes(qLower);
}).slice(0, ${Math.min(Math.max(1, limit), 100)});
const result = matches.map(n => ({
    id: n.id(),
    name: n.name(),
    preview: n.plaintext().substring(0, 200),
    folder: n.container().name(),
    modificationDate: n.modificationDate().toISOString()
}));
JSON.stringify(result);
`;

const JXA_CREATE_NOTE = (title: string, body: string, folderId?: string) => `
const app = Application('Notes');
${folderId ? `const folder = app.folders.byId('${escapeJxaString(folderId)}');` : `const folder = app.defaultAccount().defaultFolder();`}
const note = app.Note({
    name: '${escapeJxaString(title)}',
    body: '${escapeJxaString(body)}'
});
folder.notes.push(note);
const result = {
    id: note.id(),
    name: note.name(),
    folder: folder.name()
};
JSON.stringify(result);
`;

const JXA_UPDATE_NOTE = (noteId: string, body: string) => `
const app = Application('Notes');
const note = app.notes.byId('${escapeJxaString(noteId)}');
note.body = '${escapeJxaString(body)}';
const result = {
    id: note.id(),
    name: note.name(),
    modificationDate: note.modificationDate().toISOString()
};
JSON.stringify(result);
`;

const JXA_DELETE_NOTE = (noteId: string) => `
const app = Application('Notes');
const note = app.notes.byId('${escapeJxaString(noteId)}');
const name = note.name();
app.delete(note);
JSON.stringify({ deleted: true, name: name });
`;

export function createAppleNotesMcpServer() {
    const server = new McpServer({
        name: 'apple-notes-server',
        version: '1.0.0',
    });

    server.registerTool(
        'notes_list_folders',
        {
            title: 'List Note Folders',
            description: 'List all folders in Apple Notes with their note counts.',
            inputSchema: {},
        },
        async () => {
            const result = await runJxa(JXA_LIST_FOLDERS);
            return formatResult(result);
        },
    );

    server.registerTool(
        'notes_list',
        {
            title: 'List Notes',
            description:
                'List notes, optionally from a specific folder. Returns note metadata (not full content).',
            inputSchema: {
                folderId: z
                    .string()
                    .optional()
                    .describe('Folder ID to list notes from (omit for all notes)'),
                limit: z.number().default(50).describe('Maximum notes to return (default: 50)'),
            },
        },
        async ({ folderId, limit }) => {
            const result = await runJxa(JXA_LIST_NOTES(folderId, limit));
            return formatResult(result);
        },
    );

    server.registerTool(
        'notes_get',
        {
            title: 'Get Note',
            description: 'Get full content of a note by its ID. Includes HTML body and plaintext.',
            inputSchema: {
                noteId: z.string().describe('Note ID to retrieve'),
            },
        },
        async ({ noteId }) => {
            const result = await runJxa(JXA_GET_NOTE(noteId));
            return formatResult(result);
        },
    );

    server.registerTool(
        'notes_search',
        {
            title: 'Search Notes',
            description: 'Search notes by title or content. Returns matching notes with preview.',
            inputSchema: {
                query: z.string().describe('Search query (searches title and content)'),
                limit: z.number().default(20).describe('Maximum results to return (default: 20)'),
            },
        },
        async ({ query, limit }) => {
            const result = await runJxa(JXA_SEARCH_NOTES(query, limit));
            return formatResult(result);
        },
    );

    server.registerTool(
        'notes_create',
        {
            title: 'Create Note',
            description: 'Create a new note in Apple Notes. Body supports HTML formatting.',
            inputSchema: {
                title: z.string().describe('Note title'),
                body: z.string().describe('Note content (supports HTML)'),
                folderId: z
                    .string()
                    .optional()
                    .describe('Folder ID to create note in (omit for default folder)'),
            },
        },
        async ({ title, body, folderId }) => {
            const result = await runJxa(JXA_CREATE_NOTE(title, body, folderId));
            return formatResult(result);
        },
    );

    server.registerTool(
        'notes_update',
        {
            title: 'Update Note',
            description: 'Update the content of an existing note.',
            inputSchema: {
                noteId: z.string().describe('Note ID to update'),
                body: z.string().describe('New note content (supports HTML)'),
            },
        },
        async ({ noteId, body }) => {
            const result = await runJxa(JXA_UPDATE_NOTE(noteId, body));
            return formatResult(result);
        },
    );

    server.registerTool(
        'notes_delete',
        {
            title: 'Delete Note',
            description: 'Delete a note by its ID. Moves to Recently Deleted.',
            inputSchema: {
                noteId: z.string().describe('Note ID to delete'),
            },
        },
        async ({ noteId }) => {
            const result = await runJxa(JXA_DELETE_NOTE(noteId));
            return formatResult(result);
        },
    );

    server.registerResource(
        'notes_recent',
        'notes://recent',
        {
            title: 'Recent Notes',
            description: '10 most recently modified notes',
            mimeType: 'application/json',
        },
        async () => {
            const result = await runJxa(JXA_LIST_NOTES(undefined, 10));
            return {
                contents: [
                    {
                        uri: 'notes://recent',
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
    const server = createAppleNotesMcpServer();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP] Apple Notes started');
}

// Run if executed directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().catch((error) => {
        console.error('[MCP Apple Notes Server] Fatal error:', error);
        process.exit(1);
    });
}
