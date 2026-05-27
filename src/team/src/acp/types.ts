export interface AcpLaunchSpec {
    command: string;
    args: string[];
    env?: Record<string, string>;
}

export type AcpPermissionMode = 'auto-allow-in-cwd' | 'deny-all';

export interface AcpConfig {
    enabled: boolean;
    cwdRoot: string;
    permissionMode: AcpPermissionMode;
    timeoutMs: number;
    agents: Record<string, AcpLaunchSpec>;
}

export interface AcpRunResult {
    stopReason: string;
    transcript: string;
    toolCalls: string[];
    editedPaths: string[];
    deniedPaths: string[];
}
