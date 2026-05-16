/** Parse `REPORTED:` lines; auto-extract URLs as news fallback. */
export function parseReportedLines(
    text: string,
    jobName: string,
): { emails: string[]; meetings: string[]; tasks: string[]; news: string[] } {
    const out = {
        emails: [] as string[],
        meetings: [] as string[],
        tasks: [] as string[],
        news: [] as string[],
    };

    for (const line of text.split('\n')) {
        const m = line.match(/^\s*REPORTED:\s*(.+)$/i);
        if (!m?.[1]) continue;
        const payload = m[1];
        const re = /(emails|meetings|tasks|news)\s*=\s*\[([^\]]*)\]/gi;
        let tm: RegExpExecArray | null;
        while ((tm = re.exec(payload)) !== null) {
            const type = tm[1]!.toLowerCase() as keyof typeof out;
            const ids = tm[2]!
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            out[type].push(...ids);
        }
    }

    const lower = jobName.toLowerCase();
    if (lower.includes('news') || lower.includes('briefing') || lower.includes('digest')) {
        const urls = text.match(/https?:\/\/[^\s)>\]"']+/gi);
        if (urls) {
            const clean = [...new Set(urls.map((u) => u.replace(/[.,;:!?]+$/, '')))];
            out.news.push(...clean);
        }
    }

    return out;
}

export function stripReportedLines(text: string): string {
    return text
        .split('\n')
        .filter((line) => !/^\s*REPORTED:\s*/i.test(line))
        .join('\n')
        .trim();
}
