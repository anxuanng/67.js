import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { retargetAssetClip } from '../src/agent-retarget.js';
import { clipFromGltfAnimation, createAssetPose } from '../src/skeleton-pose.js';

function dataUri(bytes) {
  return `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Two joints (Hips with child Spine), a skin, and one clip that turns the Spine; no mesh. */
function skeletonDocument(edit = () => {}) {
  const floats = new Float32Array([0, 1, 0, 0, 0, 1, 0, 0.7071068, 0, 0.7071068]);
  const bytes = new Uint8Array(floats.buffer);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Hips', children: [1] }, { name: 'Spine', translation: [0, 1, 0] }],
    skins: [{ joints: [0, 1] }],
    animations: [{
      name: 'Turn',
      samplers: [{ input: 0, output: 1 }],
      channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
    }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 0, byteOffset: 8, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ byteLength: bytes.length, uri: dataUri(bytes) }],
  };
  edit(document);
  return JSON.stringify(document);
}

test('a skeleton-only file loads as nodes, joints and clips with zero parts', async () => {
  const asset = await parseGltf(skeletonDocument());
  assert.deepEqual(asset.parts, []);
  assert.equal(asset.animations.length, 1);
  assert.deepEqual(asset.nodes.map(node => [node.name, node.joint]), [['Hips', true], ['Spine', true]]);
  assert.equal(asset.nodes[1].parent, asset.nodes[0].id);
});

test('a skeleton-only asset can be posed from its own clip', async () => {
  const asset = await parseGltf(skeletonDocument());
  const clip = clipFromGltfAnimation(asset.animations[0]);
  const pose = createAssetPose(asset, { layers: [{ clip }] });
  assert.deepEqual(pose.apply(0), []);
  const rest = Array.from(pose.jointWorld('Spine').position);
  pose.apply(1);
  assert.deepEqual(Array.from(pose.jointWorld('Spine').position), rest);
  assert.notDeepEqual(Array.from(pose.jointWorld('Spine').rotation), [0, 0, 0, 1]);
});

test('the retarget addon reads a skeleton-only asset as a rig and asks for humanoid bones', async () => {
  const asset = await parseGltf(skeletonDocument());
  const clip = clipFromGltfAnimation(asset.animations[0]);
  assert.throws(() => retargetAssetClip(asset.nodes, asset.nodes, clip), /Source rig is not humanoid\. Missing bones: head/);
});

test('a file with neither a mesh nor a skin or clip is still refused', async () => {
  const data = skeletonDocument(document => {
    delete document.skins;
    delete document.animations;
  });
  await assert.rejects(parseGltf(data), /no supported triangle meshes and no skin or animation/);
});

const GOOD_TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];

/**
 * A mesh "Body" whose primitive 0 draws and whose primitive 1 is built by `edit(document, helpers)`.
 * Accessor 0 is the good triangle; accessors added by a case follow it.
 */
function twoPrimitiveDocument(edit) {
  const floats = new Float32Array([...GOOD_TRIANGLE, 0, 0, 0, 1, 1, 1, 2, 2, 2, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const indexBytes = new Uint8Array(new Uint16Array([0, 1, 2, 0, 1, 9, 0, 1]).buffer);
  const floatBytes = new Uint8Array(floats.buffer);
  const bytes = new Uint8Array(floatBytes.length + indexBytes.length);
  bytes.set(floatBytes);
  bytes.set(indexBytes, floatBytes.length);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Body', mesh: 0 }],
    meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      // 1: two vertices only. 2: three vertices on one point (zero area). 3: six indices, the last three out of range.
      { bufferView: 0, byteOffset: 36, componentType: 5126, count: 2, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 2] },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: 4, type: 'SCALAR' },
      // 5: four vertices, the last one unused. 6: the triangle 0, 1, 2.
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: floatBytes.length }, { buffer: 0, byteOffset: floatBytes.length, byteLength: indexBytes.length }],
    buffers: [{ byteLength: bytes.length, uri: dataUri(bytes) }],
  };
  edit(document.meshes[0].primitives[1]);
  return JSON.stringify(document);
}

const BAD_PRIMITIVES = {
  'fewer than 3 vertices': [primitive => { primitive.attributes.POSITION = 1; }, /primitive 1 of mesh "Body": its POSITION accessor .* fewer than 3 vertices/],
  'a missing POSITION accessor': [primitive => { primitive.attributes = {}; }, /primitive 1 of mesh "Body": its POSITION accessor is missing/],
  'an index count that is not a multiple of 3': [primitive => { primitive.indices = 4; }, /primitive 1 of mesh "Body": its index count 4 is not a multiple of 3/],
  'an index out of range': [primitive => { primitive.indices = 3; primitive.attributes.POSITION = 0; }, /primitive 1 of mesh "Body": an index is out of range/],
  'only zero-area triangles': [primitive => { primitive.attributes.POSITION = 2; }, /primitive 1 of mesh "Body": every triangle has zero area/],
};

for (const [name, [edit, expected]] of Object.entries(BAD_PRIMITIVES)) {
  test(`a primitive with ${name} is skipped with one warning and the rest loads`, async () => {
    const asset = await parseGltf(twoPrimitiveDocument(edit));
    assert.equal(asset.parts.length, 1);
    assert.equal(asset.warnings.length, 1);
    assert.match(asset.warnings[0], expected);
  });
}

test('an unused vertex without a generated normal does not stop a primitive that has real triangles', async () => {
  const asset = await parseGltf(twoPrimitiveDocument(primitive => {
    primitive.attributes.POSITION = 5;
    primitive.indices = 6;
  }));
  assert.equal(asset.parts.length, 2);
  assert.deepEqual(asset.warnings, []);
});

test('a file whose only primitive is unusable says why and throws', async () => {
  const data = JSON.parse(twoPrimitiveDocument(primitive => { primitive.attributes.POSITION = 1; }));
  data.meshes[0].primitives.shift();
  await assert.rejects(parseGltf(JSON.stringify(data)), /no supported triangle meshes.*Skipped primitive 0 of mesh "Body"/);
});
