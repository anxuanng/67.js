import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeAgentBake, bakeSecondsLimit } from '../src/agent-bake.js';
import { BAKE_PRESETS, BAKE_PRESET_PATH_WORK, BAKE_EXPLICIT_PATH_WORK_LIMIT, BAKE_MAXIMUM_SECONDS, BAKE_WORKER_MAXIMUM_SECONDS } from '../src/agent-scene-capabilities.js';

function closedRoom(extra = {}) {
  const box = (id, translation, scale, material) => ({ id, geometry: 'box', material, translation, scale });
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [
      { id: 'white', color: [0.8, 0.8, 0.8], roughness: 0.9 },
      { id: 'lamp', color: [1, 1, 1], emission: 2 },
    ],
    nodes: [
      box('floor', [0, -0.05, 0], [4, 0.1, 4], 'white'),
      box('ceiling', [0, 3.05, 0], [4, 0.1, 4], 'white'),
      box('back', [0, 1.5, -2.05], [4.2, 3.2, 0.1], 'white'),
      box('front', [0, 1.5, 2.05], [4.2, 3.2, 0.1], 'white'),
      box('left', [-2.05, 1.5, 0], [0.1, 3.2, 4.2], 'white'),
      box('right', [2.05, 1.5, 0], [0.1, 3.2, 4.2], 'white'),
      box('block', [-0.7, 0.6, -0.4], [1.2, 1.2, 1.2], 'white'),
      box('bulb', [0.9, 2.5, 0.6], [0.2, 0.2, 0.2], 'lamp'),
    ],
    camera: { eye: [0, 1.5, 1.9], target: [0, 1.4, -2], fov: 70, near: 0.05, far: 20 },
    environment: { pointLights: [{ position: [0, 2.7, 0], intensity: 14, radius: 0.1 }], keyIntensity: 0, fillIntensity: 0 },
    bake: { preset: 'draft' },
    ...extra,
  };
}

function closedRoomWithoutBake() {
  const { bake, ...recipe } = closedRoom();
  return recipe;
}

function lightmapBytes(part) {
  return Buffer.from(part.material.emissiveMap.image.data ?? part.material.emissiveMap.image.bytes);
}

test('bake presets and fields resolve to plain numbers within their ranges', () => {
  assert.deepEqual(normalizeAgentBake({ preset: 'fine' }), { ...BAKE_PRESETS.fine, probes: 'room' });
  assert.deepEqual(normalizeAgentBake({}), { ...BAKE_PRESETS.standard, probes: 'room' });
  assert.deepEqual(normalizeAgentBake({ preset: 'draft', samples: 48 }), { ...BAKE_PRESETS.draft, samples: 48, probes: 'room' });
  assert.equal(normalizeAgentBake(null), null);
});

test('bake rejects hostile and out of range fields', () => {
  const hostile = [
    { preset: 'ultra' }, { samples: 0 }, { samples: 257 }, { samples: 1e9 }, { samples: NaN }, { samples: '64' },
    { samples: 2.5 }, { bounces: 4 }, { bounces: 1.5 }, { texelsPerUnit: 0.5 }, { texelsPerUnit: 13 },
    { maxSeconds: 600 }, { unknown: 1 }, [], 'standard', JSON.parse('{"__proto__":{"samples":1}}'),
  ];
  for (const input of hostile) {
    assert.throws(() => normalizeAgentBake(input), undefined, JSON.stringify(input));
  }
});

test('a recipe bake lights the room with lightmaps and reports its time and skipped parts', () => {
  const scene = createAgentScene(closedRoom());
  const bake = scene.inspect().bake;
  assert.equal(bake.reused, false);
  assert.ok(Number.isFinite(bake.seconds) && bake.seconds >= 0);
  assert.ok(bake.texels > 0);
  assert.deepEqual(bake.skipped, []);
  const floor = scene.parts.find(part => part.name === 'floor');
  assert.ok(floor.material.emissiveMap);
  assert.equal(floor.material.color[0], 0.8);
  const bulb = scene.parts.find(part => part.name === 'bulb');
  assert.equal(bulb.material.emissiveMap, undefined);
  assert.ok(bulb.material.lightMap);
  assert.equal(bulb.material.emission, 2);
  assert.equal(createAgentScene(closedRoomWithoutBake()).parts.some(part => part.material.emissiveMap), false);
});

