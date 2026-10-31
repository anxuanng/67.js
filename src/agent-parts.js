import { AGENT_PART_CATALOG, MAX_PARTS, MAX_PART_POSITION } from './agent-part-catalog.js';

// Expands the parts of a recipe into ordinary geometries, materials and nodes. The result is plain recipe data: the
// exported recipe has no `parts` field, every node can be edited on its own, and nothing here runs agent code.
// Each part is a list of items (a box, cylinder, sphere, hex prism or gear outline) with a centre and a size in the
// part's own frame, standing on y = 0. One item is the anchor. Every other item gets relations to the anchor, derived
// from the numbers (touching faces become `gap`, inset edges `align`, centred axes `centered`), so moving or resizing
// the anchor with set-node carries the part along. The same input always expands to the same output.

const EPSILON = 1e-6;
const AXIS_NAMES = ['x', 'y', 'z'];
const HALF_ROOT = Math.SQRT1_2;
const MAX_PIPE_POINTS = 16;
const MAX_PIPE_COORDINATE = 1000;
const HEX_CORNER_PER_FLAT = 1 / Math.cos(Math.PI / 6);

const PART_MATERIALS = Object.freeze({
  'part-wood': { id: 'part-wood', color: [1, 1, 1], roughness: 0.65, pattern: { type: 'wood', size: 0.6, bump: 0.4 } },
  'part-paint': { id: 'part-paint', color: [0.86, 0.85, 0.8], roughness: 0.5 },
  'part-metal': { id: 'part-metal', color: [0.6, 0.6, 0.63], metallic: 1, roughness: 0.38 },
  'part-glass': { id: 'part-glass', color: [0.7, 0.85, 0.9], roughness: 0.05, opacity: 0.25, alphaMode: 'blend' },
  'part-shade': { id: 'part-shade', color: [0.9, 0.78, 0.55], roughness: 0.9 },
  'part-bulb': { id: 'part-bulb', color: [1, 0.9, 0.7], roughness: 0.4, emission: 2.5 },
});

const SHARED_GEOMETRIES = Object.freeze({
  box: { id: 'part-box', type: 'box', bevel: 0 },
  cylinder: { id: 'part-cylinder', type: 'cylinder', segments: 32, bevel: 0 },
  sphere: { id: 'part-sphere', type: 'sphere', segments: 24, rings: 16 },
  hex: { id: 'part-hex', type: 'cylinder', segments: 6, bevel: 0 },
});

// A cylinder is built along +Y; these quaternions lay it along X or Z. Gears lie flat, so their extrusion turns to +Y.
const CYLINDER_ROTATIONS = Object.freeze({ y: undefined, x: [0, 0, -HALF_ROOT, HALF_ROOT], z: [HALF_ROOT, 0, 0, HALF_ROOT] });
const GEAR_ROTATION = Object.freeze([-HALF_ROOT, 0, 0, HALF_ROOT]);

function round(value) {
  return Number(value.toFixed(6));
}

function item(name, shape, role, center, size, extra = {}) {
  return { name, shape, role, center, size, ...extra };
}

function box(name, role, center, size) {
  return item(name, 'box', role, center, size);
}

function requireFit(condition, message) {
  if (!condition) {
    throw new RangeError(message);
  }
}

