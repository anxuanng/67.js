import { createMeshData, deriveEdges, TAG_PREFIX, DOMAINS } from './mesh-data.js';
import { weldVertices } from './mesh-convert.js';

// Local topology operators on an EditMesh. Each takes a face mask indexed by EditMesh face index (equal to MeshData
// face index right after editMesh()) and returns the faces it created, so callers can tag and report them.

function copyElementAttributes(store, source, target) {
  for (const attribute of store.attributes.values()) {
    const size = attribute.size;
    attribute.data.copyWithin(target * size, source * size, (source + 1) * size);
  }
}

function saveElementAttributes(store, index) {
  const saved = [];
  for (const attribute of store.attributes.values()) {
    saved.push(attribute.data.slice(index * attribute.size, (index + 1) * attribute.size));
  }
  return saved;
}

function restoreElementAttributes(store, index, saved) {
  let position = 0;
  for (const attribute of store.attributes.values()) {
    attribute.data.set(saved[position], index * attribute.size);
    position++;
  }
}

function clearTags(edit, face) {
  for (const [name, attribute] of edit.faces.attributes) {
    if (name.startsWith(TAG_PREFIX)) attribute.data[face] = 0;
  }
}

/** Mark faces with a tag, creating the tag attribute when needed. */
export function tagFaces(edit, faces, tag) {
  const attribute = edit.ensureAttribute('face', TAG_PREFIX + tag, Uint8Array, 1);
  for (const face of faces) attribute.data[face] = 1;
}

