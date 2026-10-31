// The agent modeling tasks. Each prompt gives sizes in metres, so every check is objective. Checks run on the recipe
// the agent exports (see measure.mjs and check.mjs); none of them looks at how the object was built.

export const PROMPT_PREAMBLE = `You are modeling with the 67.js MCP tools. Build the object described below as a procedural recipe scene:
start it with scene_create, refine it with mesh_edit, mesh_stack and scene_apply, and look at it with scene_look when
that helps. Units are metres and Y is up. Rest the object on the ground (lowest point at Y = 0), centred on X = 0 and
Z = 0. Build it as closed, watertight solids. When the object is finished, call scene_export_recipe once: the exported
recipe is what gets graded.`;

const crateChecks = [
  { kind: 'lint' },
  { kind: 'size', expected: [0.6, 0.63, 0.6] },
  { kind: 'ground' },
  { kind: 'holes', equals: 0 },
  { kind: 'volume', min: 0.19, max: 0.212 },
  { kind: 'section', axis: 'x', at: 0.29, equals: 2, label: 'recessed panel on +X' },
  { kind: 'section', axis: 'z', at: -0.29, equals: 2, label: 'recessed panel on -Z' },
  { kind: 'section', axis: 'y', at: 0.615, equals: 1, label: 'raised lid' },
];

