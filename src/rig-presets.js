// Rig presets place bones from a bounding box. Y is up and the character faces +Z, the recipe's forward axis.
// Humanoid bone names are the canonical names of `HUMANOID_BONES`, so `retargetClip` maps an authored rig without overrides.

export const RIG_PRESETS = Object.freeze(['humanoid', 'quadruped']);

// Knees point forward and elbows point back at rest: a two-bone solver with no pole bends toward the way the middle joint
// already sits off the line from root to end.
const KNEE_BEND = 0.012;
const ELBOW_BEND = -0.012;

function boundsFrame(bounds) {
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const center = bounds.max.map((value, axis) => (value + bounds.min[axis]) / 2);
  return { size, center, floorY: bounds.min[1], minimumZ: bounds.min[2] };
}

function humanoidLayout(bounds) {
  const { size, center, floorY } = boundsFrame(bounds);
  const height = size[1];
  const place = (x, y, z) => [center[0] + x * height, floorY + y * height, center[2] + z * height];
  const bones = [
    { name: 'hips', parent: null, head: place(0, 0.52, 0) },
    { name: 'spine', parent: 'hips', head: place(0, 0.58, 0) },
    { name: 'chest', parent: 'spine', head: place(0, 0.68, 0) },
    { name: 'neck', parent: 'chest', head: place(0, 0.8, 0) },
    { name: 'head', parent: 'neck', head: place(0, 0.86, 0), tail: place(0, 1, 0) },
  ];
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const name = bone => `${side}${bone}`;
    bones.push(
      { name: name('Shoulder'), parent: 'chest', head: place(sign * 0.03, 0.77, 0) },
      { name: name('UpperArm'), parent: name('Shoulder'), head: place(sign * 0.1, 0.77, 0) },
      { name: name('LowerArm'), parent: name('UpperArm'), head: place(sign * 0.12, 0.6, ELBOW_BEND) },
      { name: name('Hand'), parent: name('LowerArm'), head: place(sign * 0.135, 0.45, 0), tail: place(sign * 0.145, 0.37, 0) },
      { name: name('UpperLeg'), parent: 'hips', head: place(sign * 0.06, 0.5, 0) },
      { name: name('LowerLeg'), parent: name('UpperLeg'), head: place(sign * 0.065, 0.28, KNEE_BEND) },
      { name: name('Foot'), parent: name('LowerLeg'), head: place(sign * 0.065, 0.05, 0) },
      { name: name('Toes'), parent: name('Foot'), head: place(sign * 0.065, 0.02, 0.07), tail: place(sign * 0.065, 0.02, 0.12) },
    );
  }
  return bones;
}

function quadrupedLayout(bounds) {
  const { size, center, floorY, minimumZ } = boundsFrame(bounds);
  const [width, height, length] = size;
  const place = (x, y, z) => [center[0] + x * width, floorY + y * height, minimumZ + z * length];
  const bones = [
    { name: 'hips', parent: null, head: place(0, 0.62, 0.25) },
    { name: 'spine', parent: 'hips', head: place(0, 0.64, 0.45) },
    { name: 'chest', parent: 'spine', head: place(0, 0.64, 0.65) },
    { name: 'neck', parent: 'chest', head: place(0, 0.72, 0.78) },
    { name: 'head', parent: 'neck', head: place(0, 0.85, 0.86), tail: place(0, 0.85, 1) },
    { name: 'tail1', parent: 'hips', head: place(0, 0.64, 0.18) },
    { name: 'tail2', parent: 'tail1', head: place(0, 0.6, 0.1) },
    { name: 'tail3', parent: 'tail2', head: place(0, 0.55, 0.04), tail: place(0, 0.5, 0) },
  ];
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const legX = sign * 0.28;
    bones.push(
      { name: `${side}FrontUpperLeg`, parent: 'chest', head: place(legX, 0.6, 0.65) },
      { name: `${side}FrontLowerLeg`, parent: `${side}FrontUpperLeg`, head: place(legX, 0.33, 0.65 + ELBOW_BEND) },
      { name: `${side}FrontFoot`, parent: `${side}FrontLowerLeg`, head: place(legX, 0.1, 0.65), tail: place(legX, 0, 0.68) },
      { name: `${side}HindUpperLeg`, parent: 'hips', head: place(legX, 0.6, 0.25) },
      { name: `${side}HindLowerLeg`, parent: `${side}HindUpperLeg`, head: place(legX, 0.33, 0.25 + KNEE_BEND * 4) },
      { name: `${side}HindFoot`, parent: `${side}HindLowerLeg`, head: place(legX, 0.1, 0.25), tail: place(legX, 0, 0.28) },
    );
  }
  return bones;
}

const LAYOUTS = { humanoid: humanoidLayout, quadruped: quadrupedLayout };

/** Bones for a preset fitted to `bounds` ({ min, max } in armature space). `landmarks` replace a bone's head by name, or its tail as `<name>Tail`. */
export function presetBones(preset, bounds, landmarks = {}) {
  if (!Object.hasOwn(LAYOUTS, preset)) throw new RangeError(`Armature preset must be one of ${RIG_PRESETS.join(', ')}.`);
  const names = new Set();
  const bones = LAYOUTS[preset](bounds).map(bone => {
    names.add(bone.name);
    return { ...bone, head: landmarks[bone.name] ?? bone.head, ...(bone.tail || landmarks[`${bone.name}Tail`] ? { tail: landmarks[`${bone.name}Tail`] ?? bone.tail } : {}) };
  });
  for (const landmark of Object.keys(landmarks)) {
    const bone = landmark.endsWith('Tail') ? landmark.slice(0, -4) : landmark;
    if (!names.has(bone)) throw new RangeError(`Landmark ${landmark} does not name a ${preset} bone. Bones: ${[...names].join(', ')}.`);
  }
  return bones;
}