test('the same recipe gives the same lightmap bytes', () => {
  const first = createAgentScene(closedRoom());
  const second = createAgentScene(closedRoom());
  for (const name of ['floor', 'back', 'block']) {
    const firstBytes = lightmapBytes(first.parts.find(part => part.name === name));
    const secondBytes = lightmapBytes(second.parts.find(part => part.name === name));
    assert.ok(firstBytes.length > 0);
    assert.deepEqual(firstBytes, secondBytes);
  }
});

test('a camera edit, a motion seek and a look edit that leaves the lights reuse the bake', () => {
  const scene = createAgentScene(closedRoom({ motion: { duration: 1, tracks: [{ kind: 'node', id: 'bulb', property: 'translation', keyframes: [{ time: 0, value: [0.9, 2.5, 0.6] }, { time: 1, value: [0.9, 2.5, 0.4] }] }] } }));
  const first = scene.inspect().bake;
  const partsBefore = scene.parts.map(part => part.material.emissiveMap);
  scene.apply([{ type: 'set-camera', eye: [0.3, 1.5, 1.9] }], { expectedRevision: 0 });
  scene.sampleMotion(0.5);
  scene.apply([{ type: 'set-effects', effects: { exposure: 1.2 } }], { expectedRevision: 1 });
  const after = scene.inspect().bake;
  assert.equal(after.reused, true);
  assert.equal(after.seconds, first.seconds);
  assert.deepEqual(scene.parts.map(part => part.material.emissiveMap), partsBefore);
});

test('moving a part, changing a light or changing the bake runs it again, and clearing it removes the lightmaps', () => {
  const scene = createAgentScene(closedRoom());
  scene.apply([{ type: 'set-node', id: 'block', translation: [0.5, 0.6, -0.4] }], { expectedRevision: 0 });
  assert.equal(scene.inspect().bake.reused, false);
  scene.apply([{ type: 'set-environment', environment: { pointLights: [{ position: [0, 2.5, 0.5], intensity: 14, radius: 0.1 }] } }], { expectedRevision: 1 });
  assert.equal(scene.inspect().bake.reused, false);
  scene.apply([{ type: 'set-bake', bake: { preset: 'draft', samples: 40 } }], { expectedRevision: 2 });
  assert.equal(scene.inspect().bake.samples, 40);
  assert.equal(scene.inspect().bake.reused, false);
  scene.apply([{ type: 'set-bake', bake: null }], { expectedRevision: 3 });
  assert.equal(scene.inspect().bake, undefined);
  assert.equal(scene.parts.some(part => part.material.emissiveMap), false);
  assert.equal(scene.exportRecipe().bake, null);
});

test('a failed bake leaves the scene as it was', () => {
  const scene = createAgentScene(closedRoom());
  assert.throws(() => scene.apply([{ type: 'set-bake', bake: { samples: 5000 } }], { expectedRevision: 0 }));
  assert.equal(scene.revision, 0);
  assert.equal(scene.inspect().bake.samples, BAKE_PRESETS.draft.samples);
});

test('a brick wall keeps its pattern and receives bounced light through a light map', () => {
  const recipe = closedRoom();
  recipe.materials.push({ id: 'bricks', color: [1, 1, 1], roughness: 0.9, pattern: { type: 'bricks', size: 1 } });
  recipe.nodes.find(node => node.id === 'back').material = 'bricks';
  const scene = createAgentScene(recipe);
  assert.deepEqual(scene.inspect().bake.skipped, []);
  const wall = scene.parts.find(part => part.name === 'back');
  assert.ok(wall.material.lightMap);
  assert.ok(wall.material.map);
  assert.ok(wall.material.boxMapScale > 0);
  assert.equal(wall.geometry.lightUvs.length, wall.geometry.positions.length / 3 * 2);
  const again = createAgentScene(recipe).parts.find(part => part.name === 'back');
  assert.deepEqual(Array.from(again.material.lightMap.image.data), Array.from(wall.material.lightMap.image.data));
});

