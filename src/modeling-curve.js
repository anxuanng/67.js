// Centripetal Catmull-Rom curve with arc-length sampling and rotation-minimizing frames, for the tube generator.
const ARC_LENGTH_DIVISIONS = 200;
const TANGENT_DELTA = 0.0001;

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function add(first, second) {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

function crossProduct(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function lengthOf(vector) {
  return Math.sqrt(dotProduct(vector, vector));
}

function normalize(vector) {
  const scale = 1 / (lengthOf(vector) || 1);
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function rotateAroundAxis(vector, axis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const remainder = 1 - cosine;
  const [axisX, axisY, axisZ] = axis;
  const xx = remainder * axisX;
  const yy = remainder * axisY;
  return [
    (xx * axisX + cosine) * vector[0] + (xx * axisY - sine * axisZ) * vector[1] + (xx * axisZ + sine * axisY) * vector[2],
    (xx * axisY + sine * axisZ) * vector[0] + (yy * axisY + cosine) * vector[1] + (yy * axisZ - sine * axisX) * vector[2],
    (xx * axisZ - sine * axisY) * vector[0] + (yy * axisZ + sine * axisX) * vector[1] + (remainder * axisZ * axisZ + cosine) * vector[2],
  ];
}

function distanceSquared(first, second) {
  const difference = subtract(first, second);
  return dotProduct(difference, difference);
}

function nonuniformCoefficients(x0, x1, x2, x3, dt0, dt1, dt2) {
  let tangentStart = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
  let tangentEnd = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
  tangentStart *= dt1;
  tangentEnd *= dt1;
  return [x1, tangentStart, -3 * x1 + 3 * x2 - 2 * tangentStart - tangentEnd, 2 * x1 - 2 * x2 + tangentStart + tangentEnd];
}

function createCurve(points, closed) {
  const count = points.length;
  const pointAt = parameter => {
    const scaled = (count - (closed ? 0 : 1)) * parameter;
    let segment = Math.floor(scaled);
    let weight = scaled - segment;
    if (closed) {
      segment += segment > 0 ? 0 : (Math.floor(Math.abs(segment) / count) + 1) * count;
    } else if (weight === 0 && segment === count - 1) {
      segment = count - 2;
      weight = 1;
    }
    const before = closed || segment > 0
      ? points[(segment - 1) % count]
      : add(subtract(points[0], points[1]), points[0]);
    const start = points[segment % count];
    const end = points[(segment + 1) % count];
    const after = closed || segment + 2 < count
      ? points[(segment + 2) % count]
      : add(subtract(points[count - 1], points[count - 2]), points[count - 1]);
    let dt0 = Math.pow(distanceSquared(before, start), 0.25);
    let dt1 = Math.pow(distanceSquared(start, end), 0.25);
    let dt2 = Math.pow(distanceSquared(end, after), 0.25);
    if (dt1 < 1e-4) dt1 = 1.0;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    const squared = weight * weight;
    const cubed = squared * weight;
    return [0, 1, 2].map(axis => {
      const [c0, c1, c2, c3] = nonuniformCoefficients(before[axis], start[axis], end[axis], after[axis], dt0, dt1, dt2);
      return c0 + c1 * weight + c2 * squared + c3 * cubed;
    });
  };
  const cumulativeLengths = [0];
  let previous = pointAt(0);
  let sum = 0;
  for (let division = 1; division <= ARC_LENGTH_DIVISIONS; division++) {
    const current = pointAt(division / ARC_LENGTH_DIVISIONS);
    sum += lengthOf(subtract(current, previous));
    cumulativeLengths.push(sum);
    previous = current;
  }
  const parameterAtFraction = fraction => {
    const target = fraction * cumulativeLengths[ARC_LENGTH_DIVISIONS];
    let low = 0;
    let high = ARC_LENGTH_DIVISIONS;
    while (low <= high) {
      const middle = Math.floor(low + (high - low) / 2);
      const comparison = cumulativeLengths[middle] - target;
      if (comparison < 0) {
        low = middle + 1;
      } else if (comparison > 0) {
        high = middle - 1;
      } else {
        high = middle;
        break;
      }
    }
    if (cumulativeLengths[high] === target) return high / ARC_LENGTH_DIVISIONS;
    const segmentLength = cumulativeLengths[high + 1] - cumulativeLengths[high];
    return (high + (target - cumulativeLengths[high]) / segmentLength) / ARC_LENGTH_DIVISIONS;
  };
  const tangentAt = fraction => {
    const parameter = parameterAtFraction(fraction);
    const before = pointAt(Math.max(parameter - TANGENT_DELTA, 0));
    const after = pointAt(Math.min(parameter + TANGENT_DELTA, 1));
    return normalize(subtract(after, before));
  };
  return { pointAtFraction: fraction => pointAt(parameterAtFraction(fraction)), tangentAt };
}

function initialNormal(tangent) {
  const absolute = tangent.map(Math.abs);
  let axis = 0;
  if (absolute[1] <= absolute[axis]) axis = 1;
  if (absolute[2] <= absolute[axis]) axis = 2;
  const reference = [0, 0, 0];
  reference[axis] = 1;
  return crossProduct(tangent, normalize(crossProduct(tangent, reference)));
}

function frames(tangents, closed) {
  const segments = tangents.length - 1;
  const normals = [initialNormal(tangents[0])];
  for (let index = 1; index <= segments; index++) {
    let normal = normals[index - 1];
    const axis = crossProduct(tangents[index - 1], tangents[index]);
    if (lengthOf(axis) > Number.EPSILON) {
      const angle = Math.acos(Math.min(Math.max(dotProduct(tangents[index - 1], tangents[index]), -1), 1));
      normal = rotateAroundAxis(normal, normalize(axis), angle);
    }
    normals.push(normal);
  }
  if (closed) {
    let angle = Math.acos(Math.min(Math.max(dotProduct(normals[0], normals[segments]), -1), 1));
    angle /= segments;
    if (dotProduct(tangents[0], crossProduct(normals[0], normals[segments])) > 0) angle = -angle;
    for (let index = 1; index <= segments; index++) {
      normals[index] = rotateAroundAxis(normals[index], tangents[index], angle * index);
    }
  }
  return normals.map((normal, index) => ({ normal, binormal: crossProduct(tangents[index], normal) }));
}

/** Samples a tube path at equal arc-length steps: one point and one frame per step, steps + 1 in all. */
export function sampleTubePath(points, closed, steps) {
  const curve = createCurve(points, closed);
  const tangents = Array.from({ length: steps + 1 }, (_, index) => curve.tangentAt(index / steps));
  const sampleFrames = frames(tangents, closed);
  return sampleFrames.map((_, index) => {
    const source = closed && index === steps ? 0 : index;
    return { point: curve.pointAtFraction(source / steps), ...sampleFrames[source] };
  });
}
