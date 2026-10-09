import { mat4, quat } from 'gl-matrix';

function mesh(positions, indices) {
  const normals = [];
  for (let index = 0; index < positions.length / 3; index++) normals.push(0, 0, 1);
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

export function disk2D(segments = 96, innerRadius = 0) {
  const positions = [];
  const indices = [];
  if (innerRadius === 0) {
    positions.push(0, 0, 0);
    for (let index = 0; index <= segments; index++) {
      const angle = index / segments * Math.PI * 2;
      positions.push(Math.cos(angle), Math.sin(angle), 0);
    }
    for (let index = 0; index < segments; index++) indices.push(0, index + 1, index + 2);
  } else {
    for (let index = 0; index <= segments; index++) {
      const angle = index / segments * Math.PI * 2;
      for (const radius of [innerRadius, 1]) positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    }
    for (let index = 0; index < segments; index++) {
      const first = index * 2;
      indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
    }
  }
  return mesh(positions, indices);
}

export function roundedRect2D(radius = 0.08, segments = 12) {
  const positions = [0, 0, 0];
  const indices = [];
  for (let corner = 0; corner < 4; corner++) {
    const angle = corner * Math.PI / 2;
    const center = [Math.cos(angle + Math.PI / 4) > 0 ? 0.5 - radius : -0.5 + radius, Math.sin(angle + Math.PI / 4) > 0 ? 0.5 - radius : -0.5 + radius];
    for (let index = 0; index <= segments; index++) {
      const pointAngle = angle + index / segments * Math.PI / 2;
      positions.push(center[0] + Math.cos(pointAngle) * radius, center[1] + Math.sin(pointAngle) * radius, 0);
    }
  }
  const count = positions.length / 3 - 1;
  for (let index = 0; index < count; index++) indices.push(0, index + 1, (index + 1) % count + 1);
  return mesh(positions, indices);
}

export function createCanvas2D() {
  const geometries = {
    rectangle: mesh([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], [0, 1, 2, 0, 2, 3]),
    rounded: roundedRect2D(),
    disk: disk2D(),
    ring: disk2D(144, 0.987),
  };
  const colors = {
    paper: [0.83, 0.85, 0.82], ink: [0.022, 0.027, 0.03], purple: [0.31, 0.16, 0.57], acid: [0.69, 0.91, 0.08], pale: [0.52, 0.61, 0.59], white: [0.95, 0.96, 0.92],
  };
  const parts = [];
  const animated = [];
  function add(name, shape, position, size, color, roll = 0) {
    const matrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 0, roll * 180 / Math.PI), position, [size[0], size[1], 1]);
    const part = { name, geometry: geometries[shape], matrix, material: { tag: 'unlit', color: colors[color], metallic: 0, roughness: 1, emission: 0 } };
    parts.push(part);
    return part;
  }
  function line(name, start, end, depth, width, color) {
    const delta = end.map((value, axis) => value - start[axis]);
    return add(name, 'rectangle', [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, depth], [Math.hypot(...delta), width], color, Math.atan2(delta[1], delta[0]));
  }
  add('Poster paper', 'rounded', [0, 0, 0], [4, 5], 'paper');
  add('Purple upper inset', 'rounded', [0, 0.65, 0.01], [3.6, 3.25], 'purple');
  add('Orbital lime disk', 'disk', [0, 0.46, 0.02], [1.05, 1.05], 'acid');
  add('Orbital center', 'disk', [0, 0.46, 0.025], [0.11, 0.11], 'ink');
  for (let index = 0; index < 3; index++) add('Orbital ellipse', 'ring', [0, 0.46, 0.03 + index * 0.002], [1.55, 0.6 + index * 0.26], 'white', index * Math.PI / 3);
  for (let index = 0; index < 48; index++) {
    const angle = index / 48 * Math.PI * 2;
    const radius = 1.26;
    line('Radial registration mark', [Math.cos(angle) * radius, 0.46 + Math.sin(angle) * radius], [Math.cos(angle) * (radius + (index % 4 === 0 ? 0.09 : 0.035)), 0.46 + Math.sin(angle) * (radius + (index % 4 === 0 ? 0.09 : 0.035))], 0.04, 0.008, 'ink');
  }
  for (let index = 0; index < 4; index++) {
    const part = add('Orbiting vector dot', 'disk', [0, 0, 0.05], [0.068, 0.068], index % 2 ? 'acid' : 'white');
    animated.push({ part, index });
  }
  const digitSegments = [[-0.09, 0.12, 0.18, 0.035], [-0.09, 0, 0.18, 0.035], [-0.09, -0.12, 0.18, 0.035], [-0.19, 0.06, 0.035, 0.13], [-0.19, -0.06, 0.035, 0.13], [0.01, 0.06, 0.035, 0.13], [0.01, -0.06, 0.035, 0.13]];
  for (const [horizontal, visible] of [[-1.25, [0, 1, 2, 3, 4, 6]], [-0.94, [0, 5, 6]]]) {
    for (const segment of visible) {
      const [offsetX, offsetY, width, height] = digitSegments[segment];
      add('Vector 67 digit', 'rectangle', [horizontal + offsetX, 1.98 + offsetY, 0.06], [width, height], 'white');
    }
  }
  for (let index = 0; index < 3; index++) add('Poster header dot', 'disk', [1.09 + index * 0.19, 1.98, 0.06], [0.038, 0.038], 'acid');
  add('Waveform strip', 'rounded', [0, -1.58, 0.01], [3.6, 0.88], 'ink');
  for (let index = 0; index < 47; index++) {
    const start = -1.58 + index / 47 * 3.16;
    const end = -1.58 + (index + 1) / 47 * 3.16;
    line('Signal waveform', [start, -1.58 + Math.sin(index * 0.34) * 0.17], [end, -1.58 + Math.sin((index + 1) * 0.34) * 0.17], 0.02, 0.022, 'acid');
  }
  for (let index = 0; index < 29; index++) add('Vector footer code', 'rectangle', [-1.65 + index * 0.037, -2.22, 0.01], [index % 3 === 0 ? 0.022 : 0.01, index % 4 === 0 ? 0.16 : 0.11], 'ink');
  line('Footer direction shaft', [0.97, -2.22], [1.55, -2.22], 0.02, 0.024, 'ink');
  line('Footer arrow upper', [1.4, -2.08], [1.55, -2.22], 0.02, 0.024, 'ink');
  line('Footer arrow lower', [1.4, -2.36], [1.55, -2.22], 0.02, 0.024, 'ink');
  function animate(time) {
    if (!Number.isFinite(time)) throw new TypeError('Canvas timeline time must be finite');
    const phase = time / 8 * Math.PI * 2;
    for (const { part, index } of animated) {
      const angle = phase + index * Math.PI / 2;
      const orbit = index % 3;
      const roll = orbit * Math.PI / 3;
      const horizontal = Math.cos(angle) * 1.55;
      const vertical = Math.sin(angle) * (0.6 + orbit * 0.26);
      part.matrix[12] = Math.cos(roll) * horizontal - Math.sin(roll) * vertical;
      part.matrix[13] = 0.46 + Math.sin(roll) * horizontal + Math.cos(roll) * vertical;
    }
    return animated.map(item => item.part);
  }
  animate(0);
  return { parts, duration: 8, animate, bounds: { minimum: [-2, -2.5, 0], maximum: [2, 2.5, 0.06] }, camera: { eye: [0, 0, 8], target: [0, 0, 0], up: [0, 1, 0], projection: 'orthographic', orthographicHeight: 5.8 } };
}
