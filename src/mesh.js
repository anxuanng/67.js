// Polygon mesh core for agent modeling: compact MeshData, half-edge EditMesh, conversion, normals, render
// extraction and lint. See docs/mesh.md.
export {
  createMeshData, deriveEdges, meshTags, facesWithTag, tagCounts, meshBounds,
  DOMAINS, TAG_PREFIX, MAX_MESH_VERTICES, MAX_MESH_CORNERS,
} from './mesh-data.js';
export { EditMesh, editMesh, meshData } from './mesh-edit.js';
export { validateTopology } from './mesh-validate.js';
export { faceNormals, cornerNormals } from './mesh-normals.js';
export { triangulateMesh, extractRender, gatherRenderPositions } from './mesh-render.js';
export { meshFromGeometry, joinTriangles, tagFacesByAxis, weldVertices, rebuildFromCorners, withFaceAttributes } from './mesh-convert.js';
export { lintMesh } from './mesh-lint.js';
export { selectFaces, countSelected } from './mesh-select.js';
export { applyMeshEdits, normalizeMeshEdits, transformMesh, MESH_EDIT_OPERATIONS, MAX_MESH_EDITS } from './mesh-recipe.js';
export { loadMeshBooleans, meshBooleansLoaded, meshBoolean, BOOLEAN_OPERATIONS } from './mesh-boolean.js';
export {
  extrudeFaceRegion, extrudeIndividual, insetRegion, insetIndividual, deleteFaces, flipFaces, translateFaces,
  mergeByDistance, tagFaces, connectedRegions, FALLOFF_CURVES,
} from './mesh-ops.js';
export { cornerFaces, cornerCycles, edgeCornerTable, faceParts } from './mesh-topology.js';
