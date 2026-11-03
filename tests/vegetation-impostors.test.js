import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTree, scatterVegetation, selectLevels } from '../src/vegetation.js';
import {
  bakeImpostorAtlas, blendLevels, FADE_STEPS, getImpostor, impostorCardBasis, impostorCellOf, impostorFrameDirection, selectBlendedLevels,
} from '../src/vegetation-impostors.js';
import { IMPOSTOR_FRAMES, impostorShader } from '../src/impostor-shader.js';
import { createDepthVertexShader, createFragmentShader, createVertexShader } from '../src/shaders.js';

const FAST_BAKE = { frameSize: 32 };
const THRESHOLDS = [38, 95, 150];

function digestOf(pixels) {
  return createHash('sha256').update(pixels).digest('hex');
}

function createForest(treeCount, seed = 5) {
  const side = Math.sqrt(treeCount / 0.0035);
  const forest = scatterVegetation({ area: { minX: -side / 2, maxX: side / 2, minZ: -side / 2, maxZ: side / 2 }, density: 0.0035, mix: { broadleaf: 3, birch: 1.5, conifer: 2, bush: 2 }, seed });
  return forest;
}

test('every atlas cell is picked from the direction it was baked from', () => {
  for (let row = 0; row < IMPOSTOR_FRAMES; row++) {
    for (let column = 0; column < IMPOSTOR_FRAMES; column++) {
      const direction = impostorFrameDirection(column, row);
      assert.ok(Math.abs(Math.hypot(...direction) - 1) < 1e-9);
      assert.ok(direction[1] > 0);
      assert.deepEqual(impostorCellOf(direction), { column, row });
    }
  }
});

test('the card basis is orthonormal and falls back straight above the tree', () => {
  for (const toEye of [[0.6, 0.5, -0.62], [0, 1, 0], [1, 0.01, 0]]) {
    const length = Math.hypot(...toEye);
    const direction = toEye.map(value => value / length);
    const { right, up } = impostorCardBasis(direction);
    const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
    assert.ok(Math.abs(dot(right, up)) < 1e-9);
    assert.ok(Math.abs(dot(right, direction)) < 1e-9);
    assert.ok(Math.abs(dot(up, direction)) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...up) - 1) < 1e-9);
  }
});

test('an atlas bake covers the tree, repeats exactly and keeps unit normals', () => {
  const tree = createTree('broadleaf', 4);
  const first = bakeImpostorAtlas(tree, { ...FAST_BAKE, level: 2 });
  const second = bakeImpostorAtlas(tree, { ...FAST_BAKE, level: 2 });
  assert.equal(digestOf(first.colorPixels), digestOf(second.colorPixels));
  assert.equal(digestOf(first.normalPixels), digestOf(second.normalPixels));
  let covered = 0;
  for (let index = 3; index < first.colorPixels.length; index += 4) if (first.colorPixels[index] === 255) covered++;
  const share = covered / (first.colorPixels.length / 4);
  assert.ok(share > 0.05 && share < 0.6, `covered share ${share}`);
  for (let index = 0; index < first.normalPixels.length; index += 4) {
    if (first.colorPixels[index + 3] !== 255) continue;
    const x = first.normalPixels[index] / 255 * 2 - 1;
    const y = first.normalPixels[index + 1] / 255 * 2 - 1;
    const z = first.normalPixels[index + 2] / 255 * 2 - 1;
    assert.ok(z > -0.02, 'a baked normal never faces away from the view');
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 0.05);
  }
});

test('the impostor card holds the tree and carries the impostor tag', () => {
  const tree = createTree('conifer', 2);
  const impostor = getImpostor(tree, { ...FAST_BAKE, level: 2 });
  assert.equal(getImpostor(tree), impostor, 'the bake is cached on the variant');
  assert.equal(impostor.material.tag, 'impostor');
  assert.equal(impostor.geometry.indices.length, 6);
  assert.ok(impostor.geometry.positions[0] < 0 && impostor.geometry.positions[3] > 0);
  assert.ok(impostor.bakeMilliseconds > 0);
});

test('a distance gives the same blend whatever came before, with eighths between two levels', () => {
  const band = 0.06;
  assert.deepEqual(blendLevels(10, THRESHOLDS, band), { level: 0, next: 0, step: 0 });
  assert.deepEqual(blendLevels(500, THRESHOLDS, band), { level: 3, next: 3, step: 0 });
  assert.deepEqual(blendLevels(38, THRESHOLDS, band), { level: 0, next: 1, step: FADE_STEPS / 2 });
  let previousStep = 0;
  for (let distance = 35; distance < 41.5; distance += 0.05) {
    const blend = blendLevels(distance, THRESHOLDS, band);
    assert.deepEqual(blend, blendLevels(distance, THRESHOLDS, band));
    const fraction = blend.level === 1 ? FADE_STEPS : blend.step;
    assert.ok(fraction >= previousStep, 'the fade only moves one way as the distance grows');
    previousStep = fraction;
  }
  assert.equal(previousStep, FADE_STEPS);
});

