# Bundle size budgets

`npm run size` bundles each package entry with esbuild, minified and tree-shaken, and compares its gzip size with the same bundle on the base branch. The `Test` workflow runs it on every pull request. A pull request never edits a size number, so two pull requests do not conflict over one.

## What it measures

- **`entry:<name>`:** everything that one package entry exports. This is the most that an app can pay for the entry.
- **`scene:<name>`:** a small app that uses only what it needs. `lit-box`, `gltf-box` and `agent-scene` are the numbers that the goal in issue 23 uses.
- **three.js:** the same `lit-box` and `gltf-box` scenes, at the version in `package.json`. They have no budget, because this project does not control them.

`manifold-3d` and `@dimforge/rapier3d-compat` are optional peers that load separately, so no bundle counts them.

## Baseline

Measured on 2026-10-31 with three.js 0.186.1. Sizes are bytes gzip.

| Scene | 67js | three.js | Goal |
| --- | --- | --- | --- |
| `lit-box` | 48,762 | 133,652 | 50,000 |
| `gltf-box` | 159,422 | 155,814 | 80,000 |
| `agent-scene` | 185,592 | no equivalent | 100,000 |

`bench/size/baseline.json` holds every size. The goals are proposals from issue 23.

## How the check decides

The check measures the base branch with the same script, then compares each bundle. In CI the base is the branch that the pull request targets. On your machine it is `origin/main`, from the commit where your branch left it. The base numbers are cached by base commit in `node_modules/.cache/size-base`, and CI caches that folder, so a run on an unchanged base skips the second measurement. The base is measured beside your own bundles, so a cold run costs little more than one measurement.

A bundle fails when it grows by more than its allowance:

- `entry:core` and every `scene:*` bundle, with their `+lazy` rows: 64 bytes gzip.
- Every other entry: 2% of its size on the base, and at least 64 bytes.

A bundle that the base does not have is reported and never fails. A bundle that shrinks never fails.

The table in the output shows each bundle, the base size, the growth and the allowance. The release budgets in `budgets.json` and the goals are printed as a report. They do not fail a pull request.

## When a check fails

The output names the bundle, how much it grew and its allowance.

1. Find out why the bundle grew. A new import of a large module is the usual cause.
2. If the growth is a mistake, remove it.
3. If the growth is worth its cost, accept it. Add `changes/<issue>.size.md` to your pull request, with one line for each bundle that you accept:

```md
- entry:core: the lighting pass costs 180 bytes and replaces two shaders
- archive: the new guide ships in the package
```

4. State the same reason in the pull request.

A line needs a bundle name, a colon, a space and a reason. A bundle with no line still fails. The check reads only the size notes that your branch adds, so a note from another pull request never accepts your growth. Your note is a new file, so it conflicts with nobody. Use `archive` for the package archive.

## At release

Release steps in `CONTRIBUTING.md` run `npm run changes:fold`, which deletes the size notes. Then run `npm run size:release`. It resets every budget to 2% over the current size and rewrites `baseline.json`. Run `npm run size -- --absolute` before it to see which bundles are past their release budget. Check the diff of `budgets.json`, because a reset hides growth since the last reset. Also review the sizes of the accepted bundles, since each accepted increase is small alone and they add up.

## Package archive

`archiveBytes` in `budgets.json` caps the npm archive that `npm pack` makes. `npm run smoke:package` checks it, after `npm run prepare:release`. The archive has a ceiling and not a base measurement, because measuring the base archive needs a full build. A pull request that pushes the archive over the ceiling accepts it with an `archive` line in its size note. Only a release edits `archiveBytes`. The archive was 904,975 bytes before the MCP preview shared the package's engine chunks and 666,214 after; features then grew it to 802,581, and one-line notices in each built file plus a stub for the SDK's unused Ajv shim brought it to 695,041. The budget is now 740,000 bytes (measured 2026-11-02 against `budgets.json`: lower it when the archive shrinks). Lower `archiveBytes` when work shrinks it.

Moving code into installed dependencies would shrink the archive further but adds install size to every consumer, including library users who never run MCP. Making `@modelcontextprotocol/server` and `zod` dependencies saved about 125 KB of archive for about 14.5 MB on disk, so it was not kept.

### How the archive budget is set

The budget is a hand-set ceiling, not a measurement. Two rules decide it.

- **It protects install size.** The archive is what every consumer downloads, including library users who never run MCP. The ceiling stops slow growth that no single pull request notices.
- **It keeps 20 KB of headroom.** The next feature of normal size must fit without a budget change. When the archive is within 20 KB of the budget, remove something before raising the number. Raising it needs a reason in the pull request.

Measured 2026-11-02 with `npm pack --ignore-scripts --json`, gzipping each packed file alone. The archive was 740,972 bytes before the change below. The parts sum to more than that, because the archive compresses across files.

| Part | Bytes gzip |
| --- | --- |
| `build/` without `build/mcp/` | 458,778 |
| `build/mcp/` (`server.mjs` alone is 126,804) | 145,808 |
| `docs/` | 122,481 |
| `CHANGELOG.md` | 36,111 |
| `skills/` | 25,078 |
| the rest (README, notices, roadmap, `bin/`, `package.json`, license) | 13,967 |

What may leave without a loss for users is text that GitHub serves at a stable address: the changelog and the docs that only the site needs. A shipped doc then links the GitHub copy with an absolute URL, because a relative link to a file the package does not hold is dead inside `node_modules`. `npm run check:links:package` packs the archive, unpacks it and checks every link, and the `Test` workflow runs it.

`CHANGELOG.md` left the archive on 2026-11-02 for that reason. The archive is now 705,961 bytes, 34,039 under the budget. The 20 docs that `docs/guide.md` links but the package does not ship would add 64,477 bytes, so they stay on GitHub. Source maps are not packed, and the packed files hold no test fixtures or data.

## Limits

The check reads gzip size only. It does not measure parse time, memory or runtime speed.

The check reports a status. It can not block a merge by itself, because this private repository has no branch protection. `CONTRIBUTING.md` gives the merge rule.
