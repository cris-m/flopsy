/**
 * Emacs-style kill ring for cut/yank operations in the input editor.
 *
 * Adapted from earendil-works/pi (MIT) — packages/tui/src/kill-ring.ts.
 * Ring stores killed (deleted) text entries. Consecutive kills accumulate
 * into a single entry; yank pulls the most recent; yank-pop cycles older
 * entries to the front.
 */
export class KillRing {
    private ring: string[] = [];

    /**
     * Add text to the kill ring.
     *
     * @param text - The killed text to add
     * @param opts.prepend - If accumulating, prepend (backward deletion) vs append (forward deletion)
     * @param opts.accumulate - Merge with the most recent entry rather than creating a new one
     */
    push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
        if (!text) return;
        if (opts.accumulate && this.ring.length > 0) {
            const last = this.ring.pop()!;
            this.ring.push(opts.prepend ? text + last : last + text);
        } else {
            this.ring.push(text);
        }
    }

    /** Get most recent entry without modifying the ring. */
    peek(): string | undefined {
        return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
    }

    /** Move last entry to the front (for yank-pop cycling). */
    rotate(): void {
        if (this.ring.length > 1) {
            const last = this.ring.pop()!;
            this.ring.unshift(last);
        }
    }

    get length(): number {
        return this.ring.length;
    }
}
