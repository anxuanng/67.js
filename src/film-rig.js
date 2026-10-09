import { mat4, quat } from 'gl-matrix';
import { createAnimationClip, compileAnimationSampler } from './animation.js';
import { createSceneGraph } from './scene-graph.js';

// Times are relative to the set's first shot, matching sampleFilm(). Repeated
// values hold a thought; movements happen between those holds, never on a loop.
// Columns: time, pitch, yaw, left arm, right arm, brow, mouth tension, gaze.
const PERFORMANCES = {
  portrait: {
    poses: [
      [0, 0.035, -0.10, 0.02, -0.025, 0.1, 0.15, -0.5],
      [2.2, 0.035, -0.10, 0.02, -0.025, 0.1, 0.15, -0.5],
      [3.5, 0.005, 0.04, 0.01, -0.06, 0.32, 0.35, 0.3],
      [8.8, 0.005, 0.04, 0.01, -0.06, 0.32, 0.35, 0.3],
      [16, -0.025, 0.11, 0.015, -0.045, 0.4, 0.45, 0.1],
      [17.2, -0.025, 0.11, 0.015, -0.045, 0.4, 0.45, 0.1],
      [18, 0.018, 0.065, 0.015, -0.08, 0.68, 0.75, -0.35],
      [20, 0.018, 0.065, 0.015, -0.08, 0.68, 0.75, -0.35],
    ],
    blinks: [3.15, 7.4, 17.65],
  },
  office: {
    poses: [
      [0, 0.06, -0.08, -0.06, -0.025, 0.15, 0.12, -0.4],
      [2, 0.06, -0.08, -0.06, -0.025, 0.15, 0.12, -0.4],
      [4, 0, 0.06, -0.10, -0.12, 0.28, 0.2, 0.5],
      [9, 0, 0.06, -0.10, -0.12, 0.28, 0.2, 0.5],
      [53, 0.025, -0.16, 0.01, -0.035, 0.45, 0.5, -0.6],
      [57, 0.025, -0.16, 0.01, -0.035, 0.45, 0.5, -0.6],
      [59, -0.035, 0.05, -0.025, -0.15, 0.5, 0.2, 0.2],
      [65, -0.035, 0.05, -0.025, -0.15, 0.5, 0.2, 0.2],
      [85, 0.04, 0.10, -0.015, -0.04, 0.6, 0.6, 0.1],
      [90, 0.04, 0.10, -0.015, -0.04, 0.6, 0.6, 0.1],
      [154, 0.07, -0.05, 0.01, -0.02, 0.8, 0.7, -0.25],
      [156, 0.07, -0.05, 0.01, -0.02, 0.8, 0.7, -0.25],
    ],
    blinks: [3.6, 7.8, 58.1, 63.2, 87.3, 155.1],
  },
  laboratory: {
    poses: [
      [0, 0.09, -0.05, -0.1, -0.22, 0.3, 0.2, -0.3],
      [2, 0.09, -0.05, -0.1, -0.22, 0.3, 0.2, -0.3],
      [3.2, 0.015, 0.13, -0.05, -0.10, 0.12, 0.08, 0.5],
      [5, 0.015, 0.13, -0.05, -0.10, 0.12, 0.08, 0.5],
      [92, 0.04, -0.10, -0.08, -0.12, 0.6, 0.5, -0.2],
      [95, 0.04, -0.10, -0.08, -0.12, 0.6, 0.5, -0.2],
      [97, -0.02, 0.06, -0.015, -0.04, 0.7, 0.6, 0.2],
      [99, -0.02, 0.06, -0.015, -0.04, 0.7, 0.6, 0.2],
    ],
    blinks: [2.7, 94.2, 98.1],
  },
  settlement: {
    poses: [
      [0, 0.025, -0.08, 0.015, -0.02, 0.1, 0.1, -0.4],
      [4, 0.025, -0.08, 0.015, -0.02, 0.1, 0.1, -0.4],
      [7, -0.025, 0.14, -0.08, -0.025, 0.15, 0.15, 0.6],
      [19, -0.025, 0.14, -0.08, -0.025, 0.15, 0.15, 0.6],
      [22, 0.015, -0.03, -0.025, -0.08, 0.25, 0.25, -0.2],
      [28, 0.015, -0.03, -0.025, -0.08, 0.25, 0.25, -0.2],
    ],
    blinks: [5.8, 13.4, 21.4, 26.2],
  },
  control: {
    poses: [
      [0, 0.10, -0.07, -0.12, -0.18, 0.2, 0.1, -0.4],
      [2, 0.10, -0.07, -0.12, -0.18, 0.2, 0.1, -0.4],
      [3.5, 0.02, 0.12, -0.06, -0.09, 0.3, 0.25, 0.4],
      [6, 0.02, 0.12, -0.06, -0.09, 0.3, 0.25, 0.4],
      [126, 0.06, -0.12, -0.04, -0.12, 0.5, 0.55, -0.3],
      [129, 0.06, -0.12, -0.04, -0.12, 0.5, 0.55, -0.3],
      [131, -0.01, 0.08, -0.08, -0.05, 0.6, 0.6, 0.25],
      [133, -0.01, 0.08, -0.08, -0.05, 0.6, 0.6, 0.25],
      [158, 0.08, -0.04, -0.12, -0.2, 0.75, 0.65, -0.2],
      [161, 0.08, -0.04, -0.12, -0.2, 0.75, 0.65, -0.2],
      [169, -0.015, 0.1, -0.025, -0.06, 0.8, 0.7, 0.15],
      [171, -0.015, 0.1, -0.025, -0.06, 0.8, 0.7, 0.15],
    ],
    blinks: [2.7, 128.2, 132, 159.5, 170.3],
  },
};
const CHANNELS = ['pitch', 'yaw', 'leftArm', 'rightArm', 'brow', 'mouth', 'gaze'];

