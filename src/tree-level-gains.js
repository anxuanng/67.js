// Per species and level of detail: how much to scale the leaf colour (`color`) and the sky visibility (`sky`) of a lower level,
// so its pure-leaf luminance matches level 0 under sky light and a sun behind and in front of the tree (issue #432). The colour
// gain moves all three lights, the sky gain moves the sky share only, so two numbers per level fit three lights.
// Trees of one species differ: a level whose clumps carry more leaf area against level 0 than usual draws darker, so the colour
// gain of each tree also scales by exp(`areaExponent` * (its log area ratio - `area`)) (src/vegetation.js). The exponents
// follow the slope of the measured log ratio over the log area ratio on seeds 1 to 8.
// The gains come from seeds 1 to 6: run `node scripts/measure-tree-level-luminance.mjs --gpu --fit --seed N > fit-N.json`
// for each, then `node scripts/merge-tree-level-gains.mjs src/tree-level-gains.js fit-1.json ... fit-6.json`, then measure
// seeds 1 to 8 without --fit (`> measured-N.json`) and merge once more with `--measured measured-1.json ...` to recentre.
// It is data, so run them again after any change to the leaf cards, clumps or shading instead of editing it by hand.
export const TREE_LEVEL_GAINS = {
  palm: { areaExponent: 0.6, 2: { color: 2.449, sky: 3.373, area: 0.8953 }, 3: { color: 2.492, sky: 3.613, area: 1.7062 } },
  broadleaf: { areaExponent: 0.45, 2: { color: 1.832, sky: 1.644, area: 0.5478 }, 3: { color: 1.835, sky: 1.869, area: 1.3587 } },
  conifer: { areaExponent: 0.8, 2: { color: 1.121, sky: 10.132, area: 0.1494 }, 3: { color: 1.21, sky: 11.362, area: 0.9604 } },
  birch: { areaExponent: 0.7, 2: { color: 1.528, sky: 2.251, area: 0.7787 }, 3: { color: 1.615, sky: 2.49, area: 1.5896 } },
  bush: { areaExponent: 0.35, 2: { color: 1.472, sky: 0.978, area: -1.4443 }, 3: { color: 1.418, sky: 1.47, area: -0.6334 } },
};
