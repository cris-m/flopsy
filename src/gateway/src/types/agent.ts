export type InvokeRole = 'user' | 'system';

export interface ChannelEvent {
    readonly type: 'task_complete' | 'task_error';
    readonly taskId: string;
    readonly result?: string;
    readonly error?: string;
    readonly completedAt: number;
}

export interface IEventQueue {
    push(event: ChannelEvent): void;
    tryDequeue(): ChannelEvent | null;
    waitForEvent(timeoutMs: number): Promise<boolean>;
}

export interface AgentCallbacks {
    readonly onReply: (text: string) => Promise<void>;
    readonly setDidSendViaTool: () => void;
    readonly eventQueue: IEventQueue;
    readonly pending: string[];
    readonly signal: AbortSignal;
}

export interface AgentChunk {
    readonly type: 'text_delta' | 'tool_start' | 'tool_result' | 'done';
    readonly text?: string;
    readonly toolName?: string;
    readonly toolResult?: string;
}

export interface StreamingCallbacks extends AgentCallbacks {
    readonly onChunk: (chunk: AgentChunk) => void;
}

export interface AgentResult {
    readonly reply: string | null;
    readonly didSendViaTool: boolean;
    readonly tokenUsage?: { readonly input: number; readonly output: number };
}

export interface AgentHandler {
    invoke(text: string, threadId: string, callbacks: AgentCallbacks, role?: InvokeRole): Promise<AgentResult>;
    stream?(text: string, threadId: string, callbacks: StreamingCallbacks, role?: InvokeRole): AsyncIterable<AgentChunk>;
}