// Pattern materials are box projected in the shader, which glTF cannot express. This writes the same projection as
// TEXCOORD_0: every triangle takes the object axis its normal is closest to, as the shader's blend weights do on a
// face, and vertices are split only where neighbouring triangles pick different axes.

function swapAxes(values, boxMapAxis) {
  if (boxMapAxis === 0) return [values[1], values[0], values[2]];
  if (boxMapAxis === 2) return [values[0], values[2], values[1]];
  return values;
}

function dominantAxis(positions, indices, triangle, boxMapAxis) {
  const [first, second, third] = [0, 1, 2].map(corner => indices[triangle * 3 + corner] * 3);
  const edgeA = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
  const edgeB = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
  const normal = [
    edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
    edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
    edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
  ];
  const swapped = swapAxes(normal, boxMapAxis).map(Math.abs);
  return swapped[0] >= swapped[1] && swapped[0] >= swapped[2] ? 0 : swapped[1] >= swapped[2] ? 1 : 2;
}

function projectedCoordinates(position, scale, boxMapScale, boxMapAxis, axis) {
  const [x, y, z] = swapAxes(position.map((value, component) => value * scale[component] * boxMapScale), boxMapAxis);
  if (axis === 0) return [z, y];
  if (axis === 1) return [x, z];
  return [x, y];
}

function remapped(source, perVertex, sourceOf) {
  const target = new source.constructor(sourceOf.length * perVertex);
  sourceOf.forEach((sourceVertex, vertex) => {
    for (let component = 0; component < perVertex; component++) {
      target[vertex * perVertex + component] = source[sourceVertex * perVertex + component];
    }
  });
  return target;
}

/** `scale` is the part matrix's column lengths: the shader projects scaled object positions. */
export function boxProjectedGeometry(geometry, scale, boxMapScale, boxMapAxis) {
  const { positions, indices } = geometry;
  const triangleCount = indices.length / 3;
  const newIndexByKey = new Map();
  const sourceOf = [];
  const newIndices = new Uint32Array(indices.length);
  const axisByNewVertex = [];
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const axis = dominantAxis(positions, indices, triangle, boxMapAxis);
    for (let corner = 0; corner < 3; corner++) {
      const sourceVertex = indices[triangle * 3 + corner];
      const key = sourceVertex * 3 + axis;
      if (!newIndexByKey.has(key)) {
        newIndexByKey.set(key, sourceOf.length);
        sourceOf.push(sourceVertex);
        axisByNewVertex.push(axis);
      }
      newIndices[triangle * 3 + corner] = newIndexByKey.get(key);
    }
  }
  const projected = { ...geometry, indices: newIndices };
  projected.positions = remapped(positions, 3, sourceOf);
  projected.normals = remapped(geometry.normals, 3, sourceOf);
  for (const [field, perVertex] of [['colors', 3], ['skinIndices', 4], ['skinWeights', 4]]) {
    if (geometry[field]) projected[field] = remapped(geometry[field], perVertex, sourceOf);
  }
  if (geometry.morphTargets) {
    projected.morphTargets = geometry.morphTargets.map(target => ({
      ...target,
      ...(target.positions ? { positions: remapped(target.positions, 3, sourceOf) } : {}),
      ...(target.normals ? { normals: remapped(target.normals, 3, sourceOf) } : {}),
    }));
  }
  projected.uvs = new Float32Array(sourceOf.length * 2);
  sourceOf.forEach((sourceVertex, vertex) => {
    const position = [positions[sourceVertex * 3], positions[sourceVertex * 3 + 1], positions[sourceVertex * 3 + 2]];
    projected.uvs.set(projectedCoordinates(position, scale, boxMapScale, boxMapAxis, axisByNewVertex[vertex]), vertex * 2);
  });
  return projected;
}
