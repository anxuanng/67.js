import { createMeshData, TAG_PREFIX } from './mesh-data.js';
import { triangulateMesh } from './mesh-render.js';
import { faceNormals } from './mesh-normals.js';

// Quadric edge collapse (Garland and Heckbert) on the triangulated mesh. Open boundaries and the borders between
// faces with different tags are constraints: their vertices only collapse along the constraint, and extra planes
// through each constraint edge keep it in place. Corner and edge attributes (uv, colour, sharp) are dropped, because
// a collapse has no single right value for them; run uv_unwrap after decimating.

export const MIN_DECIMATED_TRIANGLES = 4;
const CONSTRAINT_WEIGHT = 100;
const MINIMUM_NORMAL_AGREEMENT = 0.2;
const MAXIMUM_DRIFT_IN_EDGE_LENGTHS = 1.5;

class MinHeap {
  constructor() {
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  push(entry) {
    const entries = this.entries;
    let index = entries.length;
    entries.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (entries[parent].cost <= entry.cost) break;
      entries[index] = entries[parent];
      index = parent;
    }
    entries[index] = entry;
  }

  pop() {
    const entries = this.entries;
    const top = entries[0];
    const last = entries.pop();
    if (entries.length) {
      let index = 0;
      for (;;) {
        let child = index * 2 + 1;
        if (child >= entries.length) break;
        if (child + 1 < entries.length && entries[child + 1].cost < entries[child].cost) child++;
        if (entries[child].cost >= last.cost) break;
        entries[index] = entries[child];
        index = child;
      }
      entries[index] = last;
    }
    return top;
  }
}

// A quadric is the symmetric 4x4 matrix of a plane sum, stored as ten numbers: aa ab ac ad bb bc bd cc cd dd.
function addPlane(quadrics, vertex, nx, ny, nz, d, weight) {
  const base = vertex * 10;
  quadrics[base] += weight * nx * nx;
  quadrics[base + 1] += weight * nx * ny;
  quadrics[base + 2] += weight * nx * nz;
  quadrics[base + 3] += weight * nx * d;
  quadrics[base + 4] += weight * ny * ny;
  quadrics[base + 5] += weight * ny * nz;
  quadrics[base + 6] += weight * ny * d;
  quadrics[base + 7] += weight * nz * nz;
  quadrics[base + 8] += weight * nz * d;
  quadrics[base + 9] += weight * d * d;
}

function quadricError(q, x, y, z) {
  return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x +
    q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y +
    q[7] * z * z + 2 * q[8] * z + q[9];
}

/** The point minimising the quadric, or null when the system is nearly singular. */
function optimalPoint(q) {
  const [a, b, c, d, e, f, g, h, i] = q;
  const determinant = a * (e * h - f * f) - b * (b * h - f * c) + c * (b * f - e * c);
  const scale = Math.abs(a) * Math.abs(e) * Math.abs(h);
  if (Math.abs(determinant) <= 1e-9 * scale || scale === 0) return null;
  const x = -(d * (e * h - f * f) - b * (g * h - f * i) + c * (g * f - e * i)) / determinant;
  const y = -(a * (g * h - f * i) - d * (b * h - f * c) + c * (b * i - g * c)) / determinant;
  const z = -(a * (e * i - g * f) - b * (b * i - g * c) + d * (b * f - e * c)) / determinant;
  return [x, y, z];
}