/** Area-weighted normal (Newell) of one EditMesh face; length is twice the area. */
function faceNormalVector(edit, face) {
  const position = edit.vertices.arrays.position;
  const loops = edit.loops.arrays;
  const first = edit.faces.arrays.loop[face];
  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  let loop = first;
  do {
    const current = loops.vertex[loop] * 3;
    const next = loops.vertex[loops.next[loop]] * 3;
    normalX += (position[current + 1] - position[next + 1]) * (position[current + 2] + position[next + 2]);
    normalY += (position[current + 2] - position[next + 2]) * (position[current] + position[next]);
    normalZ += (position[current] - position[next]) * (position[current + 1] + position[next + 1]);
    loop = loops.next[loop];
  } while (loop !== first);
  return [normalX, normalY, normalZ];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length === 0) return [0, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

/** Live face indices selected by a mask. */
export function maskedFaces(edit, mask) {
  const faces = [];
  for (let face = 0; face < mask.length; face++) {
    if (mask[face] && edit.faces.isLive(face)) faces.push(face);
  }
  return faces;
}

function regionNormal(edit, faces) {
  const sum = [0, 0, 0];
  for (const face of faces) {
    const normal = faceNormalVector(edit, face);
    sum[0] += normal[0];
    sum[1] += normal[1];
    sum[2] += normal[2];
  }
  return normalize(sum);
}

/**
 * Split a face region from the rest of the mesh along its boundary, as BMesh's extrude_face_region does:
 * boundary vertices are duplicated, region faces are rebuilt on the duplicates, and one quad per boundary edge
 * joins old and new vertices. Interior region vertices are shared, not duplicated.
 * Returns the rebuilt cap faces, the new side faces, the boundary loops (as vertex pairs with their face normal)
 * and the map from original boundary vertex to duplicate.
 */
function splitRegion(edit, faces) {
  const inRegion = new Uint8Array(edit.faces.count);
  for (const face of faces) inRegion[face] = 1;
  const loops = edit.loops.arrays;
  const boundary = [];
  for (const face of faces) {
    const normal = normalize(faceNormalVector(edit, face));
    const first = edit.faces.arrays.loop[face];
    let loop = first;
    do {
      let sharedWithRegion = false;
      let other = loops.radialNext[loop];
      while (other !== loop) {
        if (inRegion[loops.face[other]]) sharedWithRegion = true;
        other = loops.radialNext[other];
      }
      if (!sharedWithRegion) {
        boundary.push({
          from: loops.vertex[loop], to: loops.vertex[loops.next[loop]], face, normal,
          fromCorner: saveElementAttributes(edit.loops, loop),
          toCorner: saveElementAttributes(edit.loops, loops.next[loop]),
          faceAttributes: saveElementAttributes(edit.faces, face),
        });
      }
      loop = loops.next[loop];
    } while (loop !== first);
  }
  const duplicateOf = new Map();
  for (const { from, to } of boundary) {
    for (const vertex of [from, to]) {
      if (duplicateOf.has(vertex)) continue;
      const position = edit.vertexPosition(vertex);
      const duplicate = edit.createVertex(position[0], position[1], position[2]);
      copyElementAttributes(edit.vertices, vertex, duplicate);
      duplicateOf.set(vertex, duplicate);
    }
  }
  const regionEdges = new Set();
  for (const face of faces) {
    for (const loop of edit.faceLoops(face)) regionEdges.add(loops.edge[loop]);
  }
  const capFaces = [];
  for (const face of faces) {
    const faceLoops = edit.faceLoops(face);
    const vertices = faceLoops.map(loop => loops.vertex[loop]);
    const cornerAttributes = faceLoops.map(loop => saveElementAttributes(edit.loops, loop));
    const faceAttributes = saveElementAttributes(edit.faces, face);
    edit.removeFace(face);
    const rebuilt = edit.createFace(vertices.map(vertex => duplicateOf.get(vertex) ?? vertex));
    restoreElementAttributes(edit.faces, rebuilt, faceAttributes);
    edit.faceLoops(rebuilt).forEach((loop, index) => restoreElementAttributes(edit.loops, loop, cornerAttributes[index]));
    capFaces.push(rebuilt);
  }
  const sideFaces = [];
  for (const edge of boundary) {
    const side = edit.createFace([edge.from, edge.to, duplicateOf.get(edge.to), duplicateOf.get(edge.from)]);
    restoreElementAttributes(edit.faces, side, edge.faceAttributes);
    clearTags(edit, side);
    const [fromLoop, toLoop, toDuplicateLoop, fromDuplicateLoop] = edit.faceLoops(side);
    restoreElementAttributes(edit.loops, fromLoop, edge.fromCorner);
    restoreElementAttributes(edit.loops, fromDuplicateLoop, edge.fromCorner);
    restoreElementAttributes(edit.loops, toLoop, edge.toCorner);
    restoreElementAttributes(edit.loops, toDuplicateLoop, edge.toCorner);
    sideFaces.push(side);
  }
  // Region edges whose faces moved onto duplicates are left as wire edges; drop them so the result stays clean.
  for (const edge of regionEdges) {
    if (edit.edges.isLive(edge) && edit.edgeFaceCount(edge) === 0) edit.removeEdge(edge);
  }
  return { capFaces, sideFaces, boundary, duplicateOf };
}

function faceVertexSet(edit, faces) {
  const vertices = new Set();
  for (const face of faces) {
    for (const vertex of edit.faceVertices(face)) vertices.add(vertex);
  }
  return vertices;
}

function moveVertices(edit, vertices, offset) {
  const position = edit.vertices.arrays.position;
  for (const vertex of vertices) {
    position[vertex * 3] += offset[0];
    position[vertex * 3 + 1] += offset[1];
    position[vertex * 3 + 2] += offset[2];
  }
}

function offsetVector(edit, faces, { offset, direction }) {
  if (direction !== undefined) {
    const unit = normalize(direction);
    if (unit.every(value => value === 0)) throw new RangeError('direction cannot be zero.');
    return unit.map(value => value * offset);
  }
  const normal = regionNormal(edit, faces);
  if (normal.every(value => value === 0)) throw new RangeError('The selected faces face opposite ways, so their average normal cancels out. Use extrude_individual or inset_individual, select fewer faces, or pass direction.');
  return normal.map(value => value * offset);
}

/** Groups of selected faces connected through shared edges. */
export function connectedRegions(edit, faces) {
  const selected = new Set(faces);
  const visited = new Set();
  const regions = [];
  for (const start of faces) {
    if (visited.has(start)) continue;
    const region = [];
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const face = stack.pop();
      region.push(face);
      for (const neighbor of edit.faceNeighbors(face)) {
        if (selected.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    regions.push(region);
  }
  return regions;
}

/**
 * Extrude the selected faces and move each cap by `offset` along its region's normal or along `direction`.
 * Faces connected by edges extrude together as one region; separate groups extrude separately.
 */
export function extrudeFaceRegion(edit, mask, options) {
  const capFaces = [];
  const sideFaces = [];
  for (const region of connectedRegions(edit, maskedFaces(edit, mask))) {
    const vector = offsetVector(edit, region, options);
    const result = splitRegion(edit, region);
    moveVertices(edit, faceVertexSet(edit, result.capFaces), vector);
    capFaces.push(...result.capFaces);
    sideFaces.push(...result.sideFaces);
  }
  return { capFaces, sideFaces };
}

/** Extrude every selected face on its own, each along its own normal (or `direction`). */
export function extrudeIndividual(edit, mask, options) {
  const capFaces = [];
  const sideFaces = [];
  for (const face of maskedFaces(edit, mask)) {
    const vector = offsetVector(edit, [face], options);
    const result = splitRegion(edit, [face]);
    moveVertices(edit, faceVertexSet(edit, result.capFaces), vector);
    capFaces.push(...result.capFaces);
    sideFaces.push(...result.sideFaces);
  }
  return { capFaces, sideFaces };
}

/**
 * Inset the selected region: a rim of quads `thickness` wide along the region boundary, measured in the plane of the
 * neighbouring region faces with even-thickness correction at corners, then the inner faces move `depth` along the
 * region normal (negative depth pushes in).
 */
export function insetRegion(edit, mask, options) {
  const capFaces = [];
  const sideFaces = [];
  for (const region of connectedRegions(edit, maskedFaces(edit, mask))) {
    const result = insetFaces(edit, region, options);
    capFaces.push(...result.capFaces);
    sideFaces.push(...result.sideFaces);
  }
  return { capFaces, sideFaces };
}

/** Inset every selected face on its own, as Blender's inset with "individual". */
export function insetIndividual(edit, mask, options) {
  const capFaces = [];
  const sideFaces = [];
  for (const face of maskedFaces(edit, mask)) {
    const result = insetFaces(edit, [face], options);
    capFaces.push(...result.capFaces);
    sideFaces.push(...result.sideFaces);
  }
  return { capFaces, sideFaces };
}

function insetFaces(edit, faces, { thickness, depth = 0 }) {
  const normal = regionNormal(edit, faces);
  const { capFaces, sideFaces, boundary, duplicateOf } = splitRegion(edit, faces);
  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of boundary) {
    outgoing.set(edge.from, edge);
    incoming.set(edge.to, edge);
  }
  const position = edit.vertices.arrays.position;
  const point = vertex => [position[vertex * 3], position[vertex * 3 + 1], position[vertex * 3 + 2]];
  const inwardOf = edge => {
    const start = point(edge.from);
    const end = point(edge.to);
    return normalize(cross(edge.normal, [end[0] - start[0], end[1] - start[1], end[2] - start[2]]));
  };
  for (const [vertex, duplicate] of duplicateOf) {
    const before = incoming.get(vertex);
    const after = outgoing.get(vertex);
    const directions = [before, after].filter(Boolean).map(inwardOf);
    const sum = directions.reduce((total, value) => [total[0] + value[0], total[1] + value[1], total[2] + value[2]], [0, 0, 0]);
    const inward = normalize(sum);
    // Even thickness: divide by the cosine between the corner bisector and each edge's inward direction.
    const cosine = Math.max(0.25, ...directions.map(value => value[0] * inward[0] + value[1] * inward[1] + value[2] * inward[2]));
    const distance = thickness / cosine;
    position[duplicate * 3] += inward[0] * distance;
    position[duplicate * 3 + 1] += inward[1] * distance;
    position[duplicate * 3 + 2] += inward[2] * distance;
  }
  if (depth !== 0) moveVertices(edit, faceVertexSet(edit, capFaces), normal.map(value => value * depth));
  return { capFaces, sideFaces };
}

/** Delete the selected faces, then edges and vertices that no face uses any more. */
export function deleteFaces(edit, mask) {
  const faces = maskedFaces(edit, mask);
  const edges = new Set();
  const vertices = new Set();
  for (const face of faces) {
    for (const loop of edit.faceLoops(face)) {
      edges.add(edit.loops.arrays.edge[loop]);
      vertices.add(edit.loops.arrays.vertex[loop]);
    }
  }
  for (const face of faces) edit.removeFace(face);
  for (const edge of edges) {
    if (edit.edges.isLive(edge) && edit.edgeFaceCount(edge) === 0) edit.removeEdge(edge);
  }
  for (const vertex of vertices) {
    if (edit.vertices.isLive(vertex) && edit.vertexDegree(vertex) === 0) edit.removeVertex(vertex);
  }
  return { deletedFaces: faces.length };
}

/** Reverse the winding of the selected faces, carrying corner attributes with their vertices. */
export function flipFaces(edit, mask) {
  const flipped = [];
  for (const face of maskedFaces(edit, mask)) {
    const faceLoops = edit.faceLoops(face);
    const vertices = faceLoops.map(loop => edit.loops.arrays.vertex[loop]).reverse();
    const cornerAttributes = faceLoops.map(loop => saveElementAttributes(edit.loops, loop)).reverse();
    const faceAttributes = saveElementAttributes(edit.faces, face);
    edit.removeFace(face);
    const rebuilt = edit.createFace(vertices);
    restoreElementAttributes(edit.faces, rebuilt, faceAttributes);
    edit.faceLoops(rebuilt).forEach((loop, index) => restoreElementAttributes(edit.loops, loop, cornerAttributes[index]));
    flipped.push(rebuilt);
  }
  return { flippedFaces: flipped };
}

// Blender's proportional-editing falloff curves, as functions of t = distance / radius in [0, 1].
export const FALLOFF_CURVES = Object.freeze({
  smooth: t => 3 * (1 - t) ** 2 - 2 * (1 - t) ** 3,
  sphere: t => Math.sqrt(Math.max(0, 1 - t * t)),
  root: t => Math.sqrt(1 - t),
  sharp: t => (1 - t) ** 2,
  linear: t => 1 - t,
  constant: () => 1,
  inverseSquare: t => 1 - t * t,
});

class MinimumHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }

  push(key, value) {
    const keys = this.keys;
    const values = this.values;
    let index = keys.length;
    keys.push(key);
    values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[index] = keys[parent];
      values[index] = values[parent];
      index = parent;
    }
    keys[index] = key;
    values[index] = value;
  }

  pop() {
    const keys = this.keys;
    const values = this.values;
    const top = { key: keys[0], value: values[0] };
    const lastKey = keys.pop();
    const lastValue = values.pop();
    if (keys.length) {
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        if (left >= keys.length) break;
        const right = left + 1;
        const child = right < keys.length && keys[right] < keys[left] ? right : left;
        if (keys[child] >= lastKey) break;
        keys[index] = keys[child];
        values[index] = values[child];
        index = child;
      }
      keys[index] = lastKey;
      values[index] = lastValue;
    }
    return top;
  }

  get size() {
    return this.keys.length;
  }
}

