import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Line3, Matrix4, Ray, Triangle, Vector3 } from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';

const records = new WeakMap();
const EPSILON = 1e-9;
const INDEX_OPTIONS = new Set(['maxTriangles', 'maxVertices', 'memoryBudgetMiB', 'solid', 'maxValidationPairs']);
const PAIR_OPTIONS = new Set(['mode', 'maxTriangleTests']);
const NEAREST_OPTIONS = new Set(['maxDistance', 'maxTriangleTests']);
const PROJECT_OPTIONS = new Set(['origin', 'direction', 'maxDistance', 'maxTriangleTests']);
const DIRECTIONS = [[0, 0, 1], [1, 0.41421356237, 0.73205080757], [0.61803398875, 1, 0.27182818285], [0.17320508075, 0.44721359550, 1], [-1, 0.31622776602, 0.14142135624], [0.22360679775, -1, 0.70710678118]];

function optionsObject(options, fields) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Query options require an object.');
  for (const field of Object.keys(options)) if (!fields.has(field)) throw new TypeError(`Unsupported query option ${field}.`);
}

function integer(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${label} requires an integer within one and ${maximum}.`);
  return value;
}

function budget(maximum, label) {
  let tests = 0;
  return {
    charge() {
      tests++;
      if (tests > maximum) throw new RangeError(`${label} exhausted. Raise the query budget or reduce geometry detail.`);
    },
    get tests() { return tests; },
  };
}

function live(index) {
  const record = records.get(index);
  if (!record) throw new TypeError('Use an index from createMeshQueryIndex().');
  if (record.disposed) throw new Error('Mesh query index was disposed. Create a new index.');
  return record;
}

// BVH callbacks must unwind normally: the maintained cast stores module-global traversal state.
function cast(first, second, transform, counter, visitor) {
  let failure;
  const intersected = first.bvh.bvhcast(second.bvh, transform, {
    intersectsTriangles(firstTriangle, secondTriangle, firstIndex, secondIndex) {
      try {
        counter.charge();
        return visitor(firstTriangle, secondTriangle, first.bvh.resolveTriangleIndex(firstIndex), second.bvh.resolveTriangleIndex(secondIndex));
      } catch (error) {
        failure = error;
        return true;
      }
    },
  });
  if (failure) throw failure;
  return intersected;
}

function validateGeometry(geometry, maxVertices, maxTriangles) {
  if (!geometry || typeof geometry !== 'object') throw new TypeError('Mesh queries require geometry.');
  if (geometry.skinIndices !== undefined || geometry.skinWeights !== undefined || geometry.morphTargets !== undefined) {
    throw new RangeError('Mesh queries require static geometry without skinning or morph targets.');
  }
  const positions = geometry.positions;
  const indices = geometry.indices;
  if (!(positions instanceof Float32Array) || positions.length === 0 || positions.length % 3 !== 0) throw new TypeError('Query positions require nonempty Float32 XYZ vertices.');
  if (!(indices instanceof Uint32Array) || indices.length === 0 || indices.length % 3 !== 0) throw new TypeError('Query indices require nonempty Uint32 triangles.');
  if (positions.length / 3 > maxVertices || indices.length / 3 > maxTriangles) throw new RangeError('Geometry exceeds maxVertices or maxTriangles.');
  const bounds = new Box3();
  const point = new Vector3();
  for (let offset = 0; offset < positions.length; offset += 3) {
    point.fromArray(positions, offset);
    if (![point.x, point.y, point.z].every(Number.isFinite)) throw new RangeError('Query positions must remain finite.');
    bounds.expandByPoint(point);
  }
  for (const index of indices) if (index >= positions.length / 3) throw new RangeError('Query index exceeds the vertex count.');
  const center = bounds.getCenter(new Vector3());
  const extent = bounds.getSize(new Vector3());
  const scale = Math.max(extent.x, extent.y, extent.z);
  if (scale === 0) throw new RangeError('Query geometry has no drawable extent.');
  const first = new Vector3();
  const second = new Vector3();
  const third = new Vector3();
  const cross = new Vector3();
  let minimumAltitude = Infinity;
  for (let offset = 0; offset < indices.length; offset += 3) {
    first.fromArray(positions, indices[offset] * 3);
    second.fromArray(positions, indices[offset + 1] * 3).sub(first).multiplyScalar(1 / scale);
    third.fromArray(positions, indices[offset + 2] * 3).sub(first).multiplyScalar(1 / scale);
    const longest = Math.max(second.length(), third.length(), first.subVectors(second, third).length());
    cross.crossVectors(second, third);
    const altitude = Math.hypot(cross.x, cross.y, cross.z) / longest;
    if (!Number.isFinite(altitude) || altitude <= 1e-8) throw new RangeError('Query triangle is degenerate or below the normalized precision domain.');
    minimumAltitude = Math.min(minimumAltitude, altitude);
  }
  return { center, scale, minimumAltitude, vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
}

function topology(geometry) {
  const vertexIds = new Uint32Array(geometry.positions.length / 3);
  const vertices = new Map();
  for (let vertex = 0; vertex < vertexIds.length; vertex++) {
    const offset = vertex * 3;
    const key = Array.from(geometry.positions.subarray(offset, offset + 3), value => value === 0 ? 0 : value).join(',');
    if (!vertices.has(key)) vertices.set(key, vertices.size);
    vertexIds[vertex] = vertices.get(key);
  }
  const triangles = Uint32Array.from(geometry.indices, index => vertexIds[index]);
  const edges = new Map();
  const neighbors = Array.from({ length: triangles.length / 3 }, () => []);
  const incident = Array.from({ length: vertices.size }, () => []);
  for (let face = 0; face < triangles.length / 3; face++) {
    const ids = Array.from(triangles.subarray(face * 3, face * 3 + 3));
    for (let corner = 0; corner < 3; corner++) {
      const first = ids[corner];
      const second = ids[(corner + 1) % 3];
      incident[first].push(face);
      const key = `${Math.min(first, second)}:${Math.max(first, second)}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ first, second, face });
    }
  }
  for (const adjacent of edges.values()) {
    if (adjacent.length !== 2 || adjacent[0].first !== adjacent[1].second || adjacent[0].second !== adjacent[1].first) {
      throw new RangeError('Solid geometry requires closed oriented manifold edges after exact position welding.');
    }
    neighbors[adjacent[0].face].push(adjacent[1].face);
    neighbors[adjacent[1].face].push(adjacent[0].face);
  }
  const visited = new Set([0]);
  const stack = [0];
  while (stack.length) {
    for (const neighbor of neighbors[stack.pop()]) if (!visited.has(neighbor)) {
      visited.add(neighbor);
      stack.push(neighbor);
    }
  }
  if (visited.size !== triangles.length / 3) throw new RangeError('Solid geometry requires one connected boundary.');
  for (let vertex = 0; vertex < incident.length; vertex++) {
    if (incident[vertex].length === 0) continue;
    const links = new Map();
    for (const face of incident[vertex]) {
      const other = Array.from(triangles.subarray(face * 3, face * 3 + 3)).filter(index => index !== vertex);
      for (let side = 0; side < 2; side++) {
        if (!links.has(other[side])) links.set(other[side], []);
        links.get(other[side]).push(other[1 - side]);
      }
    }
    if (Array.from(links.values()).some(link => link.length !== 2)) throw new RangeError('Solid geometry requires manifold vertex links.');
    const reached = new Set();
    const pending = [links.keys().next().value];
    while (pending.length) {
      const current = pending.pop();
      if (reached.has(current)) continue;
      reached.add(current);
      pending.push(...links.get(current));
    }
    if (reached.size !== links.size) throw new RangeError('Solid geometry requires a single cycle at each vertex link.');
  }
  return triangles;
}