/** Rigid joints and facial pigment deform from absolute time without frame state. */
export function createFilmActorRig(parts, sceneName = 'portrait') {
  const joints = new Map();
  const bindings = [];
  const faces = parts.filter(part => part.name === 'Continuous sculpted head');
  for (const part of parts) {
    if (!part.actorJoint) continue;
    joints.set(part.actorJoint.name, part.actorJoint);
    bindings.push({ part, base: mat4.clone(part.matrix), joint: part.actorJoint.name });
  }
  if (!joints.size) return () => {};
  const performance = PERFORMANCES[sceneName] ?? PERFORMANCES.laboratory;
  const clip = createAnimationClip({
    duration: performance.poses.at(-1)[0],
    tracks: CHANNELS.map((channel, index) => ({
      target: channel,
      property: 'value',
      interpolation: 'SMOOTH',
      keyframes: performance.poses.map(pose => ({ time: pose[0], value: pose[index + 1] })),
    })),
  });
  const graph = createSceneGraph(Array.from(joints.values(), joint => ({ name: joint.name, pivot: joint.pivot })));
  const actors = faces.map((face, index) => {
    const prefix = face.actorJoint.name.slice(0, -5);
    return {
      face,
      index,
      sampler: compileAnimationSampler(clip),
      joints: Array.from(joints.values()).filter(joint => joint.name.startsWith(`${prefix} `)).map(joint => ({
        ...joint,
        matrix: graph.getNode(joint.name).localMatrix,
      })),
    };
  });
  for (const binding of bindings) binding.worldMatrix = graph.getNode(binding.joint).worldMatrix;
  const orientation = quat.create();
  const pitchRotation = quat.create();
  return time => {
    for (const actor of actors) {
      const actorTime = time + actor.index * 0.43;
      const tracks = actor.sampler.sample(actorTime);
      const value = channel => tracks[channel].output[0];
      for (const joint of actor.joints) {
        if (joint.kind === 'head') {
          quat.setAxisAngle(orientation, [0, 1, 0], value(1));
          quat.setAxisAngle(pitchRotation, [Math.cos(joint.rotation), 0, -Math.sin(joint.rotation)], value(0));
          quat.multiply(orientation, orientation, pitchRotation);
        } else {
          quat.setAxisAngle(orientation, joint.axis, value(joint.side < 0 ? 2 : 3));
        }
        mat4.fromQuat(joint.matrix, orientation);
      }
      let closure = 0;
      for (const blinkTime of performance.blinks) {
        const phase = Math.abs(actorTime - blinkTime) / 0.13;
        if (phase < 1) closure = Math.cos(phase * Math.PI / 2) ** 2;
      }
      actor.face.morph.weights.set([closure, value(4), value(5), value(6)]);
    }
    graph.update();
    for (const binding of bindings) mat4.multiply(binding.part.matrix, binding.worldMatrix, binding.base);
  };
}
