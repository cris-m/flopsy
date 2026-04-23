import { describe, it, expect } from 'vitest';
import { parseCommand } from '../src/commands/parser';

describe('parseCommand / happy path', () => {
    it('parses a bare command', () => {
        expect(parseCommand('/status')).toEqual({
            name: 'status',
            args: [],
            rawArgs: '',
        });
    });

    it('parses command + args', () => {
        expect(parseCommand('/status foo bar')).toEqual({
            name: 'status',
            args: ['foo', 'bar'],
            rawArgs: 'foo bar',
        });
    });

    it('preserves internal whitespace in rawArgs', () => {
        expect(parseCommand('/search a  b   c')?.rawArgs).toBe('a  b   c');
    });

    it('lowercases the name', () => {
        expect(parseCommand('/STATUS')?.name).toBe('status');
        expect(parseCommand('/Help')?.name).toBe('help');
    });

    it('tolerates leading whitespace', () => {
        expect(parseCommand('   /status')?.name).toBe('status');
    });
});

describe('parseCommand / Telegram bot suffix', () => {
    it('strips @botname', () => {
        expect(parseCommand('/status@flopsybot')?.name).toBe('status');
    });

    it('strips @botname with args', () => {
        expect(parseCommand('/status@myBot foo')).toEqual({
            name: 'status',
            args: ['foo'],
            rawArgs: 'foo',
        });
    });

    it('bot suffix with numbers and underscores', () => {
        expect(parseCommand('/help@Flopsy_Bot_42')?.name).toBe('help');
    });
});

describe('parseCommand / rejected inputs', () => {
    it('returns null for non-command text', () => {
        expect(parseCommand('hello world')).toBeNull();
    });

    it('returns null when slash is not first', () => {
        expect(parseCommand('hi /status')).toBeNull();
    });

    it('returns null for bare slash', () => {
        expect(parseCommand('/')).toBeNull();
    });

    it('returns null for slash followed by whitespace', () => {
        expect(parseCommand('/ status')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(parseCommand('')).toBeNull();
    });

    it('returns null for names with special characters', () => {
        expect(parseCommand('/hello!')).toBeNull();
        expect(parseCommand('/foo.bar')).toBeNull();
    });

    it('allows hyphens and underscores in name', () => {
        expect(parseCommand('/stop_all')?.name).toBe('stop_all');
        expect(parseCommand('/kill-task')?.name).toBe('kill-task');
    });
});
