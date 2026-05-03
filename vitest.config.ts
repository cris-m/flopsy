/**
 * Root Vitest configuration for the FlopsyBot test suite.
 *
 * All flopsybot tests live under `/test/` mirroring the `/src/` layout. This
 * config is the single source of truth — workspace-level vitest configs
 * inside src/team, src/gateway, src/shared remain for any tests still living
 * inside their package, but the canonical home for new tests is `/test/`.
 *
 * flopsygraph is a separate package with its own `tests/` directory and is
 * NOT included here. Run those with `cd flopsygraph && npm test`.
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

const root = __dirname;
const flopsygraphSrc = path.resolve(root, 'flopsygraph/src');

export default defineConfig({
    resolve: {
        alias: {
            '@flopsy/team':    path.resolve(root, 'src/team/src'),
            '@flopsy/gateway': path.resolve(root, 'src/gateway/src'),
            '@flopsy/shared':  path.resolve(root, 'src/shared/src'),
            '@flopsy/cli':     path.resolve(root, 'src/cli/src'),
            // Internal package aliases used by source files (mirror tsconfig.base.json).
            '@gateway':        path.resolve(root, 'src/gateway/src'),
            '@shared':         path.resolve(root, 'src/shared/src'),
            '@core':           path.join(flopsygraphSrc, 'core'),
            '@llm':            path.join(flopsygraphSrc, 'llm'),
            '@agent':          path.join(flopsygraphSrc, 'agent'),
            '@graph':          path.join(flopsygraphSrc, 'graph'),
            '@orchestration':  path.join(flopsygraphSrc, 'orchestration'),
            '@exporters':      path.join(flopsygraphSrc, 'exporters'),
            '@checkpoint':     path.join(flopsygraphSrc, 'checkpoint'),
            '@memory':         path.join(flopsygraphSrc, 'memory'),
            '@mcp':            path.join(flopsygraphSrc, 'mcp'),
            '@embedding':      path.join(flopsygraphSrc, 'embedding'),
            '@prebuilt':       path.join(flopsygraphSrc, 'prebuilt'),
            '@utils':          path.join(flopsygraphSrc, 'utils'),
            '@sandbox':        path.join(flopsygraphSrc, 'sandbox'),
            '@a2a':            path.join(flopsygraphSrc, 'a2a'),
            '@server':         path.join(flopsygraphSrc, 'server'),
        },
    },
    test: {
        include: ['test/**/*.test.ts'],
        globals: true,
        testTimeout: 10_000,
        pool: 'forks',
    },
});
