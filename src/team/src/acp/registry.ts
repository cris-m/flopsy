import type { AcpLaunchSpec } from './types';

const BUILT_IN: Record<string, AcpLaunchSpec> = {
    'claude-code': { command: 'npx', args: ['-y', '@zed-industries/claude-code-acp'] },
};

export function resolveLaunchSpec(
    agent: string,
    configured: Record<string, AcpLaunchSpec> = {},
): AcpLaunchSpec | null {
    return configured[agent] ?? BUILT_IN[agent] ?? null;
}

export function knownAgents(configured: Record<string, AcpLaunchSpec> = {}): string[] {
    return [...new Set([...Object.keys(BUILT_IN), ...Object.keys(configured)])];
}
