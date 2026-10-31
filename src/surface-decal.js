import { mat4, vec3 } from 'gl-matrix';

// A decal vertex is six numbers: position x, y, z then normal x, y, z.
const CLIP_AXES = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];

/** Rigid projector matrix for XYZ Euler angles in radians, as a column-major Float64Array. */
export function createProjectorMatrix(position, rotation) {
  const [angleX, angleY, angleZ] = rotation;
  const a = Math.cos(angleX);
  const b = Math.sin(angleX);
  const c = Math.cos(angleY);
  const d = Math.sin(angleY);
  const e = Math.cos(angleZ);
  const f = Math.sin(angleZ);
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  return Float64Array.of(
    c * e, af + be * d, bf - ae * d, 0,
    -c * f, ae - bf * d, be + af * d, 0,
    d, -b * c, a * c, 0,
    position[0], position[1], position[2], 1,
  );
}

export function invertMatrix(matrix) {
  return mat4.invert(new Float64Array(16), matrix);
}

function interpolate(first, second, along) {
  const vertex = new Float64Array(6);
  for (let component = 0; component < 6; component++) {
    vertex[component] = first[component] + along * (second[component] - first[component]);
  }
  return vertex;
}

function clipEdge(inside, outside, axis, sign, limit) {
  const insideDistance = sign * inside[axis] - limit;
  const outsideDistance = sign * outside[axis] - limit;
  return interpolate(inside, outside, insideDistance / (insideDistance - outsideDistance));
}

// Keeps the part of each triangle on the inner side of one projector face, in the order the original clipper emitted it.
function clipToFace(vertices, axis, sign, size) {
  const limit = 0.5 * size[axis];
  const clipped = [];
  for (let start = 0; start < vertices.length; start += 3) {
    const triangle = [vertices[start], vertices[start + 1], vertices[start + 2]];
    const outside = triangle.map(vertex => sign * vertex[axis] - limit > 0);
    const outsideCount = outside.filter(Boolean).length;
    if (outsideCount === 0) {
      clipped.push(...triangle);
    } else if (outsideCount === 1) {
      clipped.push(...clipOneCornerOut(triangle, outside.indexOf(true), axis, sign, limit));
    } else if (outsideCount === 2) {
      const inside = outside.indexOf(false);
      const keep = triangle[inside];
      const next = triangle[(inside + 1) % 3];
      const previous = triangle[(inside + 2) % 3];
      clipped.push(keep, clipEdge(keep, next, axis, sign, limit), clipEdge(keep, previous, axis, sign, limit));
    }
  }
  return clipped;
}

function clipOneCornerOut(triangle, outsideCorner, axis, sign, limit) {
  const out = triangle[outsideCorner];
  const first = triangle[(outsideCorner + 1) % 3];
  const second = triangle[(outsideCorner + 2) % 3];
  const firstCut = clipEdge(out, first, axis, sign, limit);
  const secondCut = clipEdge(out, second, axis, sign, limit);
  // The original clipper wound the middle corner's quad the other way round.
  if (outsideCorner === 1) return [secondCut, first, second, first, secondCut, firstCut];
  return [first, second, firstCut, secondCut, firstCut, second];
}

/**
 * Clips the selected triangles of a target to a box-shaped projector and returns patch arrays in target space.
 * Normals are normalized on entry and carried unchanged; uvs run from 0 to 1 across the projector face.
 */
export function clipTrianglesToProjector(positions, normals, indices, projectorMatrix, size) {
  const projectorInverse = invertMatrix(projectorMatrix);
  let vertices = [];
  const point = new Float64Array(3);
  for (const index of indices) {
    const vertex = new Float64Array(6);
    point.set(positions.subarray(index * 3, index * 3 + 3));
    vec3.transformMat4(point, point, projectorInverse);
    vertex.set(point, 0);
    vertex.set(vec3.normalize(new Float64Array(3), normals.subarray(index * 3, index * 3 + 3)), 3);
    vertices.push(vertex);
  }
  for (const [axis, sign] of CLIP_AXES) vertices = clipToFace(vertices, axis, sign, size);
  const patch = { positions: new Float32Array(vertices.length * 3), normals: new Float32Array(vertices.length * 3), uvs: new Float32Array(vertices.length * 2) };
  vertices.forEach((vertex, slot) => {
    patch.uvs[slot * 2] = 0.5 + vertex[0] / size[0];
    patch.uvs[slot * 2 + 1] = 0.5 + vertex[1] / size[1];
    vec3.transformMat4(point, vertex.subarray(0, 3), projectorMatrix);
    patch.positions.set(point, slot * 3);
    patch.normals.set(vertex.subarray(3, 6), slot * 3);
  });
  return patch;
}
