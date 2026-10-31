import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { box } from '../src/geometry.js';
import { createMorphPose } from '../src/morph.js';
import { clipFromGltfAnimation } from '../src/skeleton-pose.js';
import { bakeMaterialPattern, normalizeMaterialPattern } from '../src/material-patterns.js';

// CC0 RobotExpressive by Tomás Laulhé, modified by Don McCurdy: a skinned character with many clips.
const robotBytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
const robotBuffer = robotBytes.buffer.slice(robotBytes.byteOffset, robotBytes.byteOffset + robotBytes.byteLength);
// Node has no image decoder: decode the exporter's PNGs (unfiltered rows) so parseGltf sees real pixels.
globalThis.self = globalThis;
globalThis.createImageBitmap = async blob => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const channels = bytes[25] === 6 ? 4 : 3;
  const idat = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let row = 0; row < height; row++) {
    assert.equal(raw[row * (width * channels + 1)], 0);
    for (let column = 0; column < width; column++) {
      for (let channel = 0; channel < channels; channel++) data[(row * width + column) * 4 + channel] = raw[row * (width * channels + 1) + 1 + column * channels + channel];
    }
  }
  return { width, height, data, close() {} };
};

const PARSE_OPTIONS = { maxVertices: 500000 };

function checkerImage(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let texel = 0; texel < size * size; texel++) {
    const checker = ((texel % size >> 1) + (Math.floor(texel / size) >> 1)) % 2 ? 255 : 40;
    data.set([checker, 255 - checker, 128, 255], texel * 4);
  }
  return { width: size, height: size, data };
}

function maximumDifference(first, second) {
  let largest = 0;
  for (let index = 0; index < first.length; index++) largest = Math.max(largest, Math.abs(first[index] - second[index]));
  return largest;
}

function texturedBox(textureCount = 5) {
  const geometry = box();
  geometry.uvs = new Float32Array(geometry.positions.length / 3 * 2).map((_, index) => index % 7 / 7);
  const material = { color: [0.8, 0.7, 0.6], metallic: 0.2, roughness: 0.6, emission: 1, emissiveColor: [0.5, 0.2, 0.1], normalScale: [0.5, 0.5], occlusionStrength: 0.75 };
  ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'].slice(0, textureCount).forEach((channel, index) => {
    material[channel] = { image: checkerImage(8 + index * 4), wrapS: 33071, wrapT: 33648, magFilter: 9728, colorSpace: channel === 'map' || channel === 'emissiveMap' ? 'srgb' : 'linear' };
  });
  return { name: 'Crate', geometry, matrix: mat4.create(), material };
}

test('all five texture channels round trip as PNG with their pixels, samplers and factors', async () => {
  const source = texturedBox();
  const imported = await parseGltf(exportGlb([source]));
  const material = imported.parts[0].material;
  for (const channel of ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) {
    const expected = source.material[channel].image;
    const actual = material[channel].image;
    assert.equal(actual.width, expected.width, channel);
    assert.equal(actual.height, expected.height, channel);
    const pixels = Uint8ClampedArray.from(actual.data ?? []);
    if (pixels.length) assert.equal(maximumDifference(pixels, expected.data), 0, channel);
    assert.equal(material[channel].wrapS, 33071);
    assert.equal(material[channel].wrapT, 33648);
  }
  assert.deepEqual(material.normalScale, [0.5, 0.5]);
  assert.equal(material.occlusionStrength, 0.75);
});

test('textures carry the flipY of their descriptor into glTF row order', async () => {
  const source = texturedBox(1);
  source.material.map.flipY = true;
  const imported = await parseGltf(exportGlb([source]));
  const expected = source.material.map.image;
  const actual = imported.parts[0].material.map.image;
  if (!actual.data) return;
  const topRow = Array.from(actual.data.slice(0, expected.width * 4));
  const lastSourceRow = Array.from(expected.data.slice((expected.height - 1) * expected.width * 4));
  assert.deepEqual(topRow, lastSourceRow);
});

