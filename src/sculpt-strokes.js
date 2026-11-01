// Brush strokes shared by sculptGeometry (triangle geometry) and the sculpt mesh edit (polygon meshes). A stroke moves
// groups of coincident vertices: each group has a point, a unit normal and, for smoothing, its neighbouring groups.

export function finite(value, name) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new TypeError(`${name} must be a finite Float32 value.`);
  }
  return value;
}

function vector(input, name) {
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== 3) {
    throw new TypeError(`${name} must contain three components.`);
  }
  return Array.from(input, value => finite(value, name));
}

export function prepareStrokes(strokes) {
  return strokes.map(stroke => {
    if (!['inflate', 'displace', 'smooth'].includes(stroke?.type)) {
      throw new TypeError('Sculpt stroke type must be inflate, displace or smooth.');
    }
    const center = vector(stroke.center, 'center');
    const radius = finite(stroke.radius, 'radius');
    const strength = finite(stroke.strength, 'strength');
    if (Math.fround(radius) <= 0) throw new RangeError('Brush radius must remain positive at Float32 precision.');
    if (stroke.type === 'smooth' && (strength < 0 || strength > 1)) {
      throw new RangeError('Smooth strength must be within zero and one.');
    }
    let direction;
    if (stroke.type === 'displace') {
      direction = vector(stroke.direction, 'direction');
      const length = Math.hypot(...direction);
      if (length === 0) throw new RangeError('Displace direction cannot be zero.');
      direction = direction.map(value => value / length);
    }
    return { type: stroke.type, center, radius, strength, direction };
  });
}

export function applyStroke(groups, stroke) {
  const next = stroke.type === 'smooth' ? groups.map(group => [...group.point]) : null;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const distance = Math.hypot(...group.point.map((value, axis) => value - stroke.center[axis]));
    if (distance >= stroke.radius || stroke.strength === 0) continue;
    const relative = distance / stroke.radius;
    // Quintic falloff has zero first and second derivatives at both ends.
    const falloff = 1 - relative ** 3 * (10 + relative * (-15 + 6 * relative));
    if (stroke.type === 'smooth') {
      if (!group.neighbors.size) continue;
      const mean = [0, 0, 0];
      for (const neighbor of group.neighbors) {
        for (let axis = 0; axis < 3; axis++) mean[axis] += groups[neighbor].point[axis] / group.neighbors.size;
      }
      for (let axis = 0; axis < 3; axis++) {
        next[index][axis] += (mean[axis] - group.point[axis]) * stroke.strength * falloff;
      }
    } else {
      const direction = stroke.type === 'inflate' ? group.normal : stroke.direction;
      for (let axis = 0; axis < 3; axis++) group.point[axis] += direction[axis] * stroke.strength * falloff;
    }
  }
  if (next) groups.forEach((group, index) => { group.point = next[index]; });
  for (const group of groups) {
    for (const value of group.point) finite(value, 'Sculpt result');
  }
}
