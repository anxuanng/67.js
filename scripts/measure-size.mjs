// Measures what an app pays for each package entry, and for small scenes against three.js: npm run size
// It fails when a bundle passes its budget in bench/size/budgets.json. --update-baseline rewrites the baseline after a
// merge-ready change, and --set-budgets also resets each budget to 2% over its current size.
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { budgetsFrom, compareToBudgets, formatRows, initialOutputPaths } from './size-budget.mjs';

const BUDGETS_PATH = 'bench/size/budgets.json';
const BASELINE_PATH = 'bench/size/baseline.json';
const EXTERNAL_PACKAGES = ['manifold-3d', '@dimforge/rapier3d-compat'];
const CORE_ENTRY = 'core';

// Each scene does the same small job in both engines, so a size difference is the cost of the engine.
const SCENES = {
  'lit-box': {
    three: `
      import { Scene, PerspectiveCamera, WebGLRenderer, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight } from 'three';
      const scene = new Scene();
      const renderer = new WebGLRenderer();
      scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), new DirectionalLight());
      renderer.render(scene, new PerspectiveCamera());`,
    engine: `
      import { Renderer67 } from './src/renderer.js';
      import { box } from './src/geometry.js';
      const material = { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.5 };
      const parts = [{ name: 'box', geometry: box(0, 1), matrix: new Float32Array(16), material }];
      new Renderer67(document.createElement('canvas'), parts, {}).render({ eye: [3, 3, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 });`,
  },
  'gltf-box': {
    three: `
      import { Scene, PerspectiveCamera, WebGLRenderer, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight } from 'three';
      import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
      const scene = new Scene();
      const renderer = new WebGLRenderer();
      new GLTFLoader().load('x.glb', model => scene.add(model.scene));
      scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), new DirectionalLight());
      renderer.render(scene, new PerspectiveCamera());`,
    engine: `
      import { Renderer67 } from './src/renderer.js';
      import { parseGltf } from './src/gltf.js';
      parseGltf(new ArrayBuffer(0)).then(asset => new Renderer67(document.createElement('canvas'), asset.parts, {}).render({}));`,
  },
  'agent-scene': {
    engine: `
      import { createAgentScene } from './src/agent-scene.js';
      import { Renderer67 } from './src/renderer.js';
      const scene = createAgentScene({});
      new Renderer67(document.createElement('canvas'), scene.parts, {}).render(scene.camera);`,
  },
};

function gzipSize(contents) {
  return gzipSync(contents, { level: 9 }).length;
}

// Dynamic imports become separate chunks. What a page pays at start is the entry chunk and every chunk it imports
// statically; the rest loads when a feature asks for it. Both are reported so lazy code never hides.
function chunkSizes(result) {
  const outputsByPath = new Map(result.outputFiles.map(file => [relative(process.cwd(), file.path).replaceAll('\\', '/'), file]));
  const initialPaths = initialOutputPaths(result.metafile);
  const sizeOf = paths => {
    const parts = [...paths].map(path => outputsByPath.get(path).contents);
    const bytes = Buffer.concat(parts);
    return { min: bytes.length, gzip: parts.reduce((total, part) => total + gzipSize(part), 0), brotli: parts.reduce((total, part) => total + brotliCompressSync(part).length, 0) };
  };
  return { initial: sizeOf(initialPaths), all: sizeOf(outputsByPath.keys()) };
}

async function measureSource(contents) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'js' },
    bundle: true, minify: true, format: 'esm', write: false, treeShaking: true, metafile: true,
    splitting: true, outdir: 'size-output',
    external: EXTERNAL_PACKAGES, logLevel: 'silent', target: 'es2022',
    loader: { '.css': 'empty', '.json': 'json' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return chunkSizes(result);
}

async function packageEntries() {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const addons = Object.keys(manifest.exports).filter(key => key.startsWith('./addons/')).map(key => key.slice('./addons/'.length));
  return { [CORE_ENTRY]: 'src/index.js', ...Object.fromEntries(addons.map(name => [name, `src/${name}.js`])) };
}

// A bundle with on-demand code gets a second row, so the total after every lazy chunk is visible and budgeted.
function addMeasured(measured, name, sizes) {
  measured[name] = sizes.initial;
  if (sizes.all.gzip !== sizes.initial.gzip) measured[`${name}+lazy`] = sizes.all;
}

async function measureAll() {
  const measured = {};
  for (const [name, path] of Object.entries(await packageEntries())) {
    const absolute = resolve(path).replace(/\\/g, '/');
    addMeasured(measured, `entry:${name}`, await measureSource(`export * from '${absolute}';`));
  }
  for (const [name, scene] of Object.entries(SCENES)) addMeasured(measured, `scene:${name}`, await measureSource(scene.engine));
  return measured;
}

async function measureThree() {
  const measured = {};
  for (const [name, scene] of Object.entries(SCENES)) {
    if (scene.three) measured[name] = (await measureSource(scene.three)).initial;
  }
  return measured;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 1)}\n`);
}

function printComparisonWithThree(measured, three, goals) {
  console.log('\nThe same scene in both engines, in bytes gzip:');
  for (const [name, threeSize] of Object.entries(three)) {
    const engineSize = measured[`scene:${name}`].gzip;
    const goal = goals[name] === undefined ? '' : `, goal ${goals[name]}`;
    console.log(`  ${name.padEnd(14)} 67js ${engineSize}, three.js ${threeSize.gzip}${goal}`);
  }
  for (const [name, goal] of Object.entries(goals)) {
    if (!three[name]) console.log(`  ${name.padEnd(14)} 67js ${measured[`scene:${name}`].gzip}, no three.js equivalent, goal ${goal}`);
  }
}

const flags = new Set(process.argv.slice(2));
const measured = await measureAll();
const three = await measureThree();
const budgetFile = await readJson(BUDGETS_PATH);
const baselineFile = await readJson(BASELINE_PATH);

if (flags.has('--set-budgets')) budgetFile.budgets = budgetsFrom(measured);
if (flags.has('--set-budgets') || flags.has('--update-baseline')) {
  const threeManifest = await readJson('node_modules/three/package.json');
  await writeJson(BUDGETS_PATH, budgetFile);
  await writeJson(BASELINE_PATH, { threeVersion: threeManifest.version, three, bundles: measured });
}

const { rows, problems } = compareToBudgets(measured, budgetFile.budgets, baselineFile.bundles);
console.log(formatRows(rows));
printComparisonWithThree(measured, three, budgetFile.goals);
if (problems.length) {
  console.error(`\n${problems.length} size problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log('\nEvery bundle is within its budget.');
