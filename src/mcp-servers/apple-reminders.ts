// MCP Apple Reminders Server
// Manage Apple Reminders using JXA (JavaScript for Automation)
// macOS only - requires Reminders.app access permission

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

const JXA_LIST_LISTS = `
const app = Application('Reminders');
const lists = app.lists();
const result = lists.map(l => ({
    id: l.id(),
    name: l.name(),
    count: l.reminders.length
}));
JSON.stringify(result);
`;

const JXA_LIST_REMINDERS = (listId?: string, includeCompleted = false) => `
const app = Application('Reminders');
let reminders;
${
    listId
        ? `
const list = app.lists.byId('${escapeJxaString(listId)}');
reminders = list.reminders();
`
        : `
reminders = app.reminders();
`
}
${!includeCompleted ? `reminders = reminders.filter(r => !r.completed());` : ``}
const result = reminders.map(r => {
    const obj = {
        id: r.id(),
        name: r.name(),
        completed: r.completed(),
        priority: r.priority(),
        list: r.container().name()
    };
    try { if (r.body()) obj.body = r.body(); } catch(e) {}
    try { if (r.dueDate()) obj.dueDate = r.dueDate().toISOString(); } catch(e) {}
    try { if (r.remindMeDate()) obj.remindMeDate = r.remindMeDate().toISOString(); } catch(e) {}
    return obj;
});
JSON.stringify(result);
`;

const JXA_GET_REMINDER = (reminderId: string) => `
const app = Application('Reminders');
const r = app.reminders.byId('${escapeJxaString(reminderId)}');
const obj = {
    id: r.id(),
    name: r.name(),
    completed: r.completed(),
    priority: r.priority(),
    list: r.container().name(),
    creationDate: r.creationDate().toISOString(),
    modificationDate: r.modificationDate().toISOString()
};
try { if (r.body()) obj.body = r.body(); } catch(e) {}
try { if (r.dueDate()) obj.dueDate = r.dueDate().toISOString(); } catch(e) {}
try { if (r.remindMeDate()) obj.remindMeDate = r.remindMeDate().toISOString(); } catch(e) {}
JSON.stringify(obj);
`;

const JXA_CREATE_REMINDER = (
    name: string,
    listId?: string,
    body?: string,
    dueDate?: string,
    priority?: number,
) => `
const app = Application('Reminders');
${listId ? `const list = app.lists.byId('${escapeJxaString(listId)}');` : `const list = app.defaultList();`}
const props = {
    name: '${escapeJxaString(name)}'
};
${body ? `props.body = '${escapeJxaString(body)}';` : ``}
${dueDate ? `props.dueDate = new Date('${escapeJxaString(dueDate)}');` : ``}
${priority !== undefined ? `props.priority = ${Math.min(Math.max(0, priority), 9)};` : ``}
const reminder = app.Reminder(props);
list.reminders.push(reminder);
JSON.stringify({
    id: reminder.id(),
    name: reminder.name(),
    list: list.name()
});
`;

const JXA_COMPLETE_REMINDER = (reminderId: string, completed = true) => `
const app = Application('Reminders');
const r = app.reminders.byId('${escapeJxaString(reminderId)}');
r.completed = ${Boolean(completed)};
JSON.stringify({
    id: r.id(),
    name: r.name(),
    completed: r.completed()
});
`;

const JXA_DELETE_REMINDER = (reminderId: string) => `
const app = Application('Reminders');
const r = app.reminders.byId('${escapeJxaString(reminderId)}');
const name = r.name();
app.delete(r);
JSON.stringify({ deleted: true, name: name });
`;

const JXA_UPDATE_REMINDER = (
    reminderId: string,
    name?: string,
    body?: string,
    dueDate?: string,
    priority?: number,
) => `
const app = Application('Reminders');
const r = app.reminders.byId('${escapeJxaString(reminderId)}');
${name ? `r.name = '${escapeJxaString(name)}';` : ``}
${body ? `r.body = '${escapeJxaString(body)}';` : ``}
${dueDate ? `r.dueDate = new Date('${escapeJxaString(dueDate)}');` : ``}
${priority !== undefined ? `r.priority = ${Math.min(Math.max(0, priority), 9)};` : ``}
const obj = {
    id: r.id(),
    name: r.name(),
    completed: r.completed(),
    priority: r.priority()
};
try { if (r.body()) obj.body = r.body(); } catch(e) {}
try { if (r.dueDate()) obj.dueDate = r.dueDate().toISOString(); } catch(e) {}
JSON.stringify(obj);
`;

