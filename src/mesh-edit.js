import { createMeshData, DOMAINS } from './mesh-data.js';

// Mutable polygon topology in BMesh's model, stored as typed arrays indexed by element number.
//
// Vertex v: position, and one "edge slot" in its disk cycle (-1 when loose).
// Edge e: two endpoint slots, 2e and 2e+1. Slot s belongs to vertex edgeVertex[s]. diskNext/diskPrev link the slots
//   around one vertex, which plays the role of BMesh's v1_disk_link and v2_disk_link. edgeLoop is one loop of the
//   radial cycle (-1 for a wire edge).
// Loop l: one face corner. loopVertex is the corner's vertex, loopEdge runs from it to the next corner's vertex.
//   loopNext/loopPrev walk the face, loopRadialNext/Prev walk the faces sharing loopEdge.
// Face f: one loop and the corner count.
// Removed elements are flagged and recycled through free lists; toMeshData() compacts.

const INITIAL_CAPACITY = 16;

function grow(array, capacity, fill) {
  const next = new array.constructor(capacity);
  next.set(array);
  if (fill !== undefined) next.fill(fill, array.length);
  return next;
}

class ElementStore {
  constructor(fields, capacity) {
    this.fields = fields;
    this.capacity = capacity;
    this.count = 0;
    this.liveCount = 0;
    this.free = [];
    this.removed = new Uint8Array(capacity);
    this.arrays = {};
    for (const [name, { type, width, fill }] of Object.entries(fields)) {
      this.arrays[name] = new type(capacity * width);
      if (fill !== undefined) this.arrays[name].fill(fill);
    }
    this.attributes = new Map();
  }

  ensureCapacity(required) {
    if (required <= this.capacity) return;
    let capacity = this.capacity;
    while (capacity < required) capacity *= 2;
    for (const [name, { width, fill }] of Object.entries(this.fields)) {
      this.arrays[name] = grow(this.arrays[name], capacity * width, fill);
    }
    for (const attribute of this.attributes.values()) {
      attribute.data = grow(attribute.data, capacity * attribute.size);
    }
    this.removed = grow(this.removed, capacity);
    this.capacity = capacity;
  }

  allocate() {
    let index;
    if (this.free.length) {
      index = this.free.pop();
      this.removed[index] = 0;
    } else {
      this.ensureCapacity(this.count + 1);
      index = this.count;
      this.count++;
    }
    for (const attribute of this.attributes.values()) {
      attribute.data.fill(0, index * attribute.size, (index + 1) * attribute.size);
    }
    this.liveCount++;
    return index;
  }

  release(index) {
    this.removed[index] = 1;
    this.free.push(index);
    this.liveCount--;
  }

  isLive(index) {
    return index >= 0 && index < this.count && !this.removed[index];
  }
}

export class EditMesh {
  constructor(capacities = {}) {
    this.vertices = new ElementStore({
      position: { type: Float32Array, width: 3 },
      edgeSlot: { type: Int32Array, width: 1, fill: -1 },
    }, Math.max(INITIAL_CAPACITY, capacities.vertices ?? 0));
    this.edges = new ElementStore({
      vertex: { type: Int32Array, width: 2, fill: -1 },
      diskNext: { type: Int32Array, width: 2, fill: -1 },
      diskPrev: { type: Int32Array, width: 2, fill: -1 },
      loop: { type: Int32Array, width: 1, fill: -1 },
    }, Math.max(INITIAL_CAPACITY, capacities.edges ?? 0));
    this.loops = new ElementStore({
      vertex: { type: Int32Array, width: 1 },
      edge: { type: Int32Array, width: 1 },
      face: { type: Int32Array, width: 1 },
      next: { type: Int32Array, width: 1 },
      prev: { type: Int32Array, width: 1 },
      radialNext: { type: Int32Array, width: 1 },
      radialPrev: { type: Int32Array, width: 1 },
    }, Math.max(INITIAL_CAPACITY, capacities.loops ?? 0));
    this.faces = new ElementStore({
      loop: { type: Int32Array, width: 1, fill: -1 },
      size: { type: Int32Array, width: 1 },
    }, Math.max(INITIAL_CAPACITY, capacities.faces ?? 0));
  }

  storeForDomain(domain) {
    if (domain === 'point') return this.vertices;
    if (domain === 'edge') return this.edges;
    if (domain === 'face') return this.faces;
    if (domain === 'corner') return this.loops;
    throw new RangeError(`Unknown domain ${domain}.`);
  }

