import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { numberLooseOptional, stringArrayLooseOptional } from '../schema-coerce';

describe('numberLooseOptional', () => {
    const schema = numberLooseOptional().pipe(z.number().int().positive().optional());

    it('passes a real number through', () => {
        expect(schema.parse(600000)).toBe(600000);
    });

    it('coerces a numeric string', () => {
        expect(schema.parse('600000')).toBe(600000);
    });

    it('trims whitespace before coercing', () => {
        expect(schema.parse('  600000 ')).toBe(600000);
    });

    it('passes undefined through', () => {
        expect(schema.parse(undefined)).toBeUndefined();
    });

    it('rejects empty string (optional value should be omitted, not "")', () => {
        expect(() => schema.parse('')).toThrow();
    });

    it('still rejects non-numeric strings', () => {
        expect(() => schema.parse('not a number')).toThrow();
    });

    it('still enforces inner constraints (positive)', () => {
        expect(() => schema.parse('-5')).toThrow();
    });
});

describe('stringArrayLooseOptional', () => {
    const schema = stringArrayLooseOptional();

    it('passes a real array through', () => {
        expect(schema.parse(['web_search', 'web_extract'])).toEqual(['web_search', 'web_extract']);
    });

    it('wraps a bare string in an array', () => {
        expect(schema.parse('web_search')).toEqual(['web_search']);
    });

    it('parses a JSON-array string', () => {
        expect(schema.parse('["web_search", "web_extract"]')).toEqual(['web_search', 'web_extract']);
    });

    it('splits a CSV string', () => {
        expect(schema.parse('web_search, web_extract, http_request')).toEqual([
            'web_search',
            'web_extract',
            'http_request',
        ]);
    });

    it('trims whitespace inside CSV entries', () => {
        expect(schema.parse('  a , b  ,   c  ')).toEqual(['a', 'b', 'c']);
    });

    it('drops empty CSV entries', () => {
        expect(schema.parse('a,,b,')).toEqual(['a', 'b']);
    });

    it('passes undefined through', () => {
        expect(schema.parse(undefined)).toBeUndefined();
    });

    it('treats empty string as empty array', () => {
        expect(schema.parse('')).toEqual([]);
    });

    it('falls back to bare-string wrap when JSON.parse fails', () => {
        expect(schema.parse('[broken')).toEqual(['[broken']);
    });
});
