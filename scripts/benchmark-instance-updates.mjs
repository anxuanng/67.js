import { mat3 } from 'gl-matrix';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { Renderer67, groupParts } from '../src/renderer.js';
import { createWallEPreviewScene } from '../src/wall-e-preview-scene.js';
setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
const { parts } = createWallEPreviewScene();
const renderer = Object.create(Renderer67.prototype);
renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData() {} };
renderer.partLocations = new Map();
renderer.updateBatches = new Set();
renderer.batches = groupParts(parts).map(group => {
  const batch = { instanceData: new Float32Array(group.length * 41) };
  group.forEach((part, index) => renderer.partLocations.set(part, {
    batch, index, geometry: part.geometry, map: part.material.map ?? null, normalMatrix: mat3.create(),
    mapState: ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']
      .map(field => part.material[field] ?? null).concat(part.material.normalScale ?? [1, 1], part.material.occlusionStrength ?? 1),
  }));
  return batch;
});
for (let index = 0; index < 100; index++) renderer.updateParts(parts);
let normalAllocations = 0;
const create = mat3.create;
mat3.create = () => { normalAllocations++; return create(); };
const samples = [];
try {
  for (let trial = 0; trial < 5; trial++) {
    const start = performance.now();
    for (let frame = 0; frame < 500; frame++) renderer.updateParts(parts);
    samples.push((performance.now() - start) / 500);
  }
} finally {
  mat3.create = create;
}
samples.sort((a, b) => a - b);
const result = {
  parts: parts.length, frames: 2500, medianUpdateMs: samples[2], samplesMs: samples, normalAllocations,
  scope: 'CPU validation and instance packing; mock GPU upload, not GPU frame time',
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/instance-update-benchmark.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