function windowPart(parameters) {
  const { width, height, depth, frame, columns, rows, glass } = parameters;
  const innerWidth = width - 2 * frame;
  const innerHeight = height - 2 * frame;
  const paneWidth = (innerWidth - (columns - 1) * frame) / columns;
  const paneHeight = (innerHeight - (rows - 1) * frame) / rows;
  requireFit(paneWidth > 0 && paneHeight > 0, 'window frame and bars leave no room for the panes: lower frame, columns or rows, or raise width and height.');
  const items = [
    box('bottom', 'main', [0, frame / 2, 0], [width, frame, depth]),
    box('top', 'main', [0, height - frame / 2, 0], [width, frame, depth]),
    box('left', 'main', [-(width - frame) / 2, height / 2, 0], [frame, innerHeight, depth]),
    box('right', 'main', [(width - frame) / 2, height / 2, 0], [frame, innerHeight, depth]),
  ];
  for (let column = 1; column < columns; column++) {
    const x = -innerWidth / 2 + column * paneWidth + (column - 0.5) * frame;
    items.push(box(`bar-column-${column}`, 'main', [x, height / 2, 0], [frame, innerHeight, depth]));
  }
  for (let row = 1; row < rows; row++) {
    const y = frame + row * paneHeight + (row - 0.5) * frame;
    for (let column = 0; column < columns; column++) {
      const x = -innerWidth / 2 + column * (paneWidth + frame) + paneWidth / 2;
      items.push(box(`bar-row-${row}-${column}`, 'main', [x, y, 0], [paneWidth, frame, depth]));
    }
  }
  if (glass === 1) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -innerWidth / 2 + column * (paneWidth + frame) + paneWidth / 2;
        const y = frame + row * (paneHeight + frame) + paneHeight / 2;
        items.push(box(`glass-${row}-${column}`, 'glass', [x, y, 0], [paneWidth, paneHeight, Math.min(0.01, depth / 2)]));
      }
    }
  }
  return { anchor: 'bottom', items };
}

function doorPart(parameters) {
  const { width, height, thickness, frame, panels } = parameters;
  requireFit(2 * frame < width && frame < height, 'door frame is wider than the door: lower frame or raise width.');
  const leafWidth = width - 2 * frame;
  const leafHeight = height - frame;
  const frameDepth = thickness + 0.04;
  const items = [
    box('leaf', 'main', [0, leafHeight / 2, 0], [leafWidth, leafHeight, thickness]),
    box('jamb-left', 'main', [-(width - frame) / 2, height / 2, 0], [frame, height, frameDepth]),
    box('jamb-right', 'main', [(width - frame) / 2, height / 2, 0], [frame, height, frameDepth]),
    box('head', 'main', [0, height - frame / 2, 0], [leafWidth, frame, frameDepth]),
  ];
  const panelDepth = 0.01;
  const panelZ = (thickness + panelDepth) / 2;
  if (panels === 1) {
    items.push(box('panel', 'main', [0, leafHeight / 2, panelZ], [leafWidth * 0.7, leafHeight * 0.8, panelDepth]));
  }
  if (panels === 2) {
    items.push(box('panel-upper', 'main', [0, leafHeight * 0.72, panelZ], [leafWidth * 0.7, leafHeight * 0.3, panelDepth]));
    items.push(box('panel-lower', 'main', [0, leafHeight * 0.3, panelZ], [leafWidth * 0.7, leafHeight * 0.35, panelDepth]));
  }
  items.push(item('knob', 'sphere', 'metal', [leafWidth / 2 - 0.08, Math.min(1, leafHeight / 2), thickness / 2 + 0.025], [0.05, 0.05, 0.05]));
  return { anchor: 'leaf', items };
}

function shelfPart(parameters) {
  const { width, height, depth, board, shelves, plinth, back } = parameters;
  requireFit(2 * board < width && plinth + shelves * board < height, 'shelf boards do not fit: lower board, shelves or plinth, or raise width and height.');
  requireFit(back < depth, 'shelf back is as thick as the shelf is deep: lower back.');
  const boardDepth = depth - back;
  const boardZ = back / 2;
  const items = [];
  for (let level = 0; level < shelves; level++) {
    const y = plinth + board / 2 + level * (height - plinth - board) / (shelves - 1);
    items.push(box(`board-${level}`, 'main', [0, y, boardZ], [width - 2 * board, board, boardDepth]));
  }
  items.push(box('side-left', 'main', [-(width - board) / 2, height / 2, 0], [board, height, depth]));
  items.push(box('side-right', 'main', [(width - board) / 2, height / 2, 0], [board, height, depth]));
  if (back > 0) {
    items.push(box('back', 'main', [0, (height + plinth) / 2, -(depth - back) / 2], [width - 2 * board, height - plinth, back]));
  }
  return { anchor: 'board-0', items };
}

