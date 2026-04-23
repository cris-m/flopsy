// MCP Calendar Server
// Calendar tools: list, create, update, delete meetings

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google, type calendar_v3 } from 'googleapis';
import { z } from 'zod';

import { createAuth, installAuthErrorHandler } from './shared/google-auth';

// Gateway injects Google OAuth tokens via env; this client refreshes in-process.
const auth = createAuth();
installAuthErrorHandler();

function parseEvent(event: calendar_v3.Schema$Event) {
    return {
        id: event.id ?? '',
        summary: event.summary ?? '',
        description: event.description ?? null,
        location: event.location ?? null,
        start: event.start?.dateTime ?? event.start?.date ?? '',
        end: event.end?.dateTime ?? event.end?.date ?? '',
        attendees: event.attendees?.map((a) => a.email ?? '') ?? [],
        htmlLink: event.htmlLink ?? null,
        status: event.status ?? null,
    };
}

export async function createCalendarMcpServer() {
    const calendar = (google.calendar as any)({ version: 'v3', auth });

    const server = new McpServer({
        name: 'calendar-server',
        version: '1.0.0',
    });

    server.registerTool(
        'calendar_list',
        {
            title: 'List Meetings',
            description: 'Get meetings for a specific date',
            inputSchema: {
                date: z
                    .string()
                    .optional()
                    .describe('Date in YYYY-MM-DD format (defaults to today)'),
                timezone: z.string().default('UTC').describe('Timezone (e.g., America/New_York)'),
            },
        },
        async ({ date, timezone }) => {
            // Use today if no date provided
            const targetDate = date ?? new Date().toISOString().split('T')[0];

            // Create start/end times using RFC3339 format
            // The API will interpret these in the context of the provided timezone
            const timeMin = `${targetDate}T00:00:00Z`;
            const timeMax = `${targetDate}T23:59:59Z`;

            const res = await calendar.events.list({
                calendarId: 'primary',
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: 'startTime',
                timeZone: timezone,
            });

            const meetings = (res.data.items ?? []).map(parseEvent);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                date: targetDate,
                                timezone,
                                count: meetings.length,
                                meetings,
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
        'calendar_create',
        {
            title: 'Create Meeting',
            description: 'Create a new calendar event',
            inputSchema: {
                summary: z.string().describe('Meeting title'),
                startTime: z.string().describe('Start time (ISO format)'),
                endTime: z.string().describe('End time (ISO format)'),
                description: z.string().optional().describe('Meeting description'),
                location: z.string().optional().describe('Meeting location'),
                attendees: z.array(z.string()).optional().describe('Attendee emails'),
                timezone: z.string().default('UTC').describe('Timezone'),
                sendNotifications: z.boolean().default(true).describe('Send invites'),
            },
        },
        async ({
            summary,
            startTime,
            endTime,
            description,
            location,
            attendees,
            timezone,
            sendNotifications,
        }) => {
            const event: calendar_v3.Schema$Event = {
                summary,
                start: { dateTime: startTime, timeZone: timezone },
                end: { dateTime: endTime, timeZone: timezone },
            };

            if (description) event.description = description;
            if (location) event.location = location;
            if (attendees?.length) event.attendees = attendees.map((email) => ({ email }));

            const res = await calendar.events.insert({
                calendarId: 'primary',
                requestBody: event,
                sendUpdates: sendNotifications ? 'all' : 'none',
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, event: parseEvent(res.data) },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'calendar_get',
        {
            title: 'Get Meeting',
            description: 'Get details of a specific meeting',
            inputSchema: {
                eventId: z.string().describe('Calendar event ID'),
            },
        },
        async ({ eventId }) => {
            const res = await calendar.events.get({ calendarId: 'primary', eventId });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, event: parseEvent(res.data) },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'calendar_update',
        {
            title: 'Update Meeting',
            description: 'Update an existing meeting',
            inputSchema: {
                eventId: z.string().describe('Calendar event ID'),
                summary: z.string().optional().describe('New title'),
                startTime: z.string().optional().describe('New start time'),
                endTime: z.string().optional().describe('New end time'),
                description: z.string().optional().describe('New description'),
                location: z.string().optional().describe('New location'),
                attendees: z.array(z.string()).optional().describe('New attendee list'),
                timezone: z.string().default('UTC').describe('Timezone'),
                sendNotifications: z.boolean().default(true).describe('Send updates'),
            },
        },
        async ({
            eventId,
            summary,
            startTime,
            endTime,
            description,
            location,
            attendees,
            timezone,
            sendNotifications,
        }) => {
            const existing = await calendar.events.get({ calendarId: 'primary', eventId });
            const event = existing.data;

            if (summary) event.summary = summary;
            if (description) event.description = description;
            if (location) event.location = location;
            if (startTime) event.start = { dateTime: startTime, timeZone: timezone };
            if (endTime) event.end = { dateTime: endTime, timeZone: timezone };
            if (attendees) event.attendees = attendees.map((email) => ({ email }));

            const res = await calendar.events.update({
                calendarId: 'primary',
                eventId,
                requestBody: event,
                sendUpdates: sendNotifications ? 'all' : 'none',
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, event: parseEvent(res.data) },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'calendar_delete',
        {
            title: 'Delete Meeting',
            description: 'Delete a calendar event',
            inputSchema: {
                eventId: z.string().describe('Calendar event ID'),
                sendNotifications: z.boolean().default(true).describe('Send cancellation'),
            },
        },
        async ({ eventId, sendNotifications }) => {
            await calendar.events.delete({
                calendarId: 'primary',
                eventId,
                sendUpdates: sendNotifications ? 'all' : 'none',
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, eventId, deleted: true }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        'calendar_availability',
        {
            title: 'Get Available Slots',
            description: 'Find available time slots on a date',
            inputSchema: {
                date: z.string().optional().describe('Date (YYYY-MM-DD, defaults to today)'),
                workStart: z.number().default(9).describe('Work start hour'),
                workEnd: z.number().default(17).describe('Work end hour'),
                duration: z.number().default(60).describe('Meeting duration (minutes)'),
                timezone: z.string().default('UTC').describe('Timezone'),
            },
        },
        async ({ date, workStart, workEnd, duration, timezone }) => {
            // Use today if no date provided
            const targetDate = date ?? new Date().toISOString().split('T')[0];

            const timeMin = `${targetDate}T00:00:00Z`;
            const timeMax = `${targetDate}T23:59:59Z`;

            const res = await calendar.events.list({
                calendarId: 'primary',
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: 'startTime',
                timeZone: timezone,
            });

            const meetings = res.data.items ?? [];
            const busyTimes = meetings
                .filter((m: any) => m.start?.dateTime && m.end?.dateTime)
                .map((m: any) => ({
                    start: new Date(m.start!.dateTime!).getTime(),
                    end: new Date(m.end!.dateTime!).getTime(),
                }))
                .sort((a: any, b: any) => a.start - b.start);

            // Parse date for work hours calculation
            const [year, month, day] = targetDate!.split('-').map(Number);
            const dayStart = new Date(year!, month! - 1, day!, workStart, 0, 0, 0);
            const dayEnd = new Date(year!, month! - 1, day!, workEnd, 0, 0, 0);

            const durationMs = duration * 60 * 1000;
            const slots = [];
            let current = dayStart.getTime();

            for (const busy of busyTimes) {
                if (busy.start - current >= durationMs) {
                    slots.push({
                        start: new Date(current).toISOString(),
                        end: new Date(busy.start).toISOString(),
                        minutes: Math.floor((busy.start - current) / 60000),
                    });
                }
                current = Math.max(current, busy.end);
            }

            if (dayEnd.getTime() - current >= durationMs) {
                slots.push({
                    start: new Date(current).toISOString(),
                    end: dayEnd.toISOString(),
                    minutes: Math.floor((dayEnd.getTime() - current) / 60000),
                });
            }

            return {
                content: [
                    { type: 'text', text: JSON.stringify({ success: true, date, slots }, null, 2) },
                ],
            };
        },
    );

    server.registerTool(
        'calendar_invite',
        {
            title: 'Invite to Meeting',
            description: 'Add attendees to an existing meeting',
            inputSchema: {
                eventId: z.string().describe('Calendar event ID'),
                attendees: z.array(z.string()).describe('Emails to invite'),
                sendNotifications: z.boolean().default(true).describe('Send invites'),
            },
        },
        async ({ eventId, attendees, sendNotifications }) => {
            const existing = await calendar.events.get({ calendarId: 'primary', eventId });
            const event = existing.data;

            const currentEmails = new Set(event.attendees?.map((a: any) => a.email));
            const newAttendees = [...(event.attendees ?? [])];

            for (const email of attendees) {
                if (!currentEmails.has(email)) {
                    newAttendees.push({ email });
                }
            }

            event.attendees = newAttendees;

            const res = await calendar.events.update({
                calendarId: 'primary',
                eventId,
                requestBody: event,
                sendUpdates: sendNotifications ? 'all' : 'none',
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { success: true, event: parseEvent(res.data) },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.registerResource(
        'calendar_today',
        'calendar://today',
        {
            title: "Today's Meetings",
            description: 'Meetings scheduled for today',
            mimeType: 'application/json',
        },
        async () => {
            const now = new Date();
            const today = now.toISOString().split('T')[0] ?? '';
            const timeMin = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate(),
                0,
                0,
                0,
            ).toISOString();
            const timeMax = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate(),
                23,
                59,
                59,
                999,
            ).toISOString();

            const res = await calendar.events.list({
                calendarId: 'primary',
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: 'startTime',
            });

            const meetings = (res.data.items ?? []).map(parseEvent);

            return {
                contents: [
                    {
                        uri: 'calendar://today',
                        mimeType: 'application/json',
                        text: JSON.stringify(
                            { date: today, count: meetings.length, meetings },
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
        const server = await createCalendarMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('[MCP] Calendar started');
    } catch (error) {
        console.error('[MCP] Calendar failed:', error);
        process.exit(1);
    }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main();
}
