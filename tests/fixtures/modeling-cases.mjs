// Inputs for lathe, extrude and tube taken from the modeling tests, the mesh recipe tests and the agent suite references.
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

const panes = [
  rectangle(-0.44, 0.06, -0.03, 0.57, true), rectangle(0.03, 0.06, 0.44, 0.57, true),
  rectangle(-0.44, 0.63, -0.03, 1.14, true), rectangle(0.03, 0.63, 0.44, 1.14, true),
];
const windowFrame = rectangle(-0.5, 0, 0.5, 1.2);
const lPlate = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
const boltPipe = [[0.04, 0.3], [0.04, 0], [0.09, 0], [0.09, 0.02], [0.05, 0.02], [0.05, 0.28], [0.09, 0.28], [0.09, 0.3], [0.04, 0.3]];
const comb = [[0, 0], [6, 0], [6, 4], [5, 4], [5, 1], [4, 1], [4, 4], [3, 4], [3, 1], [2, 1], [2, 4], [0, 4]];
const arrow = [[0, 0], [4, 0], [4, 1], [6, 1], [3, 4], [0, 1.5], [1, 1]];

export const MODELING_CASES = [
  { name: 'lathe-cylinder', kind: 'lathe', profile: [[0, 0], [1, 0], [1, 2], [0, 2]], options: { segments: 128 } },
  { name: 'lathe-half-sweep', kind: 'lathe', profile: [[1, 0], [1, 2]], options: { segments: 8, sweep: Math.PI } },
  { name: 'lathe-quarter-offset', kind: 'lathe', profile: [[0, 0], [1, 0], [1, 2], [0, 2]], options: { segments: 16, startAngle: 1, sweep: Math.PI / 2 } },
  { name: 'lathe-pipe', kind: 'lathe', profile: boltPipe, options: { segments: 64 } },
  { name: 'lathe-vase', kind: 'lathe', profile: [[0.5, -1], [1, 0], [0.5, 1]], options: { segments: 8 } },
  { name: 'lathe-large-angle', kind: 'lathe', profile: [[1, 0], [1, 2]], options: { startAngle: 1e20, segments: 8 } },
  { name: 'lathe-cone-tip', kind: 'lathe', profile: [[0, 2], [1, 0]], options: { segments: 12 } },
  { name: 'lathe-tilted-profile', kind: 'lathe', profile: [[1, 1], [2, 0], [1, -1], [0.2, -1]], options: { segments: 20 } },
  { name: 'extrude-square', kind: 'extrude', contour: rectangle(-1, -1, 1, 1), options: { depth: 1 } },
  { name: 'extrude-concave', kind: 'extrude', contour: lPlate, options: { depth: 2 } },
  { name: 'extrude-comb', kind: 'extrude', contour: comb, options: { depth: 1 } },
  { name: 'extrude-arrow', kind: 'extrude', contour: arrow, options: { depth: 0.5, steps: 2 } },
  { name: 'extrude-hollow', kind: 'extrude', contour: rectangle(-2, -2, 2, 2), options: { holes: [[[-1, -1], [-1, 1], [1, 1], [1, -1]]], depth: 0.5 } },
  { name: 'extrude-hollow-reversed', kind: 'extrude', contour: rectangle(-2, -2, 2, 2).reverse(), options: { holes: [[[-1, -1], [-1, 1], [1, 1], [1, -1]].reverse()], depth: 0.5 } },
  { name: 'extrude-bevel', kind: 'extrude', contour: rectangle(-1, -1, 1, 1), options: { depth: 0.5, bevel: 0.1, bevelSegments: 6 } },
  { name: 'extrude-bevel-thickness', kind: 'extrude', contour: lPlate, options: { depth: 1, bevel: 0.05, bevelThickness: 0.1, bevelSegments: 2 } },
  { name: 'extrude-bevel-holes', kind: 'extrude', contour: windowFrame, options: { holes: panes, depth: 0.08, bevel: 0.005, bevelSegments: 2 } },
  { name: 'extrude-window', kind: 'extrude', contour: windowFrame, options: { holes: panes, depth: 0.08 } },
  { name: 'extrude-window-steps', kind: 'extrude', contour: windowFrame, options: { holes: panes, depth: 0.08, steps: 3 } },
  { name: 'extrude-hexagon', kind: 'extrude', contour: circle(0.05 / Math.sqrt(3), 6), options: { depth: 0.02 } },
  { name: 'extrude-gear', kind: 'extrude', contour: gearContour(12, 0.1, 0.085), options: { holes: [circle(0.02, 32, 0, 0, true)], depth: 0.02 } },
  { name: 'extrude-bracket', kind: 'extrude', contour: rectangle(-0.1, -0.05, 0.1, 0.05), options: { holes: [circle(0.01, 32, 0, 0, true), circle(0.01, 32, 0.06, 0, true)], depth: 0.02 } },
  { name: 'extrude-two-holes-bevel', kind: 'extrude', contour: circle(2, 24), options: { holes: [circle(0.5, 12, 1, 0), circle(0.5, 12, -1, 0)], depth: 0.3, bevel: 0.05, bevelSegments: 3 } },
  { name: 'tube-straight', kind: 'tube', path: [[0, 0, 0], [0, 2, 0]], options: { radius: 0.2, segments: 16, radialSegments: 24 } },
  { name: 'tube-closed', kind: 'tube', path: [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]], options: { closed: true, segments: 48 } },
  { name: 'tube-cable', kind: 'tube', path: [[0, 0, 0], [1, 1, 0], [2, 0, 0]], options: { radius: 0.05 } },
  { name: 'tube-bend', kind: 'tube', path: [[0, 0, 0], [0, 1, 0], [1, 2, 0]], options: { segments: 8, radialSegments: 4 } },
  { name: 'tube-helix', kind: 'tube', path: Array.from({ length: 12 }, (_, index) => [Math.cos(index), index * 0.2, Math.sin(index)]), options: { radius: 0.08, segments: 90, radialSegments: 8 } },
  { name: 'tube-uneven-spacing', kind: 'tube', path: [[0, 0, 0], [0.1, 0, 0], [3, 1, 0], [3.1, 1.2, 1], [0, 3, 0]], options: { segments: 40, radialSegments: 6 } },
  { name: 'tube-closed-loop-plane', kind: 'tube', path: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], options: { closed: true, segments: 32, radialSegments: 8, radius: 0.05 } },
];
