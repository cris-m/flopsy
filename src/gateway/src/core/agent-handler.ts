import type { EventQueue } from './event-queue';

export type InvokeRole = 'user' | 'system';

export interface AgentCallbacks {
    readonly onReply: (text: string) => Promise<void>;
    readonly setDidSendViaTool: () => void;
    readonly eventQueue: EventQueue;
    readonly pending: string[];
    readonly signal: AbortSignal;
}

export interface AgentResult {
    readonly reply: string | null;
    readonly didSendViaTool: boolean;
    readonly tokenUsage?: { readonly input: number; readonly output: number };
}

export interface AgentHandler {
    invoke(text: string, threadId: string, callbacks: AgentCallbacks, role?: InvokeRole): Promise<AgentResult>;
}
