import { createMeshData, deriveEdges, TAG_PREFIX } from './mesh-data.js';
import { lintMesh } from './mesh-lint.js';
import { triangulateMesh } from './mesh-render.js';
import { faceNormals } from './mesh-normals.js';
import { joinTriangles } from './mesh-convert.js';

// Mesh booleans through the Manifold library (Apache-2.0, the solver Blender 4.5 added), compiled to WebAssembly.
// Manifold needs closed, consistently wound inputs; in return it is robust and fast. The module loads lazily,
// once, because the WebAssembly binary is about a megabyte.

let manifoldPromise = null;
let manifoldModule = null;
let loadManifoldModule = () => import('manifold-3d');

/** Replace how the Manifold module is imported, for hosts that serve it from elsewhere. Call before loading. */
export function setManifoldModuleLoader(loader) {
  if (typeof loader !== 'function') throw new TypeError('The Manifold loader must be a function returning a module promise.');
  loadManifoldModule = loader;
}

/**
 * Load the boolean engine. In Node the binary is found next to the package; in a browser bundle pass the binary
 * bytes as `wasmBinary` (an ArrayBuffer or Uint8Array). Safe to call repeatedly.
 */
export function loadMeshBooleans({ wasmBinary } = {}) {
  manifoldPromise ??= loadManifoldModule().catch(error => {
    throw new Error(`Mesh booleans need the optional peer dependency manifold-3d 3.5.4: npm install manifold-3d@3.5.4 (${error.message}).`);
  }).then(async ({ default: createModule }) => {
    const module = await createModule(wasmBinary ? { wasmBinary } : undefined);
    module.setup();
    manifoldModule = module;
    return module;
  }).catch(error => {
    manifoldPromise = null;
    throw error;
  });
  return manifoldPromise;
}

export function meshBooleansLoaded() {
  return manifoldModule !== null;
}

function requireModule() {
  if (!manifoldModule) throw new Error('Mesh booleans are not loaded yet. Await loadMeshBooleans() before running a boolean edit.');
  return manifoldModule;
}

export const BOOLEAN_OPERATIONS = Object.freeze(['union', 'difference', 'intersect']);

function hasCornerUv(mesh) {
  return mesh.attributes.corner.uv?.size === 2;
}

/** Triangulated Manifold input: positions (plus UV) per corner-vertex, triangle face IDs offset by faceIdOffset. */
function manifoldInput(module, mesh, faceIdOffset, propertyCount) {
  const { normals } = faceNormals(mesh);
  const { triangleCorners, triangleFaces } = triangulateMesh(mesh, normals);
  // One property vertex per (vertex, uv) pair would be ideal; one per corner is simpler and Mesh.merge() welds
  // positions back together for the solver while keeping UV seams as properties.
  const uv = hasCornerUv(mesh) ? mesh.attributes.corner.uv.data : null;
  const vertexProperties = new Float32Array(mesh.cornerCount * propertyCount);
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const vertex = mesh.cornerVertices[corner];
    vertexProperties[corner * propertyCount] = mesh.positions[vertex * 3];
    vertexProperties[corner * propertyCount + 1] = mesh.positions[vertex * 3 + 1];
    vertexProperties[corner * propertyCount + 2] = mesh.positions[vertex * 3 + 2];
    if (propertyCount === 5 && uv) {
      vertexProperties[corner * propertyCount + 3] = uv[corner * 2];
      vertexProperties[corner * propertyCount + 4] = uv[corner * 2 + 1];
    }
  }
  const faceID = new Uint32Array(triangleFaces.length);
  for (let triangle = 0; triangle < triangleFaces.length; triangle++) faceID[triangle] = triangleFaces[triangle] + faceIdOffset;
  const input = new module.Mesh({
    numProp: propertyCount,
    vertProperties: vertexProperties,
    triVerts: new Uint32Array(triangleCorners),
    faceID,
  });
  input.merge();
  return input;
}

function solverError(module, manifold, label) {
  const status = manifold.status();
  if (status === 'NoError' || status === module.ErrorStatus?.NoError || status === 0) return null;
  return `${label} is not a closed manifold for the boolean solver (${status}). Run mesh_inspect: every edge needs exactly two faces with matching winding. Fix open edges or merge_by_distance first.`;
}

