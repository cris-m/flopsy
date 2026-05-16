/**
 * User message rendering — gray block style.
 *
 * Pasted-text placeholders `[Pasted text #N <info>]` render compactly inside
 * the bubble (just `[Pasted text #N]`), with the size + hint as a dim-gray
 * caption line below the bubble — matches the Claude Code "expand" pattern.
 */

import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { wrapVisible } from './text-utils';

const PLACEHOLDER_RE = /\[Pasted text #(\d+)([^\]]*)\]/g;

/** Render user message as a gray background block. */
export function renderUserMessage(text: string, termWidth: number): string[] {
    const innerW = Math.max(20, termWidth - 4);
    const dimGray = chalk.hex('#777');
    const out: string[] = [''];

    for (const raw of text.split('\n')) {
        // Collect any paste-info captions for this line BEFORE we mutate it
        // for the bubble — bubble shows `[Pasted text #N]`, the info text
        // goes underneath in dim gray.
        const captions: string[] = [];
        for (const m of raw.matchAll(PLACEHOLDER_RE)) {
            const info = (m[2] ?? '').trim();
            if (info) captions.push(info);
        }
        const bubbleLine = raw.replace(PLACEHOLDER_RE, '[Pasted text #$1]');

        for (const wrapped of wrapVisible(bubbleLine, innerW)) {
            const visLen = stripAnsi(wrapped).length;
            const padded = wrapped + ' '.repeat(Math.max(0, innerW - visLen));
            out.push('  ' + chalk.bgBlackBright.white(' ' + padded + ' '));
        }
        for (const caption of captions) {
            out.push('    ' + dimGray(caption));
        }
    }
    return out;
}