/** Distance from the seed vertices along edges (geodesic on the mesh), up to `radius`. */
function connectedDistances(edit, seeds, radius) {
  const distances = new Map();
  const heap = new MinimumHeap();
  for (const seed of seeds) heap.push(0, seed);
  const position = edit.vertices.arrays.position;
  while (heap.size) {
    const { key: distance, value: vertex } = heap.pop();
    if (distances.has(vertex)) continue;
    distances.set(vertex, distance);
    for (const edge of edit.vertexEdges(vertex)) {
      const neighbor = edit.edgeOtherVertex(edge, vertex);
      if (distances.has(neighbor)) continue;
      const step = Math.hypot(
        position[neighbor * 3] - position[vertex * 3],
        position[neighbor * 3 + 1] - position[vertex * 3 + 1],
        position[neighbor * 3 + 2] - position[vertex * 3 + 2],
      );
      if (distance + step <= radius) heap.push(distance + step, neighbor);
    }
  }
  return distances;
}

/** Straight-line distance from the nearest seed vertex, up to `radius`, for every live vertex. */
function spatialDistances(edit, seeds, radius, maxVisits) {
  const seedList = [...seeds];
  const liveCount = edit.vertexCount;
  if (seedList.length * liveCount > maxVisits) {
    throw new RangeError('Proportional falloff exceeds its distance budget. Use connected: true or a smaller selection.');
  }
  const distances = new Map();
  const position = edit.vertices.arrays.position;
  for (const vertex of edit.liveIndices('point')) {
    let best = Infinity;
    for (const seed of seedList) {
      const distance = Math.hypot(
        position[vertex * 3] - position[seed * 3],
        position[vertex * 3 + 1] - position[seed * 3 + 1],
        position[vertex * 3 + 2] - position[seed * 3 + 2],
      );
      if (distance < best) best = distance;
    }
    if (best <= radius) distances.set(vertex, best);
  }
  return distances;
}

