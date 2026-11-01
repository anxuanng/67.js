import test from 'node:test';
import assert from 'node:assert/strict';
import { box, sphere } from '../src/geometry.js';
import { applyReflectionProbes, normalizeProbeList, selectProbe, roomCentreProbe } from '../src/reflection-probes.js';
import { traceProbeMaps, traceProbes } from '../src/probe-trace.js';
import { createFragmentShader } from '../src/shaders.js';
import { normalizeAgentBake } from '../src/agent-bake.js';

const cube = box(0, 1);
const ball = sphere(16, 12);

function placed(name, geometry, translation, scale, material = {}) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry, matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0, ...material } };
}

function closedRoom() {
  return [
    placed('floor', cube, [0, -0.05, 0], [6, 0.1, 6]),
    placed('ceiling', cube, [0, 3.05, 0], [6, 0.1, 6]),
    placed('back', cube, [0, 1.5, -3.05], [6, 3.2, 0.1], { color: [0.8, 0.1, 0.1] }),
    placed('left', cube, [-3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('right', cube, [3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('front', cube, [0, 1.5, 3.05], [6, 3.2, 0.1]),
    placed('mirror', ball, [1.5, 0.5, 0], [0.5, 0.5, 0.5], { metallic: 1, roughness: 0.05 }),
  ];
}

const lamp = { pointLights: [{ position: [0, 2.6, 0], color: [1, 1, 1], intensity: 8, radius: 0.05 }], keyColor: [0, 0, 0] };

test('an enclosed room gets one automatic probe at its centre', () => {
  const result = applyReflectionProbes(closedRoom(), lamp, 'room');
  assert.equal(result.report.placed.length, 1);
  assert.deepEqual(result.report.placed[0].position.map(value => Math.round(value * 100) / 100), [0, 1.5, 0]);
  assert.ok(result.report.placed[0].hitFraction >= 0.9);
  assert.equal(result.report.partsWithProbe, 7);
  assert.ok(result.parts.every(part => part.material.environmentProbe === result.probes[0].map));
});

test('an open scene gets no automatic probe and says why', () => {
  const openParts = [placed('floor', cube, [0, -0.05, 0], [6, 0.1, 6]), placed('post', cube, [2, 1, 0], [0.2, 2, 0.2])];
  const result = applyReflectionProbes(openParts, lamp, 'room');
  assert.equal(result.probes.length, 0);
  assert.match(result.report.skipped, /open scene/);
  assert.equal(result.report.partsWithProbe, 0);
});

test('a probe sees the coloured wall it faces and is lit by the lamp', () => {
  const [probe] = traceProbeMaps(closedRoom(), lamp, [[0, 1.5, 0]], { width: 32, samples: 8 });
  // Row 8 of 16 looks at the horizon; the middle column looks toward -Z, where the red wall is.
  const offset = (8 * 32 + 16) * 3;
  const [red, green] = [probe.data[offset], probe.data[offset + 1]];
  assert.ok(red > 0.05 && red > green * 3, `wall seen as red ${red} ${green}`);
  assert.equal(probe.hitFraction, 1);
});

test('the same input traces the same bytes', () => {
  const first = traceProbes(closedRoom(), lamp, 'room', { samples: 8 });
  const second = traceProbes(closedRoom(), lamp, 'room', { samples: 8 });
  assert.deepEqual(Array.from(first.traced[0].data), Array.from(second.traced[0].data));
});

test('a part takes the nearest probe in range, else none', () => {
  const near = { position: [0, 0, 0], radius: 2 };
  const far = { position: [10, 0, 0], radius: 2 };
  assert.equal(selectProbe([far, near], [0.5, 0, 0]), near);
  assert.equal(selectProbe([far, near], [9, 0, 0]), far);
  assert.equal(selectProbe([far, near], [5, 0, 0]), null);
  const overlapping = { position: [1, 0, 0], radius: 2 };
  assert.equal(selectProbe([near, overlapping], [0.4, 0, 0]), near);
  assert.equal(selectProbe([overlapping, near], [0.6, 0, 0]), overlapping);
});

test('explicit probes with a radius leave distant parts without one', () => {
  const room = closedRoom();
  const result = applyReflectionProbes(room, lamp, [{ position: [1.5, 1, 0], radius: 1.2 }], { samples: 4 });
  assert.deepEqual(result.parts.filter(part => part.material.environmentProbe).map(part => part.name), ['mirror']);
});

test('probe lists are validated', () => {
  assert.throws(() => normalizeProbeList(Array.from({ length: 5 }, () => ({ position: [0, 0, 0] }))), /at most 4/);
  assert.throws(() => normalizeProbeList([{ position: [0, 0] }]), /position/);
  assert.throws(() => normalizeProbeList([{ position: [0, 0, 0], size: 1 }]), /unknown field/);
  assert.throws(() => normalizeProbeList([{ position: [0, 0, 0], radius: 0 }]), /radius/);
  assert.deepEqual(roomCentreProbe(closedRoom()).position.map(Math.round), [0, 2, 0]);
});

test('bake.probes defaults to room, and false opts out', () => {
  assert.equal(normalizeAgentBake({}).probes, 'room');
  assert.equal(normalizeAgentBake({ preset: 'draft' }).probes, 'room');
  assert.equal(normalizeAgentBake({ probes: false }).probes, false);
  assert.equal(normalizeAgentBake({ probes: 'room' }).probes, 'room');
  assert.deepEqual(normalizeAgentBake({ probes: [{ position: [0, 1, 0] }] }).probes, [{ position: [0, 1, 0] }]);
});

test('the probe shader code compiles in only when asked for', () => {
  assert.doesNotMatch(createFragmentShader(), /probeEnabled/);
  assert.match(createFragmentShader(['probe']), /probeEnabled > 0.5\) surroundings/);
});

test('a probe on a light-mapped part keeps its light map fields and still reads live colour', () => {
  const lightMap = { width: 2, height: 2, data: new Uint8Array(16) };
  const lightMapped = placed('mirror', ball, [0, 1, 0], [0.5, 0.5, 0.5], { metallic: 1, roughness: 0.05, lightMap, lightMapScale: 2, emission: 0.5 });
  const [probed] = applyReflectionProbes([lightMapped], lamp, [{ position: [0, 1, 0], radius: 5 }], {}).parts;
  assert.ok(probed.material.environmentProbe);
  assert.equal(probed.material.lightMap, lightMap);
  assert.equal(probed.material.lightMapScale, 2);
  lightMapped.material.color = [0.2, 0.3, 0.4];
  assert.deepEqual(probed.material.color, [0.2, 0.3, 0.4]);
});
