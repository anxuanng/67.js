export const CRADLE = Object.freeze({
  count: 5,
  radius: 0.15,
  spacing: 0.31,
  length: 1,
  pivotHeight: 1.15,
  depth: 1.72,
  duration: 8,
  timestep: 1 / 480,
  captureRate: 30,
});

export function cradlePivot(index) {
  return [(index - (CRADLE.count - 1) / 2) * CRADLE.spacing, CRADLE.pivotHeight, CRADLE.depth];
}

export const CRADLE_BAKE_OPTIONS = Object.freeze({
  timestep: CRADLE.timestep,
  frameCount: Math.round(CRADLE.duration / CRADLE.timestep) + 1,
  maxFrames: Math.round(CRADLE.duration / CRADLE.timestep) + 1,
  solverIterations: 12,
  maxMemoryBytes: 16 * 1024 * 1024,
});

/** The film uses an offline recording of contacts, rather than live simulation. */
export function createCradleDefinition() {
  const bodies = [{ name: 'rail', type: 'fixed', translation: [0, CRADLE.pivotHeight, CRADLE.depth] }];
  const colliders = [];
  const joints = [];
  for (let index = 0; index < CRADLE.count; index++) {
    const angle = index === 0 ? -0.62 : 0;
    const pivot = cradlePivot(index);
    const name = `Cradle ball ${index}`;
    bodies.push({
      name,
      translation: [pivot[0] + Math.sin(angle) * CRADLE.length, pivot[1] - Math.cos(angle) * CRADLE.length, pivot[2]],
      rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
      linearDamping: 0.002,
      angularDamping: 0.002,
      ccd: true,
    });
    colliders.push({ name, body: name, shape: 'ball', radius: CRADLE.radius, mass: 0.2, friction: 0, restitution: 0.995 });
    joints.push({ name: `Cradle hinge ${index}`, type: 'revolute', bodyA: 'rail', bodyB: name,
      anchorA: [pivot[0], 0, 0], anchorB: [0, CRADLE.length, 0], axis: [0, 0, 1] });
  }
  return { gravity: [0, -9.81, 0], bodies, colliders, joints };
}
