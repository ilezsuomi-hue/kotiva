import { cpSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * build.mjs — tiny zero-dependency static build.
 * Copies the runtime files into dist/ so the site can be served or zipped
 * without tests, node_modules or tooling. Browser loads three.js from CDN.
 */

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

const RUNTIME_FILES = [
    'index.html',
    'style.css',
    'app.js',
    'robot.js',
    'stage.js',
    'booking.js',
    'sound.js'
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

for (const file of RUNTIME_FILES) {
    const src = join(root, file);
    if (!existsSync(src)) {
        console.error(`BUILD FAILED: missing ${file}`);
        process.exit(1);
    }
    cpSync(src, join(dist, file));
    console.log(`  built ${file} (${statSync(src).size} bytes)`);
}

console.log(`BUILD OK -> dist/ (${RUNTIME_FILES.length} files)`);
console.log('Serve the build: KOTIVA_PUBLIC_DIR=dist npm start');
