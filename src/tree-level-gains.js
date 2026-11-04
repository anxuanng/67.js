// Per species and level of detail: how much to scale the leaf colour (`color`) and the sky visibility (`sky`) of a lower level,
// so its pure-leaf luminance matches level 0 under sky light and a sun behind and in front of the tree (issue #432). The colour
// gain moves all three lights, the sky gain moves the sky share only, so two numbers per level fit three lights.
// One tree fits its own seed, so the numbers here are the geometric mean over seeds 1 to 6: run
// `node scripts/measure-tree-level-luminance.mjs --fit --seed N > fit-N.json` for each (it draws each level against level 0 and
// solves for the gains) and then `node scripts/merge-tree-level-gains.mjs src/tree-level-gains.js 99 99 fit-1.json ... fit-6.json`.
// It is data, so run them again after any change to the leaf cards, clumps or shading instead of editing it by hand.
export const TREE_LEVEL_GAINS = {
  palm: { 1: { color: 1.176, sky: 1.184 }, 2: { color: 2.071, sky: 4 }, 3: { color: 2.182, sky: 4 } },
  broadleaf: { 1: { color: 0.982, sky: 1.378 }, 2: { color: 1.622, sky: 1.901 }, 3: { color: 1.62, sky: 2.283 } },
  conifer: { 1: { color: 0.809, sky: 1.033 }, 2: { color: 2.33, sky: 4 }, 3: { color: 2.496, sky: 4 } },
  birch: { 1: { color: 0.958, sky: 1.228 }, 2: { color: 1.637, sky: 2.2 }, 3: { color: 1.684, sky: 2.511 } },
  bush: { 1: { color: 0.977, sky: 1.301 }, 2: { color: 1.344, sky: 0.448 }, 3: { color: 1.345, sky: 0.956 } },
};
