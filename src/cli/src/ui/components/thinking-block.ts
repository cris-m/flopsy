/**
 * Thinking block rendering.
 *
 * Accumulates raw thinking text and re-wraps the entire block in-place
 * on every chunk so streaming tokens flow as a paragraph.
 */

import chalk from 'chalk';
import { palette } from '../theme';
import { wrapVisible } from './text-utils';
import { renderInline } from './markdown-renderer';

/**
 * Build the thinking block lines for a given raw text buffer.
 * Returns lines to be spliced into the chat log at thinkStartIndex.
 * If `visible` is false, returns empty — thinking is hidden.
 */
export function buildThinkingLines(
    thinkBuf: string,
    termWidth: number,
    visible: boolean,
): string[] {
    if (!visible) return [];

    const dim = chalk.hex(palette.muted);
    const wrapWidth = Math.max(40, termWidth - 6);
    const newLines: string[] = [];
    const paragraphs = thinkBuf.split('\n');

    paragraphs.forEach((para, pi) => {
        if (!para.trim()) {
            if (pi !== 0) newLines.push('');
            return;
        }
        const styledPara = renderInline(para);
        const wrapped = wrapVisible(styledPara, wrapWidth);
        wrapped.forEach((seg, si) => {
            const isFirst = (pi === 0 && si === 0);
            const prefix = isFirst ? `  ${dim.italic('✻ ')}` : `    `;
            newLines.push(prefix + dim.italic(seg));
        });
    });

    return newLines;
}