export function createAppleRemindersMcpServer() {
    // Platform check - JXA only works on macOS
    if (process.platform !== 'darwin') {
        console.error('[Apple Reminders MCP] This tool requires macOS (uses JXA automation)');
    }

    const server = new McpServer({
        name: 'apple-reminders-server',
        version: '1.0.0',
    });

    server.registerTool(
        'reminders_list_lists',
        {
            title: 'List Reminder Lists',
            description: `List all Apple Reminders lists (macOS only).
Use this for Apple ecosystem reminders that sync to iPhone/Mac.
For Google Tasks, use tasks_list_lists instead.
Returns list IDs needed for reminders_create and reminders_list.`,
            inputSchema: {},
        },
        async () => {
            const result = await runJxa(JXA_LIST_LISTS);
            return formatResult(result);
        },
    );

    server.registerTool(
        'reminders_list',
        {
            title: 'List Reminders',
            description: `List Apple Reminders (macOS only, syncs to iPhone/iPad).
Use when user asks about their Apple reminders or iOS tasks.
For Google Tasks, use tasks_list instead.`,
            inputSchema: {
                listId: z
                    .string()
                    .optional()
                    .describe(
                        "List ID from reminders_list_lists (e.g., 'x-apple-reminder://...'). Omit for all lists",
                    ),
                includeCompleted: z
                    .boolean()
                    .default(false)
                    .describe('Include completed reminders in results'),
            },
        },
        async ({ listId, includeCompleted }) => {
            const result = await runJxa(JXA_LIST_REMINDERS(listId, includeCompleted));
            return formatResult(result);
        },
    );

    server.registerTool(
        'reminders_get',
        {
            title: 'Get Reminder',
            description: 'Get full details of a reminder by its ID.',
            inputSchema: {
                reminderId: z.string().describe('Reminder ID to retrieve'),
            },
        },
        async ({ reminderId }) => {
            const result = await runJxa(JXA_GET_REMINDER(reminderId));
            return formatResult(result);
        },
    );

    server.registerTool(
        'reminders_create',
        {
            title: 'Create Apple Reminder',
            description:
                'Create a reminder in Apple Reminders app (macOS/iOS). Syncs to iCloud and shows notifications on all Apple devices. Use this for personal task management. For bot-initiated scheduled messages, use schedule_bot_message instead.',
            inputSchema: {
                name: z.string().describe('Reminder title/name'),
                listId: z
                    .string()
                    .optional()
                    .describe('List ID to add reminder to (omit for default list)'),
                body: z.string().optional().describe('Notes/body text for the reminder'),
                dueDate: z
                    .string()
                    .optional()
                    .describe('Due date in ISO 8601 format (e.g., 2024-12-25T10:00:00)'),
                priority: z
                    .number()
                    .min(0)
                    .max(9)
                    .optional()
                    .describe('Priority: 0 = none, 1-4 = high, 5 = medium, 6-9 = low'),
            },
        },
        async ({ name, listId, body, dueDate, priority }) => {
            const result = await runJxa(JXA_CREATE_REMINDER(name, listId, body, dueDate, priority));
            return formatResult(result);
        },
    );

    server.registerTool(
        'reminders_complete',
        {
            title: 'Complete Reminder',
            description: 'Mark a reminder as completed or uncomplete it.',
            inputSchema: {
                reminderId: z.string().describe('Reminder ID to complete'),
                completed: z
                    .boolean()
                    .default(true)
                    .describe('true to complete, false to uncomplete (default: true)'),
            },
        },
        async ({ reminderId, completed }) => {
            const result = await runJxa(JXA_COMPLETE_REMINDER(reminderId, completed));
            return formatResult(result);
        },
    );

    server.registerTool(
        'reminders_update',
        {
            title: 'Update Reminder',
            description: "Update a reminder's name, notes, due date, or priority.",
            inputSchema: {
                reminderId: z.string().describe('Reminder ID to update'),
                name: z.string().optional().describe('New reminder title/name'),
                body: z.string().optional().describe('New notes/body text'),
                dueDate: z.string().optional().describe('New due date in ISO 8601 format'),
                priority: z.number().min(0).max(9).optional().describe('New priority (0-9)'),
            },
        },
        async ({ reminderId, name, body, dueDate, priority }) => {
            const result = await runJxa(
                JXA_UPDATE_REMINDER(reminderId, name, body, dueDate, priority),
            );
            return formatResult(result);
        },
    );

    server.registerTool(
        'reminders_delete',
        {
            title: 'Delete Reminder',
            description: 'Permanently delete a reminder.',
            inputSchema: {
                reminderId: z.string().describe('Reminder ID to delete'),
            },
        },
        async ({ reminderId }) => {
            const result = await runJxa(JXA_DELETE_REMINDER(reminderId));
            return formatResult(result);
        },
    );

    server.registerResource(
        'reminders_pending',
        'reminders://pending',
        {
            title: 'Pending Reminders',
            description: 'All incomplete reminders across all lists',
            mimeType: 'application/json',
        },
        async () => {
            const result = await runJxa(JXA_LIST_REMINDERS(undefined, false));
            return {
                contents: [
                    {
                        uri: 'reminders://pending',
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
    const server = createAppleRemindersMcpServer();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP] Apple Reminders started');
}

// Run if executed directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().catch((error) => {
        console.error('[MCP Apple Reminders Server] Fatal error:', error);
        process.exit(1);
    });
}
