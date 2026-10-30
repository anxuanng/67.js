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
});

export const STACK_OPERATIONS = Object.freeze(['mirror', 'array', 'solidify', 'bevel', 'uv_unwrap']);
export const MAX_STACK_NODES = 16;
