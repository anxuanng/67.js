import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const release = JSON.parse(await readFile('public/release.json', 'utf8'));
const archive = resolve('public', release.tarball.slice(1));
const binary = await readFile(archive);
assert.equal(release.version, metadata.version);
assert.equal(release.packageName, metadata.name);
assert.equal(release.packageAlias, '67js');
assert.equal(release.integrity, `sha512-${createHash('sha512').update(binary).digest('base64')}`);
assert.ok(binary.length < 1024 * 1024, 'Library and optional addon wrappers must fit within a 1 MiB archive.');
assert.ok((await readFile('build/67.module.js')).length < 150000, 'The core must exclude the optional asset decoder.');
const consumer = await mkdtemp(resolve(tmpdir(), '67js-consumer-'));
await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
// Release preparation preserves the registry archive for an already-published version.
// Validate the current source through a separate local pack, without replacing that archive.
const sourcePack = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', consumer], { windowsHide: true, encoding: 'utf8' });
assert.equal(sourcePack.status, 0, sourcePack.stderr);
const sourcePackResult = JSON.parse(sourcePack.stdout);
const packedSource = Array.isArray(sourcePackResult) ? sourcePackResult[0] : sourcePackResult[metadata.name];
assert.ok(packedSource?.filename, 'npm pack must return a source archive.');
assert.ok(packedSource.size < 1024 * 1024, 'The current source package must fit within a 1 MiB archive.');
const sourceArchive = resolve(consumer, packedSource.filename);
const installed = spawnSync(process.execPath, [npmCli, 'install', `67js@file:${sourceArchive.replaceAll('\\', '/')}`, '@dimforge/rapier3d-compat@0.21.0', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, windowsHide: true, encoding: 'utf8' });
assert.equal(installed.status, 0, installed.stderr);
const example = `import assert from 'node:assert/strict';
import { VERSION, Renderer67, box, assemblyOffset, cameraView, fitPerspectiveDistance, createAnimationClip, sampleAnimationClip, EFFECT_PRESETS, createMorphPose, MAX_MORPH_TARGETS, exportGlb } from '67js';
import { createModel } from '67js/addons/model';
import * as nature from '67js/addons/nature';
import * as film from '67js/addons/film';
import { createMotionScene } from '67js/addons/motion';
import { createCanvas2D } from '67js/addons/canvas2d';
import { parseGltf } from '67js/addons/gltf';
import { createPhysicsScene, planPhysicsScene } from '67js/addons/physics';
assert.equal(VERSION, '${metadata.version}');
assert.equal(typeof Renderer67, 'function');
assert.equal(MAX_MORPH_TARGETS, 64);
assert.ok(createMorphPose(64).weights instanceof Float32Array);
const morphGeometry = box();
morphGeometry.morphTargets = [{ positions: new Float32Array(morphGeometry.positions.length).fill(0.125) }];
const morphPose = createMorphPose(1);
morphPose.weights[0] = -0.5;
const morphSnapshot = exportGlb([{ name: 'packed morph', geometry: morphGeometry, morph: morphPose, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.7, emission: 0 } }]);
const morphHeader = new DataView(morphSnapshot);
const morphDocument = JSON.parse(new TextDecoder().decode(new Uint8Array(morphSnapshot, 20, morphHeader.getUint32(12, true))));
assert.deepEqual(morphDocument.nodes[0].weights, [-0.5]);
assert.ok(Number.isInteger(morphDocument.meshes[0].primitives[0].targets[0].POSITION));
const importedMorph = await parseGltf(morphSnapshot);
assert.equal(importedMorph.parts.length, 1);
assert.deepEqual(Array.from(importedMorph.parts[0].morph.weights), [-0.5]);
assert.deepEqual(importedMorph.parts[0].geometry.morphTargets[0].positions, morphGeometry.morphTargets[0].positions);
importedMorph.dispose();
assert.throws(() => new Renderer67({}, [], { environment: { pointLights: Array(9).fill({ position: [0, 1, 0] }) } }), /at most/, 'Packed renderer must validate light limits before requesting a GPU context.');
assert.ok(box().positions.length > 0);
const parts = createModel();
assert.equal(parts.length, 574);
assert.ok(parts.every(part => assemblyOffset(part, 1).some(value => value !== 0)));
assert.ok(Object.keys(nature).length > 0);
assert.ok(Object.keys(film).length > 0);
assert.equal(cameraView('top').projection, 'orthographic');
const fitBounds = { minimum: [-1, -1, -1], maximum: [1, 1, 1] };
const fitView = { eye: [0, 0, 5], target: [0, 0, 0], fov: 45, far: 100 };
const fitDistance = fitPerspectiveDistance(fitBounds, fitView, 0.5, 1);
assert.ok(Math.abs(fitDistance - (1 + 2 / Math.tan(Math.PI / 8))) < 1e-10);
assert.ok(film.sampleFilm(162, { aspect: 0.5 }).camera.eye.every(Number.isFinite));
assert.ok(EFFECT_PRESETS.cinematic.bloom.strength > 0);
const clip = createAnimationClip({ duration: 2, tracks: [{ target: 'cube', property: 'value', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 2 }] }] });
assert.equal(sampleAnimationClip(clip, 1)[0].value, 1);
assert.ok(createMotionScene().parts.length > 0);
assert.ok(createCanvas2D().parts.length > 0);
assert.equal(typeof parseGltf, 'function');
const physicsDefinition = {
  bodies: [{ name: 'floor', type: 'fixed', translation: [0, -0.5, 0] }, { name: 'ball', translation: [0, 2, 0] }],
  colliders: [{ name: 'floor', body: 'floor', shape: 'cuboid', halfExtents: [4, 0.5, 4] }, { name: 'ball', body: 'ball', shape: 'ball', radius: 0.25, mass: 1 }],
};
assert.ok(planPhysicsScene(physicsDefinition, { frameCount: 121 }).timelineBytes > 0);
const physics = await createPhysicsScene(physicsDefinition, { frameCount: 121 });
const finalPose = physics.sample(physics.duration);
assert.ok(finalPose[8] >= 0.23 && finalPose[8] < 0.3, 'Packed addon wrapper must run real Rapier floor contact.');
physics.sample(0);
assert.deepEqual(physics.sample(physics.duration), finalPose);
physics.dispose();
const motorScene = await createPhysicsScene({
  gravity: [0, 0, 0],
  bodies: [{ name: 'base', type: 'fixed' }, { name: 'slider' }],
  colliders: [{ name: 'slider', body: 'slider', shape: 'ball', radius: 0.25, mass: 1 }],
  joints: [{ name: 'drive', type: 'prismatic', bodyA: 'base', bodyB: 'slider', axis: [1, 0, 0], limits: [-1, 1], motor: { mode: 'position', target: 0.5, stiffness: 40, damping: 8, maxForce: 10 } }],
}, { frameCount: 241 });
const motorPose = motorScene.sample(motorScene.duration);
assert.ok(Math.abs(motorPose[7] - 0.5) < 0.02, 'Packed motor API must reach its bounded slider target through the real solver.');
motorScene.sample(0);
assert.deepEqual(motorScene.sample(motorScene.duration), motorPose);
motorScene.dispose();
console.log('Clean consumer: core, geometry, addons, real physics contact and all574 explosion offsets passed.');`;
await writeFile(resolve(consumer, 'check.mjs'), example);
const result = spawnSync(process.execPath, ['check.mjs'], { cwd: consumer, windowsHide: true, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
console.log(result.stdout.trim());
