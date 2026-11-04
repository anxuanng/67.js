// Per species and level of detail: how much to scale the leaf colour (`color`) and the sky visibility (`sky`) of a lower level,
// so its pure-leaf luminance matches level 0 under sky light and a sun behind and in front of the tree (issue #432). The colour
// gain moves all three lights, the sky gain moves the sky share only, so two numbers per level fit three lights.
// One tree fits its own seed, so the numbers here are the geometric mean over seeds 1 to 6: run
// `node scripts/measure-tree-level-luminance.mjs --fit --seed N > fit-N.json` for each (it draws each level against level 0 and
// solves for the gains) and then `node scripts/merge-tree-level-gains.mjs src/tree-level-gains.js 1.6 2 fit-1.json ... fit-6.json`.
// It is data, so run them again after any change to the leaf cards, clumps or shading instead of editing it by hand.
export const TREE_LEVEL_GAINS = {
  palm: { 1: { color: 1.176, sky: 1.184 }, 2: { color: 1.6, sky: 2 }, 3: { color: 1.6, sky: 2 } },
  broadleaf: { 1: { color: 0.982, sky: 1.378 }, 2: { color: 1.6, sky: 1.901 }, 3: { color: 1.6, sky: 2 } },
  conifer: { 1: { color: 0.809, sky: 1.033 }, 2: { color: 1.6, sky: 2 }, 3: { color: 1.6, sky: 2 } },
  birch: { 1: { color: 0.958, sky: 1.228 }, 2: { color: 1.6, sky: 2 }, 3: { color: 1.6, sky: 2 } },
  bush: { 1: { color: 0.977, sky: 1.301 }, 2: { color: 1.344, sky: 0.448 }, 3: { color: 1.345, sky: 0.956 } },
};