test('a pattern material exports box projected UVs and its baked textures', async () => {
  const pattern = normalizeMaterialPattern({ type: 'wood', resolution: 256, size: 0.5 });
  const baked = bakeMaterialPattern(pattern);
  const source = {
    name: 'Plank', geometry: box(), matrix: mat4.fromScaling(mat4.create(), [2, 1, 1]),
    material: { color: [1, 1, 1], metallic: 0, roughness: 1, map: baked.map, normalMap: baked.normalMap, metallicRoughnessMap: baked.metallicRoughnessMap, boxMapScale: baked.boxMapScale, boxMapAxis: baked.boxMapAxis },
  };
  const imported = await parseGltf(exportGlb([source]));
  const geometry = imported.parts[0].geometry;
  assert.ok(geometry.uvs, 'the export gives pattern geometry UVs');
  assert.equal(geometry.positions.length / 3, geometry.uvs.length / 2);
  // Every vertex sits on one face, so its UV is the projection of its scaled position onto that face.
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    const [x, y, z] = [0, 1, 2].map(axis => geometry.positions[vertex * 3 + axis] * [2, 1, 1][axis] * baked.boxMapScale);
    const [u, v] = [geometry.uvs[vertex * 2], geometry.uvs[vertex * 2 + 1]];
    const candidates = [[z, x], [x, z], [x, y], [z, y], [y, z]].filter(([expectedU, expectedV]) => Math.abs(expectedU - u) < 1e-4 && Math.abs(expectedV - v) < 1e-4);
    assert.ok(candidates.length > 0 || [[x, z], [x, y], [z, y]].some(([expectedU, expectedV]) => Math.abs(expectedU - u) < 1e-4 && Math.abs(expectedV - v) < 1e-4));
  }
  assert.equal(imported.parts[0].material.map.image.width, 256);
});

test('RobotExpressive round trips geometry, skin, materials and every clip', async () => {
  const original = await parseGltf(robotBuffer.slice(0), PARSE_OPTIONS);
  const clips = original.animations.map((animation, index) => ({ ...clipFromGltfAnimation(animation), name: animation.name || `clip ${index}` }));
  const exported = exportGlb(original.parts, { nodes: original.nodes, clips });
  const copy = await parseGltf(exported.slice(0), PARSE_OPTIONS);

  assert.equal(copy.parts.length, original.parts.length);
  const skinnedBefore = original.parts.filter(part => part.skin).length;
  assert.ok(skinnedBefore > 0, 'the fixture has skinned parts');
  assert.equal(copy.parts.filter(part => part.skin).length, skinnedBefore);
  assert.equal(copy.skins.length, original.skins.length);
  assert.equal(copy.animations.length, original.animations.length);

  const sortedNames = parts => parts.map(part => part.name).sort();
  assert.deepEqual(sortedNames(copy.parts), sortedNames(original.parts));
  const copyByName = new Map(copy.parts.map(part => [part.name, part]));
  for (const part of original.parts) {
    const other = copyByName.get(part.name);
    assert.equal(other.geometry.positions.length, part.geometry.positions.length, part.name);
    assert.equal(maximumDifference(other.geometry.positions, part.geometry.positions), 0, part.name);
    assert.equal(other.geometry.morphTargets?.length ?? 0, part.geometry.morphTargets?.length ?? 0, part.name);
    assert.ok(maximumDifference(other.material.color, part.material.color) < 1e-6, part.name);
    assert.ok(Math.abs(other.material.roughness - part.material.roughness) < 1e-6, part.name);
    assert.equal(Boolean(other.material.map), Boolean(part.material.map), part.name);
    if (part.skin) assert.deepEqual(other.skin.joints.map(joint => joint.name), part.skin.joints.map(joint => joint.name));
  }
  for (let index = 0; index < original.animations.length; index++) {
    assert.ok(Math.abs(copy.animations[index].duration - original.animations[index].duration) < 1e-5, original.animations[index].name);
    const trackNames = animation => animation.tracks.filter(track => !track.name.endsWith('morphTargetInfluences')).map(track => track.name).sort();
    assert.deepEqual(trackNames(copy.animations[index]), trackNames(original.animations[index]));
  }
});

test('an exported clip poses the copy the way it poses the original', async () => {
  const original = await parseGltf(robotBuffer.slice(0), PARSE_OPTIONS);
  const clipIndex = original.animations.findIndex(animation => /walk/i.test(animation.name));
  assert.ok(clipIndex >= 0, 'the fixture has a walking clip');
  const clips = [{ ...clipFromGltfAnimation(original.animations[clipIndex]), name: 'Walking' }];
  const copy = await parseGltf(exportGlb(original.parts, { nodes: original.nodes, clips }), PARSE_OPTIONS);
  const time = original.animations[clipIndex].duration * 0.37;
  original.applyAnimation(time, clipIndex);
  copy.applyAnimation(time, 0);
  const jointsBefore = original.skins[0].jointWorldMatrices;
  const jointsAfter = copy.skins[0].jointWorldMatrices;
  assert.ok(maximumDifference(jointsAfter, jointsBefore) < 1e-3);
});

