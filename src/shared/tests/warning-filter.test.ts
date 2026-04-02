import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// shouldIgnoreWarning is a pure function — import statically, no module state issues.
import { shouldIgnoreWarning } from '../src/utils/warning-filter';

// ---------------------------------------------------------------------------
// shouldIgnoreWarning (pure — no side effects)
// ---------------------------------------------------------------------------

describe('shouldIgnoreWarning', () => {
    it('suppresses MaxListenersExceededWarning', () => {
        expect(shouldIgnoreWarning({ name: 'MaxListenersExceededWarning' })).toBe(true);
    });

    it('passes through unrelated warnings', () => {
        expect(shouldIgnoreWarning({ name: 'DeprecationWarning' })).toBe(false);
        expect(shouldIgnoreWarning({ name: 'ExperimentalWarning' })).toBe(false);
        expect(shouldIgnoreWarning({})).toBe(false);
        expect(shouldIgnoreWarning({ code: 'DEP0001' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// installWarningFilter
//
// The `installed` flag is module-level state. Each test resets it via
// vi.resetModules() + a fresh dynamic import so tests are independent.
// ---------------------------------------------------------------------------

describe('installWarningFilter', () => {
    const originalEmitWarning = process.emitWarning;

    beforeEach(() => {
        vi.resetModules();
        process.emitWarning = originalEmitWarning;
    });

    afterEach(() => {
        process.emitWarning = originalEmitWarning;
    });

    it('patches process.emitWarning', async () => {
        const { installWarningFilter } = await import('../src/utils/warning-filter');
        installWarningFilter();
        expect(process.emitWarning).not.toBe(originalEmitWarning);
    });

    it('is idempotent — calling twice does not double-wrap', async () => {
        const { installWarningFilter } = await import('../src/utils/warning-filter');
        installWarningFilter();
        const afterFirst = process.emitWarning;
        installWarningFilter();
        expect(process.emitWarning).toBe(afterFirst);
    });

    it('suppresses MaxListenersExceededWarning', async () => {
        const spy = vi.fn();
        process.emitWarning = spy as typeof process.emitWarning;

        const { installWarningFilter } = await import('../src/utils/warning-filter');
        installWarningFilter(); // wraps our spy

        const err = new Error('11 listeners added');
        err.name = 'MaxListenersExceededWarning';
        process.emitWarning(err as never);

        expect(spy).not.toHaveBeenCalled();
    });

    it('forwards non-suppressed warnings to the original', async () => {
        const spy = vi.fn();
        process.emitWarning = spy as typeof process.emitWarning;

        const { installWarningFilter } = await import('../src/utils/warning-filter');
        installWarningFilter();

        process.emitWarning('Deprecated feature X', 'DeprecationWarning');

        expect(spy).toHaveBeenCalledOnce();
    });

    it('also suppresses MaxListeners warning emitted as a string message with name arg', async () => {
        const spy = vi.fn();
        process.emitWarning = spy as typeof process.emitWarning;

        const { installWarningFilter } = await import('../src/utils/warning-filter');
        installWarningFilter();

        process.emitWarning('11 exit listeners added', 'MaxListenersExceededWarning');

        expect(spy).not.toHaveBeenCalled();
    });
});
