/**
 * Global registry for cleanup functions that run on graceful shutdown.
 * Each subsystem calls registerCleanup() and receives an unregister
 * function (RAII-style). The gateway calls runCleanup() on SIGTERM/exit.
 *
 * Pattern from claude-code's cleanupRegistry.ts.
 */

const cleanupFunctions = new Set<() => Promise<void>>();

/**
 * Register a cleanup function to run during shutdown.
 * @returns An unregister function that removes this cleanup handler.
 */
export function registerCleanup(fn: () => Promise<void>): () => void {
    cleanupFunctions.add(fn);
    return () => cleanupFunctions.delete(fn);
}

/**
 * Run all registered cleanup functions in parallel.
 * Errors are collected and re-thrown as an AggregateError after
 * all cleaners complete, so one failure doesn't skip others.
 */
export async function runCleanup(): Promise<void> {
    const results = await Promise.allSettled(
        Array.from(cleanupFunctions).map((fn) => fn()),
    );
    const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason as Error);
    if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} cleanup(s) failed`);
    }
}