test('a node that hosts a hair system bakes without an error and is reported as skipped', () => {
  const recipe = closedRoom({
    geometries: [{ id: 'box', type: 'box' }, { id: 'head', type: 'sphere', segments: 12, rings: 8 }],
    particles: { systems: [{ type: 'hair', node: 'fur', surface: 'head', seed: 5, count: 40, length: [0.1, 0.2], segments: 3 }] },
  });
  recipe.nodes.push({ id: 'head', geometry: 'head', material: 'white', translation: [0.5, 0.5, 0.5], scale: [0.3, 0.3, 0.3] });
  recipe.nodes.push({ id: 'fur', geometry: 'box', material: 'white' });
  const scene = createAgentScene(recipe);
  const skipped = scene.inspect().bake.skipped.find(entry => entry.name === 'fur');
  assert.ok(skipped);
  assert.match(skipped.reason, /hair|particle/);
  assert.ok(scene.parts.find(part => part.name === 'head').material.emissiveMap);
  assert.equal(scene.parts.find(part => part.name === 'fur').material.emissiveMap, undefined);
});

function roomLitBy(environment) {
  return closedRoom({ environment: { ...environment, keyIntensity: 0, fillIntensity: 0 } });
}

function lightmapBytesOf(scene, name) {
  return lightmapBytes(scene.parts.find(part => part.name === name));
}

test('a spot light that points at the floor bakes the light that bounces off it', () => {
  const recipe = roomLitBy({ spotLights: [{ position: [0, 2.8, 0.5], direction: [0, -1, 0], angle: 0.6, intensity: 30 }] });
  const scene = createAgentScene(recipe);
  assert.ok(scene.parts.find(part => part.name === 'back').material.emissiveMap);
  assert.deepEqual(lightmapBytesOf(createAgentScene(recipe), 'back'), lightmapBytesOf(scene, 'back'));
  const withoutSpot = createAgentScene(roomLitBy({}));
  assert.notDeepEqual(lightmapBytesOf(withoutSpot, 'back'), lightmapBytesOf(scene, 'back'));
});

