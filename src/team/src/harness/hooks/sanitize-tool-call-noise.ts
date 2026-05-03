import type { Interceptor } from 'flopsygraph';
import type { ChatResponse } from 'flopsygraph';
import { createLogger } from '@flopsy/shared';

const log = createLogger('sanitize-tool-call-noise');

// Runs at the model-response boundary so the next planner iteration doesn't
// re-read its own leaked tool-call shape as if it were a real call.
const META_TOOL_CALL_LINE = /^[ \t]*__(search_tools|load_tool|respond)__\s*\([^)]*\)\s*$/gm;
const OPENAI_TOOL_CALL = /\{[\s\n]*"type"\s*:\s*"function"[\s\S]*?"name"\s*:\s*"[a-zA-Z0-9_]+"[\s\S]*?\}/g;
const ANTHROPIC_TOOL_USE = /\{[\s\n]*"type"\s*:\s*"tool_use"[\s\S]*?"name"\s*:\s*"[a-zA-Z0-9_]+"[\s\S]*?\}/g;

function strip(text: string): string {
    if (!text) return text;
    let out = text;
    out = out.replace(META_TOOL_CALL_LINE, '');
    out = out.replace(OPENAI_TOOL_CALL, '');
    out = out.replace(ANTHROPIC_TOOL_USE, '');
    out = out.replace(/\n{3,}/g, '\n\n');
    const trimmed = out.trim();
    return trimmed || text;
}

export function sanitizeToolCallNoise(): Interceptor {
    return {
        name: 'sanitize-tool-call-noise',
        priority: 10,
        afterModelCall(_ctx, response: ChatResponse): ChatResponse | void {
            if (typeof response.content !== 'string') return;
            const cleaned = strip(response.content);
            if (cleaned === response.content) return;
            log.debug(
                {
                    beforeLen: response.content.length,
                    afterLen: cleaned.length,
                },
                'tool-call noise stripped from assistant content',
            );
            return { ...response, content: cleaned };
        },
    };
}
