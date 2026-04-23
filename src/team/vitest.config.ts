import { defineConfig } from 'vitest/config';
import path from 'node:path';

const flopsygraphSrc = path.resolve(__dirname, '../../flopsygraph/src');

export default defineConfig({
    // Mirror flopsygraph's internal path aliases so tests that import from
    // `flopsygraph` (public API) transitively resolve `@exporters/console`,
    // `@core/...`, etc. without a built dist step.
    resolve: {
        alias: {
            '@shared': path.resolve(__dirname, '../shared/src'),
            '@core': path.join(flopsygraphSrc, 'core'),
            '@llm': path.join(flopsygraphSrc, 'llm'),
            '@agent': path.join(flopsygraphSrc, 'agent'),
            '@graph': path.join(flopsygraphSrc, 'graph'),
            '@orchestration': path.join(flopsygraphSrc, 'orchestration'),
            '@exporters': path.join(flopsygraphSrc, 'exporters'),
            '@checkpoint': path.join(flopsygraphSrc, 'checkpoint'),
            '@memory': path.join(flopsygraphSrc, 'memory'),
            '@mcp': path.join(flopsygraphSrc, 'mcp'),
            '@embedding': path.join(flopsygraphSrc, 'embedding'),
            '@prebuilt': path.join(flopsygraphSrc, 'prebuilt'),
            '@utils': path.join(flopsygraphSrc, 'utils'),
            '@sandbox': path.join(flopsygraphSrc, 'sandbox'),
            '@a2a': path.join(flopsygraphSrc, 'a2a'),
            '@server': path.join(flopsygraphSrc, 'server'),
        },
    },
    test: {
        include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
        globals: true,
        testTimeout: 10_000,
        hookTimeout: 10_000,
        pool: 'forks',
    },
});
