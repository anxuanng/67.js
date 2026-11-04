import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Since the world materials moved out of the core bundle (#281), each addon that builds tagged world parts must load
// their shader code itself. Each case runs in a fresh process that imports only that addon, so an import another test
// happened to load cannot hide a missing one (#449).
const WORLD_ADDONS = [
  { module: 'nature.js', build: 'createNatureWorld()' },
  { module: 'terrain.js', build: 'createTerrain({ size: 16, resolution: 4, chunks: 1, levels: 1, material: { tag: "terrain", color: [1, 1, 1], metallic: 0, roughness: 1, emission: 0 } })' },
  { module: 'grass.js', build: 'createGrass({ area: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, density: 4 })' },
  { module: 'vegetation.js', build: 'createTree("broadleaf", 1)' },
];

function childScript({ module, build }) {
  const name = build.slice(0, build.indexOf('('));
  return `
    import { ${name} } from './src/${module}';
    import { createFragmentShader, createVertexShader } from './src/shaders.js';
    const built = ${build};
    const tags = new Set();
    const seen = new Set();
    function collect(value) {
      if (!value || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) return;
      seen.add(value);
      if (typeof value.tag === 'string') tags.add(value.tag);
      for (const child of Object.values(value)) collect(child);
    }
    collect(built);
    // The tags renderer.js (TAG_SHADER_FEATURES) turns into shader features; other tags such as rock draw with stock code.
    const tagFeatures = new Set(['floor', 'water', 'foliage', 'terrain', 'grass', 'fire', 'smoke', 'unlit']);
    const features = [...tags].filter(tag => tagFeatures.has(tag));
    if (features.length === 0) throw new Error('The world has no tagged parts, so this case checks nothing.');
    createVertexShader(features);
    createFragmentShader(features);
    console.log(JSON.stringify(features));
  `;
}

for (const addon of WORLD_ADDONS) {
  test(`${addon.module} alone loads the shader code its world parts need`, () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', childScript(addon)], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(Array.isArray(JSON.parse(output.trim().split('\n').at(-1))));
  });
}
