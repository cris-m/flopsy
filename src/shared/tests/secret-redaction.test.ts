import { describe, it, expect } from 'vitest';
import { scrubPii } from '../src/utils/logger';

describe('scrubPii — secret redaction', () => {
    const cases: Array<[string, string, string]> = [
        ['xAI', 'My key is xai-' + 'A'.repeat(60), '[XAI_KEY]'],
        ['HuggingFace', 'Token: hf_' + 'B'.repeat(40), '[HUGGINGFACE_TOKEN]'],
        ['Replicate', 'Use r8_' + 'C'.repeat(40), '[REPLICATE_TOKEN]'],
        ['Firecrawl', 'fc-' + 'D'.repeat(30), '[FIRECRAWL_KEY]'],
        ['Tavily', 'tvly-' + 'E'.repeat(30), '[TAVILY_KEY]'],
        ['Exa', 'exa_' + 'F'.repeat(30), '[EXA_KEY]'],
        ['Groq', 'gsk_' + 'G'.repeat(40), '[GROQ_KEY]'],
        ['AgentMail', 'am_' + 'H'.repeat(40), '[AGENTMAIL_KEY]'],
        ['npm', 'npm_' + 'I'.repeat(40), '[NPM_TOKEN]'],
        ['DigitalOcean', 'dop_v1_' + 'a'.repeat(60), '[DIGITALOCEAN_TOKEN]'],
        ['Perplexity', 'pplx-' + 'J'.repeat(40), '[PERPLEXITY_KEY]'],
        ['SendGrid', 'SG.aaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[SENDGRID_KEY]'],
        ['GitHub PAT', 'ghp_' + 'K'.repeat(40), '[GITHUB_TOKEN]'],
        ['Slack', 'xoxb-1234-5678-abcdefghijklmnop', '[SLACK_TOKEN]'],
        ['Google API', 'AIza' + 'L'.repeat(35), '[GOOGLE_API_KEY]'],
        ['Vault', 'hvs.abcdefghijklmnopqrstuv', '[VAULT_TOKEN]'],
    ];

    for (const [name, input, expectedLabel] of cases) {
        it(`redacts ${name}`, () => {
            const result = scrubPii(input);
            expect(result).toContain(expectedLabel);
            expect(result).not.toContain(input.split(' ').slice(-1)[0]!);
        });
    }

    it('redacts sensitive URL query parameters (keeps tail)', () => {
        const url = 'https://api.example.com/data?api_key=abcdef1234567890&page=2';
        const result = scrubPii(url);
        expect(result).toContain('api_key=[REDACTED…7890]');
        expect(result).toContain('page=2');
        expect(result).not.toContain('abcdef1234567890');
    });

    it('redacts authorization query param', () => {
        const url = 'https://example.com/?authorization=Bearer%20xyz123tokenend';
        const result = scrubPii(url);
        expect(result).toContain('authorization=[REDACTED…');
        expect(result).not.toContain('xyz123tokenend');
    });

    it('leaves benign query params alone', () => {
        const url = 'https://example.com/?q=hello&page=2&sort=desc';
        expect(scrubPii(url)).toBe(url);
    });

    it('handles multiple secrets in one string', () => {
        const text = `key1=hf_${'A'.repeat(40)} and key2=gsk_${'B'.repeat(40)}`;
        const result = scrubPii(text);
        expect(result).toContain('[HUGGINGFACE_TOKEN]');
        expect(result).toContain('[GROQ_KEY]');
    });

    it('preserves non-secret prose untouched', () => {
        const text = 'The agent successfully completed the request.';
        expect(scrubPii(text)).toBe(text);
    });
});