/**
 * Group output triangles by source face and turn each group back into one polygon when its triangles form a single
 * boundary loop; otherwise (holes, separate pieces) keep the group's triangles. Works on welded vertex indices, so
 * property vertices that Manifold keeps apart at one position do not open fake boundaries.
 * Each polygon lists its welded vertices and, per corner, one property vertex for interpolated attributes.
 */
function polygonsFromTriangles(weldedTriangles, propertyTriangles, triangleFaceIds) {
  const groups = new Map();
  for (let triangle = 0; triangle < triangleFaceIds.length; triangle++) {
    const id = triangleFaceIds[triangle];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(triangle);
  }
  const polygons = [];
  for (const [sourceFace, triangles] of groups) {
    const directed = new Set();
    const propertyOf = new Map();
    for (const triangle of triangles) {
      for (let corner = 0; corner < 3; corner++) {
        const from = weldedTriangles[triangle * 3 + corner];
        const to = weldedTriangles[triangle * 3 + (corner + 1) % 3];
        directed.add(`${from},${to}`);
        if (!propertyOf.has(from)) propertyOf.set(from, propertyTriangles[triangle * 3 + corner]);
      }
    }
    const nextVertex = new Map();
    let boundaryCount = 0;
    let branching = false;
    for (const key of directed) {
      const [from, to] = key.split(',').map(Number);
      if (directed.has(`${to},${from}`)) continue;
      boundaryCount++;
      if (nextVertex.has(from)) branching = true;
      nextVertex.set(from, to);
    }
    let loop = null;
    if (!branching && boundaryCount >= 3) {
      const start = nextVertex.keys().next().value;
      loop = [start];
      let vertex = nextVertex.get(start);
      while (vertex !== start && loop.length <= boundaryCount) {
        loop.push(vertex);
        vertex = nextVertex.get(vertex);
      }
      if (vertex !== start || loop.length !== boundaryCount) loop = null;
    }
    if (loop) {
      polygons.push({ sourceFace, vertices: loop, properties: loop.map(vertex => propertyOf.get(vertex)) });
      continue;
    }
    for (const triangle of triangles) {
      const vertices = Array.from(weldedTriangles.subarray(triangle * 3, triangle * 3 + 3));
      if (new Set(vertices).size !== 3) continue;
      polygons.push({ sourceFace, vertices, properties: Array.from(propertyTriangles.subarray(triangle * 3, triangle * 3 + 3)) });
    }
  }
  return polygons;
}

/**
 * Boolean of two closed meshes. Faces from `mesh` keep their tags and other face attributes; faces from `cutter`
 * get the tag `cutTag` (when given). Corner UVs are interpolated where both inputs have them.
 * Returns { mesh, removedFaces, cutterFaces }.
 */
export function meshBoolean(mesh, cutter, operation, { cutTag } = {}) {
  if (!BOOLEAN_OPERATIONS.includes(operation)) throw new RangeError(`Boolean operation must be one of ${BOOLEAN_OPERATIONS.join(', ')}.`);
  const module = requireModule();
  for (const [label, input] of [['The mesh', mesh], ['The cutter', cutter]]) {
    const report = lintMesh(input);
    const open = report.problems.filter(problem => ['boundary-edge', 'non-manifold-edge', 'inconsistent-winding'].includes(problem.kind));
    if (open.length) {
      throw new RangeError(`${label} must be closed for a boolean: ${open.map(problem => `${problem.count} ${problem.kind}`).join(', ')}. ${open[0].fix}`);
    }
  }
  const propertyCount = hasCornerUv(mesh) ? 5 : 3;
  const resources = [];
  try {
    const inputA = manifoldInput(module, mesh, 0, propertyCount);
    resources.push(inputA);
    const inputB = manifoldInput(module, cutter, mesh.faceCount, propertyCount);
    resources.push(inputB);
    const solidA = new module.Manifold(inputA);
    resources.push(solidA);
    const solidB = new module.Manifold(inputB);
    resources.push(solidB);
    const problem = solverError(module, solidA, 'The mesh') ?? solverError(module, solidB, 'The cutter');
    if (problem) throw new RangeError(problem);
    const result = operation === 'union' ? solidA.add(solidB) : operation === 'difference' ? solidA.subtract(solidB) : solidA.intersect(solidB);
    resources.push(result);
    const output = result.getMesh();
    resources.push(output);
    if (!output.triVerts.length) throw new RangeError(`The ${operation} leaves nothing. Check the cutter's position and size against mesh_inspect bounds.`);
    return rebuildOutput(mesh, output, propertyCount, cutTag);
  } finally {
    for (const resource of resources.reverse()) resource.delete?.();
  }
}

