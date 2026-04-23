// MCP Drive Server
// Google Drive tools: list, search, share, create folders

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google, type drive_v3 } from 'googleapis';
import { z } from 'zod';

import { createAuth, installAuthErrorHandler } from './shared/google-auth';

// Gateway injects Google OAuth tokens via env; this client refreshes in-process.
const auth = createAuth();
installAuthErrorHandler();

function parseFile(file: drive_v3.Schema$File) {
    return {
        id: file.id ?? '',
        name: file.name ?? '',
        mimeType: file.mimeType ?? '',
        size: file.size ?? null,
        createdTime: file.createdTime ?? null,
        modifiedTime: file.modifiedTime ?? null,
        webViewLink: file.webViewLink ?? null,
        shared: file.shared ?? false,
    };
}

function formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(2)} ${units[i]}`;
}

export async function createDriveMcpServer() {
    const drive = (google.drive as any)({ version: 'v3', auth });

    const server = new McpServer({
        name: 'drive-server',
        version: '1.0.0',
    });

    server.registerTool(
        'drive_list',
        {
            title: 'List Files',
            description: 'List files in Google Drive',
            inputSchema: {
                maxResults: z.number().default(50).describe('Maximum files to return'),
                orderBy: z.string().default('modifiedTime desc').describe('Sort order'),
            },
        },
        async ({ maxResults, orderBy }) => {
            const res = await drive.files.list({
                pageSize: maxResults,
                orderBy,
                fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, shared)',
            });

            const files = (res.data.files ?? []).map(parseFile);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, count: files.length, files },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'drive_search',
        {
            title: 'Search Files',
            description: 'Search for files in Google Drive',
            inputSchema: {
                query: z.string().describe('Search query'),
                maxResults: z.number().default(50).describe('Maximum results'),
            },
        },
        async ({ query, maxResults }) => {
            const fullQuery = `fullText contains '${query}' or name contains '${query}'`;

            const res = await drive.files.list({
                pageSize: maxResults,
                q: fullQuery,
                fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, shared)',
            });

            const files = (res.data.files ?? []).map(parseFile);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, query, count: files.length, files },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'drive_get',
        {
            title: 'Get File',
            description: 'Get file metadata',
            inputSchema: {
                fileId: z.string().describe('File ID'),
            },
        },
        async ({ fileId }) => {
            const res = await drive.files.get({
                fileId,
                fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink, shared, parents',
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, file: parseFile(res.data) }, null, 2),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'drive_create_folder',
        {
            title: 'Create Folder',
            description: 'Create a folder in Google Drive',
            inputSchema: {
                name: z.string().describe('Folder name'),
                parentId: z.string().optional().describe('Parent folder ID'),
            },
        },
        async ({ name, parentId }) => {
            const metadata: drive_v3.Schema$File = {
                name,
                mimeType: 'application/vnd.google-apps.folder',
            };

            if (parentId) metadata.parents = [parentId];

            const res = await drive.files.create({
                requestBody: metadata,
                fields: 'id, name, mimeType, createdTime, webViewLink',
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, folder: parseFile(res.data) },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'drive_delete',
        {
            title: 'Delete File',
            description: 'Move file to trash or permanently delete',
            inputSchema: {
                fileId: z.string().describe('File ID'),
                permanently: z.boolean().default(false).describe('Permanently delete'),
            },
        },
        async ({ fileId, permanently }) => {
            if (permanently) {
                await drive.files.delete({ fileId });
            } else {
                await drive.files.update({ fileId, requestBody: { trashed: true } });
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, fileId, deleted: true, permanently }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'drive_share',
        {
            title: 'Share File',
            description: 'Share a file with someone or make it public',
            inputSchema: {
                fileId: z.string().describe('File ID'),
                email: z.string().optional().describe('Email to share with (omit for public)'),
                role: z
                    .enum(['reader', 'writer', 'commenter'])
                    .default('reader')
                    .describe('Permission level'),
                notify: z.boolean().default(true).describe('Send notification'),
            },
        },
        async ({ fileId, email, role, notify }) => {
            const type = email ? 'user' : 'anyone';

            const permission: drive_v3.Schema$Permission = { type, role };
            if (email) permission.emailAddress = email;

            const res = await drive.permissions.create({
                fileId,
                requestBody: permission,
                sendNotificationEmail: notify,
                fields: 'id',
            });

            const file = await drive.files.get({ fileId, fields: 'webViewLink' });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                permissionId: res.data.id,
                                link: file.data.webViewLink,
                                shared: email ? `Shared with ${email}` : 'Made public',
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'drive_permissions',
        {
            title: 'Get Permissions',
            description: 'Get sharing permissions for a file',
            inputSchema: {
                fileId: z.string().describe('File ID'),
            },
        },
        async ({ fileId }) => {
            const res = await drive.permissions.list({
                fileId,
                fields: 'permissions(id, type, role, emailAddress)',
            });

            const permissions = (res.data.permissions ?? []).map((p: any) => ({
                id: p.id,
                type: p.type,
                role: p.role,
                email: p.emailAddress ?? null,
            }));

            return {
                content: [
                    { type: 'text', text: JSON.stringify({ success: true, permissions }, null, 2) },
                ],
            };
        },
    );

    server.registerTool(
        'drive_copy',
        {
            title: 'Copy File',
            description: 'Make a copy of a file',
            inputSchema: {
                fileId: z.string().describe('File ID to copy'),
                newName: z.string().optional().describe('Name for copy'),
                parentId: z.string().optional().describe('Destination folder'),
            },
        },
        async ({ fileId, newName, parentId }) => {
            const body: drive_v3.Schema$File = {};
            if (newName) body.name = newName;
            if (parentId) body.parents = [parentId];

            const res = await drive.files.copy({
                fileId,
                requestBody: body,
                fields: 'id, name, mimeType, webViewLink',
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, file: parseFile(res.data) }, null, 2),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'drive_move',
        {
            title: 'Move File',
            description: 'Move a file to a different folder',
            inputSchema: {
                fileId: z.string().describe('File ID'),
                folderId: z.string().describe('Destination folder ID'),
            },
        },
        async ({ fileId, folderId }) => {
            const file = await drive.files.get({ fileId, fields: 'parents' });
            const previousParents = (file.data.parents ?? []).join(',');

            await drive.files.update({
                fileId,
                addParents: folderId,
                removeParents: previousParents,
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, fileId, movedTo: folderId }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'drive_rename',
        {
            title: 'Rename File',
            description: 'Rename a file or folder',
            inputSchema: {
                fileId: z.string().describe('File ID'),
                newName: z.string().describe('New name'),
            },
        },
        async ({ fileId, newName }) => {
            const res = await drive.files.update({
                fileId,
                requestBody: { name: newName },
                fields: 'id, name',
            });

            return {
                content: [
                    { type: 'text', text: JSON.stringify({ success: true, file: res.data }) },
                ],
            };
        },
    );

    server.registerTool(
        'drive_storage',
        {
            title: 'Get Storage Info',
            description: 'Get Google Drive storage usage',
            inputSchema: {},
        },
        async () => {
            const res = await drive.about.get({ fields: 'storageQuota' });
            const quota = res.data.storageQuota;

            const usage = parseInt(quota?.usage ?? '0');
            const limit = quota?.limit ? parseInt(quota.limit) : null;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                usageBytes: usage,
                                limitBytes: limit,
                                usageFormatted: formatSize(usage),
                                limitFormatted: limit ? formatSize(limit) : 'Unlimited',
                                usagePercent: limit
                                    ? ((usage / limit) * 100).toFixed(2) + '%'
                                    : null,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerResource(
        'drive_storage',
        'drive://storage',
        {
            title: 'Drive Storage',
            description: 'Google Drive storage usage',
            mimeType: 'application/json',
        },
        async () => {
            const res = await drive.about.get({ fields: 'storageQuota' });
            const quota = res.data.storageQuota;
            const usage = parseInt(quota?.usage ?? '0');
            const limit = quota?.limit ? parseInt(quota.limit) : null;

            return {
                contents: [
                    {
                        uri: 'drive://storage',
                        mimeType: 'application/json',
                        text: JSON.stringify(
                            {
                                usageBytes: usage,
                                usageFormatted: formatSize(usage),
                                limitFormatted: limit ? formatSize(limit) : 'Unlimited',
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
        const server = await createDriveMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('[MCP] Drive started');
    } catch (error) {
        console.error('[MCP] Drive failed:', error);
        process.exit(1);
    }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main();
}
