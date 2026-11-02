// Speed baseline for the polygon mesh core in addons/mesh.
// Usage: node scripts/benchmark-mesh-core.mjs [gridSide=1000] [runs=5]
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, cpus, setPriority } from 'node:os';
import { sphere } from '../src/geometry.js';
import { recomputeNormals } from '../src/geometry-normals.js';
import {
  createMeshData, editMesh, meshData, cornerNormals, extractRender, lintMesh, meshFromGeometry, validateTopology,
} from '../src/mesh.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const side = Number(process.argv[2] ?? 1000);
const runs = Number(process.argv[3] ?? 5);

function quadGrid(columns, rows) {
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const offset = (row * (columns + 1) + column) * 3;
      positions[offset] = column / columns;
      positions[offset + 1] = Math.sin(column * 0.05) * Math.cos(row * 0.05) * 0.02;
      positions[offset + 2] = -row / rows;
    }
  }
  const faceOffsets = new Uint32Array(columns * rows + 1);
  const cornerVertices = new Uint32Array(columns * rows * 4);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const face = row * columns + column;
      const first = row * (columns + 1) + column;
      faceOffsets[face + 1] = (face + 1) * 4;
      cornerVertices[face * 4] = first;
      cornerVertices[face * 4 + 1] = first + 1;
      cornerVertices[face * 4 + 2] = first + columns + 2;
      cornerVertices[face * 4 + 3] = first + columns + 1;
    }
  }
  return { positions, faceOffsets, cornerVertices };
}

function measure(label, run) {
  const samples = [];
  let result;
  for (let index = 0; index < runs + 1; index++) {
    const started = performance.now();
    result = run();
    const elapsed = performance.now() - started;
    if (index > 0) samples.push(elapsed);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`${label.padEnd(44)} ${median.toFixed(1).padStart(9)} ms`);
  return { label, medianMs: Number(median.toFixed(2)), samplesMs: samples.map(value => Number(value.toFixed(2))), result };
}

const input = quadGrid(side, side);
const results = [];
const created = measure(`createMeshData ${side}x${side} quads`, () => createMeshData(input));
results.push(created);
const mesh = created.result;
const edited = measure('editMesh (MeshData -> EditMesh)', () => editMesh(mesh));
results.push(edited);
results.push(measure('meshData (EditMesh -> MeshData)', () => meshData(edited.result)));
results.push(measure('round trip editMesh + meshData', () => meshData(editMesh(mesh))));
results.push(measure('validateTopology', () => validateTopology(edited.result)));
results.push(measure('cornerNormals (sharpAngle 30 degrees)', () => cornerNormals(mesh, { sharpAngle: Math.PI / 6 })));
const extracted = measure('extractRender', () => extractRender(mesh));
results.push(extracted);
results.push(measure('lintMesh', () => lintMesh(mesh)));

const triangles = sphere(1000, 500);
results.push(measure('meshFromGeometry sphere 1000x500 (~1M tris)', () => meshFromGeometry(triangles)));
results.push(measure('baseline recomputeNormals sphere 1000x500', () => recomputeNormals(triangles, triangles.positions)));

const editCore = edited.result;
let editBytes = 0;
for (const store of [editCore.vertices, editCore.edges, editCore.loops, editCore.faces]) {
  for (const array of Object.values(store.arrays)) editBytes += array.byteLength;
  editBytes += store.removed.byteLength;
}
const report = {
  date: new Date().toISOString(),
  node: process.version,
  cpu: cpus()[0]?.model,
  threads: 1,
  priority: 'below normal',
  grid: { side, faces: mesh.faceCount, vertices: mesh.vertexCount, edges: mesh.edgeCount },
  editMeshBytesPerFace: Number((editBytes / mesh.faceCount).toFixed(1)),
  results: results.map(({ label, medianMs, samplesMs }) => ({ label, medianMs, samplesMs })),
};
console.log(`EditMesh memory: ${report.editMeshBytesPerFace} bytes per face (capacity, without attributes)`);
await mkdir('artifacts', { recursive: true });
await writeFile(`artifacts/mesh-core-benchmark-${side}.json`, JSON.stringify(report, null, 2));
