import { mkdir, writeFile } from 'node:fs/promises';
import { createModel } from '../src/model.js';
import { exportGlb } from '../src/export.js';

const directory = new URL('../public/', import.meta.url);
await mkdir(directory, { recursive: true });
const binary = exportGlb(createModel());
await writeFile(new URL('wall-e.glb', directory), new Uint8Array(binary));
console.log(`Exported procedural WALL-E: ${binary.byteLength} bytes`);