  /** Add (or return) a per-element attribute array that grows with the domain. */
  ensureAttribute(domain, name, type = Float32Array, size = 1) {
    const store = this.storeForDomain(domain);
    let attribute = store.attributes.get(name);
    if (attribute) {
      if (attribute.data.constructor !== type || attribute.size !== size) throw new TypeError(`Attribute ${name} already exists with another type or size.`);
      return attribute;
    }
    attribute = { data: new type(store.capacity * size), size };
    store.attributes.set(name, attribute);
    return attribute;
  }

  attribute(domain, name) {
    return this.storeForDomain(domain).attributes.get(name);
  }

  get vertexCount() { return this.vertices.liveCount; }
  get edgeCount() { return this.edges.liveCount; }
  get faceCount() { return this.faces.liveCount; }
  get loopCount() { return this.loops.liveCount; }

  // ----- vertices -----

  createVertex(x, y, z) {
    const vertex = this.vertices.allocate();
    const position = this.vertices.arrays.position;
    position[vertex * 3] = x;
    position[vertex * 3 + 1] = y;
    position[vertex * 3 + 2] = z;
    this.vertices.arrays.edgeSlot[vertex] = -1;
    return vertex;
  }

  vertexPosition(vertex, target = [0, 0, 0]) {
    const position = this.vertices.arrays.position;
    target[0] = position[vertex * 3];
    target[1] = position[vertex * 3 + 1];
    target[2] = position[vertex * 3 + 2];
    return target;
  }

  setVertexPosition(vertex, x, y, z) {
    const position = this.vertices.arrays.position;
    position[vertex * 3] = x;
    position[vertex * 3 + 1] = y;
    position[vertex * 3 + 2] = z;
  }

  // ----- disk cycles -----

  slotVertex(slot) {
    return this.edges.arrays.vertex[slot];
  }

  /** Edges around a vertex, in disk order. */
  vertexEdges(vertex) {
    const result = [];
    const first = this.vertices.arrays.edgeSlot[vertex];
    if (first === -1) return result;
    const diskNext = this.edges.arrays.diskNext;
    let slot = first;
    do {
      result.push(slot >> 1);
      slot = diskNext[slot];
    } while (slot !== first);
    return result;
  }

  vertexDegree(vertex) {
    const first = this.vertices.arrays.edgeSlot[vertex];
    if (first === -1) return 0;
    const diskNext = this.edges.arrays.diskNext;
    let count = 0;
    let slot = first;
    do {
      count++;
      slot = diskNext[slot];
    } while (slot !== first);
    return count;
  }

  /** The edge between two vertices, or -1. Walks the first vertex's disk cycle, as BM_edge_exists does. */
  findEdge(first, second) {
    const start = this.vertices.arrays.edgeSlot[first];
    if (start === -1) return -1;
    const diskNext = this.edges.arrays.diskNext;
    const edgeVertex = this.edges.arrays.vertex;
    let slot = start;
    do {
      if (edgeVertex[slot ^ 1] === second) return slot >> 1;
      slot = diskNext[slot];
    } while (slot !== start);
    return -1;
  }

  linkSlot(slot) {
    const vertex = this.edges.arrays.vertex[slot];
    const edgeSlot = this.vertices.arrays.edgeSlot;
    const diskNext = this.edges.arrays.diskNext;
    const diskPrev = this.edges.arrays.diskPrev;
    const first = edgeSlot[vertex];
    if (first === -1) {
      diskNext[slot] = slot;
      diskPrev[slot] = slot;
      edgeSlot[vertex] = slot;
      return;
    }
    const last = diskPrev[first];
    diskNext[last] = slot;
    diskPrev[slot] = last;
    diskNext[slot] = first;
    diskPrev[first] = slot;
  }

  unlinkSlot(slot) {
    const vertex = this.edges.arrays.vertex[slot];
    const edgeSlot = this.vertices.arrays.edgeSlot;
    const diskNext = this.edges.arrays.diskNext;
    const diskPrev = this.edges.arrays.diskPrev;
    const next = diskNext[slot];
    if (next === slot) {
      edgeSlot[vertex] = -1;
    } else {
      const previous = diskPrev[slot];
      diskNext[previous] = next;
      diskPrev[next] = previous;
      if (edgeSlot[vertex] === slot) edgeSlot[vertex] = next;
    }
    diskNext[slot] = -1;
    diskPrev[slot] = -1;
  }

