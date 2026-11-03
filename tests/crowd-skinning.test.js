import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { parseGltf } from '../src/gltf.js';
import { clipFromGltfAnimation, createAssetPose } from '../src/skeleton-pose.js';
import { createCrowd } from '../src/retarget.js';
import { groupParts, Renderer67 } from '../src/renderer.js';
import { InstanceSelection, extractFrustumPlanes, selectInstances } from '../src/render-culling.js';
import {
  bakeCrowdPalette, createCrowdLods, createCrowdParts, createCrowdRig, crowdFrameBlend, crowdVertexAt,
} from '../src/crowd-skinning.js';

// A real character: the CC0 RobotExpressive, merged into one crowd rig (rigid parts follow one joint each, the hands keep their skins).
const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));

async function loadWalker() {
  const asset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  const source = asset.animations.find(animation => animation.name === 'Walking');
  const pose = createAssetPose(asset, { layers: [{ clip: clipFromGltfAnimation(source, { loop: true }) }] });
  const rig = createCrowdRig(asset.parts);
  return { asset, pose, rig, duration: source.duration };
}

test('a crowd rig keeps one geometry per material and a joint for every rigid part and skin joint', async () => {
  const { asset, rig } = await loadWalker();
  const materials = new Set(asset.parts.map(part => part.material));
  assert.equal(rig.parts.length, materials.size);
  const skinJoints = asset.parts.filter(part => part.skin).reduce((total, part) => total + part.skin.jointMatrices.length / 16, 0);
  assert.equal(rig.jointCount, asset.parts.filter(part => !part.skin).length + skinJoints);
  const vertices = asset.parts.reduce((total, part) => total + part.geometry.positions.length / 3, 0);
  assert.equal(rig.parts.reduce((total, part) => total + part.geometry.positions.length / 3, 0), vertices);
});

test('a baked palette is the same whatever order its frames are posed in, and frames blend by clip time alone', async () => {
  const { pose, rig, duration } = await loadWalker();
  const forward = bakeCrowdPalette(rig, seconds => pose.apply(seconds), { duration });
  const times = [];
  for (let frame = forward.frameCount - 1; frame >= 0; frame--) times.push(frame * forward.frameStep);
  const visited = [];
  const backward = bakeCrowdPalette(rig, (seconds) => {
    pose.apply(times[visited.length]);
    visited.push(seconds);
  }, { duration });
  // Posing frame i at the time of frame count - 1 - i gives the reverse table, so reversing it back must equal the forward one.
  const matricesPerFrame = rig.jointCount * 16;
  for (let frame = 0; frame < forward.frameCount; frame++) {
    const mirrored = forward.frameCount - 1 - frame;
    assert.deepEqual(
      backward.data.subarray(frame * matricesPerFrame, (frame + 1) * matricesPerFrame),
      forward.data.subarray(mirrored * matricesPerFrame, (mirrored + 1) * matricesPerFrame),
    );
  }
  const early = crowdFrameBlend(forward, 0.4);
  const later = crowdFrameBlend(forward, 0.4 + duration * 3);
  assert.deepEqual(early.slice(0, 2), later.slice(0, 2), 'a looping clip repeats');
  assert.ok(Math.abs(early[2] - later[2]) < 1e-6);
  const wrapped = crowdFrameBlend(forward, duration - forward.frameStep / 2);
  assert.equal(wrapped[1], 0, 'a looping clip blends its last frame into its first');
  assert.ok(Math.abs(wrapped[2] - 0.5) < 1e-3);
});

test('a crowd vertex at any time matches per-instance skinning and stays inside the bound', async () => {
  const { pose, rig, duration } = await loadWalker();
  const palette = bakeCrowdPalette(rig, seconds => pose.apply(seconds), { duration });
  const radius = palette.bounds.radius;
  const joints = new Float32Array(rig.jointCount * 16);
  let largestError = 0;
  let largestErrorAtFrame = 0;
  for (const seconds of [0, 0.123, 0.4, 0.7777, duration * 0.999, duration * 2.25]) {
    pose.apply(seconds % duration);
    rig.readJointMatrices(joints);
    for (const { geometry } of rig.parts) {
      for (let vertex = 0; vertex < geometry.positions.length / 3; vertex += 7) {
        const expected = [0, 0, 0];
        const x = geometry.positions[vertex * 3];
        const y = geometry.positions[vertex * 3 + 1];
        const z = geometry.positions[vertex * 3 + 2];
        for (let influence = 0; influence < 4; influence++) {
          const weight = geometry.crowdWeights[vertex * 4 + influence];
          const base = geometry.crowdJoints[vertex * 4 + influence] * 16;
          for (let axis = 0; axis < 3; axis++) expected[axis] += weight * (joints[base + axis] * x + joints[base + 4 + axis] * y + joints[base + 8 + axis] * z + joints[base + 12 + axis]);
        }
        const actual = crowdVertexAt(palette, geometry, vertex, seconds);
        const error = Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2]);
        const onFrame = Math.abs(seconds % palette.frameStep) < 1e-9 ? 1 : 0;
        if (error > largestError) {
          largestError = error;
          largestErrorAtFrame = onFrame;
        }
        const distance = Math.hypot(actual[0] - palette.bounds.center[0], actual[1] - palette.bounds.center[1], actual[2] - palette.bounds.center[2]);
        assert.ok(distance <= radius * (1 + 1e-4), `vertex ${vertex} left the bound at ${seconds}`);
      }
    }
  }
  assert.ok(largestError < radius * 0.01, `largest error ${largestError} against a bound of ${radius} (on a frame: ${largestErrorAtFrame})`);
  const exact = crowdVertexAt(palette, rig.parts[0].geometry, 3, 5 * palette.frameStep);
  pose.apply(5 * palette.frameStep);
  rig.readJointMatrices(joints);
  assert.ok(Number.isFinite(exact[0]));
});

