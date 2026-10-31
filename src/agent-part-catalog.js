// The reusable parts an agent can name in a recipe, as plain data: what each one is called and which numbers it takes.
// The MCP server reads this without bundling the scene engine; src/agent-parts.js (loaded on demand) expands a part into
// ordinary geometries, materials and nodes with relations. Metres everywhere; a part stands on y = 0 and faces +Z.

export const MAX_PARTS = 64;
export const MAX_PART_POSITION = 10_000;

function number(defaultValue, minimum, maximum) {
  return Object.freeze({ default: defaultValue, minimum, maximum, integer: false });
}

function count(defaultValue, minimum, maximum) {
  return Object.freeze({ default: defaultValue, minimum, maximum, integer: true });
}

export const PART_COMMON_FIELDS = 'id (nodes are <id>.<name>), type, at [x,y,z] (bottom centre, default origin) or on (mesh node ID: stands on its top face), material (ID for the main body), then the numbers below with their defaults (metres; an out of range value fails and the message gives the range).';

export const AGENT_PART_CATALOG = Object.freeze({
  window: Object.freeze({
    summary: 'Frame with cross bars standing in the XY plane, panes open or glazed.',
    parameters: Object.freeze({
      width: number(1, 0.2, 4), height: number(1.2, 0.2, 4), depth: number(0.08, 0.01, 0.5), frame: number(0.06, 0.005, 0.3),
      columns: count(2, 1, 6), rows: count(2, 1, 6), glass: count(0, 0, 1),
    }),
  }),
  door: Object.freeze({
    summary: 'Leaf with two jambs, a head, raised panels and a knob, in the XY plane.',
    parameters: Object.freeze({
      width: number(0.9, 0.4, 2), height: number(2, 1, 3), thickness: number(0.04, 0.01, 0.2), frame: number(0.05, 0.01, 0.2), panels: count(2, 0, 2),
    }),
  }),
  shelf: Object.freeze({
    summary: 'Open bookcase: two sides, evenly spaced boards, optional thin back.',
    parameters: Object.freeze({
      width: number(0.8, 0.2, 4), height: number(1.2, 0.2, 4), depth: number(0.3, 0.05, 1), board: number(0.02, 0.003, 0.1),
      shelves: count(4, 2, 12), plinth: number(0.06, 0, 0.5), back: number(0.006, 0, 0.05),
    }),
  }),
  table: Object.freeze({
    summary: 'Top on four square legs.',
    parameters: Object.freeze({
      width: number(1.2, 0.2, 4), depth: number(0.75, 0.2, 3), height: number(0.75, 0.1, 2), top: number(0.04, 0.005, 0.2),
      leg: number(0.05, 0.01, 0.3), inset: number(0.05, 0, 1),
    }),
  }),
  chair: Object.freeze({
    summary: 'Seat on four legs; the rear legs rise as posts joined by back slats.',
    parameters: Object.freeze({
      width: number(0.45, 0.15, 1.5), depth: number(0.45, 0.15, 1.5), seatHeight: number(0.45, 0.1, 1), seat: number(0.03, 0.005, 0.15),
      leg: number(0.04, 0.01, 0.2), backHeight: number(0.9, 0.2, 2), slats: count(3, 0, 6), slatHeight: number(0.06, 0.01, 0.3),
      slatThickness: number(0.02, 0.005, 0.1), slatPitch: number(0.1, 0.02, 0.5),
    }),
  }),
  lamp: Object.freeze({
    summary: 'Round base, thin pole, shade over an emissive bulb.',
    parameters: Object.freeze({
      height: number(0.45, 0.1, 2.5), base: number(0.15, 0.04, 0.6), shade: number(0.2, 0.05, 0.8), shadeHeight: number(0.12, 0.03, 0.5),
    }),
  }),
  pipe: Object.freeze({
    summary: 'Round pipe along axis-aligned points with joint balls and end flanges; points are offsets from at.',
    parameters: Object.freeze({ radius: number(0.05, 0.005, 0.5), flanges: count(1, 0, 1) }),
    list: 'points (2 to 16 [x,y,z], each step along one axis)',
  }),
  bolt: Object.freeze({
    summary: 'Hex bolt standing on its tip.',
    parameters: Object.freeze({
      length: number(0.12, 0.01, 1), diameter: number(0.03, 0.002, 0.2), headFlats: number(0.05, 0.004, 0.4), headHeight: number(0.02, 0.002, 0.2),
    }),
  }),
  gear: Object.freeze({
    summary: 'Spur gear lying flat with a bore.',
    parameters: Object.freeze({
      teeth: count(12, 6, 64), outerRadius: number(0.1, 0.01, 2), rootRadius: number(0.085, 0.005, 2), thickness: number(0.02, 0.002, 0.5), boreRadius: number(0.02, 0, 1),
    }),
  }),
  crate: Object.freeze({
    summary: 'Slatted wooden crate: body, four corner posts, lid.',
    parameters: Object.freeze({
      width: number(0.6, 0.1, 3), height: number(0.63, 0.1, 3), depth: number(0.6, 0.1, 3), post: number(0.05, 0.01, 0.3), lid: number(0.03, 0.005, 0.2),
    }),
  }),
});

export const AGENT_PART_TYPES = Object.freeze(Object.keys(AGENT_PART_CATALOG));

function describeParameters(entry) {
  const fields = Object.entries(entry.parameters).map(([name, spec]) => `${name} ${spec.default}`);
  return [...fields, ...(entry.list ? [entry.list] : [])].join(', ');
}

/** Plain-data listing for scene_capabilities: each part with its parameters, defaults and ranges. */
export const AGENT_PART_CAPABILITIES = Object.freeze({
  maxParts: MAX_PARTS,
  common: PART_COMMON_FIELDS,
  notes: 'Expands at scene_create or add-part into plain nodes; the exported recipe has no parts. Nodes relate to the first one, so set-node on it moves or resizes the part.',
  types: Object.freeze(Object.fromEntries(AGENT_PART_TYPES.map(name => [name, `${AGENT_PART_CATALOG[name].summary} ${describeParameters(AGENT_PART_CATALOG[name])}`]))),
});
