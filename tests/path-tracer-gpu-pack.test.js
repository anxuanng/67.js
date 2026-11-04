import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTraceScene } from '../src/path-tracer-scene.js';
import { packAtlas, packLights, packMaterials, packNodes, packSubsurface, packTriangles, sceneUsesSubsurface } from '../src/path-tracer-gpu-pack.js';
import { buildFragmentSource, FRAGMENT_SOURCE, LIGHT_TEXELS, MATERIAL_TEXELS, TRIANGLE_TEXELS } from '../src/path-tracer-gpu-shader.js';
import { SUBSURFACE_TEXELS } from '../src/path-tracer-gpu-subsurface.js';

function quad(offset) {
  return {
    positions: new Float32Array([-1, offset, 1, 1, offset, 1, 1, offset, -1, -1, offset, -1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

const texture = { image: { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]), width: 2, height: 1 }, colorSpace: 'srgb', wrapS: 10497 };

function sampleScene() {
  const parts = [
    { name: 'floor', geometry: quad(0), material: { color: [0.5, 0.25, 0.125], metallic: 0.5, roughness: 0.3, map: texture } },
    { name: 'ceiling', geometry: quad(2), material: { color: [1, 1, 1], emission: 3, lightMask: 0b101 } },
  ];
  const environment = {
    keyColor: [1, 1, 1],
    lightDirection: [0, 1, 0],
    pointLights: [{ position: [0, 1, 0], color: [1, 0.5, 0.25], intensity: 4, radius: 0.1, range: 5 }],
    areaLights: [{ position: [0, 1.9, 0], color: [1, 1, 1], intensity: 2, width: 0.5, height: 0.25, direction: [0, -1, 0] }],
  };
  return buildTraceScene(parts, environment);
}

test('triangles are packed in leaf order with their corner, edges and material', () => {
  const scene = sampleScene();
  const table = packTriangles(scene);
  const order = scene.bvh.triangleOrder;
  assert.equal(order.length, 4);
  for (let slot = 0; slot < order.length; slot++) {
    const triangle = order[slot];
    const base = slot * TRIANGLE_TEXELS * 4;
    const first = scene.indices[triangle * 3];
    const second = scene.indices[triangle * 3 + 1];
    assert.equal(table.data[base + 1], scene.positions[first * 3 + 1]);
    assert.equal(table.data[base + 4], scene.positions[second * 3] - scene.positions[first * 3]);
    assert.equal(table.data[base + 3], scene.triangleMaterial[triangle]);
  }
});

test('nodes mark a leaf with a negative triangle count and an inner node with its right child', () => {
  const scene = sampleScene();
  const table = packNodes(scene.bvh);
  for (let node = 0; node < scene.bvh.nodeCount; node++) {
    const header = table.data[node * 8 + 3];
    if (scene.bvh.rightChild[node] < 0) assert.equal(header, -scene.bvh.rangeCount[node]);
    else assert.equal(header, scene.bvh.rightChild[node]);
    assert.equal(table.data[node * 8 + 7], scene.bvh.rangeStart[node]);
  }
});

test('materials carry values, the light mask in two halves and an atlas rectangle with its flags', () => {
  const scene = sampleScene();
  const atlas = packAtlas(scene.materials);
  const table = packMaterials(scene.materials, atlas);
  const floor = 0;
  const ceiling = MATERIAL_TEXELS * 4;
  assert.deepEqual([...table.data.subarray(floor, floor + 4)], [0.5, 0.25, 0.125, 0.5]);
  assert.equal(table.data[floor + 12 + 3], 0xffff);
  assert.equal(table.data[floor + 16], 0xffff);
  assert.equal(table.data[ceiling + 12 + 3], 0b101);
  assert.equal(table.data[ceiling + 16], 0);
  assert.equal(table.data[floor + 17], 3, 'repeat and sRGB flags');
  assert.deepEqual([...table.data.subarray(floor + 24, floor + 28)], [0, 0, 2, 1]);
  assert.equal(table.data[ceiling + 24 + 2], 0, 'no map, no rectangle');
  assert.deepEqual([...atlas.data.subarray(0, 8)], [...texture.image.data]);
});

test('the backend option is cpu unless asked, and refuses other names', async () => {
  const { normalizePathTracerOptions } = await import('../src/path-tracer.js');
  assert.equal(normalizePathTracerOptions({}).backend, 'cpu');
  assert.equal(normalizePathTracerOptions({ backend: 'gpu' }).backend, 'gpu');
  assert.throws(() => normalizePathTracerOptions({ backend: 'cuda' }), /backend/);
});

test('lights are packed as points, then spots, then areas', () => {
  const scene = sampleScene();
  const { table, count } = packLights(scene.lights);
  assert.equal(count, 2);
  assert.equal(table.data[3], 0, 'point type');
  assert.equal(table.data[LIGHT_TEXELS * 4 + 3], 2, 'area type');
  assert.equal(table.data[LIGHT_TEXELS * 4 + 11], 0.5, 'area width');
  assert.equal(table.data[20], 4, 'point intensity');
});

function subsurfaceScene(weight) {
  const parts = [
    { name: 'wax', geometry: quad(0), material: { color: [0.8, 0.6, 0.4], subsurface: { weight, radius: [1, 0.5, 0.25], scale: 0.02, color: [0.9, 0.5, 0.2] } } },
    { name: 'stone', geometry: quad(2), material: { color: [0.5, 0.5, 0.5], subsurface: { weight, radius: [1, 1, 1], scale: 0.1 } } },
    { name: 'plain', geometry: quad(3), material: { color: [1, 1, 1] } },
  ];
  return buildTraceScene(parts, { keyColor: [1, 1, 1], lightDirection: [0, 1, 0] });
}

test('the subsurface block is packed as two texels per material, with -1 for the base colour', () => {
  const scene = subsurfaceScene(0.75);
  assert.equal(sceneUsesSubsurface(scene.materials), true);
  const table = packSubsurface(scene.materials);
  const wax = scene.materials.findIndex(material => material.subsurface?.color);
  const stone = scene.materials.findIndex(material => material.subsurface && !material.subsurface.color);
  const plain = scene.materials.findIndex(material => !material.subsurface);
  const waxBase = wax * SUBSURFACE_TEXELS * 4;
  assert.deepEqual([...table.data.subarray(waxBase, waxBase + 4)].map(value => Number(value.toFixed(5))), [0.75, 0.02, 0.01, 0.005]);
  assert.deepEqual([...table.data.subarray(waxBase + 4, waxBase + 8)].map(value => Number(value.toFixed(5))), [0.9, 0.5, 0.2, 0]);
  assert.equal(table.data[stone * SUBSURFACE_TEXELS * 4 + 4], -1, 'no colour means the base colour');
  assert.equal(table.data[plain * SUBSURFACE_TEXELS * 4], 0, 'a part without a block has weight 0');
});

test('weight 0 and no block both leave the kernel without the random walk', () => {
  assert.equal(sceneUsesSubsurface(subsurfaceScene(0).materials), false);
  assert.equal(sceneUsesSubsurface(sampleScene().materials), false);
  assert.equal(buildFragmentSource({ hasSubsurface: false }), FRAGMENT_SOURCE);
  assert.equal(FRAGMENT_SOURCE.includes('uSubsurface'), false);
  assert.equal(FRAGMENT_SOURCE.includes('randomWalk'), false);
  const withWalk = buildFragmentSource({ hasSubsurface: true });
  for (const name of ['uniform sampler2D uSubsurface', 'int randomWalk(', 'bool enterSubsurface(', 'subsurfaceWeight = splitSubsurface()']) {
    assert.equal(withWalk.includes(name), true, name);
  }
  assert.equal(withWalk.includes('const int WALK_STEPS = 32;'), true);
});

test('the texel kernel starts paths at lightmap texels, and the camera kernel does not carry its samplers', () => {
  const texelKernel = buildFragmentSource({ texelBake: true });
  const cameraKernel = buildFragmentSource();
  assert.match(texelKernel, /uniform sampler2D uTexelPoints;/);
  assert.match(texelKernel, /texelFetch\(uTexelNormals/);
  assert.doesNotMatch(cameraKernel, /uTexelPoints/);
  assert.match(cameraKernel, /vec3 rayDirection = normalize\(uForward/);
});
