const FULL_TURN = Math.PI * 2;

function geometry(positions, normals, indices) {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

// The sampled surfaces share one winding convention; zero-area pole triangles are omitted.
function surface(columns, rows, sample) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const vertex = sample(column / columns, row / rows);
      positions.push(...vertex.position);
      normals.push(...vertex.normal);
    }
  }
  function triangle(first, second, third) {
    const edgeA = positions.slice(second * 3, second * 3 + 3).map((value, axis) => value - positions[first * 3 + axis]);
    const edgeB = positions.slice(third * 3, third * 3 + 3).map((value, axis) => value - positions[first * 3 + axis]);
    const cross = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
    if (Math.hypot(...cross) < 1e-10) return;
    const direction = cross.reduce((sum, value, axis) => sum + value * (normals[first * 3 + axis] + normals[second * 3 + axis] + normals[third * 3 + axis]), 0);
    indices.push(first, direction > 0 ? second : third, direction > 0 ? third : second);
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const first = row * (columns + 1) + column;
      const below = first + columns + 1;
      triangle(first, first + 1, below);
      triangle(first + 1, below + 1, below);
    }
  }
  const result = geometry(positions, normals, indices);
  result.uvs = new Float32Array((columns + 1) * (rows + 1) * 2);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const offset = (row * (columns + 1) + column) * 2;
      result.uvs[offset] = column / columns;
      result.uvs[offset + 1] = row / rows;
    }
  }
  return result;
}

export function sphere(segments = 64, rings = 40) {
  const result = surface(segments, rings, (longitude, latitude) => {
    const angle = longitude * FULL_TURN;
    const elevation = latitude * Math.PI;
    const position = [Math.sin(elevation) * Math.cos(angle), Math.cos(elevation), Math.sin(elevation) * Math.sin(angle)];
    return { position, normal: position };
  });
  return result;
}

// The torus lies in XY, facing +Z. Partial arcs are useful for interrupted armor rings.
export function torus(tubeRadius = 0.08, segments = 96, sides = 24, arc = FULL_TURN, start = 0) {
  const body = surface(segments, sides, (along, around) => {
    const angle = start + along * arc;
    const tubeAngle = around * FULL_TURN;
    const radial = 1 + tubeRadius * Math.cos(tubeAngle);
    return {
      position: [radial * Math.cos(angle), radial * Math.sin(angle), tubeRadius * Math.sin(tubeAngle)],
      normal: [Math.cos(angle) * Math.cos(tubeAngle), Math.sin(angle) * Math.cos(tubeAngle), Math.sin(tubeAngle)],
    };
  });
  if (Math.abs(arc - FULL_TURN) < 1e-8) return body;
  const positions = [...body.positions];
  const normals = [...body.normals];
  const indices = [...body.indices];
  const uvs = [...body.uvs];
  for (const end of [0, 1]) {
    const angle = start + arc * end;
    const direction = end === 0 ? -1 : 1;
    const normal = [-Math.sin(angle) * direction, Math.cos(angle) * direction, 0];
    const center = positions.length / 3;
    positions.push(Math.cos(angle), Math.sin(angle), 0);
    normals.push(...normal);
    uvs.push(0.5, 0.5);
    for (let index = 0; index <= sides; index++) {
      const tubeAngle = index / sides * FULL_TURN;
      const radial = 1 + tubeRadius * Math.cos(tubeAngle);
      positions.push(radial * Math.cos(angle), radial * Math.sin(angle), tubeRadius * Math.sin(tubeAngle));
      normals.push(...normal);
      uvs.push(0.5 + Math.cos(tubeAngle) * 0.5, 0.5 + Math.sin(tubeAngle) * 0.5);
    }
    for (let index = 0; index < sides; index++) {
      const first = center + index + 1;
      indices.push(center, end === 0 ? first : first + 1, end === 0 ? first + 1 : first);
    }
  }
  return { ...geometry(positions, normals, indices), uvs: new Float32Array(uvs) };
}