function tablePart(parameters) {
  const { width, depth, height, top, leg, inset } = parameters;
  requireFit(top < height && inset + leg < width / 2 && inset + leg < depth / 2, 'table legs do not fit under the top: lower leg, inset or top, or raise width, depth and height.');
  const legHeight = height - top;
  const items = [box('top', 'main', [0, height - top / 2, 0], [width, top, depth])];
  for (const [xName, xSign] of [['left', -1], ['right', 1]]) {
    for (const [zName, zSign] of [['back', -1], ['front', 1]]) {
      const center = [xSign * (width / 2 - inset - leg / 2), legHeight / 2, zSign * (depth / 2 - inset - leg / 2)];
      items.push(box(`leg-${xName}-${zName}`, 'main', center, [leg, legHeight, leg]));
    }
  }
  return { anchor: 'top', items };
}

function chairPart(parameters) {
  const { width, depth, seatHeight, seat, leg, backHeight, slats, slatHeight, slatThickness, slatPitch } = parameters;
  requireFit(2 * leg < width && 2 * leg < depth && seat < seatHeight && seatHeight < backHeight, 'chair legs, seat or back do not fit: lower leg or seat, or raise width, depth and backHeight above seatHeight.');
  const lowestSlat = backHeight - slatPitch * slats;
  requireFit(slats === 0 || (lowestSlat - slatHeight / 2 >= seatHeight && slatHeight / 2 <= slatPitch), 'chair slats do not fit above the seat: lower slats, slatHeight or slatPitch.');
  const legHeight = seatHeight - seat;
  const items = [box('seat', 'main', [0, seatHeight - seat / 2, 0], [width, seat, depth])];
  for (const [xName, xSign] of [['left', -1], ['right', 1]]) {
    const x = xSign * (width / 2 - leg / 2);
    items.push(box(`leg-${xName}-front`, 'main', [x, legHeight / 2, depth / 2 - leg / 2], [leg, legHeight, leg]));
    items.push(box(`leg-${xName}-back`, 'main', [x, legHeight / 2, -(depth / 2 - leg / 2)], [leg, legHeight, leg]));
    items.push(box(`post-${xName}`, 'main', [x, (seatHeight + backHeight) / 2, -(depth / 2 - leg / 2)], [leg, backHeight - seatHeight, leg]));
  }
  for (let slat = 0; slat < slats; slat++) {
    const y = backHeight - slatPitch * (slats - slat);
    items.push(box(`slat-${slat}`, 'main', [0, y, -(depth / 2 - leg / 2)], [width - 2 * leg, slatHeight, slatThickness]));
  }
  return { anchor: 'seat', items };
}

function lampPart(parameters) {
  const { height, base, shade, shadeHeight } = parameters;
  const baseHeight = 0.02;
  requireFit(baseHeight + shadeHeight < height, 'lamp shade is taller than the lamp: lower shadeHeight or raise height.');
  const poleLength = height - baseHeight - shadeHeight / 2;
  const bulb = Math.min(0.05, shade / 2, shadeHeight * 0.8);
  return {
    anchor: 'base',
    items: [
      item('base', 'cylinder', 'main', [0, baseHeight / 2, 0], [base, baseHeight, base]),
      item('pole', 'cylinder', 'main', [0, baseHeight + poleLength / 2, 0], [0.016, poleLength, 0.016]),
      item('shade', 'sphere', 'shade', [0, height - shadeHeight / 2, 0], [shade, shadeHeight, shade]),
      item('bulb', 'sphere', 'bulb', [0, height - shadeHeight / 2 - shadeHeight * 0.15, 0], [bulb, bulb, bulb]),
    ],
  };
}

function bolt(parameters) {
  const { length, diameter, headFlats, headHeight } = parameters;
  requireFit(headFlats > diameter, 'bolt head is narrower than the shaft: raise headFlats above diameter.');
  const headWidth = headFlats * HEX_CORNER_PER_FLAT;
  return {
    anchor: 'shaft',
    items: [
      item('shaft', 'cylinder', 'main', [0, length / 2, 0], [diameter, length, diameter]),
      item('head', 'hex', 'main', [0, length + headHeight / 2, 0], [headWidth, headHeight, headWidth]),
    ],
  };
}