  // ----- edges -----

  /** Return the edge between two distinct vertices, creating a wire edge when none exists. */
  ensureEdge(first, second) {
    if (first === second) throw new RangeError('An edge needs two distinct vertices.');
    const existing = this.findEdge(first, second);
    if (existing !== -1) return existing;
    const edge = this.edges.allocate();
    this.edges.arrays.vertex[edge * 2] = first;
    this.edges.arrays.vertex[edge * 2 + 1] = second;
    this.edges.arrays.loop[edge] = -1;
    this.linkSlot(edge * 2);
    this.linkSlot(edge * 2 + 1);
    return edge;
  }

  edgeVertices(edge) {
    return [this.edges.arrays.vertex[edge * 2], this.edges.arrays.vertex[edge * 2 + 1]];
  }

  edgeOtherVertex(edge, vertex) {
    const vertices = this.edges.arrays.vertex;
    return vertices[edge * 2] === vertex ? vertices[edge * 2 + 1] : vertices[edge * 2];
  }

  /** Loops in the radial cycle of an edge: one per face using it. */
  edgeLoops(edge) {
    const result = [];
    const first = this.edges.arrays.loop[edge];
    if (first === -1) return result;
    const radialNext = this.loops.arrays.radialNext;
    let loop = first;
    do {
      result.push(loop);
      loop = radialNext[loop];
    } while (loop !== first);
    return result;
  }

  edgeFaceCount(edge) {
    const first = this.edges.arrays.loop[edge];
    if (first === -1) return 0;
    const radialNext = this.loops.arrays.radialNext;
    let count = 0;
    let loop = first;
    do {
      count++;
      loop = radialNext[loop];
    } while (loop !== first);
    return count;
  }

  removeEdge(edge) {
    while (this.edges.arrays.loop[edge] !== -1) {
      this.removeFace(this.loops.arrays.face[this.edges.arrays.loop[edge]]);
    }
    this.unlinkSlot(edge * 2);
    this.unlinkSlot(edge * 2 + 1);
    this.edges.release(edge);
  }

  // ----- loops and faces -----

  linkRadial(loop, edge) {
    const edgeLoop = this.edges.arrays.loop;
    const radialNext = this.loops.arrays.radialNext;
    const radialPrev = this.loops.arrays.radialPrev;
    const first = edgeLoop[edge];
    if (first === -1) {
      radialNext[loop] = loop;
      radialPrev[loop] = loop;
      edgeLoop[edge] = loop;
      return;
    }
    const last = radialPrev[first];
    radialNext[last] = loop;
    radialPrev[loop] = last;
    radialNext[loop] = first;
    radialPrev[first] = loop;
  }

  unlinkRadial(loop) {
    const edge = this.loops.arrays.edge[loop];
    const edgeLoop = this.edges.arrays.loop;
    const radialNext = this.loops.arrays.radialNext;
    const radialPrev = this.loops.arrays.radialPrev;
    const next = radialNext[loop];
    if (next === loop) {
      edgeLoop[edge] = -1;
      return;
    }
    const previous = radialPrev[loop];
    radialNext[previous] = next;
    radialPrev[next] = previous;
    if (edgeLoop[edge] === loop) edgeLoop[edge] = next;
  }

  /**
   * Create a face over existing vertices in winding order, creating missing edges.
   * Returns the face index. Rejects repeated vertices and duplicate faces over the same vertex cycle.
   */
  createFace(vertices) {
    const size = vertices.length;
    if (size < 3) throw new RangeError('A face needs at least three vertices.');
    if (new Set(vertices).size !== size) throw new RangeError('A face cannot repeat a vertex.');
    for (const vertex of vertices) {
      if (!this.vertices.isLive(vertex)) throw new RangeError(`Vertex ${vertex} does not exist.`);
    }
    const edges = new Array(size);
    for (let corner = 0; corner < size; corner++) {
      edges[corner] = this.ensureEdge(vertices[corner], vertices[(corner + 1) % size]);
    }
    const face = this.faces.allocate();
    const loopArrays = this.loops.arrays;
    let firstLoop = -1;
    let previousLoop = -1;
    for (let corner = 0; corner < size; corner++) {
      const loop = this.loops.allocate();
      loopArrays.vertex[loop] = vertices[corner];
      loopArrays.edge[loop] = edges[corner];
      loopArrays.face[loop] = face;
      if (previousLoop === -1) {
        firstLoop = loop;
      } else {
        loopArrays.next[previousLoop] = loop;
        loopArrays.prev[loop] = previousLoop;
      }
      previousLoop = loop;
      this.linkRadial(loop, edges[corner]);
    }
    loopArrays.next[previousLoop] = firstLoop;
    loopArrays.prev[firstLoop] = previousLoop;
    this.faces.arrays.loop[face] = firstLoop;
    this.faces.arrays.size[face] = size;
    return face;
  }

