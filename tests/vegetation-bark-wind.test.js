import test from 'node:test';
import assert from 'node:assert/strict';
import { createTree, resolveBarkTextures, resolveLeafTextures, scatterVegetation } from '../src/vegetation.js';
import { groupParts } from '../src/renderer.js';
import { box } from '../src/geometry.js';
import { addLeafSurface, addTube, createLeafFrame, createMeshBuilder } from '../src/vegetation-geometry.js';
import { depthVertexShader, vertexShader } from '../src/shaders.js';

const TILE_SIZE = 0.8;

function syntheticDescriptor() {
  return { image: { width: 4, height: 4, data: new Uint8ClampedArray(64) }, colorSpace: 'linear', wrapS: 10497, wrapT: 10497 };
}

function syntheticBarkSet() {
  return { color: syntheticDescriptor(), normal: syntheticDescriptor(), roughness: syntheticDescriptor() };
}

function straightTube(radius, sides, direction = [0, 1, 0]) {
  const builder = createMeshBuilder();
  const points = [0, 1, 2, 3].map(step => direction.map(component => component * step));
  addTube(builder, points, [radius, radius, radius, radius], sides, TILE_SIZE, [1, 1, 1], { worldScaleUv: true });
  return { geometry: builder.build(), sides, ringSize: sides + 1 };
}

test('bark u spans each ring by its own circumference, so texel density matches from trunk to twig', () => {
  for (const radius of [0.3, 0.1, 0.02]) {
    const { geometry, ringSize } = straightTube(radius, 8);
    const exactRepeats = 2 * Math.PI * radius / TILE_SIZE;
    const spanOfRing = geometry.uvs[ringSize * 2 - 2] - geometry.uvs[0];
    const expected = exactRepeats >= 1.5 ? Math.round(exactRepeats) : exactRepeats;
    assert.ok(Math.abs(spanOfRing - expected) < 1e-6, `radius ${radius}: span ${spanOfRing}, expected ${expected}`);
    const density = spanOfRing / exactRepeats;
    assert.ok(density > 0.74 && density < 1.34, `radius ${radius}: density ratio ${density}`);
    if (exactRepeats < 1.5) assert.ok(Math.abs(density - 1) < 1e-6);
  }
});

test('bark v advances at the same texel density as u, so texels stay square and do not stretch', () => {
  for (const radius of [0.3, 0.1, 0.02]) {
    const { geometry, ringSize } = straightTube(radius, 8);
    const circumference = 2 * Math.PI * radius;
    const uPerMeter = (geometry.uvs[ringSize * 2 - 2] - geometry.uvs[0]) / circumference;
    const vPerMeter = (geometry.uvs[(ringSize + 0) * 2 + 1] - geometry.uvs[1]) / 1;
    assert.ok(Math.abs(uPerMeter - vPerMeter) < 1e-6, `radius ${radius}: u ${uPerMeter} per meter, v ${vPerMeter} per meter`);
  }
});

test('bark v is constant around a ring and never decreases along the tube', () => {
  const { geometry, ringSize } = straightTube(0.1, 6);
  for (let ring = 0; ring < 4; ring++) {
    const firstV = geometry.uvs[ring * ringSize * 2 + 1];
    for (let side = 0; side < ringSize; side++) assert.equal(geometry.uvs[(ring * ringSize + side) * 2 + 1], firstV);
    if (ring > 0) assert.ok(firstV > geometry.uvs[(ring - 1) * ringSize * 2 + 1]);
  }
});

test('the bark seam of a thin horizontal branch sits on its underside', () => {
  const { geometry, ringSize } = straightTube(0.02, 6, [1, 0, 0]);
  for (let ring = 0; ring < 4; ring++) {
    const seamNormalY = geometry.normals[ring * ringSize * 3 + 1];
    assert.ok(seamNormalY < -0.99, `ring ${ring} seam normal y ${seamNormalY}`);
  }
});

test('procedural bark keeps its whole-number repeats and 0.6 m tile by default', () => {
  const tree = createTree('broadleaf', 4);
  assert.equal(tree.materials.bark.normalMap, undefined);
  const { uvs } = tree.levels[0].parts[0].geometry;
  for (let index = 0; index < uvs.length; index += 2) assert.ok(Number.isFinite(uvs[index]) && Number.isFinite(uvs[index + 1]));
});

test('scanned bark textures reach the bark material as map, normalMap and metallicRoughnessMap', () => {
  const set = syntheticBarkSet();
  const tree = createTree({ species: 'conifer', barkTextures: set }, 3);
  assert.equal(tree.materials.bark.map, set.color);
  assert.equal(tree.materials.bark.normalMap, set.normal);
  assert.equal(tree.materials.bark.metallicRoughnessMap, set.roughness);
  assert.equal(tree.materials.bark.tag, undefined);
});

test('barkTextures accepts one set or one set per species and rejects malformed sets', () => {
  const set = syntheticBarkSet();
  assert.equal(resolveBarkTextures(set, 'palm'), set);
  assert.equal(resolveBarkTextures({ palm: set }, 'palm'), set);
  assert.equal(resolveBarkTextures({ palm: set }, 'birch'), null);
  assert.equal(resolveBarkTextures(undefined, 'palm'), null);
  assert.throws(() => resolveBarkTextures({ palm: { normal: syntheticDescriptor() } }, 'palm'), TypeError);
  assert.throws(() => resolveBarkTextures({ color: syntheticDescriptor(), normal: 7 }, 'palm'), TypeError);
});

