type QueueItem<T extends unknown[], R> = {
    args: T;
    resolve: (value: R) => void;
    reject: (reason?: unknown) => void;
    context: unknown;
};

/**
 * Wraps an async function so concurrent calls are serialized FIFO.
 * Useful for file writes, DB operations, or any resource where
 * overlapping calls would corrupt state.
 *
 * Returns a wrapped function with the same signature. Each call
 * queues behind prior in-flight calls; return values are correctly
 * routed back to their original caller.
 */
export function sequential<T extends unknown[], R>(
    fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
    const queue: QueueItem<T, R>[] = [];
    let processing = false;

    async function processQueue(): Promise<void> {
        if (processing) return;
        if (queue.length === 0) return;
        processing = true;
        while (queue.length > 0) {
            const { args, resolve, reject, context } = queue.shift()!;
            try {
                resolve(await fn.apply(context, args));
            } catch (err) {
                reject(err);
            }
        }
        processing = false;
        if (queue.length > 0) void processQueue();
    }

    return function (this: unknown, ...args: T): Promise<R> {
        return new Promise((resolve, reject) => {
            queue.push({ args, resolve, reject, context: this });
            void processQueue();
        });
    };
}