  /** Remove a face and its loops. Edges and vertices stay, as BM_face_kill. */
  removeFace(face) {
    const loopArrays = this.loops.arrays;
    const first = this.faces.arrays.loop[face];
    let loop = first;
    do {
      const next = loopArrays.next[loop];
      this.unlinkRadial(loop);
      this.loops.release(loop);
      loop = next;
    } while (loop !== first);
    this.faces.arrays.loop[face] = -1;
    this.faces.release(face);
  }

  /** Remove a vertex together with every edge and face using it. */
  removeVertex(vertex) {
    while (this.vertices.arrays.edgeSlot[vertex] !== -1) {
      this.removeEdge(this.vertices.arrays.edgeSlot[vertex] >> 1);
    }
    this.vertices.release(vertex);
  }

  faceLoops(face) {
    const result = [];
    const next = this.loops.arrays.next;
    const first = this.faces.arrays.loop[face];
    let loop = first;
    do {
      result.push(loop);
      loop = next[loop];
    } while (loop !== first);
    return result;
  }

  faceVertices(face) {
    return this.faceLoops(face).map(loop => this.loops.arrays.vertex[loop]);
  }

  /** Faces sharing an edge with the given face (each neighbour listed once). */
  faceNeighbors(face) {
    const neighbors = new Set();
    for (const loop of this.faceLoops(face)) {
      for (const other of this.edgeLoops(this.loops.arrays.edge[loop])) {
        const otherFace = this.loops.arrays.face[other];
        if (otherFace !== face) neighbors.add(otherFace);
      }
    }
    return [...neighbors];
  }

  *liveIndices(domain) {
    const store = this.storeForDomain(domain);
    for (let index = 0; index < store.count; index++) {
      if (!store.removed[index]) yield index;
    }
  }
}

function reserve(store, count) {
  store.ensureCapacity(count);
  store.count = count;
  store.liveCount = count;
}

/**
 * Build an EditMesh from MeshData in one pass over typed arrays, keeping element order (vertex, edge, face and loop
 * indices equal MeshData's vertex, edge, face and corner indices) and copying every attribute.
 */
export function editMesh(mesh) {
  const edit = new EditMesh({
    vertices: mesh.vertexCount, edges: mesh.edgeCount, loops: mesh.cornerCount, faces: mesh.faceCount,
  });
  for (const domain of DOMAINS) {
    for (const [name, attribute] of Object.entries(mesh.attributes[domain])) {
      edit.ensureAttribute(domain, name, attribute.data.constructor, attribute.size);
    }
  }
  reserve(edit.vertices, mesh.vertexCount);
  reserve(edit.edges, mesh.edgeCount);
  reserve(edit.loops, mesh.cornerCount);
  reserve(edit.faces, mesh.faceCount);
  edit.vertices.arrays.position.set(mesh.positions);
  const edgeVertex = edit.edges.arrays.vertex;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    if (edit.findEdge(first, second) !== -1) throw new RangeError(`MeshData has a duplicate edge at ${edge}.`);
    edgeVertex[edge * 2] = first;
    edgeVertex[edge * 2 + 1] = second;
    edit.linkSlot(edge * 2);
    edit.linkSlot(edge * 2 + 1);
  }
  const loopArrays = edit.loops.arrays;
  const faceLoop = edit.faces.arrays.loop;
  const faceSize = edit.faces.arrays.size;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    faceLoop[face] = start;
    faceSize[face] = end - start;
    for (let corner = start; corner < end; corner++) {
      loopArrays.vertex[corner] = mesh.cornerVertices[corner];
      loopArrays.edge[corner] = mesh.cornerEdges[corner];
      loopArrays.face[corner] = face;
      loopArrays.next[corner] = corner + 1 === end ? start : corner + 1;
      loopArrays.prev[corner] = corner === start ? end - 1 : corner - 1;
      edit.linkRadial(corner, mesh.cornerEdges[corner]);
    }
  }
  for (const domain of DOMAINS) {
    const store = edit.storeForDomain(domain);
    for (const [name, attribute] of Object.entries(mesh.attributes[domain])) {
      store.attributes.get(name).data.set(attribute.data);
    }
  }
  return edit;
}

