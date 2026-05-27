/**
 * Generic undo stack with clone-on-push semantics for the input editor.
 *
 * Adapted from earendil-works/pi (MIT) — packages/tui/src/undo-stack.ts.
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
    private stack: S[] = [];
    private readonly maxDepth: number;

    constructor(maxDepth = 100) {
        this.maxDepth = Math.max(1, maxDepth);
    }

    /** Push a deep clone of the given state onto the stack. */
    push(state: S): void {
        this.stack.push(structuredClone(state));
        if (this.stack.length > this.maxDepth) {
            this.stack.shift();
        }
    }

    /** Pop and return the most recent snapshot, or undefined if empty. */
    pop(): S | undefined {
        return this.stack.pop();
    }

    /** Remove all snapshots. */
    clear(): void {
        this.stack.length = 0;
    }

    get length(): number {
        return this.stack.length;
    }
}
