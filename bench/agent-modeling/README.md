# Agent modeling suite

The suite measures how well an agent models through the 67js MCP tools. It records how often the agent succeeds and
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
| pebble | A smooth solid from a box (subdivision) |
| crate-uv | The crate with even UVs |
| desk-resize, desk-resize-plain | A 12-part desk (legs, drawers with handles, lamp, book) resized in three inspected steps, graded on contact for every attached pair and on where parts end up. Relations against absolute positions |
| kettle-resize, kettle-resize-plain | Resize a kettle body so the lid, handle and spout stay against it. The first start recipe holds `relations`, the second absolute positions; the difference in tool calls is what relations are worth |
| crate-wood | The crate with a wood material pattern, to see whether agents find `pattern` |
| arm-reach | A jointed arm whose tip moves between two points, to see whether agents find `motion.ik` |
| leg-plant | A leg that plants its foot on two points with the knee bending forward: `motion.ik` with `bendToward`, `pole` and `limits` |
| tray-drop | Recipe physics: balls dropped into a pocket cut in an authored mesh, on a fixed trimesh body, graded on resting height, contact and a repeatable seek |
| robot-reach | The CC0 robot from `tests/fixtures`: IK over its Idle clip, found through the asset catalog and hierarchy |
| dice | Rounded edges plus 21 recessed pips, in one piece (harder) |
| flange | A hollow pipe with flanges and 12 bolt holes, in one piece (harder) |
| chair | Many exact parts, with open gaps between back slats (harder) |
| chamfer-plate | Long: a plate with a chamfered top rim and six blind pockets, in one piece (chamfer edit, six cuts) |
| slotted-rail | Long: a bar with every edge chamfered and five through slots, in one piece |
| crate-revision | Long: starts from the crate recipe in the prompt; raise the lid, then drill a blind hole into the body |
| bracket-revision | Long: starts from the L bracket recipe in the prompt; lengthen the base, recentre it, move to three holes |
| workshop | Long: a whole scene, a floor slab with a table, a chair and a mug, 12 parts that rest on each other |
| robot-shot | Long: the robot with both hands placed by IK, then a side-on camera, checked from the exported recipe |

`references.mjs` holds one hand-built solution per task. `tests/agent-modeling-suite.test.js` checks that every
reference passes and that broken variants fail. That keeps a wrong checker from costing an agent run.

## Running

```sh
node bench/agent-modeling/run.mjs --claude <path to claude> --model sonnet --label baseline
```

Each task gets a fresh non-interactive Claude Code session in an empty temporary folder. The session has only the
67js MCP server, its built-in file and shell tools are disabled, and it runs under a per-task budget (`--budget`, in
USD, default 3) and timeout (`--timeout`, in seconds, default 1200). Pick tasks with `--tasks crate,bolt`. Raw
transcripts and exported recipes go to `artifacts/agent-modeling/<run>/`. The summary, with the model ID reported by
the session, goes to `results/<run>.json`. Grade one recipe by hand with
`node bench/agent-modeling/check.mjs <task> <recipe.json>`.

`node bench/agent-modeling/regrade.mjs <run>` grades a run's saved recipes again after a checker fix.

Compare runs only when they use the same model and suite version. A single run per task is noisy, so read differences
of one or two tasks as noise.

### Several runs and several models

`--runs 3` repeats every task three times, each in a fresh session. Raw files are named `<task>-<attempt>`, each record
has an `attempt`, and the summary adds `byModel`: runs, passes, success rate, tool calls, tool errors, input and output
tokens and cost for the model and for each of its tasks. `--resume <run name> --runs 3` skips the attempts already
recorded and continues. One run file holds one model, so a second model is a second run:

```sh
node bench/agent-modeling/run.mjs --claude <path to claude> --model sonnet --runs 3 --label long
node bench/agent-modeling/run.mjs --claude <path to claude> --model haiku --runs 3 --label long
node bench/agent-modeling/aggregate.mjs bench/agent-modeling/results/<sonnet run>.json bench/agent-modeling/results/<haiku run>.json
```

`aggregate.mjs` prints one row per model and one per task. Recorded failure details have local paths replaced by
`<local path>`, and `tests/agent-suite-aggregate.test.js` fails if a results file holds one.

The six long tasks (from `chamfer-plate` on) are meant to be hard for a single `scene_create`: they need sub-element
edits (chamfers, cuts), changes to a given scene, many parts or a posed character with a camera. Their references pass
and each plausible wrong variant fails the right check (`tests/agent-modeling-suite.test.js`), but no model has run
them yet, so how hard they are is not measured.

## Look score

The checks read the exported recipe, so a task can pass and still look wrong. The look score measures what a person
sees. It is reported in each record under `look`, beside the checks, and is never merged with them into one number.