test('a fade draws both levels with complementary coverage and repeats for a camera', () => {
  const forest = createForest(300);
  const instance = forest.instances.find(candidate => candidate.variant.kind === 'tree');
  const eye = [instance.position[0] + 38, instance.position[1], instance.position[2]];
  const direct = selectBlendedLevels([instance], eye, { fade: 0.06 });
  assert.equal(direct.fading, 1);
  const outgoing = direct.parts.filter(part => part.material.opacityBias > 0 && part.material.opacityBias < 1);
  const incoming = direct.parts.filter(part => part.material.opacityBias > 1);
  assert.ok(outgoing.length > 0 && incoming.length > 0);
  assert.ok(Math.abs(outgoing[0].material.opacityBias + incoming[0].material.opacityBias - 1 - 1) < 1e-9);
  selectBlendedLevels([instance], [instance.position[0] + 300, 0, instance.position[2]], { fade: 0.06 });
  const after = selectBlendedLevels([instance], eye, { fade: 0.06 });
  assert.deepEqual(after.parts.map(part => [part.name, part.material.opacityBias]), direct.parts.map(part => [part.name, part.material.opacityBias]));
  assert.equal(selectBlendedLevels([instance], eye, { fade: 0.06 }).changed, false);
  assert.equal(selectBlendedLevels([instance], eye, { fade: 0.06 }).parts[0], direct.parts[0], 'unchanged parts keep their identity');
});

test('selectLevels keeps its hysteresis path unless fade or impostors are asked for', () => {
  const forest = createForest(200);
  const eye = [0, 2, 0];
  const plain = selectLevels(forest.instances, eye, {});
  assert.equal(plain.impostors, undefined);
  assert.ok(plain.parts.every(part => part.material.tag !== 'impostor' && part.material.opacityBias === undefined));
});

test('impostors replace the last level only beyond its fade band', () => {
  const forest = createForest(600);
  const eye = [0, 2, 0];
  const view = selectLevels(forest.instances, eye, { impostors: { ...FAST_BAKE } });
  const cards = view.parts.filter(part => part.material.tag === 'impostor');
  assert.equal(cards.length, view.impostors);
  assert.ok(cards.length > 0);
  for (const instance of forest.instances) {
    const distance = Math.hypot(instance.position[0], instance.position[1] - 2, instance.position[2]);
    const hasCard = view.parts.some(part => part.name.startsWith(`${instance.species} ${instance.index} `) && part.material.tag === 'impostor');
    if (instance.variant.kind !== 'tree') continue;
    if (distance < 150 * 0.94) assert.equal(hasCard, false, `${distance} m draws a mesh level`);
    if (distance > 150 * 1.06) assert.equal(hasCard, true, `${distance} m draws a card`);
  }
});

test('a 5,000 tree forest draws far fewer triangles with impostors', () => {
  const forest = createForest(5000);
  const eye = [0, 2, 0];
  const plain = selectLevels(forest.instances, eye, {});
  const withCards = selectLevels(forest.instances, eye, { impostors: { ...FAST_BAKE } });
  const earlyCards = selectLevels(forest.instances, eye, { impostors: { ...FAST_BAKE, from: 2 } });
  console.log(`trees ${forest.instances.length}, triangles plain ${plain.triangles}, cards from level 3 ${withCards.triangles}, from level 2 ${earlyCards.triangles}`);
  assert.ok(forest.instances.length > 4000);
  assert.ok(withCards.triangles < plain.triangles * 0.25);
  assert.ok(earlyCards.triangles < 1.5e6);
});

test('the shaders carry the card code only where a pass needs it', () => {
  assert.match(createVertexShader([]), /impostorCard\(position, uv, instanceMatrix, viewProjection/);
  assert.match(createDepthVertexShader(), /impostorCard\(position, uv, instanceMatrix, lightProjection/);
  assert.match(impostorShader, new RegExp(`floor\\(square \\* ${IMPOSTOR_FRAMES}\\.0\\)`));
  assert.match(createFragmentShader(['alphaMode']), /incoming \? coverage < 1\.0 - threshold : coverage <= threshold/);
});
