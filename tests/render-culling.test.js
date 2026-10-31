import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box, sphere } from '../src/geometry.js';
import { generateGeometryLods } from '../src/mesh-lod.js';
import { Renderer67 } from '../src/renderer.js';
import { InstanceSelection, chooseLevel, extractFrustumPlanes, geometryBoundingSphere, selectInstances } from '../src/render-culling.js';

const STRIDE = 41;
const CANVAS_HEIGHT = 540;

function cameraMatrices(eye = [0, 0, 10], target = [0, 0, 0]) {
  const projection = mat4.perspective(mat4.create(), Math.PI / 4, 16 / 9, 0.5, 100);
  const view = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
  const viewProjection = mat4.multiply(mat4.create(), projection, view);
  return { projection, viewProjection, planes: extractFrustumPlanes(viewProjection, new Float32Array(24)) };
}

function instanceData(positions, scale = 1) {
  const data = new Float32Array(positions.length * STRIDE);
  positions.forEach(([x, y, z], index) => {
    data.set([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1], index * STRIDE);
  });
  return data;
}

function selectionFor(positions, { levelErrors = [0], bounds = { center: [0, 0, 0], radius: 1 }, eye, scale } = {}) {
  const { projection, viewProjection, planes } = cameraMatrices(eye);
  const selection = new InstanceSelection(positions.length, levelErrors.length);
  return selectInstances(selection, {
    instanceData: instanceData(positions, scale), instanceCount: positions.length, stride: STRIDE, bounds, levelErrors, planes, viewProjection,
    pixelsPerUnit: CANVAS_HEIGHT / 2 * projection[5],
  });
}

test('a bounding sphere is centred on the box of the vertices and reaches the farthest one', () => {
  const unitBox = box(0, 1);
  const bounds = geometryBoundingSphere(unitBox);
  assert.deepEqual([...bounds.center], [0, 0, 0]);
  assert.ok(Math.abs(bounds.radius - Math.hypot(...unitBox.positions.subarray(0, 3))) < 1e-6);
  assert.equal(geometryBoundingSphere(unitBox), bounds);
});

test('instances behind, beside and beyond the camera are culled and the rest stay in order', () => {
  const selection = selectionFor([[0, 0, 0], [500, 0, 0], [0, 0, 50], [0, 0, -200], [2, 1, 0]]);
  assert.deepEqual([...selection.indices[0].subarray(0, selection.counts[0])], [0, 4]);
  assert.equal(selection.visibleCount, 2);
});

test('a sphere that only touches the frustum edge is kept, and scale grows its reach', () => {
  const nearEdge = [[9.5, 0, 0]];
  assert.equal(selectionFor(nearEdge).visibleCount, 0);
  assert.equal(selectionFor(nearEdge, { scale: 4 }).visibleCount, 1);
});

test('an instance that is everywhere in view reports that the full buffer can be used', () => {
  assert.equal(selectionFor([[0, 0, 0], [1, 0, 0]]).isEverything, true);
  assert.equal(selectionFor([[0, 0, 0], [500, 0, 0]]).isEverything, false);
});

test('a level is chosen by the pixels of error it would show, coarsest first allowed', () => {
  const errors = [0, 0.01, 0.1];
  assert.equal(chooseLevel(errors, 1, 100, 1), 1);
  assert.equal(chooseLevel(errors, 1, 5, 1), 2);
  assert.equal(chooseLevel(errors, 1, 1000, 1), 0);
  assert.equal(chooseLevel([0], 1, 1, 1), 0);
});

test('farther copies of one model use coarser levels, and each copy lands in exactly one level', () => {
  const levelErrors = [0, 0.02, 0.1];
  const selection = selectionFor([[0, 0, 4], [0, 0, -30], [0, 0, -90]], { levelErrors, eye: [0, 0, 10] });
  assert.equal(selection.visibleCount, 3);
  assert.equal(selection.counts.reduce((total, count) => total + count, 0), 3);
  assert.deepEqual([...selection.counts], [1, 1, 1]);
});

