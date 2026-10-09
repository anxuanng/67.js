import { mat4 } from 'gl-matrix';
import { createModel } from './model.js';
import { EFFECT_PRESETS } from './effects.js';

const DURATION = 12;
const TRAVEL = 0.28;
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

export function createWallEPreviewScene() {
  const parts = createModel();
  const entries = parts.map(part => ({ part, base: mat4.clone(part.matrix) }));
  const path = createTrackPath();
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
  const trackPosition = {};
  const frame = { target: [0, 1.5, 0], effects: EFFECT_PRESETS.neutral };

  function sample(time) {
    if (!Number.isFinite(time)) throw new TypeError('WALL·E preview time must be finite seconds.');
    const phase = (time % DURATION) / DURATION * Math.PI * 2;
    const travel = TRAVEL * Math.sin(phase);
    for (const { part, base } of entries) {
      part.matrix.set(base);
      part.matrix[14] += travel;
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
      const angle = travel / wheel.radius;
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

  return { parts, duration: DURATION, sample };
}
