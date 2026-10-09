export function recomputeNormals(source, positions, fallbackNormals = source.normals) {
  const groups = new Map();
  const vertexGroups = new Array(positions.length / 3);
  const normals = new Float32Array(positions.length);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const offset = vertex * 3;
    // Preserve authored hard edges while joining identical UV seam vertices.
    const key = `${source.positions.subarray(offset, offset + 3).join(',')}:${source.normals.subarray(offset, offset + 3).join(',')}`;
    let group = groups.get(key);
    if (!group) {
      group = { vertices: [], normal: [0, 0, 0], referenced: false };
      groups.set(key, group);
    }
    group.vertices.push(vertex);
    vertexGroups[vertex] = group;
  }
  for (let offset = 0; offset < source.indices.length; offset += 3) {
    const first = source.indices[offset] * 3;
    const second = source.indices[offset + 1] * 3;
    const third = source.indices[offset + 2] * 3;
    const edgeFirst = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
    const edgeSecond = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
    // Number accumulators avoid Float32 cross-product overflow/underflow on valid small/large meshes.
    const normal = [
      edgeFirst[1] * edgeSecond[2] - edgeFirst[2] * edgeSecond[1],
      edgeFirst[2] * edgeSecond[0] - edgeFirst[0] * edgeSecond[2],
      edgeFirst[0] * edgeSecond[1] - edgeFirst[1] * edgeSecond[0],
    ];
    if (Math.hypot(...normal) === 0) continue;
    for (let corner = 0; corner < 3; corner++) {
      const group = vertexGroups[source.indices[offset + corner]];
      group.referenced = true;
      for (let axis = 0; axis < 3; axis++) group.normal[axis] += normal[axis];
    }
  }
  for (const group of groups.values()) {
    const length = Math.hypot(...group.normal);
    if (group.referenced && (!Number.isFinite(length) || length === 0)) {
      throw new RangeError('Sculpt normals cancel at a referenced vertex. Reduce the stroke or repair topology.');
    }
    for (const vertex of group.vertices) {
      const offset = vertex * 3;
      for (let axis = 0; axis < 3; axis++) {
        normals[offset + axis] = group.referenced ? group.normal[axis] / length : fallbackNormals[offset + axis];
      }
    }
  }
  return normals;
}