test('an area light bakes bounced light on its front side only, and a changed spot or area light bakes again', () => {
  const facingDown = roomLitBy({ areaLights: [{ position: [0, 2.9, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 20 }] });
  const facingUp = roomLitBy({ areaLights: [{ position: [0, 2.9, 0], direction: [0, 1, 0], width: 1, height: 1, intensity: 20 }] });
  const scene = createAgentScene(facingDown);
  assert.ok(scene.parts.find(part => part.name === 'floor').material.emissiveMap);
  assert.deepEqual(lightmapBytesOf(createAgentScene(facingDown), 'floor'), lightmapBytesOf(scene, 'floor'));
  assert.notDeepEqual(lightmapBytesOf(createAgentScene(facingUp), 'floor'), lightmapBytesOf(scene, 'floor'));
  scene.apply([{ type: 'set-environment', environment: { areaLights: [{ position: [0, 2.9, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 25 }] } }], { expectedRevision: 0 });
  assert.equal(scene.inspect().bake.reused, false);
});

function largeRoom(bake) {
  const recipe = closedRoom({ bake });
  recipe.environment.spotLights = [{ position: [0, 2.8, 0], direction: [0, -1, 0], angle: 1, intensity: 20 }];
  for (let index = 0; index < 48; index++) {
    const column = index % 8;
    const row = Math.floor(index / 8);
    recipe.nodes.push({ id: `crate-${index}`, geometry: 'box', material: 'white', translation: [-1.75 + column * 0.5, 0.3, -1.7 + row * 0.6], scale: [0.4, 0.6, 0.4] });
  }
  return recipe;
}

test('a preset on a 56 part room shrinks to the path work budget, finishes, and reports what it used', () => {
  const scene = createAgentScene(largeRoom({ preset: 'standard' }));
  const bake = scene.inspect().bake;
  assert.equal(scene.parts.length, 56);
  assert.equal(bake.reduced, true);
  assert.ok(bake.used.samples < BAKE_PRESETS.standard.samples);
  assert.ok(bake.used.texelsPerUnit < BAKE_PRESETS.standard.texelsPerUnit);
  assert.equal(bake.used.bounces, BAKE_PRESETS.standard.bounces);
  assert.ok(bake.texels * bake.used.samples * bake.used.bounces <= BAKE_PRESET_PATH_WORK);
  assert.ok(Number.isFinite(bake.seconds) && bake.seconds >= 0, 'the report carries the time the bake took');
  const again = createAgentScene(largeRoom({ preset: 'standard' }));
  assert.deepEqual(again.inspect().bake.used, bake.used);
  assert.deepEqual(lightmapBytesOf(again, 'floor'), lightmapBytesOf(scene, 'floor'));
});

test('a preset that already fits is not reduced', () => {
  const bake = createAgentScene(closedRoom()).inspect().bake;
  assert.equal(bake.reduced, false);
  assert.deepEqual(bake.used, { ...BAKE_PRESETS.draft, probes: 'room' });
});

test('explicit settings over the hard limit fail up front with a lower setting to try', () => {
  const heavy = { preset: 'draft', samples: 256, bounces: 3, texelsPerUnit: 12 };
  let message = '';
  assert.throws(() => createAgentScene(largeRoom(heavy)), error => {
    message = error.message;
    return /path steps/.test(error.message) && message.includes(String(BAKE_EXPLICIT_PATH_WORK_LIMIT));
  });
  const fittingSamples = Number(/samples (\d+) or fewer/.exec(message)?.[1]);
  const fittingDensity = Number(/texelsPerUnit ([\d.]+) or less/.exec(message)?.[1]);
  assert.ok(fittingSamples >= 1 && fittingSamples < 256, message);
  assert.ok(fittingDensity >= 1 && fittingDensity < 12, message);
});

test('explicit settings far above the preset budget run when they fit the hard limit, and are never reduced', () => {
  const explicit = { samples: 160, bounces: 2, texelsPerUnit: 6 };
  // A busy machine can pass the real limit here, and this test is about the settings, so the clock stands still.
  const realNow = performance.now;
  performance.now = () => 0;
  try {
    const bake = createAgentScene(largeRoom(explicit)).inspect().bake;
    assert.equal(bake.reduced, false);
    assert.deepEqual(bake.used, { ...explicit, probes: 'room' });
    assert.ok(bake.texels * explicit.samples * explicit.bounces > BAKE_PRESET_PATH_WORK);
  } finally {
    performance.now = realNow;
  }
});

test('an explicit bake that passes maxSeconds fails cleanly with a lower setting to try', () => {
  const slow = { samples: 256, bounces: 3, texelsPerUnit: 4 };
  // A fast machine finishes this bake inside the real limit, so each clock read is made to cost a second.
  const realNow = performance.now;
  let clockReads = 0;
  performance.now = () => {
    clockReads += 1;
    return realNow.call(performance) + clockReads * 1000;
  };
  try {
    assert.throws(() => createAgentScene(largeRoom(slow)), error => /maxSeconds/.test(error.message) && /Try samples 128/.test(error.message));
  } finally {
    performance.now = realNow;
  }
});

test('the bake kernel carries 20 s on the page thread and 90 s inside a worker', () => {
  assert.equal(bakeSecondsLimit(), BAKE_MAXIMUM_SECONDS);
  globalThis.WorkerGlobalScope = Object;
  try {
    assert.equal(bakeSecondsLimit(), BAKE_WORKER_MAXIMUM_SECONDS);
  } finally {
    delete globalThis.WorkerGlobalScope;
  }
});

function clothRoom() {
  const recipe = closedRoom({ cloth: { duration: 2, sheets: [{ node: 'flag', pin: ['top'] }] } });
  recipe.geometries.push({ id: 'sheet', type: 'grid', segments: 8 });
  recipe.nodes.push({ id: 'flag', geometry: 'sheet', material: 'white', translation: [0.5, 2, 0], scale: [1, 1, 1] });
  return recipe;
}

test('a cloth sheet is skipped by the bake and still has no lightmap after a seek past t=0', () => {
  const scene = createAgentScene(clothRoom());
  const skipped = scene.inspect().bake.skipped.find(entry => entry.name === 'flag');
  assert.ok(skipped);
  assert.match(skipped.reason, /cloth/);
  scene.sampleMotion(1);
  const flag = scene.parts.find(part => part.name === 'flag');
  assert.equal(flag.material.lightMap, undefined);
  assert.equal(flag.material.emissiveMap, undefined);
  for (const part of scene.parts) {
    assert.ok(!part.material.lightMap || part.geometry.lightUvs, `${part.name} has a light map without lightUvs`);
  }
  assert.ok(scene.parts.find(part => part.name === 'floor').material.emissiveMap);
});

test('a bake places a room probe unless bake.probes is false', () => {
  const withProbe = createAgentScene(closedRoom()).inspect().bake;
  assert.equal(withProbe.probes.placed.length, 1);
  const optedOut = createAgentScene(closedRoom({ bake: { preset: 'draft', probes: false } })).inspect().bake;
  assert.equal(optedOut.probes, false);
});
