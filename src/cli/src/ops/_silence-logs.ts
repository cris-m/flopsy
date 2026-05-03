/**
 * Side-effect-only: lower the default log level for one-shot CLI runs.
 *
 * Library modules (`@flopsy/team`'s LearningStore / PairingStore, etc.)
 * call `createLogger()` at *module-top-level*. ESM hoists every import
 * before any top-level code runs, so by the time `bootstrapCli()`
 * executes, those loggers are already built with the old level. To
 * influence them we must mutate `process.env.LOG_LEVEL` *before* any
 * `@flopsy/*` module imports — which means a side-effect module that
 * `index.ts` imports first, before everything else.
 *
 * Users can still opt into verbosity: `LOG_LEVEL=info flopsy ...` or
 * `LOG_DEBUG=true`.
 */
if (!process.env['LOG_LEVEL'] && process.env['LOG_DEBUG'] !== 'true') {
    process.env['LOG_LEVEL'] = 'warn';
}
