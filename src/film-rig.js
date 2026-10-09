import { mat4, quat } from 'gl-matrix';
import { createAnimationClip } from './animation.js';
import { createAnimationMixer } from './animation-mixer.js';
import { createSceneGraph } from './scene-graph.js';

/** Rigid actor groups keep attached clothing and hands on the same authored joints. */
export function createFilmActorRig(parts) {
  const groups = new Map();
  const bindings = [];
  for (const part of parts) {
    if (!part.actorJoint) continue;
    const joint = part.actorJoint;
    if (!groups.has(joint.name)) groups.set(joint.name, joint);
    bindings.push({ part, base: mat4.clone(part.matrix), joint: joint.name });
  }
  if (!groups.size) return () => {};
  const graph = createSceneGraph(Array.from(groups.values(), joint => ({ name: joint.name, pivot: joint.pivot })));
  const tracks = Array.from(groups.values(), joint => {
    const poses = joint.kind === 'head'
      ? [[0, 0], [1.7, -0.055], [2.5, -0.055], [4.8, 0.095], [7, 0.095], [10.2, 0], [12, 0]]
      : [[0, 0], [2.2, -0.018], [4.3, -0.075], [5.7, -0.075], [8.8, -0.025], [10.5, 0], [12, 0]];
    return {
      target: joint.name,
      property: 'rotation',
      interpolation: 'SMOOTH',
      keyframes: poses.map(([time, angle]) => ({ time, value: Array.from(quat.setAxisAngle(quat.create(), joint.axis, angle)) })),
    };
  });
  const mixer = createAnimationMixer(graph.animationTargets);
  mixer.clipAction(createAnimationClip({ duration: 12, loop: true, tracks })).play({ at: 0 });
  for (const binding of bindings) binding.worldMatrix = graph.getNode(binding.joint).worldMatrix;
  return time => {
    mixer.apply(time);
    graph.update();
    for (const binding of bindings) mat4.multiply(binding.part.matrix, binding.worldMatrix, binding.base);
  };
}
