/**
 * Copy the renderer's static files into dist/.
 *
 * The renderer is deliberately un-bundled: plain HTML, CSS and one dependency-
 * free JS file that Chromium runs directly. Nothing about it needs a build
 * step, and skipping one keeps the app's UI editable without a toolchain.
 */

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'desktop', 'renderer');
const to = join(root, 'dist', 'desktop', 'renderer');

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

process.stdout.write(`renderer -> ${to}\n`);
