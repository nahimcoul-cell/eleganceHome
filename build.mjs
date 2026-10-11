import { cp, mkdir, rm, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(projectRoot, 'dist');
if (dirname(outputDirectory) !== projectRoot) {
  throw new Error('Refusing to build outside the project dist directory.');
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const file of [
  'index.html',
  'admin.html',
  'admin.js',
  'confidentialite.html',
  'animations.css',
  'animations.js',
  'public-api.js',
  'service-worker.js'
]) {
  await copyFile(resolve(projectRoot, file), resolve(outputDirectory, file));
}
await cp(resolve(projectRoot, 'images'), resolve(outputDirectory, 'images'), { recursive: true });
