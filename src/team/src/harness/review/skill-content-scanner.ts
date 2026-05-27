import { detectPromptInjection, detectSecret } from 'flopsygraph';

export interface SkillScanFinding {
    readonly rule: string;
    readonly severity: 'critical' | 'high' | 'medium';
    readonly message: string;
}

const SKILL_DANGER_RULES: ReadonlyArray<{ name: string; severity: 'critical' | 'high' | 'medium'; pattern: RegExp; message: string }> = [
    {
        name: 'shell-pipe-to-shell',
        severity: 'critical',
        pattern: /\b(?:curl|wget|fetch)\s+[^\n|]*\|\s*(?:bash|sh|zsh|fish|python|node|deno|perl|ruby)\b/i,
        message: 'piping remote content directly into a shell is an arbitrary-code-execution vector',
    },
    {
        name: 'rm-rf-root',
        severity: 'critical',
        pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(?:\s|$|[^a-zA-Z0-9._-])/i,
        message: 'recursive force-delete of root paths destroys the host',
    },
    {
        name: 'eval-base64',
        severity: 'critical',
        pattern: /\b(?:eval|exec)\s*\(?\s*(?:atob|base64\s+-d|base64\s+--decode)/i,
        message: 'evaluating base64-decoded payloads is a classic obfuscated-execution pattern',
    },
    {
        name: 'sudo-without-password',
        severity: 'high',
        pattern: /\bsudo\s+-S\b|\becho\s+[^|\n]+\|\s*sudo\s+-S/i,
        message: 'piping a password into sudo bypasses interactive confirmation',
    },
    {
        name: 'chmod-world-writable',
        severity: 'medium',
        pattern: /\bchmod\s+(?:[0-7]*[2367]|a\+w|o\+w)\s+\/(?:etc|usr|root|home|var)\b/i,
        message: 'making system paths world-writable',
    },
    {
        name: 'reverse-shell-bash',
        severity: 'critical',
        pattern: /\bbash\s+-i\s+>&?\s+\/dev\/tcp\b/i,
        message: 'classic bash reverse-shell construct',
    },
    {
        name: 'crontab-modification',
        severity: 'high',
        pattern: /\b(?:crontab\s+(?:-e|-)|echo\s+[^|\n]+\|\s*crontab)\b/i,
        message: 'modifying crontab from skill content is a persistence vector',
    },
];

export function scanSkillContent(content: string): SkillScanFinding[] {
    const findings: SkillScanFinding[] = [];

    const injection = detectPromptInjection(content);
    if (injection) {
        findings.push({
            rule: `prompt-injection:${injection}`,
            severity: 'critical',
            message: `skill text contains prompt-injection pattern '${injection}'`,
        });
    }

    const secret = detectSecret(content);
    if (secret) {
        findings.push({
            rule: `secret-leak:${secret}`,
            severity: 'critical',
            message: `skill text contains a literal secret of type '${secret}'`,
        });
    }

    for (const rule of SKILL_DANGER_RULES) {
        if (rule.pattern.test(content)) {
            findings.push({
                rule: rule.name,
                severity: rule.severity,
                message: rule.message,
            });
        }
    }

    return findings;
}

export function hasCriticalFinding(findings: ReadonlyArray<SkillScanFinding>): boolean {
    return findings.some((f) => f.severity === 'critical');
}
