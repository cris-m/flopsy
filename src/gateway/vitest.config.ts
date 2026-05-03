import { defineConfig } from 'vitest/config';
import path from 'node:path';

const src = path.resolve(__dirname, 'src');
const fg = path.resolve(__dirname, '../../flopsygraph/src');

export default defineConfig({
    resolve: {
        alias: {
            '@gateway': src,
            '@gateway/types': path.join(src, 'types/index.ts'),
            '@gateway/core': path.join(src, 'core'),
            '@gateway/channels': path.join(src, 'channels'),
            '@flopsy/shared': path.resolve(__dirname, '../shared/src'),
            '@shared': path.resolve(__dirname, '../shared/src/index.ts'),
            '@shared/types': path.resolve(__dirname, '../shared/src/types/index.ts'),
            // flopsygraph internal aliases — required when executor imports
            // `structuredLLM` from flopsygraph (which then transitively
            // loads its own `@graph/*` / `@llm/*` modules).
            '@core': path.join(fg, 'core'),
            '@llm': path.join(fg, 'llm'),
            '@agent': path.join(fg, 'agent'),
            '@graph': path.join(fg, 'graph'),
            '@orchestration': path.join(fg, 'orchestration'),
            '@exporters': path.join(fg, 'exporters'),
            '@checkpoint': path.join(fg, 'checkpoint'),
            '@memory': path.join(fg, 'memory'),
            '@mcp': path.join(fg, 'mcp'),
            '@embedding': path.join(fg, 'embedding'),
            '@prebuilt': path.join(fg, 'prebuilt'),
            '@utils': path.join(fg, 'utils'),
            '@sandbox': path.join(fg, 'sandbox'),
        },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        globals: true,
        testTimeout: 10_000,
        hookTimeout: 10_000,
        pool: 'forks',
    },
});
