import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google, type people_v1 } from 'googleapis';
import { z } from 'zod';

import { createAuth, installAuthErrorHandler } from './shared/google-auth';

const auth = createAuth();
installAuthErrorHandler();

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,photos';

interface NormalizedContact {
    readonly resourceName: string;
    readonly displayName: string;
    readonly emails: readonly string[];
    readonly phones: readonly string[];
    readonly organization: string | null;
    readonly photoUrl: string | null;
}

function normalize(p: people_v1.Schema$Person): NormalizedContact {
    const primaryName = p.names?.[0]?.displayName ?? '(unnamed)';
    const emails = (p.emailAddresses ?? []).map((e) => e.value ?? '').filter(Boolean);
    const phones = (p.phoneNumbers ?? []).map((n) => n.value ?? '').filter(Boolean);
    const org = p.organizations?.[0];
    const orgText = org ? [org.title, org.name].filter(Boolean).join(' @ ') || null : null;
    const photoUrl = p.photos?.find((ph) => !ph.default)?.url ?? null;
    return {
        resourceName: p.resourceName ?? '',
        displayName: primaryName,
        emails,
        phones,
        organization: orgText,
        photoUrl,
    };
}

function matchesQuery(c: NormalizedContact, q: string): boolean {
    const needle = q.toLowerCase();
    if (c.displayName.toLowerCase().includes(needle)) return true;
    if (c.emails.some((e) => e.toLowerCase().includes(needle))) return true;
    if (c.phones.some((p) => p.includes(needle))) return true;
    if (c.organization && c.organization.toLowerCase().includes(needle)) return true;
    return false;
}

export async function createContactsMcpServer() {
    const people = (google.people as any)({ version: 'v1', auth });

    const server = new McpServer({
        name: 'contacts-server',
        version: '1.0.0',
    });

    server.registerTool(
        'contacts_search',
        {
            title: 'Search Contacts',
            description:
                'Search contacts by name, email, phone, or organization (case-insensitive substring match). ' +
                'Returns at most `maxResults` matches. Use this first to resolve "email josephine" → real address.',
            inputSchema: {
                query: z.string().min(1).describe('Substring to match against name/email/phone/org'),
                maxResults: z.number().int().min(1).max(50).default(10),
                includeOtherContacts: z
                    .boolean()
                    .default(true)
                    .describe(
                        'Also search "Other Contacts" (people you\'ve emailed but not saved). ' +
                            'Requires contacts.other.readonly scope.',
                    ),
            },
        },
        async ({ query, maxResults, includeOtherContacts }) => {
            const promises: Promise<people_v1.Schema$Person[]>[] = [];

            promises.push(
                people.people.searchContacts({
                    query,
                    pageSize: maxResults,
                    readMask: PERSON_FIELDS,
                }).then((r: { data: people_v1.Schema$SearchResponse }) =>
                    (r.data.results ?? []).map((x) => x.person ?? {}),
                ),
            );

            if (includeOtherContacts) {
                promises.push(
                    people.otherContacts
                        .search({
                            query,
                            pageSize: maxResults,
                            readMask: 'names,emailAddresses,phoneNumbers',
                        })
                        .then((r: { data: people_v1.Schema$SearchResponse }) =>
                            (r.data.results ?? []).map((x) => x.person ?? {}),
                        )
                        .catch(() => [] as people_v1.Schema$Person[]),
                );
            }

            const [primary, other] = await Promise.all(promises);
            const merged = [...primary, ...(other ?? [])].map(normalize);

            const seen = new Set<string>();
            const dedup = merged.filter((c) => {
                if (seen.has(c.resourceName)) return false;
                seen.add(c.resourceName);
                return true;
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { query, count: dedup.length, contacts: dedup.slice(0, maxResults) },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'contacts_list',
        {
            title: 'List Contacts',
            description:
                'List all contacts paginated. Returns name + emails + phones + organization. ' +
                'Use when you need to scan the address book, not for targeted lookups (use contacts_search instead).',
            inputSchema: {
                pageSize: z.number().int().min(1).max(100).default(50),
                pageToken: z.string().optional().describe('From previous response.nextPageToken'),
                query: z
                    .string()
                    .optional()
                    .describe('Optional client-side substring filter applied after fetch'),
            },
        },
        async ({ pageSize, pageToken, query }) => {
            const res = await people.people.connections.list({
                resourceName: 'people/me',
                pageSize,
                pageToken,
                personFields: PERSON_FIELDS,
                sortOrder: 'LAST_MODIFIED_DESCENDING',
            });

            const raw: people_v1.Schema$Person[] = res.data.connections ?? [];
            const connections: NormalizedContact[] = raw.map(normalize);
            const filtered: NormalizedContact[] = query
                ? connections.filter((c: NormalizedContact) => matchesQuery(c, query))
                : connections;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                count: filtered.length,
                                nextPageToken: res.data.nextPageToken ?? null,
                                contacts: filtered,
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
        'contacts_get',
        {
            title: 'Get Contact',
            description:
                'Get full details for a single contact by resourceName (e.g. "people/c12345..."). ' +
                'Use after contacts_search when you need fields beyond the search summary.',
            inputSchema: {
                resourceName: z
                    .string()
                    .regex(/^people\/[A-Za-z0-9_-]+$/)
                    .describe('Identifier from contacts_search result, e.g. people/c12345...'),
                fields: z
                    .string()
                    .default(
                        'names,emailAddresses,phoneNumbers,addresses,organizations,birthdays,biographies,urls,events,photos',
                    )
                    .describe('Comma-separated person fields to fetch'),
            },
        },
        async ({ resourceName, fields }) => {
            const res = await people.people.get({
                resourceName,
                personFields: fields,
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(res.data, null, 2),
                    },
                ],
            };
        },
    );

    server.registerResource(
        'me',
        'contacts://me',
        {
            title: 'My Contacts Summary',
            description: 'Account owner profile from People API',
            mimeType: 'application/json',
        },
        async () => {
            const res = await people.people.get({
                resourceName: 'people/me',
                personFields: 'names,emailAddresses,photos',
            });
            return {
                contents: [
                    {
                        uri: 'contacts://me',
                        mimeType: 'application/json',
                        text: JSON.stringify(res.data, null, 2),
                    },
                ],
            };
        },
    );

    return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const server = await createContactsMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