function coneContains(origin, first, second, point, normal) {
  const edgeA = first.clone().sub(origin);
  const edgeB = second.clone().sub(origin);
  const direction = point.clone().sub(origin);
  const cross = new Vector3();
  const denominator = cross.crossVectors(edgeA, edgeB).dot(normal);
  const firstWeight = cross.crossVectors(direction, edgeB).dot(normal) / denominator;
  const secondWeight = cross.crossVectors(edgeA, direction).dot(normal) / denominator;
  return firstWeight >= -EPSILON && secondWeight >= -EPSILON;
}

function validateSelfIntersections(record, welded, maximum) {
  const counter = budget(maximum, 'maxValidationPairs');
  const segment = new Line3();
  cast(record, record, new Matrix4(), counter, (first, second, firstId, secondId) => {
    if (firstId >= secondId) return false;
    if (!first.intersectsTriangle(second, segment, true)) return false;
    const firstIds = Array.from(welded.subarray(firstId * 3, firstId * 3 + 3));
    const secondIds = Array.from(welded.subarray(secondId * 3, secondId * 3 + 3));
    const shared = firstIds.filter(index => secondIds.includes(index));
    if (shared.length === 0 || shared.length === 3) throw new RangeError('Solid boundary intersects itself.');
    const firstPoints = [first.a, first.b, first.c];
    const secondPoints = [second.a, second.b, second.c];
    const firstNormal = first.getNormal(new Vector3());
    const secondNormal = second.getNormal(new Vector3());
    const coplanar = new Vector3().crossVectors(firstNormal, secondNormal).length() <= EPSILON;
    if (shared.length === 2) {
      if (coplanar) {
        const origin = firstPoints[firstIds.indexOf(shared[0])];
        const edge = firstPoints[firstIds.indexOf(shared[1])].clone().sub(origin);
        const firstTip = firstPoints[firstIds.findIndex(index => !shared.includes(index))].clone().sub(origin);
        const secondTip = secondPoints[secondIds.findIndex(index => !shared.includes(index))].clone().sub(origin);
        const firstSide = new Vector3().crossVectors(edge, firstTip).dot(firstNormal);
        const secondSide = new Vector3().crossVectors(edge, secondTip).dot(firstNormal);
        if (firstSide * secondSide >= 0) throw new RangeError('Solid adjacent faces overlap or have ambiguous coplanar sides.');
      }
      return false;
    }
    const origin = firstPoints[firstIds.indexOf(shared[0])];
    if (!coplanar) {
      if (segment.start.distanceTo(origin) > EPSILON || segment.end.distanceTo(origin) > EPSILON) throw new RangeError('Solid faces intersect beyond their shared vertex.');
      return false;
    }
    const firstOther = firstPoints.filter((point, index) => firstIds[index] !== shared[0]);
    const secondOther = secondPoints.filter((point, index) => secondIds[index] !== shared[0]);
    if (secondOther.some(point => coneContains(origin, ...firstOther, point, firstNormal)) || firstOther.some(point => coneContains(origin, ...secondOther, point, secondNormal))) {
      throw new RangeError('Solid coplanar faces intersect beyond their shared vertex.');
    }
    return false;
  });
  return counter.tests;
}