function gearOutline(parameters) {
  const { teeth, outerRadius, rootRadius } = parameters;
  const pitch = (2 * Math.PI) / teeth;
  const contour = [];
  for (let tooth = 0; tooth < teeth; tooth++) {
    for (const [fraction, radius] of [[-0.3, rootRadius], [-0.14, outerRadius], [0.14, outerRadius], [0.3, rootRadius]]) {
      const angle = (tooth + fraction) * pitch;
      contour.push([round(radius * Math.cos(angle)), round(radius * Math.sin(angle))]);
    }
  }
  return contour;
}

function boreOutline(boreRadius) {
  const points = [];
  const steps = 32;
  for (let step = 0; step < steps; step++) {
    const angle = (2 * Math.PI * step) / steps;
    points.push([round(boreRadius * Math.cos(angle)), round(boreRadius * Math.sin(angle))]);
  }
  return points;
}

function gearPart(parameters) {
  const { outerRadius, rootRadius, thickness, boreRadius } = parameters;
  requireFit(rootRadius < outerRadius && boreRadius < rootRadius, 'gear radii must satisfy boreRadius < rootRadius < outerRadius.');
  const geometry = {
    type: 'extrude', contour: gearOutline(parameters), holes: boreRadius > 0 ? [boreOutline(boreRadius)] : [], depth: thickness, bevel: 0,
  };
  return {
    anchor: 'gear',
    items: [item('gear', 'gear', 'main', [0, thickness / 2, 0], [2 * outerRadius, thickness, 2 * outerRadius], { geometry, originShift: [0, -thickness / 2, 0] })],
  };
}

function crate(parameters) {
  const { width, height, depth, post, lid } = parameters;
  requireFit(2 * post < width && 2 * post < depth && lid < height, 'crate posts or lid do not fit: lower post or lid, or raise width, depth and height.');
  const bodyHeight = height - lid;
  const items = [box('body', 'main', [0, bodyHeight / 2, 0], [width - 0.03, bodyHeight, depth - 0.03])];
  for (const [xName, xSign] of [['left', -1], ['right', 1]]) {
    for (const [zName, zSign] of [['back', -1], ['front', 1]]) {
      items.push(box(`post-${xName}-${zName}`, 'main', [xSign * (width - post) / 2, bodyHeight / 2, zSign * (depth - post) / 2], [post, bodyHeight, post]));
    }
  }
  items.push(box('lid', 'main', [0, height - lid / 2, 0], [width, lid, depth]));
  return { anchor: 'body', items };
}

function pipeDirection(from, to, partId, index) {
  const changed = [0, 1, 2].filter(axis => Math.abs(to[axis] - from[axis]) > EPSILON);
  requireFit(changed.length === 1, `Part ${partId} pipe step ${index} must change exactly one coordinate (x, y or z) of the previous point.`);
  return changed[0];
}

function pipeFlange(name, endpoint, axis, direction, radius) {
  const center = [...endpoint];
  center[axis] += direction * radius * 0.3;
  const size = [radius * 3.6, radius * 3.6, radius * 3.6];
  size[axis] = radius * 0.6;
  return item(name, 'cylinder', 'main', center, size, { axis: AXIS_NAMES[axis] });
}

function pipePart(parameters, partId) {
  const { radius, flanges, points } = parameters;
  const items = [];
  const steps = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const axis = pipeDirection(from, to, partId, index);
    const length = Math.abs(to[axis] - from[axis]);
    requireFit(length >= radius, `Part ${partId} pipe step ${index} is shorter than the radius: use longer steps or a smaller radius.`);
    const center = from.map((value, coordinate) => (value + to[coordinate]) / 2);
    const size = [2 * radius, 2 * radius, 2 * radius];
    size[axis] = length;
    steps.push({ from, to, axis, direction: Math.sign(to[axis] - from[axis]) });
    items.push(item(`run-${index}`, 'cylinder', 'main', center, size, { axis: AXIS_NAMES[axis] }));
    if (index < points.length - 1) {
      items.push(item(`joint-${index}`, 'sphere', 'main', to, [2.2 * radius, 2.2 * radius, 2.2 * radius]));
    }
  }
  if (flanges === 1) {
    const first = steps[0];
    const last = steps[steps.length - 1];
    items.push(pipeFlange('flange-start', first.from, first.axis, first.direction, radius));
    items.push(pipeFlange('flange-end', last.to, last.axis, -last.direction, radius));
  }
  return { anchor: 'run-1', items, free: true };
}