function rebuildOutput(mesh, output, propertyCount, cutTag) {
  const outputProperties = output.numProp;
  const vertexCount = output.vertProperties.length / outputProperties;
  // Property vertices split at UV seams (or kept apart by the solver) share positions; weld them by exact position.
  const positionKey = new Map();
  const meshVertexOf = new Uint32Array(vertexCount);
  const positions = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = output.vertProperties[vertex * outputProperties];
    const y = output.vertProperties[vertex * outputProperties + 1];
    const z = output.vertProperties[vertex * outputProperties + 2];
    const key = `${x},${y},${z}`;
    let meshVertex = positionKey.get(key);
    if (meshVertex === undefined) {
      meshVertex = positions.length / 3;
      positionKey.set(key, meshVertex);
      positions.push(x, y, z);
    }
    meshVertexOf[vertex] = meshVertex;
  }
  const weldedTriangles = new Uint32Array(output.triVerts.length);
  for (let index = 0; index < output.triVerts.length; index++) weldedTriangles[index] = meshVertexOf[output.triVerts[index]];
  const polygons = polygonsFromTriangles(weldedTriangles, output.triVerts, output.faceID);
  const faceOffsets = new Uint32Array(polygons.length + 1);
  const cornerVertices = [];
  const cornerUv = propertyCount === 5 ? [] : null;
  const sourceFaces = new Uint32Array(polygons.length);
  polygons.forEach((polygon, face) => {
    sourceFaces[face] = polygon.sourceFace;
    polygon.vertices.forEach((vertex, index) => {
      cornerVertices.push(vertex);
      if (cornerUv) {
        const propertyVertex = polygon.properties[index];
        cornerUv.push(output.vertProperties[propertyVertex * outputProperties + 3], output.vertProperties[propertyVertex * outputProperties + 4]);
      }
    });
    faceOffsets[face + 1] = cornerVertices.length;
  });
  const corners = Uint32Array.from(cornerVertices);
  const edges = deriveEdges(positions.length / 3, faceOffsets, corners);
  const faceAttributes = {};
  const fromCutter = face => sourceFaces[face] >= mesh.faceCount;
  for (const [name, attribute] of Object.entries(mesh.attributes.face)) {
    const data = new attribute.data.constructor(polygons.length * attribute.size);
    for (let face = 0; face < polygons.length; face++) {
      if (fromCutter(face)) continue;
      data.set(attribute.data.subarray(sourceFaces[face] * attribute.size, (sourceFaces[face] + 1) * attribute.size), face * attribute.size);
    }
    faceAttributes[name] = { data, size: attribute.size };
  }
  let cutterFaces = 0;
  if (cutTag) {
    const data = faceAttributes[TAG_PREFIX + cutTag]?.data ?? new Uint8Array(polygons.length);
    for (let face = 0; face < polygons.length; face++) {
      if (fromCutter(face)) {
        data[face] = 1;
        cutterFaces++;
      }
    }
    faceAttributes[TAG_PREFIX + cutTag] = { data, size: 1 };
  }
  const triangles = createMeshData({
    positions: Float32Array.from(positions),
    faceOffsets,
    cornerVertices: corners,
    edgeVertices: edges.edgeVertices,
    cornerEdges: edges.cornerEdges,
    attributes: {
      face: faceAttributes,
      corner: cornerUv ? { uv: { data: Float32Array.from(cornerUv), size: 2 } } : {},
    },
  });
  // Faces with holes come back as triangle fans; join flat pairs that share every attribute back into quads.
  const joined = joinTriangles(triangles);
  if (cutTag) cutterFaces = countTagged(joined, cutTag);
  return { mesh: joined, cutterFaces };
}

function countTagged(mesh, tag) {
  const data = mesh.attributes.face[TAG_PREFIX + tag].data;
  let count = 0;
  for (let face = 0; face < mesh.faceCount; face++) count += data[face] ? 1 : 0;
  return count;
}
