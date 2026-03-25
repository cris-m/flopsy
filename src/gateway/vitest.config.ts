import { defineConfig } from 'vitest/config';
import path from 'node:path';

const src = path.resolve(__dirname, 'src');

export default defineConfig({
    resolve: {
        alias: {
            '@gateway': src,
            '@gateway/types': path.join(src, 'types/index.ts'),
            '@gateway/core': path.join(src, 'core'),
            '@gateway/channels': path.join(src, 'channels'),
            '@flopsy/shared': path.resolve(__dirname, '../shared/src'),
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
