// Per species and level of detail: how much to scale the leaf colour (`color`) and the sky visibility (`sky`) of a lower level,
// so its pure-leaf luminance matches level 0 under sky light and a sun behind and in front of the tree (issue #432). The colour
// gain moves all three lights, the sky gain moves the sky share only, so two numbers per level fit three lights.
// Written by `node scripts/measure-tree-level-luminance.mjs --fit`, which draws each level against level 0 and solves for them;
// it is data, so run the script again after any change to the leaf cards, clumps or shading instead of editing it by hand.
export const TREE_LEVEL_GAINS = {
  palm: { 1: { color: 1.128, sky: 1.156 }, 2: { color: 1.845, sky: 4 }, 3: { color: 1.984, sky: 4 } },
  broadleaf: { 1: { color: 0.942, sky: 1.529 }, 2: { color: 1.654, sky: 1.829 }, 3: { color: 1.61, sky: 2.31 } },
  conifer: { 1: { color: 0.86, sky: 1.061 }, 2: { color: 2.798, sky: 4 }, 3: { color: 2.943, sky: 4 } },
  birch: { 1: { color: 0.972, sky: 1.293 }, 2: { color: 1.629, sky: 2.473 }, 3: { color: 1.588, sky: 3.014 } },
  bush: { 1: { color: 0.961, sky: 1.264 }, 2: { color: 1.315, sky: 0.55 }, 3: { color: 1.343, sky: 1.067 } },
};
