import { mat4 } from 'gl-matrix';
import { createModel } from './model.js';
import { EFFECT_PRESETS } from './effects.js';

const DURATION = 12;
const DRIVE_SPEED = 0.16;
// Keep this shoe centerline aligned with the polygon in createModel().
const TRACK_OUTLINE = [[0.095, -0.59], [0.095, 0.6], [0.32, 0.73], [0.66, 0.48], [0.7, -0.37], [0.38, -0.73]];
const WHEEL_PART_NAMES = new Set([
  'Track sprocket drum', 'Track exposed wheel disc', 'Track wheel rim',
  'Track wheel hub', 'Track hub retaining bolt', 'Track wheel bolt',
]);

function createTrackPath() {
  let perimeter = 0;
  const edges = TRACK_OUTLINE.map((start, index) => {
    const end = TRACK_OUTLINE[(index + 1) % TRACK_OUTLINE.length];
    const heightDelta = end[0] - start[0];
    const depthDelta = end[1] - start[1];
    const length = Math.hypot(heightDelta, depthDelta);
    const edge = { start, heightDelta, depthDelta, length, distance: perimeter, angle: -Math.atan2(heightDelta, depthDelta) };
    perimeter += length;
    return edge;
  });
  return { edges, perimeter };
}

function trackDistance(matrix, edges) {
  let closestDistance = Infinity;
  let distance = 0;
  for (const edge of edges) {
    const height = matrix[13] - edge.start[0];
    const depth = matrix[14] - edge.start[1];
    const fraction = Math.max(0, Math.min(1, (height * edge.heightDelta + depth * edge.depthDelta) / edge.length ** 2));
    const separation = Math.hypot(height - edge.heightDelta * fraction, depth - edge.depthDelta * fraction);
    if (separation < closestDistance) {
      closestDistance = separation;
      distance = edge.distance + edge.length * fraction;
    }
  }
  return distance;
}

function blendAngle(start, end, fraction) {
  const difference = Math.atan2(Math.sin(end - start), Math.cos(end - start));
  const easing = fraction * fraction * (3 - 2 * fraction);
  return start + difference * easing;
}

function sampleTrack(path, distance, result) {
  const wrappedDistance = ((distance % path.perimeter) + path.perimeter) % path.perimeter;
  const index = path.edges.findIndex(edge => wrappedDistance < edge.distance + edge.length);
  const edge = path.edges[index];
  const along = wrappedDistance - edge.distance;
  const fraction = along / edge.length;
  let angle = edge.angle;
  // Shoes hinge gradually at corners instead of snapping to a new edge angle.
  const hingeDistance = 0.025;
  if (along < hingeDistance) {
    const previous = path.edges[(index + path.edges.length - 1) % path.edges.length];
    angle = blendAngle(previous.angle, angle, 0.5 + along / (2 * hingeDistance));
  } else if (edge.length - along < hingeDistance) {
    const next = path.edges[(index + 1) % path.edges.length];
    angle = blendAngle(angle, next.angle, 0.5 + (along - edge.length) / (2 * hingeDistance));
  }
  result.height = edge.start[0] + edge.heightDelta * fraction;
  result.depth = edge.start[1] + edge.depthDelta * fraction;
  result.angle = angle;
}

function createJoint(pivot, entries) {
  return { pivot, inversePivot: pivot.map(value => -value), entries, local: mat4.create(), world: mat4.create() };
}

function poseJoint(joint, parent, pitch, yaw = 0, roll = 0) {
  mat4.fromTranslation(joint.local, joint.pivot);
  mat4.rotateY(joint.local, joint.local, yaw);
  mat4.rotateX(joint.local, joint.local, pitch);
  mat4.rotateZ(joint.local, joint.local, roll);
  mat4.translate(joint.local, joint.local, joint.inversePivot);
  mat4.multiply(joint.world, parent, joint.local);
  for (const entry of joint.entries) mat4.multiply(entry.part.matrix, joint.world, entry.base);
}

function createCharacterRig(entries) {
  const body = createJoint([0, 0.72, 0], entries.filter(entry => !entry.part.assembly.section.endsWith('track assembly')));
  const neckEntries = body.entries.filter(entry => entry.part.assembly.section === 'Neck linkage' || /eye housing|optical mechanism|lens assembly/.test(entry.part.assembly.section));
  const neck = createJoint([0, 1.86, -0.04], neckEntries.filter(entry => entry.part.name !== 'Neck yaw bearing'));
  const head = createJoint([0, 2.38, 0.12], neck.entries.filter(entry => entry.part.assembly.section !== 'Neck linkage' || entry.part.name === 'Binocular central bridge'));
  const arms = [-1, 1].map(side => {
    const section = side < 0 ? 'Left arm and claw' : 'Right arm and claw';
    const armEntries = entries.filter(entry => entry.part.assembly.section === section);
    const shoulder = createJoint([side * 0.8, 1.55, 0.07], armEntries.filter(entry => entry.part.name !== 'Shoulder pivot'));
    const elbow = createJoint([side * 1.015, 1.25, 0.22], shoulder.entries.filter(entry => /^(Forearm|Claw)/.test(entry.part.name)));
    const wrist = createJoint([side * 1.065, 1.13, 0.49], elbow.entries.filter(entry => entry.part.name.startsWith('Claw')));
    const fingers = [-1, 1].map(finger => createJoint(
      [side * 1.065 + finger * 0.09, 1.13, 0.675],
      wrist.entries.filter(entry => entry.part.name !== 'Claw palm' && Math.sign(entry.base[12] - side * 1.065) === finger),
    ));
    return { side, shoulder, elbow, wrist, fingers };
  });
  return { body, neck, head, arms };
}