const BUILDERS = Object.freeze({
  window: windowPart, door: doorPart, shelf: shelfPart, table: tablePart, chair: chairPart, lamp: lampPart,
  pipe: pipePart, bolt, gear: gearPart, crate,
});

const MAIN_MATERIAL = Object.freeze({
  window: 'part-paint', door: 'part-wood', shelf: 'part-wood', table: 'part-wood', chair: 'part-wood', lamp: 'part-metal',
  pipe: 'part-metal', bolt: 'part-metal', gear: 'part-metal', crate: 'part-wood',
});
const ROLE_MATERIALS = Object.freeze({ metal: 'part-metal', glass: 'part-glass', shade: 'part-shade', bulb: 'part-bulb' });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateParameters(part, entry) {
  const allowed = ['id', 'type', 'at', 'on', 'material', ...Object.keys(entry.parameters), ...(part.type === 'pipe' ? ['points'] : [])];
  for (const key of Object.keys(part)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`Part ${JSON.stringify(String(part.id).slice(0, 48))} has unknown field ${JSON.stringify(key.slice(0, 48))}. A ${part.type} takes: ${allowed.join(', ')}.`);
    }
  }
  const resolved = {};
  for (const [name, spec] of Object.entries(entry.parameters)) {
    const value = Object.hasOwn(part, name) ? part[name] : spec.default;
    const valid = Number.isFinite(value) && value >= spec.minimum && value <= spec.maximum && (!spec.integer || Number.isInteger(value));
    if (!valid) {
      throw new RangeError(`Part ${part.id} ${name} must be ${spec.integer ? 'a whole number' : 'a number'} from ${spec.minimum} to ${spec.maximum} (default ${spec.default}).`);
    }
    resolved[name] = value;
  }
  return resolved;
}

function validatePlacement(part, builderResult) {
  if (part.at !== undefined && part.on !== undefined) {
    throw new TypeError(`Part ${part.id} has both at and on. Give at (a position) or on (a node to stand on), not both.`);
  }
  if (part.at !== undefined) {
    const valid = Array.isArray(part.at) && part.at.length === 3 && part.at.every(value => Number.isFinite(value) && Math.abs(value) <= MAX_PART_POSITION);
    if (!valid) {
      throw new RangeError(`Part ${part.id} at must be [x, y, z] within +-${MAX_PART_POSITION} metres.`);
    }
  }
  if (part.on !== undefined) {
    if (typeof part.on !== 'string' || part.on.length === 0 || part.on.length > 128) {
      throw new TypeError(`Part ${part.id} on must be the ID of a mesh node (1 to 128 characters).`);
    }
    if (builderResult.free) {
      throw new TypeError(`Part ${part.id} is a ${part.type}, which is placed with at; on is for parts that stand on a surface.`);
    }
  }
  if (part.material !== undefined && (typeof part.material !== 'string' || part.material.length === 0 || part.material.length > 128)) {
    throw new TypeError(`Part ${part.id} material must be the ID of a recipe material.`);
  }
}

function validatePipePoints(part) {
  const points = part.points;
  const valid = Array.isArray(points) && points.length >= 2 && points.length <= MAX_PIPE_POINTS
    && points.every(point => Array.isArray(point) && point.length === 3 && point.every(value => Number.isFinite(value) && Math.abs(value) <= MAX_PIPE_COORDINATE));
  if (!valid) {
    throw new RangeError(`Part ${part.id} points must be 2 to ${MAX_PIPE_POINTS} points [x, y, z] within +-${MAX_PIPE_COORDINATE} metres.`);
  }
  return points;
}

