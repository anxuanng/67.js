// Triangle helpers on plain numbers. A triangle is a Float64Array of nine values: a, b, c.
const PLANE_EPSILON = 1e-12;
const INTERVAL_EPSILON = 1e-12;

export function readTriangle(positions, indices, triangleId, triangle) {
  for (let corner = 0; corner < 3; corner++) {
    const source = indices[triangleId * 3 + corner] * 3;
    triangle[corner * 3] = positions[source];
    triangle[corner * 3 + 1] = positions[source + 1];
    triangle[corner * 3 + 2] = positions[source + 2];
  }
}

function crossOfEdges(triangle, out) {
  const firstX = triangle[3] - triangle[0];
  const firstY = triangle[4] - triangle[1];
  const firstZ = triangle[5] - triangle[2];
  const secondX = triangle[6] - triangle[0];
  const secondY = triangle[7] - triangle[1];
  const secondZ = triangle[8] - triangle[2];
  out[0] = firstY * secondZ - firstZ * secondY;
  out[1] = firstZ * secondX - firstX * secondZ;
  out[2] = firstX * secondY - firstY * secondX;
}

/** Unit normal of the counterclockwise face, or zeros for a degenerate triangle. */
export function triangleNormal(triangle, out) {
  crossOfEdges(triangle, out);
  const length = Math.hypot(out[0], out[1], out[2]);
  if (length === 0) return out;
  out[0] /= length;
  out[1] /= length;
  out[2] /= length;
  return out;
}

/** Writes the point of the triangle nearest to the query point (Ericson, Real-Time Collision Detection). */
export function closestPointOnTriangle(point, triangle, out) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = triangle;
  const abX = bx - ax;
  const abY = by - ay;
  const abZ = bz - az;
  const acX = cx - ax;
  const acY = cy - ay;
  const acZ = cz - az;
  const apX = point[0] - ax;
  const apY = point[1] - ay;
  const apZ = point[2] - az;
  const d1 = abX * apX + abY * apY + abZ * apZ;
  const d2 = acX * apX + acY * apY + acZ * apZ;
  if (d1 <= 0 && d2 <= 0) return setPoint(out, ax, ay, az);
  const bpX = point[0] - bx;
  const bpY = point[1] - by;
  const bpZ = point[2] - bz;
  const d3 = abX * bpX + abY * bpY + abZ * bpZ;
  const d4 = acX * bpX + acY * bpY + acZ * bpZ;
  if (d3 >= 0 && d4 <= d3) return setPoint(out, bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const along = d1 / (d1 - d3);
    return setPoint(out, ax + abX * along, ay + abY * along, az + abZ * along);
  }
  const cpX = point[0] - cx;
  const cpY = point[1] - cy;
  const cpZ = point[2] - cz;
  const d5 = abX * cpX + abY * cpY + abZ * cpZ;
  const d6 = acX * cpX + acY * cpY + acZ * cpZ;
  if (d6 >= 0 && d5 <= d6) return setPoint(out, cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const along = d2 / (d2 - d6);
    return setPoint(out, ax + acX * along, ay + acY * along, az + acZ * along);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const along = (d4 - d3) / (d4 - d3 + d5 - d6);
    return setPoint(out, bx + (cx - bx) * along, by + (cy - by) * along, bz + (cz - bz) * along);
  }
  const scale = 1 / (va + vb + vc);
  const secondWeight = vb * scale;
  const thirdWeight = vc * scale;
  return setPoint(out, ax + abX * secondWeight + acX * thirdWeight, ay + abY * secondWeight + acY * thirdWeight, az + abZ * secondWeight + acZ * thirdWeight);
}