// Math.hypot is several times slower than this in the collapse loop.
function vectorLength(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function edgeKey(first, second, vertexCount) {
  return first < second ? first * vertexCount + second : second * vertexCount + first;
}

function faceSignatures(mesh) {
  const tags = Object.entries(mesh.attributes.face).filter(([name]) => name.startsWith(TAG_PREFIX)).map(([, attribute]) => attribute.data);
  return Uint32Array.from({ length: mesh.faceCount }, (value, face) => {
    let signature = 0;
    tags.forEach((data, index) => {
      signature = (signature * 31 + (data[face] ? index + 1 : 0)) >>> 0;
    });
    return signature;
  });
}

class Decimator {
  constructor(mesh) {
    this.mesh = mesh;
    this.vertexCount = mesh.vertexCount;
    this.positions = Float64Array.from(mesh.positions);
    this.cornerBuffer = new Float64Array(9);
    this.combinedQuadric = new Float64Array(10);
    const { triangleCorners, triangleFaces } = triangulateMesh(mesh, faceNormals(mesh).normals);
    this.triangleCount = triangleFaces.length;
    this.sourceFaces = triangleFaces;
    this.triangles = Int32Array.from(triangleCorners, corner => mesh.cornerVertices[corner]);
    this.alive = new Uint8Array(this.triangleCount).fill(1);
    this.aliveCount = this.triangleCount;
    this.vertexAlive = new Uint8Array(this.vertexCount).fill(1);
    this.vertexTriangles = Array.from({ length: this.vertexCount }, () => []);
    for (let triangle = 0; triangle < this.triangleCount; triangle++) {
      for (let corner = 0; corner < 3; corner++) this.vertexTriangles[this.triangles[triangle * 3 + corner]].push(triangle);
    }
    this.quadrics = new Float64Array(this.vertexCount * 10);
    this.constrainedVertex = new Uint8Array(this.vertexCount);
    this.constraintEdges = new Set();
    this.buildQuadrics();
  }

  /** Unnormalised normal of a triangle, with one vertex optionally moved to `replacement`. */
  triangleNormal(triangle, replaced = -1, replacement = null) {
    const corners = this.cornerBuffer;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = this.triangles[triangle * 3 + corner];
      const source = vertex === replaced ? replacement : this.positions;
      const offset = vertex === replaced ? 0 : vertex * 3;
      corners[corner * 3] = source[offset];
      corners[corner * 3 + 1] = source[offset + 1];
      corners[corner * 3 + 2] = source[offset + 2];
    }
    const ux = corners[3] - corners[0];
    const uy = corners[4] - corners[1];
    const uz = corners[5] - corners[2];
    const vx = corners[6] - corners[0];
    const vy = corners[7] - corners[1];
    const vz = corners[8] - corners[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  }

  buildQuadrics() {
    const signatures = faceSignatures(this.mesh);
    const edgeFaces = new Map();
    for (let triangle = 0; triangle < this.triangleCount; triangle++) {
      const normal = this.triangleNormal(triangle);
      const length = Math.hypot(...normal);
      if (length > 0) {
        const unit = normal.map(value => value / length);
        const first = this.triangles[triangle * 3] * 3;
        const d = -(unit[0] * this.positions[first] + unit[1] * this.positions[first + 1] + unit[2] * this.positions[first + 2]);
        for (let corner = 0; corner < 3; corner++) addPlane(this.quadrics, this.triangles[triangle * 3 + corner], unit[0], unit[1], unit[2], d, length / 2);
      }
      for (let corner = 0; corner < 3; corner++) {
        const key = edgeKey(this.triangles[triangle * 3 + corner], this.triangles[triangle * 3 + (corner + 1) % 3], this.vertexCount);
        if (!edgeFaces.has(key)) edgeFaces.set(key, []);
        edgeFaces.get(key).push(triangle);
      }
    }
    for (const [key, triangles] of edgeFaces) {
      const sameSignature = triangles.every(triangle => signatures[this.sourceFaces[triangle]] === signatures[this.sourceFaces[triangles[0]]]);
      if (triangles.length === 2 && sameSignature) continue;
      this.constraintEdges.add(key);
      const first = Math.floor(key / this.vertexCount);
      const second = key - first * this.vertexCount;
      this.constrainedVertex[first] = 1;
      this.constrainedVertex[second] = 1;
      for (const triangle of triangles) this.addConstraintPlane(first, second, triangle);
    }
  }

  addConstraintPlane(first, second, triangle) {
    const edge = [0, 1, 2].map(axis => this.positions[second * 3 + axis] - this.positions[first * 3 + axis]);
    const face = this.triangleNormal(triangle);
    const normal = [edge[1] * face[2] - edge[2] * face[1], edge[2] * face[0] - edge[0] * face[2], edge[0] * face[1] - edge[1] * face[0]];
    const length = Math.hypot(...normal);
    if (length === 0) return;
    const unit = normal.map(value => value / length);
    const d = -(unit[0] * this.positions[first * 3] + unit[1] * this.positions[first * 3 + 1] + unit[2] * this.positions[first * 3 + 2]);
    const weight = CONSTRAINT_WEIGHT * (edge[0] ** 2 + edge[1] ** 2 + edge[2] ** 2);
    addPlane(this.quadrics, first, unit[0], unit[1], unit[2], d, weight);
    addPlane(this.quadrics, second, unit[0], unit[1], unit[2], d, weight);
  }

  neighbors(vertex) {
    const found = new Set();
    for (const triangle of this.vertexTriangles[vertex]) {
      for (let corner = 0; corner < 3; corner++) found.add(this.triangles[triangle * 3 + corner]);
    }
    found.delete(vertex);
    return found;
  }

  /** The collapse of `second` into `first`: its target point and cost, or null when it would break the surface. */
  evaluate(first, second) {
    const shared = this.vertexTriangles[first].filter(triangle => this.vertexTriangles[second].includes(triangle));
    if (!shared.length) return null;
    const firstConstrained = this.constrainedVertex[first] === 1;
    const secondConstrained = this.constrainedVertex[second] === 1;
    if (firstConstrained && secondConstrained && !this.constraintEdges.has(edgeKey(first, second, this.vertexCount))) return null;
    const secondNeighbors = this.neighbors(second);
    const common = [...this.neighbors(first)].filter(vertex => secondNeighbors.has(vertex));
    if (common.length !== shared.length) return null;
    const target = this.chooseTarget(first, second, firstConstrained, secondConstrained);
    if (!this.keepsOrientation(first, second, shared, target.point)) return null;
    return target;
  }

  chooseTarget(first, second, firstConstrained, secondConstrained) {
    const combined = this.combinedQuadric;
    for (let slot = 0; slot < 10; slot++) combined[slot] = this.quadrics[first * 10 + slot] + this.quadrics[second * 10 + slot];
    const at = vertex => [this.positions[vertex * 3], this.positions[vertex * 3 + 1], this.positions[vertex * 3 + 2]];
    const start = at(first);
    const end = at(second);
    const candidates = [];
    if (firstConstrained !== secondConstrained) {
      candidates.push(firstConstrained ? start : end);
    } else {
      const middle = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
      candidates.push(start, end, middle);
      const optimal = firstConstrained ? null : optimalPoint(combined);
      const drift = optimal && vectorLength(optimal[0] - middle[0], optimal[1] - middle[1], optimal[2] - middle[2]);
      if (optimal && drift <= MAXIMUM_DRIFT_IN_EDGE_LENGTHS * vectorLength(start[0] - end[0], start[1] - end[1], start[2] - end[2])) {
        candidates.push(optimal);
      }
    }
    let best = null;
    for (const point of candidates) {
      const cost = quadricError(combined, point[0], point[1], point[2]);
      if (!best || cost < best.cost) best = { point, cost: Math.max(cost, 0) };
    }
    return best;
  }

  keepsOrientation(first, second, shared, point) {
    for (const vertex of [first, second]) {
      for (const triangle of this.vertexTriangles[vertex]) {
        if (shared.includes(triangle)) continue;
        const before = this.triangleNormal(triangle);
        const after = this.triangleNormal(triangle, vertex, point);
        const lengths = vectorLength(before[0], before[1], before[2]) * vectorLength(after[0], after[1], after[2]);
        if (lengths === 0) return false;
        const agreement = (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / lengths;
        if (agreement < MINIMUM_NORMAL_AGREEMENT) return false;
      }
    }
    return true;
  }

  collapse(first, second, point) {
    for (const triangle of [...this.vertexTriangles[second]]) {
      const corners = [0, 1, 2].map(corner => this.triangles[triangle * 3 + corner]);
      if (corners.includes(first)) {
        this.alive[triangle] = 0;
        this.aliveCount--;
        for (const vertex of corners) this.dropTriangle(vertex, triangle);
        continue;
      }
      this.triangles[triangle * 3 + corners.indexOf(second)] = first;
      this.vertexTriangles[first].push(triangle);
    }
    this.moveConstraintEdges(first, second);
    this.positions.set(point, first * 3);
    for (let slot = 0; slot < 10; slot++) this.quadrics[first * 10 + slot] += this.quadrics[second * 10 + slot];
    this.constrainedVertex[first] ||= this.constrainedVertex[second];
    this.vertexAlive[second] = 0;
    this.vertexTriangles[second] = [];
  }

  moveConstraintEdges(first, second) {
    if (!this.constrainedVertex[second]) return;
    for (const other of this.neighbors(second)) {
      const key = edgeKey(second, other, this.vertexCount);
      if (!this.constraintEdges.has(key)) continue;
      this.constraintEdges.delete(key);
      if (other !== first) this.constraintEdges.add(edgeKey(first, other, this.vertexCount));
    }
  }

  dropTriangle(vertex, triangle) {
    const list = this.vertexTriangles[vertex];
    const index = list.indexOf(triangle);
    if (index >= 0) {
      list[index] = list[list.length - 1];
      list.pop();
    }
  }

  run(targetTriangles) {
    const heap = new MinHeap();
    // Queued costs are estimates: validity is decided when an entry is popped, which keeps the setup cheap.
    const queue = (first, second) => {
      const firstConstrained = this.constrainedVertex[first] === 1;
      const secondConstrained = this.constrainedVertex[second] === 1;
      if (firstConstrained && secondConstrained && !this.constraintEdges.has(edgeKey(first, second, this.vertexCount))) return;
      heap.push({ cost: this.chooseTarget(first, second, firstConstrained, secondConstrained).cost, first, second });
    };
    for (let triangle = 0; triangle < this.triangleCount; triangle++) {
      for (let corner = 0; corner < 3; corner++) {
        const first = this.triangles[triangle * 3 + corner];
        const second = this.triangles[triangle * 3 + (corner + 1) % 3];
        if (first < second || !this.hasTriangleOnOtherSide(first, second, triangle)) queue(first, second);
      }
    }
    while (this.aliveCount > targetTriangles && heap.size) {
      const { cost, first, second } = heap.pop();
      if (!this.vertexAlive[first] || !this.vertexAlive[second]) continue;
      const target = this.evaluate(first, second);
      if (!target) continue;
      if (target.cost > cost * 1.0001 + 1e-18) {
        heap.push({ cost: target.cost, first, second });
        continue;
      }
      this.collapse(first, second, target.point);
      for (const neighbor of this.neighbors(first)) queue(first, neighbor);
    }
  }

  hasTriangleOnOtherSide(first, second, triangle) {
    return this.vertexTriangles[first].some(other => other !== triangle && this.vertexTriangles[second].includes(other));
  }

  result() {
    const vertexMap = new Int32Array(this.vertexCount).fill(-1);
    const keptTriangles = [];
    for (let triangle = 0; triangle < this.triangleCount; triangle++) if (this.alive[triangle]) keptTriangles.push(triangle);
    const positions = [];
    const cornerVertices = new Uint32Array(keptTriangles.length * 3);
    keptTriangles.forEach((triangle, slot) => {
      for (let corner = 0; corner < 3; corner++) {
        const vertex = this.triangles[triangle * 3 + corner];
        if (vertexMap[vertex] < 0) {
          vertexMap[vertex] = positions.length / 3;
          positions.push(this.positions[vertex * 3], this.positions[vertex * 3 + 1], this.positions[vertex * 3 + 2]);
        }
        cornerVertices[slot * 3 + corner] = vertexMap[vertex];
      }
    });
    const faceOffsets = Uint32Array.from({ length: keptTriangles.length + 1 }, (value, index) => index * 3);
    const face = {};
    for (const [name, attribute] of Object.entries(this.mesh.attributes.face)) {
      if (!name.startsWith(TAG_PREFIX)) continue;
      face[name] = { data: Uint8Array.from(keptTriangles, triangle => attribute.data[this.sourceFaces[triangle]]), size: 1 };
    }
    return createMeshData({ positions: Float32Array.from(positions), faceOffsets, cornerVertices, attributes: { face } });
  }
}

/**
 * Reduce a mesh to about `ratio` of its triangles (counted after triangulation, never below four). Returns the
 * triangle mesh, the triangle counts and whether the target was reached; constraints can stop a collapse early.
 */
export function decimateMesh(mesh, { ratio }) {
  if (typeof ratio !== 'number' || !(ratio > 0) || ratio > 1) throw new RangeError('ratio must be above 0 and at most 1.');
  const decimator = new Decimator(mesh);
  const before = decimator.aliveCount;
  const target = Math.max(MIN_DECIMATED_TRIANGLES, Math.ceil(before * ratio));
  decimator.run(target);
  const reduced = decimator.result();
  return { mesh: reduced, triangles: { before, after: reduced.faceCount }, reachedTarget: reduced.faceCount <= target };
}