test('selection depends only on its inputs, so any frame picks the same instances', () => {
  const positions = Array.from({ length: 200 }, (unused, index) => [(index % 20 - 10) * 3, 0, -Math.floor(index / 20) * 9]);
  const levelErrors = [0, 0.02, 0.2];
  const first = selectionFor(positions, { levelErrors });
  selectionFor(positions.slice(0, 7), { levelErrors, eye: [30, 3, 40] });
  const second = selectionFor(positions, { levelErrors });
  assert.deepEqual([...second.counts], [...first.counts]);
  first.indices.forEach((indices, level) => assert.deepEqual([...second.indices[level]], [...indices]));
});

function drawingRenderer(parts) {
  const calls = [];
  const renderer = Object.create(Renderer67.prototype);
  renderer.buffers = [];
  renderer.geometryBuffers = new Map();
  renderer.culling = true;
  renderer.lodPixelError = 1;
  renderer.canvas = { height: CANVAS_HEIGHT };
  const noop = () => {};
  renderer.context = {
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, DYNAMIC_DRAW: 3, STATIC_DRAW: 4, FLOAT: 5, TRIANGLES: 6, UNSIGNED_INT: 7,
    createBuffer: () => ({}), createVertexArray: () => ({}), bindBuffer: noop, bindVertexArray: noop, bufferData: noop,
    enableVertexAttribArray: noop, disableVertexAttribArray: noop, vertexAttribPointer: noop, vertexAttribDivisor: noop,
    vertexAttrib2f: noop, vertexAttrib3f: noop,
    bufferSubData: (target, offset, data, start, length) => calls.push({ upload: length / STRIDE }),
    drawElementsInstanced: (mode, count, type, offset, instances) => calls.push({ indices: count, instances }),
  };
  renderer.createTexture = () => null;
  renderer.partLocations = new Map();
  renderer.uploadBuffer = (target, data) => {
    renderer.buffers.push({});
    return {};
  };
  const batch = renderer.uploadBatchData(parts, {});
  return { renderer, batch, calls };
}

function rigidPart(name, geometry, position, extra = {}) {
  const matrix = mat4.fromTranslation(mat4.create(), position);
  return { name, geometry, matrix, material: { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 }, ...extra };
}

test('the renderer draws only the visible instances, each level from its own geometry', () => {
  const geometry = sphere(24, 12);
  const lods = generateGeometryLods(geometry, { ratios: [0.25] });
  const positions = [[0, 0, 4], [0, 0, -80], [900, 0, 0]];
  const parts = positions.map((position, index) => rigidPart(`p${index}`, geometry, position, { lods }));
  const { renderer, batch, calls } = drawingRenderer(parts);
  const { viewProjection, projection, planes } = cameraMatrices([0, 0, 10]);
  renderer.viewProjection = viewProjection;
  renderer.projection = projection;
  renderer.frustumPlanes = planes;
  const selection = renderer.selectBatchInstances(batch);
  assert.equal(selection.visibleCount, 2);
  renderer.drawSelectedLevels(batch, selection);
  const draws = calls.filter(call => call.instances);
  assert.deepEqual(draws.map(call => call.instances), [1, 1]);
  assert.equal(draws[0].indices, geometry.indices.length);
  assert.equal(draws[1].indices, lods[1].geometry.indices.length);
  assert.ok(lods[1].geometry.indices.length < geometry.indices.length);
});

test('culling is off for deforming, skinned and alpha-blended batches, and lods are refused there', () => {
  const geometry = box(0, 1);
  const lods = [{ geometry, error: 0 }, { geometry: box(0, 1), error: 0.1 }];
  const { renderer, batch } = drawingRenderer([rigidPart('tree', geometry, [0, 0, 0])]);
  assert.equal(batch.cullable, true);
  const swaying = rigidPart('grass', geometry, [0, 0, 0]);
  swaying.material.tag = 'grass';
  assert.equal(renderer.createCullingState([swaying]).cullable, false);
  assert.throws(() => renderer.createCullingState([{ ...swaying, lods }]), /lods need rigid, opaque parts/);
  const glass = rigidPart('glass', geometry, [0, 0, 0]);
  glass.material.alphaMode = 'blend';
  glass.material.opacity = 0.5;
  assert.equal(renderer.createCullingState([glass]).cullable, false);
  assert.throws(() => renderer.createCullingState([rigidPart('bad', geometry, [0, 0, 0], { lods: [lods[1], lods[0]] })]), /lods must list level 0/);
});
