export interface SkillRiskResult {
    readonly requiresReview: boolean;
    readonly reasons: readonly string[];
}

const REVIEW_CATEGORIES = new Set(['security']);

const SIGNALS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
    {
        label: 'destructive file/data ops',
        re: /\b(rm\s+-[a-z]*f|rmdir\b|unlink\b|shred\b|drop\s+table|truncate\s+table|delete\s+from|reset\s+--hard|force[\s-]?push|--force\b|mkfs\b|format\s+disk)/i,
    },
    {
        label: 'sends to external recipients',
        re: /\b(send[\s_-]?email|sendmail|gmail[\s_.]?(send|draft)|\bsmtp\b|twilio|send[\s_-]?sms|post\s+to\s+(twitter|x|slack|discord|telegram|facebook|instagram|linkedin|mastodon)|tweet\b|publish\s+(a\s+)?post)/i,
    },
    {
        label: 'handles credentials/secrets',
        re: /\b(api[\s_-]?key|secret[\s_-]?key|\bpassword\b|oauth|bearer\s+token|private[\s_-]?key|connect_service|\.env\b|credentials?\b)/i,
    },
    {
        label: 'money/payments',
        re: /\b(stripe|paypal|\bcharge\s+(the\s+)?card|create\s+invoice|wire\s+transfer|\brefund\b|billing\s+api|purchase\s+order|process\s+payment|checkout\s+session)/i,
    },
    {
        label: 'system/package install',
        re: /\b(pip\s+install|uv\s+pip\s+install|npm\s+i(nstall)?\b|pnpm\s+add|apt(-get)?\s+install|brew\s+install|sudo\b|systemctl|docker\s+run|kubectl\s+(apply|delete))/i,
    },
    {
        label: 'schedules recurring jobs',
        re: /\b(manage_schedule|cron\s+job|recurring\s+(job|task|schedule|fire)|create\s+(a\s+)?heartbeat)/i,
    },
    {
        label: 'external write API call',
        re: /(curl\s+-x\s*(post|put|delete)|method:\s*['"]?(post|put|delete)\b)/i,
    },
];

function extractFrontmatter(content: string): string {
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    return m ? m[1]! : '';
}

function categoryOf(frontmatter: string): string {
    const m = frontmatter.match(/^\s*category:\s*["']?([a-z0-9_-]+)/im);
    return m ? m[1]!.toLowerCase() : '';
}

export function classifySkillRisk(content: string): SkillRiskResult {
    const frontmatter = extractFrontmatter(content);

    if (/^\s*review:\s*["']?required/im.test(frontmatter)) {
        return { requiresReview: true, reasons: ['frontmatter review: required'] };
    }
    if (/^\s*review:\s*["']?(none|skip|auto)/im.test(frontmatter)) {
        return { requiresReview: false, reasons: [] };
    }

    const reasons: string[] = [];
    const cat = categoryOf(frontmatter);
    if (REVIEW_CATEGORIES.has(cat)) reasons.push(`category: ${cat}`);
    for (const sig of SIGNALS) {
        if (sig.re.test(content)) reasons.push(sig.label);
    }
    return { requiresReview: reasons.length > 0, reasons };
}