test('instances of one character and clip share one batch per material, whatever their number or time', async () => {
  const { pose, rig, duration } = await loadWalker();
  const palette = bakeCrowdPalette(rig, seconds => pose.apply(seconds), { duration });
  const crowd = createCrowd({ count: 200, clip: { duration, tracks: [] }, seed: 3 });
  const set = createCrowdParts({ rig, palette, instances: crowd.instances });
  assert.equal(set.parts.length, 200 * rig.parts.length);
  assert.equal(groupParts(set.parts).length, rig.parts.length);
  const few = createCrowdParts({ rig, palette, instances: crowd.instances.slice(0, 3) });
  assert.equal(groupParts(few.parts).length, rig.parts.length);
  set.setTimes(index => crowd.clipTime(index, 1.25));
  const first = set.parts[0].assembly.offset.slice();
  set.setTimes(index => crowd.clipTime(index, 1.25));
  assert.deepEqual(set.parts[0].assembly.offset, first, 'the same time gives the same frames');
  const other = createCrowdParts({ rig, palette: { ...palette }, instances: crowd.instances.slice(0, 2) });
  assert.equal(groupParts([...set.parts.slice(0, rig.parts.length), ...other.parts.slice(0, rig.parts.length)]).length, rig.parts.length * 2, 'another palette is another batch');
});

test('lods keep the joints, shrink the triangle count and report a growing error', async () => {
  const { rig } = await loadWalker();
  const widest = rig.parts.reduce((best, part) => (part.geometry.indices.length > best.geometry.indices.length ? part : best));
  const levels = createCrowdLods(widest.geometry);
  assert.equal(levels.length, 3);
  assert.equal(levels[0].geometry, widest.geometry);
  assert.ok(levels[1].geometry.indices.length < levels[0].geometry.indices.length);
  assert.ok(levels[2].geometry.indices.length <= levels[1].geometry.indices.length);
  assert.ok(levels[2].error > levels[1].error && levels[1].error > 0);
  const allowed = new Set(widest.geometry.crowdJoints);
  for (const { geometry } of levels) {
    assert.ok(geometry.indices.every(index => index < geometry.positions.length / 3));
    assert.ok(geometry.crowdJoints.every(joint => allowed.has(joint)));
  }
});

test('the renderer culls crowd instances with the bound of the whole clip, and refuses nothing for levels', async () => {
  const { pose, rig, duration } = await loadWalker();
  const palette = bakeCrowdPalette(rig, seconds => pose.apply(seconds), { duration });
  const matrices = [[0, 0, 0], [400, 0, 0], [0, 0, 40], [0, 0, -300]].map(position => mat4.fromTranslation(new Float32Array(16), position));
  const set = createCrowdParts({ rig, palette, instances: matrices.map(matrix => ({ matrix })) });
  const batch = groupParts(set.parts).find(group => group[0].crowd);
  const renderer = Object.create(Renderer67.prototype);
  const culling = renderer.createCullingState(batch);
  assert.equal(culling.cullable, true);
  assert.ok(culling.bounds.radius >= palette.bounds.radius);
  assert.equal(culling.levelGeometries.length, 3);
  const projection = mat4.perspective(mat4.create(), Math.PI / 4, 16 / 9, 0.5, 200);
  const viewProjection = mat4.multiply(mat4.create(), projection, mat4.lookAt(mat4.create(), [0, 2, 12], [0, 1, 0], [0, 1, 0]));
  const instanceData = new Float32Array(batch.length * 41);
  batch.forEach((part, index) => instanceData.set(part.matrix, index * 41));
  const selection = selectInstances(new InstanceSelection(batch.length, 3), {
    instanceData, instanceCount: batch.length, stride: 41, bounds: culling.bounds, levelErrors: culling.levelErrors,
    planes: extractFrustumPlanes(viewProjection, new Float32Array(24)), viewProjection, pixelsPerUnit: 540 / 2 * projection[5], pixelError: 1,
  });
  assert.equal(selection.visibleCount, 1, 'only the instance in front of the camera draws');
});
