// MCP Gmail Server
// Email tools: list, search, send, draft, read, delete

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google, type gmail_v1 } from 'googleapis';
import { z } from 'zod';

import { createAuth, installAuthErrorHandler } from './shared/google-auth';

// Gateway injects Google OAuth tokens via env; this client refreshes in-process.
const auth = createAuth();
installAuthErrorHandler();

function extractBody(payload?: gmail_v1.Schema$MessagePart): string {
    if (!payload) return '';

    if (payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
                if (part.body?.data) {
                    return Buffer.from(part.body.data, 'base64').toString('utf-8');
                }
            }
            const nested = extractBody(part);
            if (nested) return nested;
        }
    }

    return '';
}

function parseEmail(message: gmail_v1.Schema$Message) {
    const headers = message.payload?.headers ?? [];
    const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

    return {
        id: message.id ?? '',
        threadId: message.threadId ?? '',
        subject: getHeader('subject'),
        from: getHeader('from'),
        to: getHeader('to'),
        date: getHeader('date'),
        body: extractBody(message.payload),
        snippet: message.snippet ?? '',
    };
}

export async function createGmailMcpServer() {
    const gmail = (google.gmail as any)({ version: 'v1', auth });

    const server = new McpServer({
        name: 'gmail-server',
        version: '1.0.0',
    });

    server.registerTool(
        'gmail_list',
        {
            title: 'List Emails',
            description: 'List emails from inbox with optional filtering',
            inputSchema: {
                maxResults: z.number().default(20).describe('Maximum emails to return'),
                query: z.string().optional().describe('Gmail search query'),
                unreadOnly: z.boolean().default(false).describe('Only show unread'),
            },
        },
        async ({ maxResults, query, unreadOnly }) => {
            const labelIds = unreadOnly ? ['INBOX', 'UNREAD'] : ['INBOX'];

            const listParams: gmail_v1.Params$Resource$Users$Messages$List = {
                userId: 'me',
                maxResults,
                labelIds,
            };
            if (query) listParams.q = query;

            const res = await gmail.users.messages.list(listParams);
            const messages = res.data.messages ?? [];

            const emails = [];
            for (const msg of messages.slice(0, maxResults)) {
                if (!msg.id) continue;
                const full = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                });
                emails.push(parseEmail(full.data));
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, count: emails.length, emails },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'gmail_search',
        {
            title: 'Search Emails',
            description: 'Search emails using Gmail query syntax',
            inputSchema: {
                query: z.string().describe("Search query (e.g., 'from:boss subject:urgent')"),
                maxResults: z.number().default(20).describe('Maximum results'),
            },
        },
        async ({ query, maxResults }) => {
            const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
            const messages = res.data.messages ?? [];

            const emails = [];
            for (const msg of messages) {
                if (!msg.id) continue;
                const full = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                });
                emails.push(parseEmail(full.data));
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, count: emails.length, query, emails },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'gmail_get',
        {
            title: 'Get Email',
            description: 'Get full content of a specific email',
            inputSchema: {
                messageId: z.string().describe('Gmail message ID'),
            },
        },
        async ({ messageId }) => {
            const res = await gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full',
            });
            const email = parseEmail(res.data);

            return {
                content: [
                    { type: 'text', text: JSON.stringify({ success: true, email }, null, 2) },
                ],
            };
        },
    );

    server.registerTool(
        'gmail_send',
        {
            title: 'Send Email',
            description: 'Send an email',
            inputSchema: {
                to: z.string().describe('Recipient email'),
                subject: z.string().describe('Email subject'),
                body: z.string().describe('Email body (plain text)'),
                cc: z.string().optional().describe('CC recipients'),
                bcc: z.string().optional().describe('BCC recipients'),
            },
        },
        async ({ to, subject, body, cc, bcc }) => {
            const lines = [
                `To: ${to}`,
                `Subject: ${subject}`,
                `Content-Type: text/plain; charset="UTF-8"`,
            ];
            if (cc) lines.push(`Cc: ${cc}`);
            if (bcc) lines.push(`Bcc: ${bcc}`);
            lines.push('', body);

            const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
            const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, messageId: res.data.id }, null, 2),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'gmail_draft',
        {
            title: 'Create Draft',
            description: 'Create an email draft',
            inputSchema: {
                to: z.string().describe('Recipient email'),
                subject: z.string().describe('Email subject'),
                body: z.string().describe('Email body'),
            },
        },
        async ({ to, subject, body }) => {
            const lines = [
                `To: ${to}`,
                `Subject: ${subject}`,
                `Content-Type: text/plain; charset="UTF-8"`,
                '',
                body,
            ];
            const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

            const res = await gmail.users.drafts.create({
                userId: 'me',
                requestBody: { message: { raw } },
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, draftId: res.data.id }, null, 2),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'gmail_mark_read',
        {
            title: 'Mark as Read',
            description: 'Mark an email as read',
            inputSchema: {
                messageId: z.string().describe('Gmail message ID'),
            },
        },
        async ({ messageId }) => {
            await gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: { removeLabelIds: ['UNREAD'] },
            });

            return {
                content: [{ type: 'text', text: JSON.stringify({ success: true, messageId }) }],
            };
        },
    );

    server.registerTool(
        'gmail_delete',
        {
            title: 'Delete Email',
            description: 'Move email to trash',
            inputSchema: {
                messageId: z.string().describe('Gmail message ID'),
            },
        },
        async ({ messageId }) => {
            await gmail.users.messages.trash({ userId: 'me', id: messageId });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, messageId, deleted: true }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'gmail_labels',
        {
            title: 'Get Labels',
            description: 'Get all Gmail labels',
            inputSchema: {},
        },
        async () => {
            const res = await gmail.users.labels.list({ userId: 'me' });
            const labels = (res.data.labels ?? []).map((l: any) => ({
                id: l.id,
                name: l.name,
                type: l.type,
            }));

            return {
                content: [
                    { type: 'text', text: JSON.stringify({ success: true, labels }, null, 2) },
                ],
            };
        },
    );

    server.registerResource(
        'gmail_profile',
        'gmail://profile',
        {
            title: 'Gmail Profile',
            description: "User's Gmail profile",
            mimeType: 'application/json',
        },
        async () => {
            const res = await gmail.users.getProfile({ userId: 'me' });
            return {
                contents: [
                    {
                        uri: 'gmail://profile',
                        mimeType: 'application/json',
                        text: JSON.stringify(
                            {
                                email: res.data.emailAddress,
                                messagesTotal: res.data.messagesTotal,
                                threadsTotal: res.data.threadsTotal,
                            },
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
    try {
        const server = await createGmailMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('[MCP] Gmail started');
    } catch (error) {
        console.error('[MCP] Gmail failed:', error);
        process.exit(1);
    }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main();
}
