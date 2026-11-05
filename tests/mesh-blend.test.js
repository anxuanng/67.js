import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBlend, blendRadiusTable, installMeshBlend, blendFragment, MESH_BLEND_TAPS, MESH_BLEND_CAPABILITIES } from '../src/mesh-blend.js';
import { createAgentScene } from '../src/agent-scene.js';
import { blendReference } from './support/mesh-blend-reference.js';

const WIDTH = 64;
const HEIGHT = 16;
const GREEN = [0, 1, 0];
const RED = [1, 0, 0];
const ORTHOGRAPHIC = { eye: [0, 0, 100], pixelsPerMetre: 20, orthographic: true };

// A ground plane facing the viewer on the left and a rock face at 45 degrees on the right; they meet at column 32.
// The pixel pitch is 0.05 m, so a radius of 0.2 m reaches 4 pixels. `rockDepth` and `rockId` change the right half.
function syntheticBuffers({ rockId = 2, rockSlope = 1, rockOffset = 0, rockIds } = {}) {
  const ids = new Int32Array(WIDTH * HEIGHT);
  const positions = new Float32Array(WIDTH * HEIGHT * 3);
  const colors = new Float32Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const index = y * WIDTH + x;
      const onRock = x >= 32;
      ids[index] = onRock ? (rockIds ? rockIds(x) : rockId) : 1;
      const depth = onRock ? (x - 32) * 0.05 * rockSlope + rockOffset : 0;
      positions.set([x * 0.05, y * 0.05, depth], index * 3);
      colors.set(onRock ? RED : GREEN, index * 3);
    }
  }
  return { width: WIDTH, height: HEIGHT, ids, positions, colors };
}

const colorAt = (colors, x, y = 8) => Array.from(colors.subarray((y * WIDTH + x) * 3, (y * WIDTH + x) * 3 + 3));

test('a blend part mixes toward the part it cuts into, fading out over its radius', () => {
  const buffers = syntheticBuffers();
  const result = blendReference(buffers, { ...ORTHOGRAPHIC, radii: new Map([[2, 0.2]]) });
  const atSeam = colorAt(result, 33);
  const farther = colorAt(result, 34);
  assert.ok(atSeam[1] > 0.25 && atSeam[0] < 0.75, `next to the seam the rock should take on the ground colour, got ${atSeam}`);
  assert.ok(farther[1] > 0 && farther[1] < atSeam[1], 'the mix falls off with distance');
  assert.deepEqual(colorAt(result, 40), RED, 'beyond the radius the rock keeps its colour');
  assert.deepEqual(colorAt(result, 10), GREEN, 'the ground part has no blend and is untouched');
});

test('a larger radius reaches further from the seam', () => {
  const small = blendReference(syntheticBuffers(), { ...ORTHOGRAPHIC, radii: new Map([[2, 0.1]]) });
  const large = blendReference(syntheticBuffers(), { ...ORTHOGRAPHIC, radii: new Map([[2, 0.3]]) });
  assert.deepEqual(colorAt(small, 36), RED);
  assert.ok(colorAt(large, 36)[1] > 0, 'the 0.3 m radius still touches 6 pixels out');
});

test('a part without a radius is left alone even when another part touches it', () => {
  const buffers = syntheticBuffers();
  const result = blendReference(buffers, { ...ORTHOGRAPHIC, radii: new Map() });
  assert.deepEqual(Array.from(result), Array.from(buffers.colors));
});

test('a depth jump is a silhouette, not a seam: a rock in front of a far wall is not blended', () => {
  const buffers = syntheticBuffers({ rockOffset: 5 });
  const result = blendReference(buffers, { ...ORTHOGRAPHIC, radii: new Map([[2, 0.2]]) });
  assert.deepEqual(colorAt(result, 32), RED);
  assert.deepEqual(colorAt(result, 33), RED);
});

test('two parts on one plane have no normal discontinuity, so nothing blends', () => {
  const buffers = syntheticBuffers({ rockSlope: 0 });
  const result = blendReference(buffers, { ...ORTHOGRAPHIC, radii: new Map([[2, 0.2]]) });
  assert.deepEqual(Array.from(result), Array.from(buffers.colors));
});

test('pixels of one part, and the background (ID 0), never blend with themselves or the sky', () => {
  const sameId = syntheticBuffers({ rockId: 1 });
  assert.deepEqual(Array.from(blendReference(sameId, { ...ORTHOGRAPHIC, radii: new Map([[1, 0.2]]) })), Array.from(sameId.colors));
  const sky = syntheticBuffers({ rockId: 0 });
  assert.deepEqual(Array.from(blendReference(sky, { ...ORTHOGRAPHIC, radii: new Map([[1, 0.2]]) })), Array.from(sky.colors));
});

test('the reference and the shader use the same tap pattern', () => {
  assert.ok(blendFragment.includes(`< ${MESH_BLEND_TAPS.count}; index++`));
  assert.ok(blendFragment.includes(`float(index) * ${MESH_BLEND_TAPS.angleStep}`));
  assert.ok(blendFragment.includes('smoothstep(0.05, 0.4, 1.0 - dot('));
});

