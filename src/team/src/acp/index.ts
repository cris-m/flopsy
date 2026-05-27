export { normalizeAcpConfig } from './config';
export { runAcpAgent } from './client';
export type { RunAcpAgentArgs } from './client';
export { resolveLaunchSpec, knownAgents } from './registry';
export { decidePermission, isPathInside, pickOptionId } from './permission';
export { tryAcquireSlot, releaseSlot } from './session-manager';
export { AcpError, AcpSdkMissingError } from './errors';
export type { AcpConfig, AcpLaunchSpec, AcpPermissionMode, AcpRunResult } from './types';
