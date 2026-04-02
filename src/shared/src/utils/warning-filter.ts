interface ProcessWarning {
    name?: string;
    message?: string;
    code?: string;
}

/**
 * Extract warning metadata from the polymorphic `process.emitWarning` arguments.
 *
 * Supported call signatures (mirrors Node.js docs):
 *   emitWarning(error: Error)
 *   emitWarning(message: string, type?: string, code?: string)
 *   emitWarning(message: string | Error, options?: { type?: string; code?: string })
 */
function normalizeWarning(args: unknown[]): ProcessWarning {
    const [first, second, third] = args;

    let name: string | undefined;
    let message: string | undefined;
    let code: string | undefined;

    if (first instanceof Error) {
        name = first.name;
        message = first.message;
        code = (first as Error & { code?: string }).code;
    } else if (typeof first === 'string') {
        message = first;
    }

    // Options-object overload: emitWarning(msg, { type, code })
    if (second && typeof second === 'object' && !Array.isArray(second)) {
        const opts = second as { type?: unknown; code?: unknown };
        if (typeof opts.type === 'string') name = opts.type;
        if (typeof opts.code === 'string') code = opts.code;
    } else {
        // Positional overload: emitWarning(msg, type, code)
        if (typeof second === 'string') name = second;
        if (typeof third === 'string') code = third;
    }

    return { name, message, code };
}

export function shouldIgnoreWarning(warning: ProcessWarning): boolean {
    // Multi-channel gateway: each SDK (grammy, discord.js, baileys, etc.) registers
    // its own process signal handlers. Exceeding the default limit of 10 is expected
    // and is not a memory leak.
    if (warning.name === 'MaxListenersExceededWarning') return true;

    return false;
}

let installed = false;

export function installWarningFilter(): void {
    if (installed) return;
    installed = true;

    const original = process.emitWarning.bind(process);

    process.emitWarning = ((...args: unknown[]) => {
        if (shouldIgnoreWarning(normalizeWarning(args))) return;
        return original(...(args as Parameters<typeof process.emitWarning>));
    }) as typeof process.emitWarning;
}