function matrixState(record, values) {
  if ((!Array.isArray(values) && !ArrayBuffer.isView(values)) || values.length !== 16) throw new TypeError('Query matrix requires 16 affine components.');
  const elements = Array.from(values, value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new RangeError('Query matrix requires finite Float32 components.');
    return Math.fround(value);
  });
  if (elements[3] !== 0 || elements[7] !== 0 || elements[11] !== 0 || elements[15] !== 1) throw new RangeError('Query matrix must be affine.');
  const matrix = new Matrix4().fromArray(elements).multiply(record.normalization);
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant) || determinant === 0) throw new RangeError('Query matrix must be nonsingular.');
  const inverse = matrix.clone().invert();
  if (!inverse.elements.every(Number.isFinite)) throw new RangeError('Query matrix inverse exceeds the precision domain.');
  const bounds = record.bounds.clone().applyMatrix4(matrix);
  const coordinates = [...bounds.min.toArray(), ...bounds.max.toArray()];
  if (!coordinates.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) throw new RangeError('Query world coordinates exceed finite Float32 bounds.');
  const inverseNorm = Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map(index => inverse.elements[index]));
  const resolution = Math.max(...coordinates.map(Math.abs)) * 2 ** -21 + 2 ** -149;
  if (record.minimumAltitude / inverseNorm <= resolution) throw new RangeError('Query transformed triangles collapse within the Float32 precision domain.');
  return { matrix, inverse, bounds };
}

