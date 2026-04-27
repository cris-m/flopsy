/**
 * Parse a duration string like "30s", "5m", "2h", "1d" into milliseconds.
 * Returns null on invalid input — callers warn-log and skip rather than throw.
 */
export function parseDurationMs(interval: string): number | null {
    const match = interval.match(/^(\d+)\s*(s|m|h|d)$/);
    if (!match) return null;
    const value = parseInt(match[1]!, 10);
    switch (match[2]) {
        case 's':
            return value * 1_000;
        case 'm':
            return value * 60_000;
        case 'h':
            return value * 3_600_000;
        case 'd':
            return value * 86_400_000;
        default:
            return null;
    }
}
