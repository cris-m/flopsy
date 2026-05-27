import type { AcpConfig, AcpLaunchSpec } from './types';

const DEFAULT_TIMEOUT_MS = 1_800_000;

export function normalizeAcpConfig(raw: unknown): AcpConfig {
    const r = (raw ?? {}) as Partial<AcpConfig>;
    const agents = r.agents && typeof r.agents === 'object'
        ? (r.agents as Record<string, AcpLaunchSpec>)
        : {};
    return {
        enabled: r.enabled === true,
        cwdRoot: typeof r.cwdRoot === 'string' && r.cwdRoot ? r.cwdRoot : 'work/code',
        permissionMode: r.permissionMode === 'deny-all' ? 'deny-all' : 'auto-allow-in-cwd',
        timeoutMs: typeof r.timeoutMs === 'number' && r.timeoutMs > 0 ? r.timeoutMs : DEFAULT_TIMEOUT_MS,
        agents,
    };
}
