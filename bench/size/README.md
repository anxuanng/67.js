# Bundle size budgets

`npm run size` bundles each package entry with esbuild, minified and tree-shaken, and compares its gzip size with a budget. The `Test` workflow runs it on every pull request.

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

## When a check fails

The output names the bundle, its size and its budget.

1. Find out why the bundle grew. A new import of a large module is the usual cause.
2. If the growth is a mistake, remove it.
3. If the growth is worth its cost, raise the number in `bench/size/budgets.json`.
4. State the reason in the pull request. The budget change is then visible in the diff.

## After a change lands

Run `node scripts/measure-size.mjs --update-baseline` to record the new sizes, so the next pull request shows its own change. The budget does not move.

Use `--set-budgets` to reset every budget to 2% over the current size. Use it after work that makes bundles smaller, so that the saving stays. A reset also hides any growth since the last reset, so check the diff.

## Package archive

`archiveBytes` in `budgets.json` caps the npm archive that `npm pack` makes. `npm run smoke:package` checks it, after `npm run prepare:release`. The archive was 904,975 bytes before the MCP preview shared the package's engine chunks and 666,214 after; features then grew it to 802,581, and one-line notices in each built file plus a stub for the SDK's unused Ajv shim brought it to 695,041. The budget is now 740,000 bytes (measured 2026-11-02 against `budgets.json`: lower it when the archive shrinks). Lower `archiveBytes` when work shrinks it.

Moving code into installed dependencies would shrink the archive further but adds install size to every consumer, including library users who never run MCP. Making `@modelcontextprotocol/server` and `zod` dependencies saved about 125 KB of archive for about 14.5 MB on disk, so it was not kept.

## Limits

The check reads gzip size only. It does not measure parse time, memory or runtime speed.

The check reports a status. It can not block a merge by itself, because this private repository has no branch protection. `CONTRIBUTING.md` gives the merge rule.
