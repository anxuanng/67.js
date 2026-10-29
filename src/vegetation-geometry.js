// Low-level geometry helpers for the vegetation addon: vector math, seeded noise,
// a mesh builder, swept tubes (branches) and leaf surfaces (leaf meshes and cards).

export const FULL_TURN = Math.PI * 2;
export const WORLD_UP = [0, 1, 0];

export function createRandom(seed) {
  let state = Math.floor(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let mixed = Math.imul(state ^ state >>> 15, state | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

export function lerp(first, second, amount) {
  return first + (second - first) * amount;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function randomInRange(random, range) {
  return lerp(range[0], range[1], random());
}

function hashLattice(latticeX, latticeY, seed) {
  let mixed = Math.imul(latticeX, 374761393) ^ Math.imul(latticeY, 668265263) ^ Math.imul(seed, 2147483647);
  mixed = Math.imul(mixed ^ mixed >>> 13, 1274126177);
  return ((mixed ^ mixed >>> 16) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]; a positive period makes it tile on that axis. */
export function valueNoise(x, y, seed, periodX = 0, periodY = 0) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fractionX = x - cellX;
  const fractionY = y - cellY;
  const smoothX = fractionX * fractionX * (3 - 2 * fractionX);
  const smoothY = fractionY * fractionY * (3 - 2 * fractionY);
  const wrap = (value, period) => period > 0 ? ((value % period) + period) % period : value;
  const corner = (offsetX, offsetY) => hashLattice(wrap(cellX + offsetX, periodX), wrap(cellY + offsetY, periodY), seed);
  const top = lerp(corner(0, 0), corner(1, 0), smoothX);
  const bottom = lerp(corner(0, 1), corner(1, 1), smoothX);
  return lerp(top, bottom, smoothY);
}

export function addVectors(first, second) {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

export function subtractVectors(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

export function scaleVector(vector, amount) {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

export function addScaled(base, direction, amount) {
  return [base[0] + direction[0] * amount, base[1] + direction[1] * amount, base[2] + direction[2] * amount];
}

export function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

export function crossProduct(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

export function vectorLength(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

export function normalized(vector) {
  const length = vectorLength(vector);
  if (length < 1e-9) return [0, 1, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function lerpVectors(first, second, amount) {
  return [lerp(first[0], second[0], amount), lerp(first[1], second[1], amount), lerp(first[2], second[2], amount)];
}

/** Two unit vectors perpendicular to the direction and to each other. */
export function createFrame(direction) {
  const helperAxis = Math.abs(direction[1]) < 0.9 ? WORLD_UP : [1, 0, 0];
  const first = normalized(crossProduct(direction, helperAxis));
  const second = crossProduct(direction, first);
  return { first, second };
}

function transportFrame(frame, direction) {
  const first = normalized(addScaled(frame.first, direction, -dotProduct(frame.first, direction)));
  return { first, second: crossProduct(direction, first) };
}

export function createMeshBuilder({ withColors = false } = {}) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  return {
    get vertexCount() {
      return positions.length / 3;
    },
    get triangleCount() {
      return indices.length / 3;
    },
    addVertex(position, normal, u, v, color = [1, 1, 1]) {
      positions.push(position[0], position[1], position[2]);
      normals.push(normal[0], normal[1], normal[2]);
      uvs.push(u, v);
      if (withColors) colors.push(color[0], color[1], color[2]);
      return positions.length / 3 - 1;
    },
    addTriangle(first, second, third) {
      if (first === second || second === third || first === third) return;
      indices.push(first, second, third);
    },
    build() {
      const geometry = {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices),
      };
      if (withColors) geometry.colors = new Float32Array(colors);
      return geometry;
    },
  };
}

// Below this many texture repeats around a ring the bark texture is not wrapped to a whole number:
// rounding would stretch a thin twig by more than a third, so it keeps true world scale instead.
const MINIMUM_WHOLE_REPEATS = 1.5;
const MINIMUM_UNDERSIDE_REACH = 0.25;

function wholeOrExactRepeats(exactRepeats) {
  return exactRepeats >= MINIMUM_WHOLE_REPEATS ? Math.round(exactRepeats) : exactRepeats;
}

/** Angle around the ring whose radial direction points most nearly straight down, or `fallback` on near-vertical rings. */
function undersideAngle(frame, fallback) {
  const downOnFirst = -frame.first[1];
  const downOnSecond = -frame.second[1];
  if (Math.hypot(downOnFirst, downOnSecond) < MINIMUM_UNDERSIDE_REACH) return fallback;
  return Math.atan2(downOnSecond, downOnFirst);
}

/**
 * Sweeps a tapered round tube along a polyline with parallel-transported rings.
 * By default `u` repeats a whole number of times around the base ring. With `worldScaleUv` every ring
 * gets `u` and `v` from its own circumference so texels keep one world size from trunk to twig, rings
 * wide enough to wrap whole tiles do so (no seam), and thinner rings put their seam on the underside.
 */
export function addTube(builder, points, radii, sides, tileSize, color = [1, 1, 1], { worldScaleUv = false } = {}) {
  const baseRepeats = Math.max(1, Math.round(FULL_TURN * radii[0] / tileSize));
  const firstVertex = builder.vertexCount;
  const lastIndex = points.length - 1;
  let frame = null;
  let along = 0;
  let seamAngle = 0;
  points.forEach((point, index) => {
    const tangent = normalized(subtractVectors(points[Math.min(index + 1, lastIndex)], points[Math.max(index - 1, 0)]));
    frame = frame ? transportFrame(frame, tangent) : createFrame(tangent);
    const exactRepeats = FULL_TURN * radii[index] / tileSize;
    const repeatsAround = worldScaleUv ? wholeOrExactRepeats(exactRepeats) : baseRepeats;
    const alongScale = worldScaleUv && exactRepeats > 1e-6 ? repeatsAround / exactRepeats : 1;
    if (index > 0) along += vectorLength(subtractVectors(point, points[index - 1])) / tileSize * alongScale;
    if (worldScaleUv) seamAngle = undersideAngle(frame, seamAngle);
    for (let side = 0; side <= sides; side++) {
      const angle = seamAngle + side / sides * FULL_TURN;
      const radial = addVectors(scaleVector(frame.first, Math.cos(angle)), scaleVector(frame.second, Math.sin(angle)));
      builder.addVertex(addScaled(point, radial, radii[index]), radial, side / sides * repeatsAround, along, color);
    }
  });
  const ringSize = sides + 1;
  for (let ring = 0; ring < lastIndex; ring++) {
    for (let side = 0; side < sides; side++) {
      const current = firstVertex + ring * ringSize + side;
      const next = current + ringSize;
      builder.addTriangle(current, current + 1, next);
      builder.addTriangle(current + 1, next + 1, next);
    }
  }
}

function lobeNormal(forwardTilt, lateralTilt, normalAxis, forward, right) {
  return normalized(addVectors(addVectors(normalAxis, scaleVector(forward, forwardTilt)), scaleVector(right, lateralTilt)));
}

/**
 * Orthonormal frame for a leaf: `right` is horizontal so the face tilts toward the sky,
 * `normal` is the face normal, and `roll` turns the leaf about its own axis.
 */
export function createLeafFrame(forward, roll) {
  const horizontalRight = crossProduct(forward, WORLD_UP);
  const right = vectorLength(horizontalRight) < 1e-4 ? createFrame(forward).first : normalized(horizontalRight);
  const turned = addVectors(scaleVector(right, Math.cos(roll)), scaleVector(crossProduct(forward, right), Math.sin(roll)));
  return { forward, right: turned, normal: crossProduct(turned, forward) };
}

/**
 * Adds a curved leaf or card as rows of 2 or 3 columns, both faces, with shading
 * normals blended toward the canopy so a flat quad lights like part of a rounded crown.
 */
export function addLeafSurface(builder, surface) {
  const { origin, frame, length, width, rows, droop = 0, fold = 0, canopyNormal, canopyBlend = 0.5, colorBase, colorTip, brightness = 1 } = surface;
  const columns = fold > 0 ? [-1, 0, 1] : [-1, 1];
  const sides = surface.backFaces === false ? [1] : [1, -1];
  const rowIndicesBySide = sides.map((side) => rows.map(([progress, widthFactor]) => {
    const center = addScaled(addScaled(origin, frame.forward, length * progress), frame.normal, -droop * length * progress * progress);
    const half = width / 2 * widthFactor;
    const forwardTilt = 2 * droop * progress;
    const color = colorBase ? lerpVectors(colorBase, colorTip ?? colorBase, progress).map(channel => channel * brightness) : [brightness, brightness, brightness];
    const makeVertex = (column) => {
      const lateralTilt = column * fold;
      const faceNormal = scaleVector(lobeNormal(forwardTilt, lateralTilt, frame.normal, frame.forward, frame.right), side);
      const shading = normalized(addVectors(scaleVector(faceNormal, 1 - canopyBlend), scaleVector(canopyNormal, canopyBlend)));
      const lifted = column === 0 ? addScaled(center, frame.normal, fold * half) : center;
      return builder.addVertex(addScaled(lifted, frame.right, column * half), shading, (column + 1) / 2, 1 - progress, color);
    };
    if (half <= 0) {
      const shared = makeVertex(0);
      return columns.map(() => shared);
    }
    return columns.map(makeVertex);
  }));
  rowIndicesBySide.forEach((rowIndices, sideIndex) => {
    const front = sides[sideIndex] > 0;
    for (let row = 0; row < rows.length - 1; row++) {
      for (let column = 0; column < columns.length - 1; column++) {
        const a = rowIndices[row][column];
        const b = rowIndices[row][column + 1];
        const c = rowIndices[row + 1][column];
        const d = rowIndices[row + 1][column + 1];
        if (front) {
          builder.addTriangle(a, b, c);
          builder.addTriangle(b, d, c);
        } else {
          builder.addTriangle(a, c, b);
          builder.addTriangle(b, c, d);
        }
      }
    }
  });
}

export function triangleCountOf(geometry) {
  return geometry.indices.length / 3;
}
