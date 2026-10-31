// The mesh edit vocabulary as plain data, with no geometry code, so capability listings and the MCP server can
// describe it without bundling the mesh engine.

export const MAX_MESH_EDITS = 64;

export const MESH_EDIT_OPERATIONS = Object.freeze({
  extrude_face_region: { fields: ['select', 'name', 'offset', 'direction', 'alongNormals'], tags: ['cap', 'side'] },
  extrude_individual: { fields: ['select', 'name', 'offset', 'direction'], tags: ['cap', 'side'] },
  inset_region: { fields: ['select', 'name', 'thickness', 'depth'], tags: ['cap', 'rim'] },
  inset_individual: { fields: ['select', 'name', 'thickness', 'depth'], tags: ['cap', 'rim'] },
  delete: { fields: ['select'], tags: [] },
  flip_normals: { fields: ['select'], tags: [] },
  translate: { fields: ['select', 'offset', 'falloff'], tags: [] },
  merge_by_distance: { fields: ['distance'], tags: [] },
  tag: { fields: ['select', 'name'], tags: [] },
  boolean: { fields: ['name', 'operation', 'cutter', 'translation', 'rotation', 'scale'], tags: ['cut'] },
  mirror: { fields: ['name', 'axis', 'merge'], tags: ['mirrored'] },
  array: { fields: ['name', 'count', 'offset', 'relativeOffset', 'merge'], tags: ['last'] },
  solidify: { fields: ['name', 'thickness', 'offset', 'evenThickness'], tags: ['inner', 'rim'] },
  bevel: { fields: ['name', 'edges', 'width', 'segments', 'profile', 'clampOverlap'], tags: ['strip', 'corner'] },
  loop_cut: { fields: ['name', 'edges', 'cuts', 'factor'], tags: ['band-<k>'] },
  uv_unwrap: { fields: ['seams', 'margin', 'maxDistortion'], tags: [] },
  subdivide: { fields: ['levels', 'crease', 'sharpness'], tags: [] },
  fill_holes: { fields: ['name', 'sides'], tags: ['fill'] },
  dissolve_faces: { fields: ['select', 'name'], tags: ['merged'] },
  dissolve_edges: { fields: ['edges', 'name'], tags: ['merged'] },
  dissolve_verts: { fields: ['verts', 'name'], tags: ['merged'] },
  dissolve_limited: { fields: ['edges', 'angle', 'name'], tags: ['merged'] },
  bisect_plane: { fields: ['name', 'point', 'normal', 'distance', 'clearInner', 'clearOuter', 'fill'], tags: ['inner', 'outer', 'cap'] },
  bridge_edge_loops: { fields: ['edges', 'name', 'segments', 'twistOffset'], tags: ['bridge'] },
  subdivide_edges: { fields: ['edges', 'name', 'cuts'], tags: ['split'] },
  grid_fill: { fields: ['edges', 'name'], tags: ['fill'] },
  knife_project: { fields: ['name', 'path', 'direction'], tags: ['cut'] },
  set_position: { fields: ['select', 'position', 'offset'], tags: [] },
  displace: { fields: ['select', 'field', 'strength', 'midlevel', 'direction'], tags: [] },
});

export const STACK_OPERATIONS = Object.freeze(['mirror', 'array', 'solidify', 'bevel', 'uv_unwrap', 'subdivide', 'set_position', 'displace']);
export const MAX_STACK_NODES = 16;

// Field expressions (mesh-fields.js) and instancing (mesh-instances.js): limits and names as plain data. A test
// keeps FIELD_OPERATOR_NAMES equal to the operators the language really has.
export const MAX_FIELD_NODES = 64;
export const MAX_FIELD_DEPTH = 12;
export const MAX_FIELD_ELEMENTS = 250_000;
export const MAX_FIELD_WORK = 8_000_000;
export const FIELD_ATTRIBUTES = Object.freeze(['position', 'normal', 'index', 'tag']);
export const FIELD_OPERATOR_NAMES = Object.freeze([
  'add', 'mul', 'min', 'max', 'sub', 'div', 'mod', 'pow', 'clamp', 'mix', 'smoothstep',
  'neg', 'abs', 'sqrt', 'sin', 'cos', 'floor', 'ceil', 'round', 'fract', 'sign',
  'lt', 'lte', 'gt', 'gte', 'eq', 'and', 'or', 'not', 'if',
  'vec', 'dot', 'cross', 'distance', 'length', 'normalize', 'x', 'y', 'z',
  'attr', 'noise', 'random',
]);
export const INSTANCE_SOURCES = Object.freeze(['grid', 'scatter', 'surface']);
export const MAX_INSTANCE_CANDIDATES = 2048;