- **Cameras.** Three fixed orthographic cameras (front, side, three-quarter), placed from the task's reference recipe in
  `references.mjs` (`look-cameras.mjs`). The reference sets the framing, so a candidate that is too big, too small or
  off centre shows it in every view. Motion is sampled at time zero.
- **Silhouette score.** The candidate and the reference are rasterized from each camera (`silhouette.mjs`, plain
  JavaScript, no GPU, 256 by 256 pixels). Each view scores intersection over union; a task scores the mean in
  `look.silhouette`. 1 is the reference's own outline. `robot-reach` has no silhouette, because an imported asset needs
  its skin pose; its record says `skipped`.
- **Images.** The same cameras drawn by the engine in headless Chrome on SwiftShader, 512 by 512, saved to
  `artifacts/agent-modeling/<run>/look/` and listed in `look.images`. `run.mjs` and `regrade.mjs` write them. Reference
  images come from `node bench/agent-modeling/look.mjs --references`.
- **Vision judge.** `rubric.md` scores shape, proportions, features and surface from 0 to 3. Nothing here calls a model.
  `node bench/agent-modeling/judge.mjs prompt <run> <task>` prints the rubric, the task prompt and the candidate and
  reference image paths for each camera; give those to a vision model with no other context. Store its answer with
  `judge.mjs record <run> <task> --model <name> --scores 3,2,3,1 --note "..."`. It lands in `look.judges.<name>`, so
  scores from different judges stay apart. Judge scores are not comparable across judge models.

Score one recipe with `node bench/agent-modeling/look.mjs <task> <recipe.json> [--images <directory>]`.
`tests/agent-look-score.test.js` checks that a widened or incomplete table scores below the correct one, on silhouette
masks alone.

The results before 2026-10-31 hold no recipes (`artifacts/` is ignored by Git and was not kept), so they have no look
score and cannot be regraded. The next run records one.

## Baseline

`results/2026-10-30-07-48-sonnet-baseline.json`: `claude-sonnet-5-5`, one run per task, without the `build-67js-scene` skill, 67js 0.11.0.
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

## Default look on a cold run (2026-11-01, issue #53)

`results/2026-11-01-01-25-haiku-look-before.json` and `results/2026-11-01-01-36-haiku-look-after.json`: Haiku, six tasks, one run each, no skill, judged by a Sonnet vision judge (`sonnet-vision`, 0 to 12, against references drawn under the same defaults). The only engine change between them is the default `effects.exposure`, 1 to 0.8. The look harness was also fixed first: it drew without the setup's environment map, so its images were darker than the MCP preview. Both runs were drawn with the fix.

| Task | Judge before | Judge after | Silhouette before | Silhouette after |
| --- | --- | --- | --- | --- |
| crate | 12 | 10 | 1 | 1 |
| mug | 10 | 11 | 0.7927 | 0.934 |
| table | 11 | 10 | 0.5919 | 0.5784 |
| soap | 12 | 12 | 1 | 1 |
| chair | 12 | 12 | 1 | 1 |
| gear | 9 | 11 | 0.9475 | 0.9724 |
| Total | 66 | 66 | | |

- **No lift shown.** The totals tie, and each task moved by one or two points either way, which is judge and agent noise at one run. The done condition of #53 (a cold recipe scoring above the current default) is not met by this measure.
- **The judge cannot see a default change.** It scores shape and features against a reference drawn under the same defaults, and agents never set lights, environment, effects, shadow or bake (their tool calls set only a camera, in 4 of 6 runs, and `roughness` in one), so both sides always share the look. A look score that separates lighting needs a fixed reference drawn under the old default, or a judge question about shading.
- **What a reader sees.** The images show an object floating on a flat grey backdrop with no contact shadow, and a pale top face at exposure 1. A default ground with a contact shadow is the larger fix and was not built: a floor in every recipe would change recipes that draw their own.
- Cost: $0.75 and $0.83 for the agent runs, $0.21, $0.99 and $1.19 for the judge.

## Clip layers (2026-10-31)

`robot-walk-wave` asks for a character that walks and waves at once through `motion.layers`. The check `assetWalkAndWave` reloads the exported recipe, plays each layer alone (keeping its own speed, offset and loop) and compares part matrices at two times: the legs must match Walking and move, the right arm must leave Walking, the left arm must keep walking. Cold Sonnet, no skill, `results/2026-10-31-11-40-sonnet-walk-wave-cold-fixed-grader.json`: 1 of 1, 7 tool calls (2 errors), $0.31. A first run, with a check that compared against Walking at speed 1 only, failed on a recipe the agent had correct (it set per-layer speeds); the check was fixed and that recipe grades as a pass. One run is not a rate.
