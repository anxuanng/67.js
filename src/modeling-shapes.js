// Geometry builders for lathe, extrude and tube. Each returns raw arrays: indices are null for triangle soup.
import { sampleTubePath } from './modeling-curve.js';
import { signedArea, triangulate } from './triangulate.js';

const MERGE_THRESHOLD = 1e-10;

function normalizeScaled(x, y, z) {
  const scale = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
  return [x * scale, y * scale, z * scale];
}

export function buildLathe(profile, segments, startAngle, sweep) {
  const normalsAlongProfile = [];
  let previousNormal = [0, 0];
  for (let index = 0; index < profile.length; index++) {
    if (index === profile.length - 1) {
      normalsAlongProfile.push([previousNormal[0], previousNormal[1]]);
      break;
    }
    const currentNormal = [profile[index + 1][1] - profile[index][1], -(profile[index + 1][0] - profile[index][0])];
    const combined = index === 0 ? currentNormal : [currentNormal[0] + previousNormal[0], currentNormal[1] + previousNormal[1]];
    const [x, y] = normalizeScaled(combined[0], combined[1], 0);
    normalsAlongProfile.push([x, y]);
    previousNormal = currentNormal;
  }
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let segment = 0; segment <= segments; segment++) {
    const angle = startAngle + segment * (1 / segments) * sweep;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    for (let index = 0; index < profile.length; index++) {
      positions.push(profile[index][0] * sine, profile[index][1], profile[index][0] * cosine);
      uvs.push(segment / segments, index / (profile.length - 1));
      normals.push(normalsAlongProfile[index][0] * sine, normalsAlongProfile[index][1], normalsAlongProfile[index][0] * cosine);
    }
  }
  const indices = [];
  for (let segment = 0; segment < segments; segment++) {
    for (let index = 0; index < profile.length - 1; index++) {
      const base = index + segment * profile.length;
      const next = base + profile.length;
      indices.push(base, next, base + 1, next + 1, base + 1, next);
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

export function buildTube(points, closed, radius, segments, radialSegments) {
  const samples = sampleTubePath(points, closed, segments);
  const positions = [];
  const normals = [];
  const uvs = [];
  for (const { point, normal, binormal } of samples) {
    for (let side = 0; side <= radialSegments; side++) {
      const angle = side / radialSegments * Math.PI * 2;
      const sine = Math.sin(angle);
      const cosine = -Math.cos(angle);
      const outward = normalizeScaled(
        cosine * normal[0] + sine * binormal[0],
        cosine * normal[1] + sine * binormal[1],
        cosine * normal[2] + sine * binormal[2],
      );
      normals.push(...outward);
      positions.push(point[0] + radius * outward[0], point[1] + radius * outward[1], point[2] + radius * outward[2]);
    }
  }
  for (let ring = 0; ring <= segments; ring++) {
    for (let side = 0; side <= radialSegments; side++) uvs.push(ring / segments, side / radialSegments);
  }
  const indices = [];
  for (let ring = 1; ring <= segments; ring++) {
    for (let side = 1; side <= radialSegments; side++) {
      const a = (radialSegments + 1) * (ring - 1) + (side - 1);
      const b = (radialSegments + 1) * ring + (side - 1);
      const c = (radialSegments + 1) * ring + side;
      const d = (radialSegments + 1) * (ring - 1) + side;
      indices.push(a, b, d, b, c, d);
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

function mergeOverlappingPoints(points) {
  let previous = points[0];
  for (let index = 1; index <= points.length; index++) {
    const currentIndex = index % points.length;
    const current = points[currentIndex];
    const deltaX = current[0] - previous[0];
    const deltaY = current[1] - previous[1];
    const largest = Math.max(Math.abs(current[0]), Math.abs(current[1]), Math.abs(previous[0]), Math.abs(previous[1]));
    if (deltaX * deltaX + deltaY * deltaY <= MERGE_THRESHOLD * MERGE_THRESHOLD * largest * largest) {
      points.splice(currentIndex, 1);
      index--;
      continue;
    }
    previous = current;
  }
}

/** The vector that moves a ring vertex one unit outward along the bisector of its two edges. */
function bevelDirection(point, previous, next) {
  const previousX = point[0] - previous[0];
  const previousY = point[1] - previous[1];
  const nextX = next[0] - point[0];
  const nextY = next[1] - point[1];
  const previousLengthSquared = previousX * previousX + previousY * previousY;
  const turn = previousX * nextY - previousY * nextX;
  let translateX;
  let translateY;
  let shrinkBy;
  if (Math.abs(turn) > Number.EPSILON) {
    const previousLength = Math.sqrt(previousLengthSquared);
    const nextLength = Math.sqrt(nextX * nextX + nextY * nextY);
    const previousShiftX = previous[0] - previousY / previousLength;
    const previousShiftY = previous[1] + previousX / previousLength;
    const nextShiftX = next[0] - nextY / nextLength;
    const nextShiftY = next[1] + nextX / nextLength;
    const factor = ((nextShiftX - previousShiftX) * nextY - (nextShiftY - previousShiftY) * nextX) / (previousX * nextY - previousY * nextX);
    translateX = previousShiftX + previousX * factor - point[0];
    translateY = previousShiftY + previousY * factor - point[1];
    const translateLengthSquared = translateX * translateX + translateY * translateY;
    if (translateLengthSquared <= 2) return [translateX, translateY];
    shrinkBy = Math.sqrt(translateLengthSquared / 2);
  } else {
    let sameDirection = false;
    if (previousX > Number.EPSILON) {
      sameDirection = nextX > Number.EPSILON;
    } else if (previousX < -Number.EPSILON) {
      sameDirection = nextX < -Number.EPSILON;
    } else {
      sameDirection = Math.sign(previousY) === Math.sign(nextY);
    }
    if (sameDirection) {
      translateX = -previousY;
      translateY = previousX;
      shrinkBy = Math.sqrt(previousLengthSquared);
    } else {
      translateX = previousX;
      translateY = previousY;
      shrinkBy = Math.sqrt(previousLengthSquared / 2);
    }
  }
  return [translateX / shrinkBy, translateY / shrinkBy];
}

function ringDirections(ring) {
  return ring.map((point, index) => bevelDirection(point, ring[(index + ring.length - 1) % ring.length], ring[(index + 1) % ring.length]));
}

function faceNormals(positions) {
  const normals = new Float32Array(positions.length);
  for (let offset = 0; offset < positions.length; offset += 9) {
    const ax = positions[offset] - positions[offset + 3];
    const ay = positions[offset + 1] - positions[offset + 4];
    const az = positions[offset + 2] - positions[offset + 5];
    const cx = positions[offset + 6] - positions[offset + 3];
    const cy = positions[offset + 7] - positions[offset + 4];
    const cz = positions[offset + 8] - positions[offset + 5];
    const unnormalized = Float32Array.from([cy * az - cz * ay, cz * ax - cx * az, cx * ay - cy * ax]);
    const stored = Float32Array.from(normalizeScaled(unnormalized[0], unnormalized[1], unnormalized[2]));
    for (let corner = 0; corner < 3; corner++) normals.set(stored, offset + corner * 3);
  }
  return normals;
}

/** Extrusion along +Z as triangle soup with flat normals. Bevel layers follow a quarter-sine profile. */
export function buildExtrusion(contourInput, holeInputs, { depth, steps, bevel, bevelThickness, bevelSegments }) {
  const beveled = bevel > 0 || bevelThickness > 0;
  const thickness = beveled ? bevelThickness : 0;
  const size = beveled ? bevel : 0;
  const segmentCount = beveled ? bevelSegments : 0;
  const contour = contourInput.map(point => [...point]);
  const holes = holeInputs.map(hole => hole.map(point => [...point]));
  if (!(signedArea(contour) < 0)) contour.reverse();
  for (const hole of holes) if (signedArea(hole) < 0) hole.reverse();
  mergeOverlappingPoints(contour);
  holes.forEach(mergeOverlappingPoints);
  const rings = [contour, ...holes];
  const vertices = rings.flat();
  const directions = rings.flatMap(ringDirections);
  const layers = [];
  const addLayer = (distance, height) => layers.push(vertices.map((vertex, index) => [vertex[0] + directions[index][0] * distance, vertex[1] + directions[index][1] * distance, height]));
  const bevelLevel = bevelStep => {
    const fraction = bevelStep / segmentCount;
    return { height: thickness * Math.cos(fraction * Math.PI / 2), distance: size * Math.sin(fraction * Math.PI / 2) };
  };
  for (let bevelStep = 0; bevelStep < segmentCount; bevelStep++) {
    const { height, distance } = bevelLevel(bevelStep);
    addLayer(distance, -height);
  }
  const fullDistance = beveled ? size : 0;
  addLayer(fullDistance, 0);
  for (let step = 1; step <= steps; step++) addLayer(fullDistance, depth / steps * step);
  for (let bevelStep = segmentCount - 1; bevelStep >= 0; bevelStep--) {
    const { height, distance } = bevelLevel(bevelStep);
    addLayer(distance, depth + height);
  }
  const faces = triangulate(contour, holes);
  const topLayer = beveled ? steps + segmentCount * 2 : steps;
  const soup = [];
  const uvs = [];
  const pushVertex = (layer, vertex) => soup.push(...layers[layer][vertex]);
  const pushTopUvs = count => {
    for (let corner = count; corner >= 1; corner--) {
      const base = soup.length - corner * 3;
      uvs.push(soup[base], soup[base + 1]);
    }
  };
  for (const face of faces) {
    pushVertex(0, face[2]);
    pushVertex(0, face[1]);
    pushVertex(0, face[0]);
    pushTopUvs(3);
  }
  for (const face of faces) {
    for (const vertex of face) pushVertex(topLayer, vertex);
    pushTopUvs(3);
  }
  let ringOffset = 0;
  for (const ring of rings) {
    for (let index = ring.length - 1; index >= 0; index--) {
      const previous = index === 0 ? ring.length - 1 : index - 1;
      for (let layer = 0; layer < steps + segmentCount * 2; layer++) {
        const a = layers[layer][ringOffset + index];
        const b = layers[layer][ringOffset + previous];
        const c = layers[layer + 1][ringOffset + previous];
        const d = layers[layer + 1][ringOffset + index];
        soup.push(...a, ...b, ...d, ...b, ...c, ...d);
        const horizontal = Math.abs(a[1] - b[1]) < Math.abs(a[0] - b[0]);
        const axis = horizontal ? 0 : 1;
        const wallUv = corner => [corner[axis], 1 - corner[2]];
        uvs.push(...wallUv(a), ...wallUv(b), ...wallUv(d), ...wallUv(b), ...wallUv(c), ...wallUv(d));
      }
    }
    ringOffset += ring.length;
  }
  const positions = Float32Array.from(soup);
  return { positions, normals: faceNormals(positions), uvs: Float32Array.from(uvs), indices: null };
}