export function createWallEPreviewScene() {
  const parts = createModel();
  const entries = parts.map(part => ({ part, base: mat4.clone(part.matrix) }));
  const path = createTrackPath();
  const rig = createCharacterRig(entries);
  const shoes = entries.filter(({ part }) => part.name === 'Caterpillar steel shoe' || part.name === 'Caterpillar rubber traction pad');
  for (const shoe of shoes) {
    shoe.distance = trackDistance(shoe.base, path.edges);
    shoe.angle = Math.atan2(shoe.base[6], shoe.base[5]);
  }
  const wheelCenters = entries.filter(({ part }) => part.name === 'Track sprocket drum');
  const wheels = entries.filter(({ part }) => WHEEL_PART_NAMES.has(part.name));
  for (const wheel of wheels) {
    const sideCenters = wheelCenters.filter(center => Math.sign(center.base[12]) === Math.sign(wheel.base[12]));
    wheel.center = sideCenters.reduce((closest, center) => {
      const separation = candidate => Math.hypot(wheel.base[13] - candidate.base[13], wheel.base[14] - candidate.base[14]);
      return separation(center) < separation(closest) ? center : closest;
    });
    wheel.radius = Math.hypot(wheel.center.base[0], wheel.center.base[1], wheel.center.base[2]);
  }
  const rotation = mat4.create();
  const root = mat4.create();
  const trackPosition = {};
  const frame = { target: [0, 1.5, 0], rootOffset: [0, 0, 0], effects: EFFECT_PRESETS.neutral };

  // Gaze is normalized screen input: positive x looks right, positive y looks up.
  // The caller owns gaze smoothing and playback/assembly pauses.
  function sample(time, interaction = {}) {
    if (!Number.isFinite(time)) throw new TypeError('WALL·E preview time must be finite seconds.');
    const gaze = interaction.gaze;
    if (gaze !== undefined && (!Array.isArray(gaze) || gaze.length !== 2 || !gaze.every(Number.isFinite))) {
      throw new TypeError('WALL·E gaze must contain two finite normalized coordinates.');
    }
    const gazeX = gaze ? Math.max(-1, Math.min(1, gaze[0])) : 0;
    const gazeY = gaze ? Math.max(-1, Math.min(1, gaze[1])) : 0;
    const phase = (time % DURATION) / DURATION * Math.PI * 2;
    const travel = time * DRIVE_SPEED;
    if (!Number.isFinite(Math.fround(travel))) throw new RangeError('WALL·E travel exceeds the Float32 scene coordinate range.');
    frame.rootOffset[2] = travel;
    frame.target[2] = travel;
    mat4.fromTranslation(root, frame.rootOffset);
    for (const { part, base } of entries) {
      part.matrix.set(base);
      part.matrix[14] += travel;
    }
    const curiosity = Math.sin(phase);
    const secondary = Math.sin(phase * 2);
    poseJoint(rig.body, root, 0.009 * secondary, 0, 0.012 * curiosity);
    rig.body.world[13] += 0.008 * Math.sin(phase * 4);
    for (const entry of rig.body.entries) mat4.multiply(entry.part.matrix, rig.body.world, entry.base);
    poseJoint(rig.neck, rig.body.world, 0, 0.38 * curiosity + 0.32 * gazeX);
    poseJoint(rig.head, rig.neck.world, 0.13 * secondary - 0.18 * gazeY, 0, 0.09 * curiosity);
    for (const arm of rig.arms) {
      const gesture = arm.side * curiosity;
      poseJoint(arm.shoulder, rig.body.world, -0.16 * gesture, 0, arm.side * 0.035 * secondary);
      poseJoint(arm.elbow, arm.shoulder.world, -0.2 * gesture);
      poseJoint(arm.wrist, arm.elbow.world, 0.08 * secondary, 0.07 * gesture);
      arm.fingers.forEach((finger, index) => poseJoint(finger, arm.wrist.world, 0, (index === 0 ? -1 : 1) * 0.14 * gesture));
    }
    for (const shoe of shoes) {
      sampleTrack(path, shoe.distance - travel, trackPosition);
      mat4.fromXRotation(rotation, trackPosition.angle - shoe.angle);
      mat4.multiply(shoe.part.matrix, rotation, shoe.base);
      shoe.part.matrix[12] = shoe.base[12];
      shoe.part.matrix[13] = trackPosition.height;
      shoe.part.matrix[14] = trackPosition.depth + travel;
    }
    for (const wheel of wheels) {
      const angle = (travel % (Math.PI * 2 * wheel.radius)) / wheel.radius;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const height = wheel.base[13] - wheel.center.base[13];
      const depth = wheel.base[14] - wheel.center.base[14];
      mat4.fromXRotation(rotation, angle);
      mat4.multiply(wheel.part.matrix, rotation, wheel.base);
      wheel.part.matrix[12] = wheel.base[12];
      wheel.part.matrix[13] = wheel.center.base[13] + height * cosine - depth * sine;
      wheel.part.matrix[14] = wheel.center.base[14] + height * sine + depth * cosine + travel;
    }
    return frame;
  }

  return { parts, duration: DURATION, driveSpeed: DRIVE_SPEED, sample };
}