function relativeState(second, transform) {
  const inverse = transform.clone().invert();
  const inverseNorm = Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map(index => inverse.elements[index]));
  const bounds = second.bounds.clone().applyMatrix4(transform);
  const maximum = Math.max(...bounds.min.toArray().map(Math.abs), ...bounds.max.toArray().map(Math.abs));
  if (!Number.isFinite(maximum) || maximum > 1e6 || second.minimumAltitude / inverseNorm <= 1e-8) {
    throw new RangeError('Relative mesh transform exceeds the normalized triangle precision domain.');
  }
}

function containment(record, point, counter) {
  if (!record.bounds.containsPoint(point)) return { inside: false, attempts: 0 };
  let previous;
  let accepted = 0;
  let attempts = 0;
  for (const direction of DIRECTIONS) {
    attempts++;
    const ray = new Ray(point, new Vector3(...direction).normalize());
    const hit = new Vector3();
    const weights = new Vector3();
    const normal = new Vector3();
    let count = 0;
    let ambiguous = false;
    let failure;
    record.bvh.shapecast({
      intersectsBounds: bounds => ray.intersectsBox(bounds),
      intersectsTriangle(triangle) {
        try {
          counter.charge();
          triangle.getNormal(normal);
          if (Math.abs(normal.dot(ray.direction)) <= EPSILON && Math.abs(normal.dot(point.clone().sub(triangle.a))) <= EPSILON) {
            ambiguous = true;
            return true;
          }
          if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) return false;
          triangle.getBarycoord(hit, weights);
          if (hit.distanceTo(point) <= EPSILON || Math.min(weights.x, weights.y, weights.z) <= EPSILON) {
            ambiguous = true;
            return true;
          }
          count++;
          return false;
        } catch (error) {
          failure = error;
          return true;
        }
      },
    });
    if (failure) throw failure;
    if (ambiguous) continue;
    const inside = count % 2 === 1;
    if (accepted && previous !== inside) throw new RangeError('Solid containment has inconsistent ray witnesses.');
    previous = inside;
    accepted++;
    if (accepted === 2) return { inside, attempts };
  }
  throw new RangeError('Solid containment is indeterminate after bounded ray retries.');
}

function localVector(input, name) {
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== 3 ||
      !Array.from(input).every(value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value)))) {
    throw new TypeError(`${name} requires three finite Float32-representable components.`);
  }
  return new Vector3(...input);
}