function compactAttribute(attribute, liveIndices) {
  const size = attribute.size;
  const data = new attribute.data.constructor(liveIndices.length * size);
  for (let output = 0; output < liveIndices.length; output++) {
    const input = liveIndices[output];
    for (let component = 0; component < size; component++) {
      data[output * size + component] = attribute.data[input * size + component];
    }
  }
  return { data, size };
}

function liveIndexArray(store) {
  const live = new Uint32Array(store.liveCount);
  let output = 0;
  for (let index = 0; index < store.count; index++) {
    if (store.removed[index]) continue;
    live[output] = index;
    output++;
  }
  return live;
}

/** Compact an EditMesh into immutable MeshData. Loose vertices are kept; wire edges are dropped. */
export function meshData(edit) {
  const liveVertices = liveIndexArray(edit.vertices);
  if (!liveVertices.length) throw new RangeError('The mesh has no vertices left.');
  const vertexMap = new Int32Array(edit.vertices.count).fill(-1);
  for (let output = 0; output < liveVertices.length; output++) vertexMap[liveVertices[output]] = output;
  const sourcePositions = edit.vertices.arrays.position;
  const positions = new Float32Array(liveVertices.length * 3);
  for (let output = 0; output < liveVertices.length; output++) {
    const input = liveVertices[output];
    positions[output * 3] = sourcePositions[input * 3];
    positions[output * 3 + 1] = sourcePositions[input * 3 + 1];
    positions[output * 3 + 2] = sourcePositions[input * 3 + 2];
  }
  const liveFaces = liveIndexArray(edit.faces);
  if (!liveFaces.length) throw new RangeError('The mesh has no faces left.');
  const faceOffsets = new Uint32Array(liveFaces.length + 1);
  const faceSize = edit.faces.arrays.size;
  for (let output = 0; output < liveFaces.length; output++) {
    faceOffsets[output + 1] = faceOffsets[output] + faceSize[liveFaces[output]];
  }
  const cornerCount = faceOffsets[liveFaces.length];
  const cornerVertices = new Uint32Array(cornerCount);
  const cornerEdges = new Uint32Array(cornerCount);
  const liveLoops = new Uint32Array(cornerCount);
  const edgeMap = new Int32Array(edit.edges.count).fill(-1);
  const liveEdges = new Uint32Array(edit.edges.liveCount);
  let liveEdgeCount = 0;
  const loopArrays = edit.loops.arrays;
  const faceLoop = edit.faces.arrays.loop;
  let corner = 0;
  for (let output = 0; output < liveFaces.length; output++) {
    const first = faceLoop[liveFaces[output]];
    let loop = first;
    do {
      const edge = loopArrays.edge[loop];
      if (edgeMap[edge] === -1) {
        edgeMap[edge] = liveEdgeCount;
        liveEdges[liveEdgeCount] = edge;
        liveEdgeCount++;
      }
      cornerVertices[corner] = vertexMap[loopArrays.vertex[loop]];
      cornerEdges[corner] = edgeMap[edge];
      liveLoops[corner] = loop;
      corner++;
      loop = loopArrays.next[loop];
    } while (loop !== first);
  }
  const keptEdges = liveEdges.subarray(0, liveEdgeCount);
  const edgeVertices = new Uint32Array(liveEdgeCount * 2);
  const sourceEdgeVertex = edit.edges.arrays.vertex;
  for (let output = 0; output < liveEdgeCount; output++) {
    const edge = keptEdges[output];
    edgeVertices[output * 2] = vertexMap[sourceEdgeVertex[edge * 2]];
    edgeVertices[output * 2 + 1] = vertexMap[sourceEdgeVertex[edge * 2 + 1]];
  }
  const liveByDomain = { point: liveVertices, edge: keptEdges, face: liveFaces, corner: liveLoops };
  const attributes = {};
  for (const domain of DOMAINS) {
    attributes[domain] = {};
    for (const [name, attribute] of edit.storeForDomain(domain).attributes) {
      attributes[domain][name] = compactAttribute(attribute, liveByDomain[domain]);
    }
  }
  return createMeshData({ positions, faceOffsets, cornerVertices, edgeVertices, cornerEdges, attributes });
}