export const TASKS = [
  {
    id: 'crate',
    prompt: `A wooden crate. The body is a 0.6 m cube. Each of its four sides has a recessed panel: a frame about
0.04 m wide around a panel sunk about 0.02 m into the side. On top sits a raised lid, inset about 0.05 m from the top
edges and 0.03 m tall.`,
    checks: crateChecks,
  },
  {
    id: 'bolt',
    prompt: `A hex bolt standing upright with the shaft pointing down. The shaft is a cylinder 0.03 m in diameter and
0.12 m long, its tip on the ground. The head on top is a regular hexagonal prism 0.05 m across the flats and 0.02 m
tall.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [null, 0.14, null] },
      { kind: 'extent', axes: ['x', 'z'], min: 0.0495, max: 0.0585 },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 1.13e-4, max: 1.43e-4 },
      { kind: 'section', axis: 'y', at: 0.06, equals: 1, label: 'one shaft' },
    ],
  },
  {
    id: 'window',
    prompt: `A window frame standing upright in the XY plane: 1.0 m wide (X), 1.2 m tall (Y) and 0.08 m deep (Z). The
outer frame and the cross bars are all 0.06 m wide, dividing it into four open panes of equal size, two by two. No
glass: the panes are open.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [1.0, 1.2, 0.08] },
      { kind: 'ground' },
      {
        kind: 'through', axis: 'z', label: 'four open panes',
        open: [[-0.235, 0.315], [0.235, 0.315], [-0.235, 0.885], [0.235, 0.885]],
        solid: [[-0.47, 0.6], [0.47, 0.6], [0.013, 0.3], [0.013, 0.9], [-0.2, 0.6], [0.2, 0.6], [-0.2, 0.03], [0.2, 1.17]],
      },
      { kind: 'volume', min: 0.0256, max: 0.0326 },
    ],
  },
  {
    id: 'table',
    prompt: `A table. The top is 1.2 m long (X), 0.75 m deep (Z) and 0.04 m thick, with its upper surface 0.75 m above
the ground. Four square legs, 0.05 m on a side, run from the ground to the underside of the top; each leg's outer faces
sit 0.05 m in from the edges of the top.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [1.2, 0.75, 0.75] },
      { kind: 'ground' },
      { kind: 'section', axis: 'y', at: 0.02, equals: 4, label: 'four legs at the floor' },
      { kind: 'section', axis: 'y', at: 0.7, equals: 4, label: 'four legs under the top' },
      { kind: 'volume', min: 0.0388, max: 0.0474 },
    ],
  },
  {
    id: 'mug',
    prompt: `A mug made as one solid piece. The cup is a cylinder 0.08 m in diameter and 0.1 m tall, open at the top,
with 0.005 m thick walls and a 0.005 m thick bottom. A loop handle on the +X side joins the outer wall at two points,
leaving a gap for fingers, and reaches about 0.03 m out from the wall.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [null, 0.1, 0.08] },
      { kind: 'extent', axes: ['x'], min: 0.1, max: 0.13 },
      { kind: 'ground', centred: false },
      { kind: 'holes', equals: 1 },
      { kind: 'volume', min: 1.1e-4, max: 2.4e-4 },
    ],
  },
  {
    id: 'gear',
    prompt: `A spur gear lying flat on the ground: 12 teeth, outer (tip) radius 0.1 m, root radius 0.085 m, 0.02 m
thick, with a round centre bore of radius 0.02 m going all the way through.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [0.2, 0.02, 0.2] },
      { kind: 'ground' },
      { kind: 'holes', equals: 1 },
      { kind: 'tips', equals: 12 },
    ],
  },
  {
    id: 'fence',
    prompt: `A fence section. Five square posts, 0.08 m on a side and 1.0 m tall, stand in a row along X with their
centres 0.5 m apart. Two horizontal rails, 0.04 m tall and 0.06 m deep, run the full length from the outer face of the
first post to the outer face of the last, centred at heights 0.3 m and 0.8 m and centred on the posts in Z.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [2.08, 1.0, 0.08] },
      { kind: 'ground' },
      { kind: 'section', axis: 'y', at: 0.1, equals: 5, label: 'five posts' },
      { kind: 'section', axis: 'x', at: 0.25, equals: 2, label: 'two rails between posts' },
      { kind: 'volume', min: 0.037, max: 0.047 },
    ],
  },
  {
    id: 'bracket',
    prompt: `An L bracket. The base plate is 0.2 m long (X), 0.02 m thick (Y) and 0.1 m deep (Z), lying on the ground.
An upright plate 0.02 m thick (X) and 0.1 m deep stands on top of the base, flush with its -X end, and rises 0.15 m
above it, so the bracket is 0.17 m tall overall. Two round
holes, 0.02 m in diameter, go straight down through the base at X = 0 and X = 0.06 (centred in Z).`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [0.2, 0.17, 0.1] },
      { kind: 'ground' },
      { kind: 'holes', equals: 2 },
      { kind: 'volume', min: 6.2e-4, max: 7.6e-4 },
      { kind: 'section', axis: 'y', at: 0.01, equals: 3, label: 'base with two holes' },
    ],
  },
  {
    id: 'soap',
    prompt: `A bar of soap: 0.09 m long (X), 0.03 m tall (Y) and 0.06 m deep (Z), with every edge and corner smoothly
rounded to a radius of about 0.01 m.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.09, 0.03, 0.06] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 1.3e-4, max: 1.56e-4 },
      { kind: 'triangles', min: 200 },
    ],
  },
  {
    id: 'pebble',
    prompt: `A smooth river pebble: 0.08 m long (X), 0.03 m tall (Y) and 0.05 m deep (Z), one closed solid with no flat
faces and no sharp edges, resting on the ground.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.08, 0.03, 0.05] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 5.5e-5, max: 8e-5 },
      { kind: 'triangles', min: 200 },
    ],
  },
  {
    id: 'crate-uv',
    prompt: `A wooden crate that will get a tiled wood texture. The body is a 0.6 m cube. Each of its four sides has a
recessed panel: a frame about 0.04 m wide around a panel sunk about 0.02 m into the side. On top sits a raised lid,
inset about 0.05 m from the top edges and 0.03 m tall. Give every part UV coordinates with even texel density and no
stretching.`,
    checks: [...crateChecks, { kind: 'uv', maxStretch: 0.15 }],
  },
  {
    id: 'crate-wood',
    prompt: `A wooden crate that looks like real wood, not a flat colour. The body is a 0.6 m cube. Each of its four
sides has a recessed panel: a frame about 0.04 m wide around a panel sunk about 0.02 m into the side. On top sits a
raised lid, inset about 0.05 m from the top edges and 0.03 m tall.`,
    checks: [...crateChecks, { kind: 'pattern', types: ['wood', 'planks'] }],
  },
  {
    id: 'dice',
    prompt: `A six-sided die as one solid piece: a 0.1 m cube with every edge and corner rounded to a radius of about
0.01 m. The faces carry round recessed pips, each about 0.02 m across and at least 0.005 m deep, in the usual layouts
with a spacing of 0.025 m between neighbouring pips: 1 pip on +Y, 6 on -Y, 2 on +X, 5 on -X, 3 on +Z and 4 on -Z.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.1, 0.1, 0.1] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 8.5e-4, max: 9.8e-4 },
      { kind: 'section', axis: 'y', at: 0.097, equals: 2, label: '1 pip on +Y' },
      { kind: 'section', axis: 'y', at: 0.003, equals: 7, label: '6 pips on -Y' },
      { kind: 'section', axis: 'x', at: 0.047, equals: 3, label: '2 pips on +X' },
      { kind: 'section', axis: 'x', at: -0.047, equals: 6, label: '5 pips on -X' },
      { kind: 'section', axis: 'z', at: 0.047, equals: 4, label: '3 pips on +Z' },
      { kind: 'section', axis: 'z', at: -0.047, equals: 5, label: '4 pips on -Z' },
    ],
  },
  {
    id: 'flange',
    prompt: `A flanged pipe standing upright as one solid piece, 0.3 m tall overall. The pipe has an outer radius of
0.05 m and a bore of radius 0.04 m that goes all the way through. Each end has a round flange of radius 0.09 m and
thickness 0.02 m, flush with the pipe's end. Each flange has six round bolt holes of radius 0.008 m going through it,
evenly spaced on a circle of radius 0.07 m, the first one on the +X side.`,
    checks: [
      { kind: 'lint' },
      { kind: 'parts', max: 1 },
      { kind: 'size', expected: [0.18, 0.3, 0.18] },
      { kind: 'ground' },
      { kind: 'holes', equals: 13 },
      { kind: 'volume', min: 1.35e-3, max: 1.65e-3 },
      { kind: 'section', axis: 'y', at: 0.15, equals: 2, label: 'pipe wall' },
      { kind: 'section', axis: 'y', at: 0.01, equals: 8, label: 'lower flange with bore and six holes' },
      { kind: 'section', axis: 'y', at: 0.29, equals: 8, label: 'upper flange with bore and six holes' },
    ],
  },
  {
    id: 'chair',
    prompt: `A chair facing +Z. The seat is 0.45 m wide (X), 0.45 m deep (Z) and 0.03 m thick, with its upper surface
0.45 m above the ground. Four square legs, 0.04 m on a side, sit in the seat's corners with their outer faces flush
with its edges. The two front legs stop at the underside of the seat; the two rear legs continue up as posts to 0.9 m.
Three horizontal back slats, 0.06 m tall and 0.02 m thick, run between the posts, centred on them in Z, at centre
heights 0.6 m, 0.7 m and 0.8 m.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [0.45, 0.9, 0.45] },
      { kind: 'ground' },
      { kind: 'section', axis: 'y', at: 0.2, equals: 4, label: 'four legs' },
      { kind: 'section', axis: 'y', at: 0.52, equals: 2, label: 'two posts above the seat' },
      {
        kind: 'through', axis: 'z', label: 'three slats with gaps',
        open: [[0.003, 0.55], [0.003, 0.65], [0.003, 0.75], [0.003, 0.86]],
        solid: [[0.003, 0.6], [0.003, 0.7], [0.003, 0.8], [0.207, 0.86], [-0.207, 0.86]],
      },
      { kind: 'volume', min: 9.4e-3, max: 1.28e-2 },
    ],
  },
  {
    id: 'arm-reach',
    prompt: `A two-segment robot arm that reaches between two points. Use three nodes with these exact IDs, each with a
small visible geometry: shoulder at [0, 1, 0], elbow 0.5 m from the shoulder, and tip 0.4 m from the elbow. Make elbow a child of
shoulder and tip a child of elbow, so they stay connected. Add a 2 second motion in which the tip is exactly at
[0.4, 1.5, 0.3] at time 0 and exactly at [0.2, 1.2, -0.5] at time 2, with the segments keeping their lengths throughout.
For this task the object does not need to rest on the ground.`,
    checks: [
      { kind: 'nodeAt', node: 'tip', time: 0, position: [0.4, 1.5, 0.3] },
      { kind: 'nodeAt', node: 'tip', time: 2, position: [0.2, 1.2, -0.5] },
      { kind: 'nodeAt', node: 'shoulder', time: 1, position: [0, 1, 0] },
      { kind: 'nodeDistance', from: 'shoulder', to: 'elbow', time: 1, distance: 0.5 },
      { kind: 'nodeDistance', from: 'elbow', to: 'tip', time: 1, distance: 0.4 },
    ],
  },
  {
    id: 'tray-drop',
    prompt: `A pocketed block with three balls dropped into it, using recipe physics. The block is node "tray", a mesh of
2 m by 0.4 m by 2 m (X, Y, Z) standing on the ground, with a square pocket 1.2 m wide cut 0.3 m deep into the middle of
its top face. Three balls of radius 0.1 m are nodes "ball-1", "ball-2" and "ball-3", starting above the pocket at
[0, 1, 0], [0.25, 1.5, 0.1] and [-0.25, 2, -0.1]. Add a 3 second physics section: the tray is a fixed body with a
trimesh collider, so it follows the pocket, and the balls are dynamic ball bodies. The balls must end resting on the
pocket floor, not on the block's top. Check the result with scene_inspect.
For this task the balls do not need to rest on the ground at time 0.`,
    checks: [
      { kind: 'lint' },
      { kind: 'physicsBody', node: 'tray', type: 'fixed', shape: 'trimesh', label: 'tray is a fixed trimesh' },
      { kind: 'physicsRest', nodes: ['ball-1', 'ball-2', 'ball-3'], height: [0.17, 0.23], within: 0.5, touching: 'tray', label: 'balls rest on the pocket floor' },
      { kind: 'physicsSeek', label: 'seek back repeats the frame' },
    ],
  },
  {
    id: 'pillar-court',
    prompt: `A pillar court: a grid of 5 pillars along X by 3 along Z. Each pillar is a square column 0.1 m wide and
0.5 m tall. Pillars are 0.4 m apart along X and 0.5 m apart along Z, centre to centre, the whole grid centred on
X = 0 and Z = 0, every pillar standing on the ground. Repeat one pillar over the grid instead of modelling fifteen.`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [1.7, 0.5, 1.1] },
      { kind: 'ground' },
      { kind: 'holes', equals: 0 },
      { kind: 'volume', min: 0.0725, max: 0.0775 },
      { kind: 'section', axis: 'y', at: 0.25, equals: 15, label: 'fifteen pillars' },
      { kind: 'section', axis: 'x', at: 0.4, equals: 3, label: 'three pillars along Z in the column at X = 0.4' },
    ],
  },
  {
    id: 'rigged-walker',
    prompt: `A blocky humanoid character 1.8 m tall, facing +Z, built from rounded blocks: a torso 0.34 m wide, 0.5 m tall and
0.2 m deep (centre at 1.15 m), a head, and for each side an upper arm, lower arm and hand (the arms hang at the sides)
and an upper leg, lower leg and foot, the feet flat on the ground. Give it a humanoid armature fitted to its height, bind
every block to it with automatic weights, and give it a looping 1 second walk: legs and arms swing in opposite phase,
knees bend forward and elbows bend back, and nothing stretches or collapses. Name the bones in the canonical humanoid
way (hips, spine, head, leftUpperArm, leftLowerLeg, rightFoot and so on).`,
    checks: [
      { kind: 'lint' },
      { kind: 'size', expected: [null, 1.8, null] },
      { kind: 'ground', centred: false },
      { kind: 'rigBones' },
      { kind: 'rigSkinned' },
      { kind: 'rigWalk', footTravel: 0.3, label: 'walk cycle' },
    ],
  },
  {
    id: 'robot-reach',
    assets: true,
    prompt: `The asset catalog holds an imported robot character. Create a scene from it with its Idle clip selected at
time 0. Add a 2 second motion in which the robot's right hand reaches for a moving point: the palm joint (labelled
Palm2.R) is at world position [-1.3, 2.6, 0.8] at time 0 and [-1, 1.7, 1.1] at time 2, while the rest of the body stays on the clip.
Find the joints you need by inspecting the scene. When it is finished, call scene_export_recipe once: the exported
recipe is what gets graded.`,
    ownPreamble: true,
    checks: [
      { kind: 'assetClip', name: 'Idle' },
      { kind: 'assetReach', endLabel: 'Palm2.R', from: [-1.3, 2.6, 0.8], to: [-1, 1.7, 1.1] },
    ],
  },
];

export function taskById(id) {
  const task = TASKS.find(candidate => candidate.id === id);
  if (!task) throw new RangeError(`Unknown task ${id}. Tasks: ${TASKS.map(candidate => candidate.id).join(', ')}.`);
  return task;
}