function queryLocalSurface(record, pointInput, directionInput, options) {
  const originalPoint = localVector(pointInput, 'Query point');
  const point = originalPoint.clone().sub(record.center).multiplyScalar(1 / record.scale);
  if (Math.max(...point.toArray().map(Math.abs)) > 1e6) throw new RangeError('Query point exceeds the normalized precision domain.');
  const maximum = options.maxDistance ?? Infinity;
  if ((maximum !== Infinity && (!Number.isFinite(maximum) || !Number.isFinite(Math.fround(maximum)))) || maximum < 0) {
    throw new RangeError('maxDistance must be nonnegative and Float32-representable, or Infinity.');
  }
  const counter = budget(integer(options.maxTriangleTests ?? 2_000_000, 100_000_000, 'maxTriangleTests'), 'maxTriangleTests');
  let ray;
  if (directionInput !== undefined) {
    const direction = localVector(directionInput, 'Projection direction');
    if (direction.length() === 0) throw new RangeError('Projection direction must be nonzero.');
    ray = new Ray(point, direction.normalize());
  }
  let bestDistance = maximum / record.scale;
  let bestLocalDistance = maximum;
  let bestTriangle = Infinity;
  let bestPoint;
  let bestNormal;
  let bestWeights;
  let failure;
  const candidate = new Vector3();
  const candidateLocal = new Vector3();
  const boundsPoint = new Vector3();
  record.bvh.shapecast({
    boundsTraverseOrder(bounds) {
      if (!ray) return bounds.clampPoint(point, boundsPoint).distanceTo(point);
      // Ray.intersectBox returns the exit when the origin is inside. The lower bound is zero there.
      if (bounds.containsPoint(point)) return 0;
      return ray.intersectBox(bounds, boundsPoint) ? boundsPoint.distanceTo(point) : Infinity;
    },
    intersectsBounds: (bounds, leaf, score) => Number.isFinite(score) && score <= bestDistance + EPSILON,
    intersectsTriangle(triangle, triangleIndex) {
      try {
        counter.charge();
        if (ray) {
          if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, candidate)) return false;
        } else {
          triangle.closestPointToPoint(point, candidate);
        }
        const distance = candidate.distanceTo(point);
        if (!Number.isFinite(distance)) throw new RangeError('Surface query exceeds the numerical precision domain.');
        candidateLocal.copy(candidate).multiplyScalar(record.scale).add(record.center);
        const localDistance = candidateLocal.distanceTo(originalPoint);
        // Apply the caller's cutoff in its original frame, avoiding normalized subtraction at exact endpoints.
        if (localDistance > bestLocalDistance || (localDistance === bestLocalDistance && triangleIndex >= bestTriangle)) return false;
        const weights = triangle.getBarycoord(candidate, new Vector3());
        const normal = triangle.getNormal(new Vector3());
        if (!weights || !weights.toArray().every(Number.isFinite) || normal.length() === 0) throw new RangeError('Surface query has invalid triangle coordinates.');
        bestDistance = distance;
        bestLocalDistance = localDistance;
        bestTriangle = triangleIndex;
        bestPoint = candidateLocal.clone();
        bestWeights = weights;
        bestNormal = normal;
        return false;
      } catch (error) {
        failure = error;
        return true;
      }
    },
  });
  if (failure) throw failure;
  if (!bestPoint) return { hit: null, triangleTests: counter.tests };
  const distance = bestLocalDistance;
  if (!Number.isFinite(distance) || !bestPoint.toArray().every(value => Number.isFinite(Math.fround(value)))) throw new RangeError('Surface query hit exceeds finite Float32 coordinates.');
  return { hit: { point: bestPoint.toArray(), distance, triangle: bestTriangle, barycentric: bestWeights.toArray(), normal: bestNormal.toArray() }, triangleTests: counter.tests };
}

