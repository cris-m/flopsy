/**
 * Personality resolution priority tests.
 *
 * The 4-deep priority chain (override → session → default → none) is the
 * core of how voice overlays get applied. Without these tests every change
 * to the chain risks regressing the override semantics that proactive fires
 * and `/personality` rely on.
 */

import { describe, it, expect } from 'vitest';
import {
    PersonalityRegistry,
    resolvePersonality,
    type Personality,
} from '../personalities';

function reg(...names: string[]): PersonalityRegistry {
    const items: Personality[] = names.map((n) => ({
        name: n,
        description: `${n} description`,
        body: `${n} body content`,
    }));
    return new PersonalityRegistry(items);
}

describe('PersonalityRegistry', () => {
    it('exposes registered names by lookup', () => {
        const r = reg('concise', 'playful');
        expect(r.size).toBe(2);
        expect(r.get('concise')?.body).toBe('concise body content');
        expect(r.has('playful')).toBe(true);
        expect(r.has('savage')).toBe(false);
        expect(r.get('savage')).toBeNull();
    });

    it('lists alphabetically', () => {
        const r = reg('savage', 'concise', 'playful');
        const names = r.list().map((p) => p.name);
        expect(names).toEqual(['concise', 'playful', 'savage']);
    });
});

describe('resolvePersonality — priority chain', () => {
    const registry = reg('concise', 'playful', 'savage');

    it('override beats session beats default beats none', () => {
        const out = resolvePersonality({
            role: 'main',
            registry,
            overrideName: 'concise',
            sessionPersonality: 'playful',
            defaultPersonality: 'savage',
        });
        expect(out?.name).toBe('concise');
    });

    it('session wins when no override is provided', () => {
        const out = resolvePersonality({
            role: 'main',
            registry,
            sessionPersonality: 'playful',
            defaultPersonality: 'savage',
        });
        expect(out?.name).toBe('playful');
    });

    it('default applies when override and session are absent', () => {
        const out = resolvePersonality({
            role: 'main',
            registry,
            defaultPersonality: 'savage',
        });
        expect(out?.name).toBe('savage');
    });

    it('returns null when nothing is configured', () => {
        const out = resolvePersonality({
            role: 'main',
            registry,
        });
        expect(out).toBeNull();
    });

    it('null sessionPersonality is treated the same as absent', () => {
        const out = resolvePersonality({
            role: 'main',
            registry,
            sessionPersonality: null,
            defaultPersonality: 'concise',
        });
        expect(out?.name).toBe('concise');
    });
});

describe('resolvePersonality — fallthrough on unknown names', () => {
    const registry = reg('concise', 'playful');

    it('unknown override name falls through to session', () => {
        const out = resolvePersonality({
            role: 'main',
            registry,
            overrideName: 'doesnotexist',
            sessionPersonality: 'playful',
        });
        expect(out?.name).toBe('playful');
    });

    it('unknown session name falls through to default', () => {
        const out = resolvePersonality({
            role: 'main',
            registry,
            sessionPersonality: 'wrongname',
            defaultPersonality: 'concise',
        });
        expect(out?.name).toBe('concise');
    });

    it('unknown default returns null (no further fallback)', () => {
        const out = resolvePersonality({
            role: 'main',
            registry,
            defaultPersonality: 'nope',
        });
        expect(out).toBeNull();
    });
});

describe('resolvePersonality — worker bypass', () => {
    const registry = reg('concise', 'playful');

    it('workers always return null even with override + session + default set', () => {
        const out = resolvePersonality({
            role: 'worker',
            registry,
            overrideName: 'concise',
            sessionPersonality: 'playful',
            defaultPersonality: 'concise',
        });
        expect(out).toBeNull();
    });
});

describe('resolvePersonality — registry edge cases', () => {
    it('returns null when registry is undefined', () => {
        const out = resolvePersonality({
            role: 'main',
            overrideName: 'concise',
        });
        expect(out).toBeNull();
    });

    it('returns null when registry is empty', () => {
        const out = resolvePersonality({
            role: 'main',
            registry: new PersonalityRegistry([]),
            overrideName: 'concise',
        });
        expect(out).toBeNull();
    });

    it('empty-string override is ignored, falls through', () => {
        const registry = reg('concise');
        const out = resolvePersonality({
            role: 'main',
            registry,
            overrideName: '',
            defaultPersonality: 'concise',
        });
        expect(out?.name).toBe('concise');
    });
});