function validatePartId(part, seen) {
  if (typeof part.id !== 'string' || part.id.trim().length === 0 || part.id.length > 64) {
    throw new TypeError('A part needs an id of 1 to 64 characters.');
  }
  if (seen.has(part.id)) {
    throw new RangeError(`Duplicate part ID: ${part.id}. Give each part its own id.`);
  }
  seen.add(part.id);
}

function lowerAxisBounds(entry, axis) {
  return entry.center[axis] - entry.size[axis] / 2;
}

function upperAxisBounds(entry, axis) {
  return entry.center[axis] + entry.size[axis] / 2;
}

function near(first, second) {
  return Math.abs(first - second) < EPSILON;
}

// One relation per axis (centred axes share one): touching faces become gap, otherwise the nearest edge is aligned.
function relationsAgainstAnchor(anchorNodeId, child, anchor) {
  const relations = [];
  const centeredAxes = [];
  for (const axis of [0, 1, 2]) {
    const name = AXIS_NAMES[axis];
    if (near(lowerAxisBounds(child, axis), upperAxisBounds(anchor, axis))) {
      relations.push({ kind: 'gap', to: anchorNodeId, side: `+${name}` });
    } else if (near(upperAxisBounds(child, axis), lowerAxisBounds(anchor, axis))) {
      relations.push({ kind: 'gap', to: anchorNodeId, side: `-${name}` });
    } else if (near(child.center[axis], anchor.center[axis])) {
      centeredAxes.push(name);
    } else {
      const minimumDistance = Math.abs(lowerAxisBounds(child, axis) - lowerAxisBounds(anchor, axis));
      const maximumDistance = Math.abs(upperAxisBounds(child, axis) - upperAxisBounds(anchor, axis));
      const atMinimum = minimumDistance <= maximumDistance;
      const offset = atMinimum
        ? lowerAxisBounds(child, axis) - lowerAxisBounds(anchor, axis)
        : upperAxisBounds(child, axis) - upperAxisBounds(anchor, axis);
      relations.push({ kind: 'align', to: anchorNodeId, axis: name, at: atMinimum ? 'min' : 'max', ...(offset === 0 ? {} : { offset: round(offset) }) });
    }
  }
  if (centeredAxes.length > 0) {
    relations.push({ kind: 'centered', to: anchorNodeId, axes: centeredAxes });
  }
  return relations;
}

// The anchor stands on the top face of `on`: its lowest point sits `anchorBottom` above that face, and the part origin is centred on it.
function relationsOnSurface(targetId, anchor) {
  const relations = [{ kind: 'gap', to: targetId, side: '+y', ...(near(lowerAxisBounds(anchor, 1), 0) ? {} : { offset: round(lowerAxisBounds(anchor, 1)) }) }];
  for (const axis of [0, 2]) {
    const offset = anchor.center[axis];
    relations.push({ kind: 'align', to: targetId, axis: AXIS_NAMES[axis], at: 'center', ...(near(offset, 0) ? {} : { offset: round(offset) }) });
  }
  return relations;
}

function geometryIdFor(entry, partId) {
  return entry.shape === 'gear' ? `${partId}.gear` : SHARED_GEOMETRIES[entry.shape].id;
}

// Built-in primitives: a box is 1 m on a side, a cylinder has radius 1 and height 1, a sphere has radius 1.
function scaleFor(entry) {
  const [width, height, depth] = entry.size;
  if (entry.shape === 'gear') {
    return [1, 1, 1];
  }
  if (entry.shape === 'sphere') {
    return [width / 2, height / 2, depth / 2].map(round);
  }
  if (entry.shape === 'cylinder' || entry.shape === 'hex') {
    const lengthAxis = AXIS_NAMES.indexOf(entry.axis ?? 'y');
    const scale = entry.size.map(extent => extent / 2);
    scale[lengthAxis] = entry.size[lengthAxis];
    const radial = [0, 1, 2].filter(axis => axis !== lengthAxis);
    return lengthAxis === 1 ? scale.map(round) : [scale[radial[0]], scale[lengthAxis], scale[radial[1]]].map(round);
  }
  return [width, height, depth].map(round);
}

