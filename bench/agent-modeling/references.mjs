// One hand-built solution per task. tests/agent-modeling-suite.test.js grades them, so a checker that rejects a
// correct object, or a task whose numbers do not add up, fails before any agent run is spent on it.

const material = [{ id: 'paint', color: [0.6, 0.55, 0.5] }];

function scene(geometries, nodes) {
  return { format: '67js.scene', schemaVersion: 1, geometries, materials: material, nodes: nodes.map(node => ({ material: 'paint', ...node })) };
}

function axisRotation(axis, angle) {
  const half = angle / 2;
  const quaternion = [0, 0, 0, Math.cos(half)];
  quaternion['xyz'.indexOf(axis)] = Math.sin(half);
  return quaternion;
}

function circle(radius, points, centerX = 0, centerY = 0, clockwise = false) {
  return Array.from({ length: points }, (_, index) => {
    const angle = (clockwise ? -1 : 1) * index / points * Math.PI * 2;
    return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)];
  });
}

function rectangle(minimumX, minimumY, maximumX, maximumY, clockwise = false) {
  const ring = [[minimumX, minimumY], [maximumX, minimumY], [maximumX, maximumY], [minimumX, maximumY]];
  return clockwise ? ring.reverse() : ring;
}

const crateEdits = [
  { op: 'translate', select: { tag: 'right' }, offset: [-0.2, 0, 0] },
  { op: 'translate', select: { tag: 'left' }, offset: [0.2, 0, 0] },
  { op: 'translate', select: { tag: 'front' }, offset: [0, 0, -0.2] },
  { op: 'translate', select: { tag: 'back' }, offset: [0, 0, 0.2] },
  { op: 'translate', select: { tag: 'top' }, offset: [0, -0.2, 0] },
  { op: 'translate', select: { tag: 'bottom' }, offset: [0, 0.2, 0] },
  { op: 'inset_individual', select: { tag: 'side' }, thickness: 0.04, name: 'panel' },
  { op: 'extrude_individual', select: { tag: 'panel.cap' }, offset: -0.02 },
  { op: 'inset_region', select: { tag: 'top' }, thickness: 0.05, name: 'lid' },
  { op: 'extrude_face_region', select: { tag: 'lid.cap' }, offset: 0.03 },
];

function hexagon(acrossFlats) {
  const radius = acrossFlats / Math.sqrt(3);
  return circle(radius, 6);
}

function gearContour(teeth, tipRadius, rootRadius) {
  const points = [];
  for (let tooth = 0; tooth < teeth; tooth++) {
    const base = tooth / teeth * Math.PI * 2;
    const step = Math.PI * 2 / teeth;
    for (const [fraction, radius] of [[0, rootRadius], [0.15, rootRadius], [0.3, tipRadius], [0.55, tipRadius], [0.7, rootRadius]]) {
      const angle = base + fraction * step;
      points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
    }
  }
  return points;
}