/**
 * Move the vertices of the selected faces by `offset`. With `falloff: { radius, curve, connected }`, nearby
 * vertices follow with a weight from Blender's proportional-editing curves (distance along edges when connected).
 */
export function translateFaces(edit, mask, { offset, falloff }, { maxFalloffVisits = 50_000_000 } = {}) {
  const seeds = faceVertexSet(edit, maskedFaces(edit, mask));
  if (!falloff) {
    moveVertices(edit, seeds, offset);
    return { movedVertices: seeds.size };
  }
  const curve = FALLOFF_CURVES[falloff.curve ?? 'smooth'];
  const distances = falloff.connected
    ? connectedDistances(edit, seeds, falloff.radius)
    : spatialDistances(edit, seeds, falloff.radius, maxFalloffVisits);
  const position = edit.vertices.arrays.position;
  for (const [vertex, distance] of distances) {
    const weight = seeds.has(vertex) ? 1 : curve(distance / falloff.radius);
    position[vertex * 3] += offset[0] * weight;
    position[vertex * 3 + 1] += offset[1] * weight;
    position[vertex * 3 + 2] += offset[2] * weight;
  }
  return { movedVertices: distances.size };
}

/**
 * Weld vertices closer than `distance` (MeshData in, MeshData out), as Blender's Merge by Distance.
 * Faces lose corners that collapse onto their neighbour; faces left with fewer than three distinct vertices are
 * removed, and so are vertices no face uses. Attributes follow the kept elements.
 */