function rotationFor(entry) {
  if (entry.shape === 'gear') {
    return [...GEAR_ROTATION];
  }
  const rotation = entry.shape === 'cylinder' ? CYLINDER_ROTATIONS[entry.axis ?? 'y'] : undefined;
  return rotation ? [...rotation] : undefined;
}

function nodeFor(part, partId, entry, anchor, origin, materialId) {
  // An extrusion spans 0 to its depth, so a gear's node origin sits at the bottom face, not at its centre.
  const shift = entry.originShift ?? [0, 0, 0];
  const translation = entry.center.map((value, axis) => round(value + origin[axis] + shift[axis]));
  const node = { id: `${partId}.${entry.name}`, geometry: geometryIdFor(entry, partId), material: materialId, translation, scale: scaleFor(entry) };
  const rotation = rotationFor(entry);
  if (rotation) {
    node.rotation = rotation;
  }
  if (entry === anchor) {
    if (part.on !== undefined) {
      node.relations = relationsOnSurface(part.on, anchor);
    }
  } else {
    node.relations = relationsAgainstAnchor(`${partId}.${anchor.name}`, entry, anchor);
  }
  return node;
}

function materialIdFor(part, entry) {
  if (entry.role === 'main') {
    return part.material ?? MAIN_MATERIAL[part.type];
  }
  return ROLE_MATERIALS[entry.role];
}

function expandPart(part, additions) {
  const entry = AGENT_PART_CATALOG[part.type];
  const parameters = validateParameters(part, entry);
  if (part.type === 'pipe') {
    parameters.points = validatePipePoints(part);
  }
  const built = BUILDERS[part.type](parameters, part.id);
  validatePlacement(part, built);
  const anchor = built.items.find(candidate => candidate.name === built.anchor);
  const origin = part.at ?? [0, 0, 0];
  for (const itemEntry of built.items) {
    const materialId = materialIdFor(part, itemEntry);
    additions.materialIds.add(materialId);
    additions.shapes.add(itemEntry.shape);
    if (itemEntry.geometry) {
      additions.geometries.push({ id: geometryIdFor(itemEntry, part.id), ...itemEntry.geometry });
    }
    additions.nodes.push(nodeFor(part, part.id, itemEntry, anchor, origin, materialId));
  }
}

/**
 * Expand a recipe's `parts` into { geometries, materials, nodes } to append to the recipe. Shared geometries and the
 * part materials are added once and skipped when the recipe already holds an entry with the same ID, so an exported
 * recipe can be fed back in. Throws a message that names the part and the field to change.
 */
export function expandParts(parts, existing = {}) {
  if (!Array.isArray(parts) || parts.length > MAX_PARTS) {
    throw new RangeError(`parts must be an array of at most ${MAX_PARTS} parts.`);
  }
  const additions = { geometries: [], nodes: [], materialIds: new Set(), shapes: new Set() };
  const seen = new Set();
  for (const part of parts) {
    if (!isPlainObject(part) || !Object.hasOwn(AGENT_PART_CATALOG, part.type)) {
      throw new TypeError(`A part needs a type: one of ${Object.keys(AGENT_PART_CATALOG).join(', ')}.`);
    }
    validatePartId(part, seen);
    expandPart(part, additions);
  }
  const knownGeometries = new Set(existing.geometryIds ?? []);
  const knownMaterials = new Set(existing.materialIds ?? []);
  const sharedGeometries = [...additions.shapes]
    .filter(shape => SHARED_GEOMETRIES[shape])
    .map(shape => SHARED_GEOMETRIES[shape])
    .filter(geometry => !knownGeometries.has(geometry.id));
  const materials = [...additions.materialIds]
    .filter(materialId => PART_MATERIALS[materialId] && !knownMaterials.has(materialId))
    .map(materialId => structuredClone(PART_MATERIALS[materialId]));
  return { geometries: [...sharedGeometries.map(geometry => ({ ...geometry })), ...additions.geometries], materials, nodes: additions.nodes };
}