export const REFERENCES = {
  crate: scene(
    [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: crateEdits }],
    [{ id: 'crate', geometry: 'crate', translation: [0, 0.3, 0] }],
  ),
  'crate-uv': scene(
    [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [...crateEdits, { op: 'uv_unwrap' }] }],
    [{ id: 'crate', geometry: 'crate', translation: [0, 0.3, 0] }],
  ),
  bolt: scene(
    [
      { id: 'shaft', type: 'cylinder', segments: 32, bevel: 0 },
      { id: 'head', type: 'extrude', contour: hexagon(0.05), depth: 0.02 },
    ],
    [
      { id: 'shaft', geometry: 'shaft', translation: [0, 0.06, 0], scale: [0.015, 0.12, 0.015] },
      { id: 'head', geometry: 'head', translation: [0, 0.12, 0], rotation: axisRotation('x', -Math.PI / 2) },
    ],
  ),
  window: scene(
    [{
      id: 'frame', type: 'extrude', depth: 0.08,
      contour: rectangle(-0.5, 0, 0.5, 1.2),
      holes: [
        rectangle(-0.44, 0.06, -0.03, 0.57, true), rectangle(0.03, 0.06, 0.44, 0.57, true),
        rectangle(-0.44, 0.63, -0.03, 1.14, true), rectangle(0.03, 0.63, 0.44, 1.14, true),
      ],
    }],
    [{ id: 'frame', geometry: 'frame', translation: [0, 0, -0.04] }],
  ),
  table: scene(
    [{ id: 'block', type: 'box', bevel: 0 }],
    [
      { id: 'top', geometry: 'block', translation: [0, 0.73, 0], scale: [1.2, 0.04, 0.75] },
      ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([signX, signZ], index) => ({
        id: `leg-${index}`, geometry: 'block', translation: [signX * 0.525, 0.355, signZ * 0.2], scale: [0.05, 0.71, 0.05],
      })),
    ],
  ),
  mug: scene(
    [{
      id: 'mug', type: 'mesh', base: { type: 'cylinder', segments: 48, bevel: 0 }, edits: [
        { op: 'boolean', operation: 'union', name: 'handle', cutter: { type: 'torus', tubeRadius: 0.25, segments: 48, sides: 12 }, translation: [1.19, 0, 0], scale: [0.45, 0.28, 0.45] },
        { op: 'boolean', operation: 'difference', name: 'cavity', cutter: { type: 'cylinder', segments: 48, bevel: 0 }, translation: [0, 0.05, 0], scale: [0.875, 1, 0.875] },
      ],
    }],
    [{ id: 'mug', geometry: 'mug', translation: [0, 0.05, 0], scale: [0.04, 0.1, 0.04] }],
  ),
  gear: scene(
    [{ id: 'gear', type: 'extrude', contour: gearContour(12, 0.1, 0.085), holes: [circle(0.02, 32, 0, 0, true)], depth: 0.02 }],
    [{ id: 'gear', geometry: 'gear', rotation: axisRotation('x', -Math.PI / 2) }],
  ),
  fence: scene(
    [{ id: 'block', type: 'box', bevel: 0 }],
    [
      ...[-1, -0.5, 0, 0.5, 1].map((x, index) => ({ id: `post-${index}`, geometry: 'block', translation: [x, 0.5, 0], scale: [0.08, 1, 0.08] })),
      { id: 'rail-low', geometry: 'block', translation: [0, 0.3, 0], scale: [2.08, 0.04, 0.06] },
      { id: 'rail-high', geometry: 'block', translation: [0, 0.8, 0], scale: [2.08, 0.04, 0.06] },
    ],
  ),
  bracket: scene(
    [
      { id: 'base', type: 'extrude', depth: 0.02, contour: rectangle(-0.1, -0.05, 0.1, 0.05), holes: [circle(0.01, 32, 0, 0, true), circle(0.01, 32, 0.06, 0, true)] },
      { id: 'block', type: 'box', bevel: 0 },
    ],
    [
      { id: 'base', geometry: 'base', rotation: axisRotation('x', -Math.PI / 2) },
      { id: 'upright', geometry: 'block', translation: [-0.09, 0.095, 0], scale: [0.02, 0.15, 0.1] },
    ],
  ),
  soap: scene(
    [{ id: 'soap', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [
      { op: 'translate', select: { tag: 'right' }, offset: [-0.455, 0, 0] },
      { op: 'translate', select: { tag: 'left' }, offset: [0.455, 0, 0] },
      { op: 'translate', select: { tag: 'top' }, offset: [0, -0.485, 0] },
      { op: 'translate', select: { tag: 'bottom' }, offset: [0, 0.485, 0] },
      { op: 'translate', select: { tag: 'front' }, offset: [0, 0, -0.47] },
      { op: 'translate', select: { tag: 'back' }, offset: [0, 0, 0.47] },
      { op: 'bevel', edges: { all: true }, width: 0.01, segments: 4 },
    ] }],
    [{ id: 'soap', geometry: 'soap', translation: [0, 0.015, 0] }],
  ),
};