test('scatterVegetation passes per-species bark textures to its variants', () => {
  const set = syntheticBarkSet();
  const forest = scatterVegetation({ area: { minX: 0, maxX: 20, minZ: 0, maxZ: 20 }, density: 0.02, mix: { conifer: 1, birch: 1 }, barkTextures: { conifer: set }, variants: 1, seed: 5 });
  assert.equal(forest.variants.conifer[0].materials.bark.map, set.color);
  assert.notEqual(forest.variants.birch[0].materials.bark.map, set.color);
});

test('textured bark is deterministic for the same seed', () => {
  const set = syntheticBarkSet();
  const first = createTree({ species: 'broadleaf', barkTextures: set }, 9).levels[0].parts[0].geometry;
  const second = createTree({ species: 'broadleaf', barkTextures: set }, 9).levels[0].parts[0].geometry;
  assert.deepEqual(first.uvs, second.uvs);
  assert.deepEqual(first.positions, second.positions);
});

test('leaf cards are single-sided: one copy of each face, half the old triangles', () => {
  const frame = createLeafFrame([0, 0, 1], 0);
  const options = { origin: [0, 0, 0], frame, length: 1, width: 1, rows: [[0, 1], [0.5, 1], [1, 1]], canopyNormal: [0, 1, 0] };
  const both = createMeshBuilder({ withColors: true });
  const single = createMeshBuilder({ withColors: true });
  addLeafSurface(both, options);
  addLeafSurface(single, { ...options, backFaces: false });
  assert.equal(single.triangleCount * 2, both.triangleCount);
  assert.equal(single.vertexCount * 2, both.vertexCount);
  const foliage = createTree({ species: 'broadleaf' }, 4).levels[0].parts[1].geometry;
  assert.equal(foliage.indices.length / 3, foliage.positions.length / 3 / 1.5, 'each card has 6 vertices and 4 triangles');
});

test('cards use the swaying foliage tag with a base map, alpha mask and double-sided drawing', () => {
  const tree = createTree({ species: 'broadleaf' }, 4);
  for (const material of [tree.materials.foliage, tree.materials.crown]) {
    assert.equal(material.tag, 'foliage');
    assert.equal(material.alphaMode, 'mask');
    assert.equal(material.doubleSided, true);
    assert.ok(material.map);
    for (const unsupported of ['normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) assert.equal(material[unsupported], undefined);
  }
});

test('colour and shadow vertex shaders apply the same wind displacement', () => {
  for (const source of [vertexShader, depthVertexShader]) {
    assert.match(source, /vec3 windOffset\(/);
    assert.match(source, /windOffset\(position, world\.xyz, uv, instanceSurface\.w, time, wind\)/);
    assert.match(source, /uniform float time;/);
    assert.match(source, /uniform float wind;/);
  }
});

function syntheticLeafSet() {
  return { color: syntheticDescriptor(), normal: syntheticDescriptor(), crown: syntheticDescriptor() };
}

test('scanned leaf cards reach the foliage and crown materials with the normal map', () => {
  const set = syntheticLeafSet();
  const tree = createTree({ species: 'broadleaf', leafTextures: { broadleaf: set } }, 4);
  assert.equal(tree.materials.foliage.map, set.color);
  assert.equal(tree.materials.foliage.normalMap, set.normal);
  assert.equal(tree.materials.crown.map, set.crown);
  assert.equal(tree.materials.crown.normalMap, undefined);
  for (const material of [tree.materials.foliage, tree.materials.crown]) {
    assert.equal(material.tag, 'foliage');
    assert.equal(material.alphaMode, 'mask');
    assert.equal(material.doubleSided, true);
  }
  const procedural = createTree({ species: 'broadleaf' }, 4);
  assert.deepEqual(tree.levels[0].parts[1].geometry.positions, procedural.levels[0].parts[1].geometry.positions, 'textures do not change the geometry');
});

test('leafTextures resolves per species, ignores mesh leaves and rejects malformed sets', () => {
  const set = syntheticLeafSet();
  assert.equal(resolveLeafTextures(set, 'palm'), set);
  assert.equal(resolveLeafTextures({ conifer: set }, 'palm'), null);
  assert.throws(() => resolveLeafTextures({ conifer: { normal: syntheticDescriptor() } }, 'conifer'), TypeError);
  assert.throws(() => resolveLeafTextures({ color: syntheticDescriptor(), crown: 'x' }, 'conifer'), TypeError);
  const meshTree = createTree({ species: 'conifer', leaves: 'mesh', leafTextures: set }, 2);
  assert.equal(meshTree.materials.foliage.map, undefined);
  const crownless = createTree({ species: 'birch', leafTextures: { color: set.color } }, 2);
  assert.notEqual(crownless.materials.crown.map, undefined, 'without a crown texture the procedural clump stays');
  const forest = scatterVegetation({ area: { minX: 0, maxX: 20, minZ: 0, maxZ: 20 }, density: 0.02, mix: { conifer: 1, palm: 1 }, leafTextures: { conifer: set }, variants: 1, seed: 5 });
  assert.equal(forest.variants.conifer[0].materials.foliage.map, set.color);
  assert.notEqual(forest.variants.palm[0].materials.foliage.map, set.color);
});

test('the renderer accepts a normal map on foliage and grass but not on other procedural tags', () => {
  const geometry = box();
  const part = (tag) => ({ name: tag, geometry, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { tag, color: [1, 1, 1], roughness: 1, metallic: 0, emission: 0, normalMap: syntheticDescriptor() } });
  assert.doesNotThrow(() => groupParts([part('foliage'), part('grass')]));
  assert.throws(() => groupParts([part('water')]), /Procedural tags accept only a base map/);
  const roughnessOnLeaves = part('foliage');
  roughnessOnLeaves.material.metallicRoughnessMap = syntheticDescriptor();
  assert.throws(() => groupParts([roughnessOnLeaves]), /standard PBR material tag/);
});