function setPoint(out, x, y, z) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** Distance along the ray to a two-sided triangle hit, or -1 for a miss. Edges count as hits. */
export function intersectRayTriangle(origin, direction, triangle) {
  const edgeFirstX = triangle[3] - triangle[0];
  const edgeFirstY = triangle[4] - triangle[1];
  const edgeFirstZ = triangle[5] - triangle[2];
  const edgeSecondX = triangle[6] - triangle[0];
  const edgeSecondY = triangle[7] - triangle[1];
  const edgeSecondZ = triangle[8] - triangle[2];
  const pivotX = direction[1] * edgeSecondZ - direction[2] * edgeSecondY;
  const pivotY = direction[2] * edgeSecondX - direction[0] * edgeSecondZ;
  const pivotZ = direction[0] * edgeSecondY - direction[1] * edgeSecondX;
  const determinant = edgeFirstX * pivotX + edgeFirstY * pivotY + edgeFirstZ * pivotZ;
  if (determinant === 0) return -1;
  const offsetX = origin[0] - triangle[0];
  const offsetY = origin[1] - triangle[1];
  const offsetZ = origin[2] - triangle[2];
  const firstWeight = (offsetX * pivotX + offsetY * pivotY + offsetZ * pivotZ) / determinant;
  if (firstWeight < 0 || firstWeight > 1) return -1;
  const queryX = offsetY * edgeFirstZ - offsetZ * edgeFirstY;
  const queryY = offsetZ * edgeFirstX - offsetX * edgeFirstZ;
  const queryZ = offsetX * edgeFirstY - offsetY * edgeFirstX;
  const secondWeight = (direction[0] * queryX + direction[1] * queryY + direction[2] * queryZ) / determinant;
  if (secondWeight < 0 || firstWeight + secondWeight > 1) return -1;
  const distance = (edgeSecondX * queryX + edgeSecondY * queryY + edgeSecondZ * queryZ) / determinant;
  return distance >= 0 ? distance : -1;
}

/** Weights of corners a, b and c for a point on the triangle plane, or null for a degenerate triangle. */
export function barycentricWeights(point, triangle, out) {
  const edgeSecondX = triangle[6] - triangle[0];
  const edgeSecondY = triangle[7] - triangle[1];
  const edgeSecondZ = triangle[8] - triangle[2];
  const edgeFirstX = triangle[3] - triangle[0];
  const edgeFirstY = triangle[4] - triangle[1];
  const edgeFirstZ = triangle[5] - triangle[2];
  const offsetX = point[0] - triangle[0];
  const offsetY = point[1] - triangle[1];
  const offsetZ = point[2] - triangle[2];
  const dotSecondSecond = edgeSecondX * edgeSecondX + edgeSecondY * edgeSecondY + edgeSecondZ * edgeSecondZ;
  const dotSecondFirst = edgeSecondX * edgeFirstX + edgeSecondY * edgeFirstY + edgeSecondZ * edgeFirstZ;
  const dotSecondOffset = edgeSecondX * offsetX + edgeSecondY * offsetY + edgeSecondZ * offsetZ;
  const dotFirstFirst = edgeFirstX * edgeFirstX + edgeFirstY * edgeFirstY + edgeFirstZ * edgeFirstZ;
  const dotFirstOffset = edgeFirstX * offsetX + edgeFirstY * offsetY + edgeFirstZ * offsetZ;
  const denominator = dotSecondSecond * dotFirstFirst - dotSecondFirst * dotSecondFirst;
  if (denominator === 0) return null;
  const thirdWeight = (dotFirstFirst * dotSecondOffset - dotSecondFirst * dotFirstOffset) / denominator;
  const secondWeight = (dotSecondSecond * dotFirstOffset - dotSecondFirst * dotSecondOffset) / denominator;
  out[0] = 1 - thirdWeight - secondWeight;
  out[1] = secondWeight;
  out[2] = thirdWeight;
  return out;
}

function planeDistances(triangle, planeNormal, planePoint) {
  const distances = [0, 0, 0];
  for (let corner = 0; corner < 3; corner++) {
    const distance = (triangle[corner * 3] - planePoint[0]) * planeNormal[0]
      + (triangle[corner * 3 + 1] - planePoint[1]) * planeNormal[1]
      + (triangle[corner * 3 + 2] - planePoint[2]) * planeNormal[2];
    distances[corner] = Math.abs(distance) <= PLANE_EPSILON ? 0 : distance;
  }
  return distances;
}