export function mergeByDistance(mesh, distance) {
  const { weldMap, representatives } = weldVertices(mesh.positions, distance);
  const keptCorners = [];
  const keptFaces = [];
  const faceOffsets = [0];
  const corners = [];
  for (let face = 0; face < mesh.faceCount; face++) {
    corners.length = 0;
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const vertex = weldMap[mesh.cornerVertices[corner]];
      if (corners.length && weldMap[mesh.cornerVertices[corners.at(-1)]] === vertex) continue;
      corners.push(corner);
    }
    while (corners.length > 1 && weldMap[mesh.cornerVertices[corners[0]]] === weldMap[mesh.cornerVertices[corners.at(-1)]]) corners.pop();
    const unique = new Set(corners.map(corner => weldMap[mesh.cornerVertices[corner]]));
    if (corners.length < 3 || unique.size !== corners.length) continue;
    keptCorners.push(...corners);
    keptFaces.push(face);
    faceOffsets.push(keptCorners.length);
  }
  if (!keptFaces.length) throw new RangeError('merge_by_distance removed every face. Use a smaller distance.');
  const usedWelded = new Int32Array(representatives.length).fill(-1);
  const keptVertices = [];
  for (const corner of keptCorners) {
    const welded = weldMap[mesh.cornerVertices[corner]];
    if (usedWelded[welded] === -1) {
      usedWelded[welded] = keptVertices.length;
      keptVertices.push(representatives[welded]);
    }
  }
  const positions = new Float32Array(keptVertices.length * 3);
  keptVertices.forEach((vertex, index) => positions.set(mesh.positions.subarray(vertex * 3, vertex * 3 + 3), index * 3));
  const cornerVertices = Uint32Array.from(keptCorners, corner => usedWelded[weldMap[mesh.cornerVertices[corner]]]);
  const offsets = Uint32Array.from(faceOffsets);
  const edges = deriveEdges(keptVertices.length, offsets, cornerVertices);
  const gather = (attribute, sources) => {
    const data = new attribute.data.constructor(sources.length * attribute.size);
    sources.forEach((source, index) => data.set(attribute.data.subarray(source * attribute.size, (source + 1) * attribute.size), index * attribute.size));
    return { data, size: attribute.size };
  };
  const edgeSources = new Uint32Array(edges.edgeCount);
  for (let corner = 0; corner < cornerVertices.length; corner++) edgeSources[edges.cornerEdges[corner]] = mesh.cornerEdges[keptCorners[corner]];
  const attributes = {};
  const sourcesByDomain = { point: keptVertices, edge: edgeSources, face: keptFaces, corner: keptCorners };
  for (const domain of DOMAINS) {
    attributes[domain] = {};
    for (const [name, attribute] of Object.entries(mesh.attributes[domain])) attributes[domain][name] = gather(attribute, sourcesByDomain[domain]);
  }
  const result = createMeshData({
    positions, faceOffsets: offsets, cornerVertices,
    edgeVertices: edges.edgeVertices, cornerEdges: edges.cornerEdges, attributes,
  });
  return { mesh: result, removedVertices: mesh.vertexCount - result.vertexCount, removedFaces: mesh.faceCount - result.faceCount };
}