test('blend is checked: a radius in metres and nothing else', () => {
  assert.deepEqual(normalizeBlend({ radius: 0.15 }), { radius: 0.15 });
  assert.throws(() => normalizeBlend({ radius: 0 }), /between 0\.005 and 2/);
  assert.throws(() => normalizeBlend({ radius: 5 }), /between 0\.005 and 2/);
  assert.throws(() => normalizeBlend({ radius: '0.1' }), /number of metres/);
  assert.throws(() => normalizeBlend({ radius: 0.1, softness: 1 }), /no field softness/);
  assert.throws(() => normalizeBlend(0.1), /must be an object/);
});

test('the radius table follows the part order, with a radius map for parts that carry none', () => {
  const parts = [{ name: 'ground' }, { name: 'rock', blend: { radius: 0.2 } }, { name: 'root' }];
  assert.deepEqual(Array.from(blendRadiusTable(parts)), [0, 0, Math.fround(0.2), 0]);
  assert.deepEqual(Array.from(blendRadiusTable(parts, new Map([['root', 0.5], ['rock', 0.9]]))), [0, 0, Math.fround(0.2), Math.fround(0.5)]);
});

// A fake WebGL context: constants are stable numbers, calls return empty objects, and shader and framebuffer checks pass.
function fakeContext() {
  const calls = [];
  const constant = name => [...name].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) % 100000, 7);
  return new Proxy({}, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) return constant(name);
      if (name === 'checkFramebufferStatus') return () => constant('FRAMEBUFFER_COMPLETE');
      if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
      return (...argumentsGiven) => {
        calls.push(name);
        return {};
      };
    },
    calls,
  });
}

function fakeRenderer(parts) {
  const drawn = [];
  const renderer = {
    context: fakeContext(),
    canvas: { width: 8, height: 8 },
    benchmark: false,
    hdr: true,
    depthTexture: {},
    projection: new Float32Array(16),
    inverseViewProjection: new Float32Array(16),
    postStages: [],
    passSupport: { framebuffer: {} },
    batches: [{ parts }],
    drawsInOpaqueLoop: () => true,
    render: frame => drawn.push(frame),
  };
  return { renderer, drawn };
}

test('installing needs the render passes addon', () => {
  const { renderer } = fakeRenderer([]);
  renderer.passSupport = null;
  assert.throws(() => installMeshBlend(renderer), /installRenderPasses/);
});

test('with no blend part a frame is drawn once, as given, and the stage does nothing', () => {
  const { renderer, drawn } = fakeRenderer([{ name: 'ground' }, { name: 'rock' }]);
  installMeshBlend(renderer);
  const frame = { eye: [0, 0, 5] };
  renderer.render(frame);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0], frame, 'the very same frame object reaches the renderer');
  assert.equal(renderer.postStages[0].apply(renderer, frame, {}, {}), null);
});

test('a blend part adds one object ID draw before the frame, and the stage runs only for that frame', () => {
  const { renderer, drawn } = fakeRenderer([{ name: 'ground' }, { name: 'rock', blend: { radius: 0.2 } }]);
  installMeshBlend(renderer);
  const frame = { eye: [0, 0, 5] };
  renderer.render(frame);
  assert.equal(drawn.length, 2);
  assert.equal(drawn[0].pass, 'objectId');
  assert.equal(drawn[1], frame);
  assert.equal(renderer.postStages[0].apply(renderer, frame, {}, {}), null, 'the stage is off again after the frame');
});

test('a radius from the radii map opts a part in like its own blend field', () => {
  const { renderer, drawn } = fakeRenderer([{ name: 'ground' }, { name: 'rock' }]);
  installMeshBlend(renderer);
  renderer.meshBlend.radii = new Map([['rock', 0.2]]);
  renderer.render({ eye: [0, 0, 5] });
  assert.equal(drawn.length, 2);
});

test('passes, mirrors and benchmark frames are never blended', () => {
  const { renderer, drawn } = fakeRenderer([{ name: 'rock', blend: { radius: 0.2 } }]);
  installMeshBlend(renderer);
  renderer.render({ eye: [0, 0, 5], pass: 'normal' });
  renderer.render({ eye: [0, 0, 5], reflectionTarget: {} });
  renderer.benchmark = true;
  renderer.render({ eye: [0, 0, 5] });
  assert.equal(drawn.length, 3);
});

test('a recipe node takes blend and keeps it through export and set-node', () => {
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'gray', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'rock', geometry: 'box', material: 'gray', blend: { radius: 0.15 } }, { id: 'ground', geometry: 'box', material: 'gray' }],
  };
  const scene = createAgentScene(recipe);
  assert.deepEqual(scene.exportRecipe().nodes[0].blend, { radius: 0.15 });
  assert.equal(scene.exportRecipe().nodes[1].blend, undefined);
  scene.apply([{ type: 'set-node', id: 'ground', blend: { radius: 0.3 } }], { expectedRevision: 0 });
  assert.deepEqual(scene.exportRecipe().nodes[1].blend, { radius: 0.3 });
});

test('the docs and the capability note describe the same option', () => {
  const documentation = readFileSync(new URL('../docs/mesh-blend.md', import.meta.url), 'utf8');
  assert.ok(documentation.includes('blend: { radius }') || documentation.includes('"blend": { "radius"'));
  assert.match(MESH_BLEND_CAPABILITIES, /blend \{radius.*docs\/mesh-blend\.md/);
});
