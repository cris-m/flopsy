/**
 * FlopsyBot terminal theme — one place to change the colour palette.
 *
 * Semantic names (instead of "blue1/blue2"), explicit hex values for
 * predictability across dark and light terminals, and a single module
 * all UI helpers import from.
 *
 * Usage:
 *   import { palette, tint } from './theme';
 *   console.log(tint.brand('FlopsyBot'));
 *   console.log(chalk.hex(palette.channel)('● Channels'));
 */

import chalk from 'chalk';

/**
 * Semantic colour tokens (hex). Hex keeps colours stable across the 8/16
 * basic ANSI palette variants different terminals ship with.
 */
export const palette = {
    /** Brand purple — banners, primary headers, active accents. */
    brand: '#9B59B6',
    /** Calm blue — channel / transport sections. */
    channel: '#3498DB',
    /** Amber — auth, credentials, anything approval-gated. */
    auth: '#F1C40F',
    /** Green — success / MCP / healthy. */
    success: '#2ECC71',
    /** Red — agents / team / destructive / errors. */
    team: '#E74C3C',
    /** Teal — proactive / scheduler / cron / heartbeats. */
    proactive: '#1ABC9C',
    /** Orange — webhook / inbound / external. */
    webhook: '#E67E22',
    /** Warning yellow — non-fatal caution. */
    warn: '#F39C12',
    /** Low-chroma gray for dim text / separator lines. */
    muted: '#7F8C8D',
} as const;

export type PaletteKey = keyof typeof palette;

/**
 * Pre-built chalk functions for each token. Lets callers skip the
 * `chalk.hex('#...')` dance.
 */
export const tint = {
    brand: chalk.hex(palette.brand),
    channel: chalk.hex(palette.channel),
    auth: chalk.hex(palette.auth),
    success: chalk.hex(palette.success),
    team: chalk.hex(palette.team),
    proactive: chalk.hex(palette.proactive),
    webhook: chalk.hex(palette.webhook),
    warn: chalk.hex(palette.warn),
    muted: chalk.hex(palette.muted),
} as const;

/**
 * Map known status-command section names to their palette token.
 * Centralising here means `section('Team')` auto-picks the right tint
 * instead of every call site passing the hex.
 */
export const sectionPalette: Readonly<Record<string, PaletteKey>> = {
    Gateway: 'brand',
    Channels: 'channel',
    Auth: 'auth',
    MCP: 'success',
    Team: 'team',
    Memory: 'brand',
    Proactive: 'proactive',
    Webhook: 'webhook',
    General: 'brand',
};
