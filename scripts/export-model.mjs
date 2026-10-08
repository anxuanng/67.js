import { mkdir, writeFile } from 'node:fs/promises';
import { createModel } from '../src/model.js';
import { exportGlb } from '../src/export.js';

const directory = new URL('../public/', import.meta.url);
await mkdir(directory, { recursive: true });
const binary = exportGlb(createModel());
await writeFile(new URL('specimen.glb', directory), new Uint8Array(binary));
console.log(`Exported original model: ${binary.byteLength} bytes`);