function onOneSide(distances) {
  return distances.every(distance => distance > 0) || distances.every(distance => distance < 0);
}

function lineInterval(triangle, distances, axis) {
  const points = [];
  for (let corner = 0; corner < 3; corner++) {
    if (distances[corner] === 0) points.push(triangle.slice(corner * 3, corner * 3 + 3));
    const next = (corner + 1) % 3;
    if (distances[corner] * distances[next] < 0) {
      const along = distances[corner] / (distances[corner] - distances[next]);
      points.push([0, 1, 2].map(component => triangle[corner * 3 + component] + (triangle[next * 3 + component] - triangle[corner * 3 + component]) * along));
    }
  }
  points.sort((first, second) => first[axis] - second[axis]);
  return { low: points[0], high: points[points.length - 1] };
}

function coplanarTrianglesOverlap(first, second, normal) {
  for (const triangle of [first, second]) {
    for (let corner = 0; corner < 3; corner++) {
      const next = (corner + 1) % 3;
      const edge = [0, 1, 2].map(component => triangle[next * 3 + component] - triangle[corner * 3 + component]);
      const axis = [edge[1] * normal[2] - edge[2] * normal[1], edge[2] * normal[0] - edge[0] * normal[2], edge[0] * normal[1] - edge[1] * normal[0]];
      if (projectionsSeparate(first, second, axis)) return false;
    }
  }
  return true;
}

function projectionsSeparate(first, second, axis) {
  const firstRange = projectionRange(first, axis);
  const secondRange = projectionRange(second, axis);
  return firstRange.high < secondRange.low - INTERVAL_EPSILON || secondRange.high < firstRange.low - INTERVAL_EPSILON;
}

function projectionRange(triangle, axis) {
  let low = Infinity;
  let high = -Infinity;
  for (let corner = 0; corner < 3; corner++) {
    const projection = triangle[corner * 3] * axis[0] + triangle[corner * 3 + 1] * axis[1] + triangle[corner * 3 + 2] * axis[2];
    low = Math.min(low, projection);
    high = Math.max(high, projection);
  }
  return { low, high };
}

/**
 * Touching counts as intersecting. For triangles that cross along a line the optional segment
 * receives the shared piece (six values); coplanar triangles leave it at zero.
 */
export function trianglesIntersect(first, second, segment = null) {
  const firstNormal = triangleNormal(first, [0, 0, 0]);
  const secondNormal = triangleNormal(second, [0, 0, 0]);
  const firstDistances = planeDistances(first, secondNormal, second);
  const secondDistances = planeDistances(second, firstNormal, first);
  if (onOneSide(firstDistances) || onOneSide(secondDistances)) return false;
  if (segment) segment.fill(0);
  if (firstDistances.every(distance => distance === 0)) return coplanarTrianglesOverlap(first, second, firstNormal);
  const direction = [
    firstNormal[1] * secondNormal[2] - firstNormal[2] * secondNormal[1],
    firstNormal[2] * secondNormal[0] - firstNormal[0] * secondNormal[2],
    firstNormal[0] * secondNormal[1] - firstNormal[1] * secondNormal[0],
  ];
  const magnitudes = direction.map(Math.abs);
  const axis = magnitudes.indexOf(Math.max(...magnitudes));
  const firstInterval = lineInterval(first, firstDistances, axis);
  const secondInterval = lineInterval(second, secondDistances, axis);
  const start = firstInterval.low[axis] >= secondInterval.low[axis] ? firstInterval.low : secondInterval.low;
  const end = firstInterval.high[axis] <= secondInterval.high[axis] ? firstInterval.high : secondInterval.high;
  if (start[axis] > end[axis] + INTERVAL_EPSILON) return false;
  if (segment) {
    segment.set(start, 0);
    segment.set(end, 3);
  }
  return true;
}
