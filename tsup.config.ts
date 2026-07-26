import { defineConfig } from 'tsup';

/**
 * Three separate bundles, because they run in three different places:
 *
 *   cli      — the terminal entry point (ESM, Node)
 *   main     — the Electron main process (CJS: Electron's ESM support in the
 *              main process is still fussy across versions and packagers, and a
 *              desktop app that won't boot is a poor trade for module syntax)
 *   preload  — the renderer bridge (CJS with a .cjs extension, which is what
 *              Electron requires for a preload script in a type:module package)
 *
 * The renderer's HTML/CSS/JS are plain static files copied by
 * scripts/copy-renderer.mjs — no bundler involved, since they are already
 * dependency-free and run directly in Chromium.
 */
export default defineConfig([
  {
    name: 'cli',
    entry: ['src/cli.tsx'],
    outDir: 'dist',
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
    // @vscode/ripgrep ships a platform binary and must not be inlined.
    // (node:sqlite is handled in src/session/db.ts — see the comment there.)
    external: ['@vscode/ripgrep'],
    splitting: false,
    sourcemap: true,
    dts: false,
  },
  {
    name: 'electron-main',
    entry: { 'desktop/main': 'src/desktop/main.ts' },
    outDir: 'dist',
    format: ['cjs'],
    target: 'node22',
    platform: 'node',
    clean: false,
    external: ['electron', '@vscode/ripgrep'],
    // Same reason as preload: this package is type:module, so a CJS bundle must
    // carry the .cjs extension or Node will parse it as ESM and fail.
    outExtension: () => ({ js: '.cjs' }),
    splitting: false,
    sourcemap: true,
    dts: false,
  },
  {
    name: 'electron-preload',
    entry: { 'desktop/preload': 'src/desktop/preload.ts' },
    outDir: 'dist',
    format: ['cjs'],
    target: 'node22',
    platform: 'node',
    clean: false,
    external: ['electron'],
    // Electron resolves a preload script by extension, and in a type:module
    // package a bare .js would be treated as ESM and rejected.
    outExtension: () => ({ js: '.cjs' }),
    splitting: false,
    sourcemap: false,
    dts: false,
  },
]);
