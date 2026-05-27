/**
 * Normalize a raw tool error string into a stable "pattern" we can group on.
 *
 * The agent's tool errors carry lots of detail that varies per call —
 * file paths, addresses, timestamps, opaque IDs — but the underlying class
 * of failure is what we want to record (and surface back to the model).
 * Two failures from the same root cause should collapse to one row in
 * `tool_failures`; otherwise the table fills with one-row-per-call noise
 * that nobody can use.
 *
 * Strategy:
 *   1. Take the first line only. Stack traces are noise.
 *   2. Mask absolute paths, hex addresses, long numeric IDs, and quoted
 *      strings longer than ~12 chars (those are usually the variable
 *      payload — URLs, tokens, file names).
 *   3. Strip surrounding whitespace.
 *   4. Truncate hard at 120 chars so the table stays readable in `<tool_quirks>`.
 *
 * Conservative on purpose — we'd rather over-collapse two distinct errors
 * than fragment one error across 50 rows. The model gets the gist either way.
 */
export function normalizeErrorPattern(raw: string): string {
    if (!raw) return '';
    let head = (raw.split('\n')[0] ?? raw).trim();
    // A first line that's only structural punctuation (e.g. "[" from a
    // pretty-printed JSON/array error) carries no signal and collapses every
    // distinct failure to one char. Detect it with a plain character check
    // (no regex) and fall back to the whole error flattened to one line.
    const STRUCTURAL = '[]{}(),';
    const onlyStructural = head.length > 0 && [...head].every((c) => STRUCTURAL.includes(c));
    if (head.length <= 2 || onlyStructural) {
        head = raw.split('\n').join(' ').replace(/\s+/g, ' ').trim();
    }
    return head
        .replace(/\b(?:[a-z]:)?\/[\w./\-_]{4,}/gi, '<path>')
        .replace(/\b0x[0-9a-f]+/gi, '<hex>')
        .replace(/\b\d{6,}\b/g, '<id>')
        .replace(/(['"`])[^'"`\n]{12,}\1/g, '<str>')
        .trim()
        .slice(0, 120);
}
