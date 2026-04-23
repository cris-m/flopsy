/**
 * Toolset registry — named bundles of tools that teammates subscribe to.
 *
 * We compose bundles from flopsygraph's prebuilt tools wherever possible
 * rather than re-implementing equivalents. A teammate's config lists toolset
 * names (e.g. `["research", "utility"]`); the factory expands those names to
 * concrete tool instances at runtime.
 *
 * To add a new toolset: register it in TOOLSETS below. To add a new tool to
 * an existing toolset: prefer extending the flopsygraph prebuilt bundle and
 * re-exporting it here, rather than hand-rolling.
 */

import type { BaseTool } from 'flopsygraph';
import {
    // Prebuilt bundles from flopsygraph — use as-is.
    webTools,
    researchTools,
    utilityTools,
    financeTools,
    newsTools,
    filesystemTools,
} from 'flopsygraph';

/**
 * All toolsets available to team members. Values are readonly tool arrays
 * (flopsygraph exports them as `readonly [...]` so we preserve that).
 */
export const TOOLSETS: Record<string, ReadonlyArray<BaseTool>> = {
    web: webTools,
    research: researchTools,
    utility: utilityTools,
    finance: financeTools,
    news: newsTools,
    filesystem: filesystemTools,
};

export type ToolsetName = keyof typeof TOOLSETS;

/**
 * Expand a list of toolset names into a flat, de-duplicated tool array.
 * Unknown toolset names throw — fail loud rather than silently drop tools.
 */
export function resolveToolsets(names: ReadonlyArray<string>): BaseTool[] {
    const seen = new Set<BaseTool>();
    const out: BaseTool[] = [];
    for (const name of names) {
        const bundle = TOOLSETS[name];
        if (!bundle) {
            const available = Object.keys(TOOLSETS).join(', ');
            throw new Error(
                `Unknown toolset "${name}". Available: ${available}. ` +
                    `Register it in src/agent/src/tools/index.ts.`,
            );
        }
        for (const tool of bundle) {
            if (!seen.has(tool)) {
                seen.add(tool);
                out.push(tool);
            }
        }
    }
    return out;
}

