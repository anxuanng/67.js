import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { createPhysicsScene } from '../src/physics.js';
import { CRADLE, CRADLE_BAKE_OPTIONS, createCradleDefinition } from '../src/film-physics-definition.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const definition = createCradleDefinition();
const options = CRADLE_BAKE_OPTIONS;
const physics = await createPhysicsScene(definition, options);
try {
  const tracks = [];
  for (let index = 0; index < CRADLE.count; index++) {
    const target = `Cradle ball ${index}`;
    tracks.push({ target, property: 'translation', interpolation: 'LINEAR', keyframes: [] });
    tracks.push({ target, property: 'rotation', interpolation: 'LINEAR', keyframes: [] });
  }
  const pose = new Float32Array(physics.bodyNames.length * 7);
  for (let frame = 0; frame <= CRADLE.duration * CRADLE.captureRate; frame++) {
    const time = frame / CRADLE.captureRate;
    physics.sample(time, pose);
    for (let index = 0; index < CRADLE.count; index++) {
      const offset = physics.bodyIndex(`Cradle ball ${index}`) * 7;
      tracks[index * 2].keyframes.push({ time, value: Array.from(pose.subarray(offset, offset + 3)) });
      tracks[index * 2 + 1].keyframes.push({ time, value: Array.from(pose.subarray(offset + 3, offset + 7)) });
    }
  }
  const recording = {
    provenance: {
      solver: '@dimforge/rapier3d-compat@0.21.0',
      definitionHash: createHash('sha256').update(JSON.stringify({ definition, options })).digest('hex'),
      simulationRate: 1 / CRADLE.timestep,
      captureRate: CRADLE.captureRate,
      timelineBytes: physics.memoryPlan.timelineBytes,
    },
    duration: CRADLE.duration,
    loop: false,
    tracks,
  };
  const output = new URL('../src/film-physics-clip.json', import.meta.url);
  const text = `${JSON.stringify(recording)}\n`;
  await writeFile(output, text);
  console.log(JSON.stringify({ ...recording.provenance, capturedKeys: tracks.reduce((total, track) => total + track.keyframes.length, 0), fileBytes: Buffer.byteLength(text) }));
} finally {
  physics.dispose();
}
