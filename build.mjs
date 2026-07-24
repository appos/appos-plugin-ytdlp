/**
 * Build script for yt-dlp plugin.
 * Bundles TypeScript source into a single IIFE for the AppOS JSCore runtime.
 * 
 * Usage:
 *   node build.mjs          # One-shot build
 *   node build.mjs --watch  # Watch mode (rebuild on save)
 */
import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: ['src/main.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: 'dist/main.js',
    sourcemap: true,
    logLevel: 'info',
};

if (isWatch) {
    const ctx = await context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
} else {
    await build(buildOptions);
}