/** Copies static geometry into a private normalized BVH. Returned handles expose no Three.js objects. */
export function createMeshQueryIndex(geometry, options = {}) {
  optionsObject(options, INDEX_OPTIONS);
  const maxTriangles = integer(options.maxTriangles ?? 250_000, 1_000_000, 'maxTriangles');
  const maxVertices = integer(options.maxVertices ?? 250_000, 1_000_000, 'maxVertices');
  const maxValidationPairs = integer(options.maxValidationPairs ?? 2_000_000, 100_000_000, 'maxValidationPairs');
  const solid = options.solid ?? false;
  if (typeof solid !== 'boolean') throw new TypeError('solid must be boolean.');
  const memoryBudgetMiB = options.memoryBudgetMiB ?? 64;
  if (!Number.isFinite(memoryBudgetMiB) || memoryBudgetMiB <= 0 || memoryBudgetMiB > 1024) throw new RangeError('memoryBudgetMiB must be within zero and 1024.');
  const metadata = validateGeometry(geometry, maxVertices, maxTriangles);
  const reservedBytes = metadata.vertexCount * (solid ? 152 : 24) + metadata.triangleCount * (solid ? 512 : 128);
  if (reservedBytes > memoryBudgetMiB * 1024 * 1024) throw new RangeError('Mesh query allocation estimate exceeds memoryBudgetMiB.');
  const welded = solid ? topology(geometry) : null;
  const source = new BufferGeometry();
  const positions = new Float64Array(geometry.positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) positions[offset + axis] = (geometry.positions[offset + axis] - metadata.center.getComponent(axis)) / metadata.scale;
  }
  source.setAttribute('position', new BufferAttribute(positions, 3));
  source.setIndex(new BufferAttribute(new Uint32Array(geometry.indices), 1));
  const normalization = new Matrix4().makeScale(metadata.scale, metadata.scale, metadata.scale).setPosition(metadata.center);
  const record = { ...metadata, normalization, geometry: source, bounds: new Box3().setFromBufferAttribute(source.attributes.position), bvh: null, disposed: false, solid };
  try {
    record.bvh = new MeshBVH(source, { indirect: true, strategy: SAH, maxDepth: 64, targetLeafSize: 8, verbose: false });
    const validationPairs = solid ? validateSelfIntersections(record, welded, maxValidationPairs) : 0;
    const memoryPlan = Object.freeze({ reservedBytes, memoryBudgetMiB, vertexCount: metadata.vertexCount, triangleCount: metadata.triangleCount, validationPairs });
    const handle = Object.freeze({
      solid,
      memoryPlan,
      info: Object.freeze({ vertexCount: metadata.vertexCount, triangleCount: metadata.triangleCount, estimatedBytes: reservedBytes }),
      nearest(point, options = {}) {
        optionsObject(options, NEAREST_OPTIONS);
        return queryLocalSurface(live(handle), point, undefined, options);
      },
      project(ray) {
        optionsObject(ray, PROJECT_OPTIONS);
        if (ray.direction === undefined) throw new TypeError('Projection requires direction.');
        return queryLocalSurface(live(handle), ray.origin, ray.direction, ray);
      },
      raycast(matrix, ray) {
        const current = live(handle);
        const state = matrixState(current, matrix);
        if (!ray || typeof ray !== 'object') throw new TypeError('ray requires origin and direction.');
        const read = field => {
          const input = ray[field];
          if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== 3 || !Array.from(input).every(value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value)))) throw new TypeError(`Ray ${field} requires three finite Float32 values.`);
          return new Vector3(...Array.from(input, Math.fround));
        };
        const origin = read('origin');
        const direction = read('direction');
        if (direction.length() === 0) throw new RangeError('Ray direction must be nonzero.');
        const maximum = ray.maxDistance ?? Infinity;
        if ((maximum !== Infinity && !Number.isFinite(maximum)) || maximum < 0) throw new RangeError('Ray maxDistance must be nonnegative.');
        const localRay = new Ray(origin.clone(), direction.normalize()).applyMatrix4(state.inverse);
        if (Math.max(...localRay.origin.toArray().map(Math.abs)) > 1e6) throw new RangeError('Ray origin exceeds the normalized query precision domain.');
        const result = current.bvh.raycastFirst(localRay, DoubleSide);
        if (!result) return null;
        const worldPoint = result.point.clone().applyMatrix4(state.matrix);
        const distance = worldPoint.distanceTo(origin);
        if (!Number.isFinite(distance) || !worldPoint.toArray().every(value => Number.isFinite(Math.fround(value)))) throw new RangeError('Ray hit exceeds finite world coordinates.');
        if (distance > maximum) return null;
        const triangle = result.faceIndex;
        const positions = current.geometry.attributes.position;
        const ids = current.geometry.index;
        const first = new Vector3().fromBufferAttribute(positions, ids.getX(triangle * 3));
        const second = new Vector3().fromBufferAttribute(positions, ids.getX(triangle * 3 + 1));
        const third = new Vector3().fromBufferAttribute(positions, ids.getX(triangle * 3 + 2));
        const weights = new Triangle(first, second, third).getBarycoord(result.point, new Vector3());
        if (!weights || !weights.toArray().every(Number.isFinite)) throw new RangeError('Ray barycentric coordinates exceed the query precision domain.');
        return { point: worldPoint.toArray(), distance, triangle, barycentric: weights.toArray() };
      },
      dispose() {
        if (record.disposed) return;
        record.disposed = true;
        record.geometry.dispose();
        record.geometry = null;
        record.bvh = null;
      },
    });
    records.set(handle, record);
    return handle;
  } catch (error) {
    source.dispose();
    throw error;
  }
}

