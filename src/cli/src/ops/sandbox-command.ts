/**
 * `flopsy sandbox` — manage the multi-language sandbox image.
 *
 * The daemon auto-builds the image on first boot when `sandbox.backend`
 * is docker/kubernetes (see src/team/src/bootstrap.ts). This CLI is the
 * escape hatch for explicit rebuilds — after pulling a new Dockerfile,
 * after changing a base image, or when the auto-build failed and the
 * operator wants a clean retry.
 *
 *   flopsy sandbox status         → show whether the image exists locally
 *   flopsy sandbox path           → print the bundled Dockerfile dir
 *   flopsy sandbox build          → build now (streams docker build output)
 *   flopsy sandbox build --force  → rebuild even if the image already exists
 */

import { Command } from 'commander';
import { ensureMultiLanguageImage, BUNDLED_DOCKERFILE_DIR } from 'flopsygraph';
import { bad, detail, ok, section } from '../ui/pretty';

export function registerSandboxCommand(root: Command): void {
    const sb = root
        .command('sandbox')
        .description('Manage the flopsy-sandbox container image (multi-language)');

    sb.command('status', { isDefault: true })
        .description('Show whether flopsy-sandbox:latest exists locally')
        .option('--image <name>', 'Image name to check', 'flopsy-sandbox:latest')
        .action(async (opts: { image: string }) => {
            // Probe via dockerode directly. ensureMultiLanguageImage would
            // try to build on miss, which is wrong for a status check.
            let Dockerode: { default: new () => unknown };
            try {
                Dockerode = await import('dockerode');
            } catch {
                console.log(bad('dockerode not installed (npm install dockerode)'));
                process.exit(1);
            }
            type Daemon = { getImage: (n: string) => { inspect: () => Promise<unknown> } };
            const daemon = new (Dockerode.default as unknown as new () => Daemon)();
            try {
                await daemon.getImage(opts.image).inspect();
                console.log(ok(`${opts.image}: present locally.`));
            } catch {
                console.log(section(`${opts.image}: not present`));
                console.log(detail('build it', 'flopsy sandbox build'));
            }
        });

    sb.command('path')
        .description('Print the path to the bundled Dockerfile context')
        .action(() => {
            console.log(BUNDLED_DOCKERFILE_DIR);
        });

    sb.command('build')
        .description('Build flopsy-sandbox:latest from the bundled Dockerfile')
        .option('--image <name>', 'Tag for the built image', 'flopsy-sandbox:latest')
        .option('--force', 'Rebuild even if the image already exists', false)
        .option('--quiet', 'Suppress build output (only final status)', false)
        .action(async (opts: { image: string; force: boolean; quiet: boolean }) => {
            // For --force we need to pull the existing image out of the way
            // first, otherwise ensureMultiLanguageImage short-circuits at the
            // probe step. Use docker rmi via child_process.
            if (opts.force) {
                const { spawn } = await import('node:child_process');
                await new Promise<void>((resolve) => {
                    const proc = spawn('docker', ['rmi', '-f', opts.image], {
                        stdio: opts.quiet ? 'ignore' : 'inherit',
                    });
                    proc.on('close', () => resolve());
                    proc.on('error', () => resolve());
                });
            }

            const stream = (line: string): void => {
                if (!opts.quiet) console.log(line);
            };

            console.log(section(`building ${opts.image}`));
            const start = Date.now();
            const result = await ensureMultiLanguageImage({
                image: opts.image,
                onLog: stream,
                onStatus: (status) => {
                    if (status === 'present') {
                        console.log(ok('image already present (use --force to rebuild)'));
                    }
                },
            });

            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            if (result.ready) {
                if (result.builtNow) {
                    console.log(ok(`built ${opts.image} in ${elapsed}s`));
                } else {
                    // already-present case: nothing more to say
                }
            } else {
                console.log(bad(`build failed after ${elapsed}s: ${result.error ?? 'unknown error'}`));
                process.exit(1);
            }
        });
}
