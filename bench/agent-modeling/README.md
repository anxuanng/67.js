# Agent modeling suite

The suite measures how well an agent models through the 67.js MCP tools. It records how often the agent succeeds and
what each success costs in tool calls, tokens and time. It is the yardstick from the modeling plan: a mesh feature
earns its place only if it raises these numbers.

## Tasks

Each task in `tasks.mjs` is a prompt with sizes in metres plus machine checks. The checks look only at the object the
exported recipe builds, never at how it was built, so a recipe made of primitives and one made with mesh edits are
graded alike. `measure.mjs` measures every node's render triangles in world space and reads lint from the engine's
own mesh report:

- bounds, plus whether the object rests on the ground and is centred;
- connected parts, and lint (closed and consistently wound);
- through holes (genus, from the Euler characteristic of closed parts);
- volume;
- lines through the object: whether a line along an axis misses it (an open pane) or hits it (a bar);
- closed loops where a plane cuts the object. For example, five loops at Y = 0.1 means five posts, and two loops just
  inside a side face means a recessed panel;
- outer tips around the thin axis, such as gear teeth;
- UV texel-density stretch.

| Task | What it exercises |
| --- | --- |
| crate | Insets and extrusions (recessed panels, raised lid) |
| bolt | Primitives or extrude, exact proportions |
| window | Four through holes |
| table | Several parts that stand on the ground |
| mug | A hollow, one-piece object with a handle loop (booleans or solidify) |
| gear | A profile with 12 teeth and a bore |
| fence | Repetition (array) and rails between posts |
| bracket | Two plates and two holes |
| soap | Rounding every edge (bevel) |
| crate-uv | The crate with even UVs |
| crate-wood | The crate with a wood material pattern, to see whether agents find `pattern` |
| arm-reach | A jointed arm whose tip moves between two points, to see whether agents find `motion.ik` |
| robot-reach | The CC0 robot from `tests/fixtures`: IK over its Idle clip, found through the asset catalog and hierarchy |
| dice | Rounded edges plus 21 recessed pips, in one piece (harder) |
| flange | A hollow pipe with flanges and 12 bolt holes, in one piece (harder) |
| chair | Many exact parts, with open gaps between back slats (harder) |

`references.mjs` holds one hand-built solution per task. `tests/agent-modeling-suite.test.js` checks that every
reference passes and that broken variants fail. That keeps a wrong checker from costing an agent run.

## Running

```sh
node bench/agent-modeling/run.mjs --claude <path to claude> --model sonnet --label baseline
```

Each task gets a fresh non-interactive Claude Code session in an empty temporary folder. The session has only the
67.js MCP server, its built-in file and shell tools are disabled, and it runs under a per-task budget (`--budget`, in
USD, default 3) and timeout (`--timeout`, in seconds, default 1200). Pick tasks with `--tasks crate,bolt`. Raw
transcripts and exported recipes go to `artifacts/agent-modeling/<run>/`. The summary, with the model ID reported by
the session, goes to `results/<run>.json`. Grade one recipe by hand with
`node bench/agent-modeling/check.mjs <task> <recipe.json>`.

`node bench/agent-modeling/regrade.mjs <run>` grades a run's saved recipes again after a checker fix.

Compare runs only when they use the same model and suite version. A single run per task is noisy, so read differences
of one or two tasks as noise.

## Baseline

`results/2026-10-30-07-48-sonnet-baseline.json`: `claude-sonnet-5-5`, one run per task, without the `build-67js-scene` skill, 67.js 0.11.0.
10 of 10 passed with 67 tool calls and $4.76 in total. The `bracket` record comes from a rerun after its prompt was
made unambiguous about the total height; the others were graded again after three checker fixes, without new agent runs.

Read this as a cost baseline, not a success rate:

- **The pass rate is at its ceiling.** Sonnet passes every task at this difficulty, so these tasks can only show changes in
  tool calls and cost. The suite needs harder tasks before it can show that a feature helps an agent succeed.
- **Agents rarely use the edit tools.** Only 2 of 10 runs called `mesh_edit`. Most recipes use placed primitives, and
  the mesh edits they do use are written directly into `scene_create`. No run used `loop_cut`, `mirror` or `array`.

Friction seen in the transcripts, all fixed after this baseline:

- `extrude` with holes whose edges line up left T-junctions in its caps, so the mesh was open. The window run hit it
  and fell back to separate bars.
- `mesh_inspect` took only `geometries`, while `mesh_edit` takes `geometry`. Four runs sent `geometry` and got a
  validation error.
- The default box has a bevel, which surprised the fence, table and soap runs. They first got rounded shapes or wrong
  sizes. The default stays, and the tool schema now says so.

## After the three fixes

`results/2026-10-30-08-14-sonnet-after-fixes.json` reruns the five affected tasks, one run each, with the same model:

| Task | Tool calls | Tool errors | Cost (USD) |
| --- | --- | --- | --- |
| window | 10 → 4 | 1 → 0 | 0.52 → 0.43 |
| gear | 7 → 5 | 2 → 1 | 0.53 → 0.49 |
| soap | 11 → 4 | 2 → 0 | 0.55 → 0.43 |
| fence | 7 → 2 | 1 → 0 | 0.49 → 0.40 |
| table | 4 → 2 | 1 → 0 | 0.41 → 0.40 |
| Total | 39 → 17 | 7 → 1 | 2.40 → 2.15 |

All five passed both times. The window run now builds the frame with one `extrude`, the route it gave up on before. The
one remaining error is the gear run trying the disabled Bash tool. With one run per task this shows a direction, not an
exact size.

## With the skill, and harder tasks

`results/2026-10-30-11-32-sonnet-with-skill.json` runs all 13 tasks with `--skill`. The no-skill side is
`results/2026-10-30-11-43-sonnet-hard-no-skill.json` for the three harder tasks, the after-fixes run for its five tasks,
and the baseline for the other five. Same model, one run per task.

| Tasks | Passed | Tool calls | Tool errors | Cost (USD) |
| --- | --- | --- | --- | --- |
| First 10, no skill | 10/10 | 45 | 2 | 4.40 |
| First 10, with skill | 10/10 | 39 | 4 | 4.44 |
| dice, flange, chair, no skill | 3/3 | 12 | 1 | 1.40 |
| dice, flange, chair, with skill | 3/3 | 8 | 0 | 1.43 |

What this does and does not show:

- **The harder tasks did not lift the ceiling.** Sonnet passes all 13 either way, including a die with 21 recesses and a
  pipe with 12 bolt holes. A part with exact sizes is solved in a few calls, often one `scene_create`. Success on such
  tasks cannot separate one tool set from another.
- **The skill made no clear difference to cost.** The gap in calls is small enough to be noise at one run per task, and the
  cost is flat. It can change the method: with it, the crate run used insets and extrusions instead of booleans.
- **Most of the edit vocabulary went unused either way.** `mesh_edit` appeared in one of 13 runs with the skill, and
  `mesh_stack`, `loop_cut`, `mirror`, `array` and `solidify` in none. Agents write the whole recipe at once. This is about
  these tasks, which do not need those operations; it does not show the operations are useless.

The suite now finds tool friction and tracks cost, but does not measure how good an object looks. Tasks with free form,
such as organic shapes or a look to match, would need a score for appearance before they could test more.