export function cylinder(segments = 80, bevel = 0.025, bevelSegments = 6) {
  const profile = [];
  for (let index = 0; index <= bevelSegments; index++) {
    const angle = -Math.PI / 2 + index / bevelSegments * Math.PI / 2;
    profile.push({ radius: 1 - bevel + bevel * Math.cos(angle), height: -0.5 + bevel + bevel * Math.sin(angle), radialNormal: Math.cos(angle), verticalNormal: Math.sin(angle) });
  }
  for (let index = 0; index <= bevelSegments; index++) {
    const angle = index / bevelSegments * Math.PI / 2;
    profile.push({ radius: 1 - bevel + bevel * Math.cos(angle), height: 0.5 - bevel + bevel * Math.sin(angle), radialNormal: Math.cos(angle), verticalNormal: Math.sin(angle) });
  }
  const wall = surface(segments, profile.length - 1, (along, height) => {
    const angle = along * FULL_TURN;
    const ring = profile[Math.round(height * (profile.length - 1))];
    return {
      position: [ring.radius * Math.cos(angle), ring.height, ring.radius * Math.sin(angle)],
      normal: [ring.radialNormal * Math.cos(angle), ring.verticalNormal, ring.radialNormal * Math.sin(angle)],
    };
  });
  const positions = [...wall.positions];
  const normals = [...wall.normals];
  const indices = [...wall.indices];
  for (const sign of [-1, 1]) {
    const center = positions.length / 3;
    positions.push(0, sign * 0.5, 0);
    normals.push(0, sign, 0);
    for (let index = 0; index <= segments; index++) {
      const angle = index / segments * FULL_TURN;
      positions.push((1 - bevel) * Math.cos(angle), sign * 0.5, (1 - bevel) * Math.sin(angle));
      normals.push(0, sign, 0);
    }
    for (let index = 0; index < segments; index++) {
      const first = center + index + 1;
      indices.push(center, sign > 0 ? first + 1 : first, sign > 0 ? first : first + 1);
    }
  }
  return geometry(positions, normals, indices);
}

export function box(bevel = 0.08, subdivisions = 6) {
  const positions = [];
  const normals = [];
  const indices = [];
  const coreExtent = 0.5 - bevel;
  const coordinates = [];
  if (bevel === 0) {
    coordinates.push(-0.5, 0.5);
  } else {
    // Sample the curved border in angular steps, leaving the planar center as one span.
    // Uniform grids miss narrow fillets and interpolate across the whole face instead.
    for (let index = 0; index <= subdivisions; index++) {
      const angle = (1 - index / subdivisions) * Math.PI / 4;
      coordinates.push(-coreExtent - bevel * Math.tan(angle));
    }
    coordinates.push(coreExtent);
    for (let index = 1; index <= subdivisions; index++) {
      const angle = index / subdivisions * Math.PI / 4;
      coordinates.push(coreExtent + bevel * Math.tan(angle));
    }
  }
  const gridSegments = coordinates.length - 1;
  for (let face = 0; face < 6; face++) {
    const axis = Math.floor(face / 2);
    const sign = face % 2 === 0 ? -1 : 1;
    const mesh = surface(gridSegments, gridSegments, (horizontal, vertical) => {
      const point = [0, 0, 0];
      point[axis] = sign * 0.5;
      point[(axis + 1) % 3] = coordinates[Math.round(horizontal * gridSegments)];
      point[(axis + 2) % 3] = coordinates[Math.round(vertical * gridSegments)];
      if (bevel === 0) {
        const normal = [0, 0, 0];
        normal[axis] = sign;
        return { position: point, normal };
      }
      const core = point.map(value => Math.max(-0.5 + bevel, Math.min(0.5 - bevel, value)));
      const offset = point.map((value, coordinate) => value - core[coordinate]);
      const length = Math.hypot(...offset);
      const normal = offset.map(value => value / length);
      return { position: core.map((value, coordinate) => value + normal[coordinate] * bevel), normal };
    });
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    normals.push(...mesh.normals);
    indices.push(...Array.from(mesh.indices, index => index + base));
  }
  return geometry(positions, normals, indices);
}
