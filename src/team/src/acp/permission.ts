import { isAbsolute, relative, resolve } from 'node:path';
import type { AcpPermissionMode } from './types';

export function isPathInside(child: string, parent: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface PermissionDecision {
    allow: boolean;
    reason: string;
}

export function decidePermission(
    mode: AcpPermissionMode,
    cwd: string,
    paths: string[],
): PermissionDecision {
    if (mode === 'deny-all') return { allow: false, reason: 'deny-all policy' };
    const outside = paths.filter((p) => !isPathInside(p, cwd));
    if (outside.length > 0) return { allow: false, reason: `outside cwd: ${outside.join(', ')}` };
    return { allow: true, reason: 'within cwd' };
}

// Pick the option id matching the decision; null when the agent offered no usable option.
export function pickOptionId(
    options: ReadonlyArray<{ optionId: string; kind: string }>,
    allow: boolean,
): string | null {
    const prefer = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    for (const kind of prefer) {
        const match = options.find((o) => o.kind === kind);
        if (match) return match.optionId;
    }
    return null;
}
