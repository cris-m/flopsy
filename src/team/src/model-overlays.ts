import { modelFamily } from '@flopsy/shared';

const GPT_EXECUTION_DISCIPLINE = `Counter GPT-class failure modes: narrating tool calls instead of making them, stopping mid-chain for permission, claiming done without evidence.

- Don't say "I'll search for X next" — call the tool. Describing a call is not making it.
- Keep calling tools until done. Don't hand back mid-chain to ask "should I continue?"
- Cite a concrete handle when claiming done: URL, path, HTTP status, message id, row count. For irreversible actions, verify the handle yourself.
- Don't enumerate options the user didn't ask for — pick the best path.`;

const GEMINI_OPERATIONAL = `Counter Gemini failure modes: relative-path tool args, serialized calls, verbose "I will now..." preambles.

- Use ABSOLUTE paths in tool arguments — relative paths resolve against an unspecified cwd.
- Lead with the result, not the journey. "Done — wrote /tmp/foo.txt" beats a paragraph describing the write.
- Cite a concrete handle when claiming done: URL, absolute path, HTTP status, message id, row count.`;

const MODEL_FAMILY_OVERLAYS: Record<string, string> = {
    anthropic: '',
    openai: GPT_EXECUTION_DISCIPLINE,
    google: GEMINI_OPERATIONAL,
    xai: GPT_EXECUTION_DISCIPLINE,
    deepseek: GPT_EXECUTION_DISCIPLINE,
    moonshot: GPT_EXECUTION_DISCIPLINE,
    qwen: GPT_EXECUTION_DISCIPLINE,
    meta: GPT_EXECUTION_DISCIPLINE,
    mistral: GPT_EXECUTION_DISCIPLINE,
    nvidia: GPT_EXECUTION_DISCIPLINE,
    zai: GPT_EXECUTION_DISCIPLINE,
    ollama: GPT_EXECUTION_DISCIPLINE,
    unknown: '',
};

export function modelFamilyOverlay(modelId: string | undefined): { body: string; family: string } {
    const family = modelFamily(modelId);
    const body = MODEL_FAMILY_OVERLAYS[family] ?? '';
    return { body, family };
}