test('skins built without a node list export derived joints and a clip can target them', async () => {
  const geometry = box();
  const vertexCount = geometry.positions.length / 3;
  geometry.skinIndices = new Uint16Array(vertexCount * 4);
  geometry.skinWeights = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    geometry.skinIndices[vertex * 4] = geometry.positions[vertex * 3 + 1] > 0 ? 1 : 0;
    geometry.skinWeights[vertex * 4] = 1;
  }
  const jointWorldMatrices = new Float32Array(32);
  mat4.identity(jointWorldMatrices.subarray(0, 16));
  mat4.fromTranslation(jointWorldMatrices.subarray(16, 32), [0, 1, 0]);
  const inverseBindMatrices = new Float32Array(32);
  mat4.identity(inverseBindMatrices.subarray(0, 16));
  mat4.fromTranslation(inverseBindMatrices.subarray(16, 32), [0, -1, 0]);
  const skin = { jointMatrices: new Float32Array(32), joints: [{ name: 'root', parent: -1 }, { name: 'tip', parent: 0 }], inverseBindMatrices, jointWorldMatrices };
  mat4.identity(skin.jointMatrices.subarray(0, 16));
  mat4.identity(skin.jointMatrices.subarray(16, 32));
  const part = { name: 'Rod', geometry, matrix: mat4.create(), material: { color: [1, 1, 1], metallic: 0, roughness: 1 }, skin };
  const clip = { name: 'Bend', duration: 1, loop: true, tracks: [{ target: 'tip', property: 'rotation', interpolation: 'SMOOTH', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, 0.7071068, 0.7071068] }] }] };
  const copy = await parseGltf(exportGlb([part], { clips: [clip] }));
  assert.deepEqual(copy.skins[0].joints.map(joint => [joint.name, joint.parent]), [['root', -1], ['tip', 0]]);
  assert.equal(copy.animations.length, 1);
  assert.equal(copy.animations[0].tracks[0].name, 'tip.quaternion');
});

test('morph weight clips round trip as one SCALAR sampler per track', async () => {
  const geometry = box();
  const positions = new Float32Array(geometry.positions.length).fill(0.1);
  geometry.morphTargets = [{ positions }, { positions: positions.map(value => -value) }];
  const morph = createMorphPose(2);
  const part = { name: 'Face', geometry, matrix: mat4.create(), morph, material: { color: [1, 1, 1], metallic: 0, roughness: 1 } };
  const keyframes = [{ time: 0, value: [0, 0] }, { time: 0.5, value: [1, 0.25] }, { time: 1, value: [0, 1] }];
  const clip = { name: 'Blink', duration: 1, loop: false, tracks: [{ target: 'Face', property: 'weights', keyframes }] };
  const binary = exportGlb([part], { clips: [clip] });
  const view = new DataView(binary);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, view.getUint32(12, true))));
  const sampler = document.animations[0].samplers[0];
  assert.equal(document.animations[0].channels[0].target.path, 'weights');
  assert.equal(document.accessors[sampler.input].count, 3);
  assert.equal(document.accessors[sampler.output].type, 'SCALAR');
  assert.equal(document.accessors[sampler.output].count, 6);
  const copy = await parseGltf(binary);
  assert.equal(copy.animations[0].tracks[0].name, 'Face.morphTargetInfluences');
  assert.deepEqual(Array.from(copy.animations[0].tracks[0].values), [0, 0, 1, 0.25, 0, 1]);
  const ragged = { ...clip, tracks: [{ target: 'Face', property: 'weights', keyframes: [{ time: 0, value: [0, 0] }, { time: 1, value: [1] }] }] };
  assert.throws(() => exportGlb([part], { clips: [ragged] }), /same nonzero count/);
});

test('a clip that targets a missing node names the fix', () => {
  const part = texturedBox(0);
  const clip = { duration: 1, loop: false, tracks: [{ target: 'ghost', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] }] };
  assert.throws(() => exportGlb([part], { clips: [clip] }), /ghost.*options\.nodes/);
});