/** Surface contacts are not proof of volume penetration. Closed solids additionally test containment. */
export function createMeshPairQuery(indexA, indexB, options = {}) {
  optionsObject(options, PAIR_OPTIONS);
  const first = live(indexA);
  const second = live(indexB);
  const mode = options.mode ?? 'surfaces';
  if (mode !== 'surfaces' && mode !== 'closed-solids') throw new RangeError('Query mode must be surfaces or closed-solids.');
  if (mode === 'closed-solids' && (!first.solid || !second.solid)) throw new RangeError('Closed-solid queries require two validated solid indices.');
  const maximum = integer(options.maxTriangleTests ?? 2_000_000, 100_000_000, 'maxTriangleTests');
  return Object.freeze({
    evaluate(matrixA, matrixB) {
      const currentA = live(indexA);
      const currentB = live(indexB);
      const stateA = matrixState(currentA, matrixA);
      const stateB = matrixState(currentB, matrixB);
      const result = { kind: mode === 'surfaces' ? 'surface-disjoint' : 'separate', solidRelation: mode === 'surfaces' ? 'not-tested' : 'outside', triangles: null, triangleTests: 0, rayAttempts: 0 };
      if (!stateA.bounds.intersectsBox(stateB.bounds)) return result;
      const relativeB = stateA.inverse.clone().multiply(stateB.matrix);
      const relativeA = stateB.inverse.clone().multiply(stateA.matrix);
      relativeState(currentB, relativeB);
      relativeState(currentA, relativeA);
      const counter = budget(maximum, 'maxTriangleTests');
      const contact = cast(currentA, currentB, relativeB, counter, (firstTriangle, secondTriangle, firstId, secondId) => {
        if (!firstTriangle.intersectsTriangle(secondTriangle)) return false;
        result.triangles = [firstId, secondId];
        return true;
      });
      if (contact) {
        result.kind = 'surface-intersection';
        result.solidRelation = mode === 'surfaces' ? 'not-tested' : 'boundaries-intersect';
      } else if (mode === 'closed-solids') {
        const pointA = new Vector3().fromBufferAttribute(currentA.geometry.attributes.position, currentA.geometry.index.getX(0)).applyMatrix4(relativeA);
        const pointB = new Vector3().fromBufferAttribute(currentB.geometry.attributes.position, currentB.geometry.index.getX(0)).applyMatrix4(relativeB);
        const firstInside = containment(currentB, pointA, counter);
        const secondInside = containment(currentA, pointB, counter);
        result.rayAttempts = firstInside.attempts + secondInside.attempts;
        if (firstInside.inside && secondInside.inside) throw new RangeError('Solid containment witnesses are inconsistent.');
        if (firstInside.inside || secondInside.inside) {
          result.kind = 'contained';
          result.solidRelation = firstInside.inside ? 'a-in-b' : 'b-in-a';
        }
      }
      result.triangleTests = counter.tests;
      return result;
    },
  });
}
