import { walkerRecipe } from '../../bench/agent-modeling/walker.mjs';

export const WALK_SECONDS = 5;
const CYCLE_SECONDS = 1;
export const CAPE_THICKNESS = 0.01;

// The reference walker, walking forward for five seconds: its one second cycle repeated and the whole rig moved on.
export function walkingCapeRecipe(cloth) {
  const recipe = walkerRecipe();
  const cycles = WALK_SECONDS / CYCLE_SECONDS;
  const repeated = keyframes => Array.from({ length: cycles }, (_, cycle) => keyframes.map(keyframe => ({ ...keyframe, time: keyframe.time + cycle * CYCLE_SECONDS })))
    .flat()
    .filter((keyframe, index, all) => index === 0 || keyframe.time > all[index - 1].time);
  const tracks = recipe.motion.tracks.map(track => ({ ...track, keyframes: repeated(track.keyframes) }));
  tracks.push({ kind: 'node', id: 'rig', property: 'translation', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: WALK_SECONDS, value: [0, 0, 5] }] });
  recipe.motion = { duration: WALK_SECONDS, loop: false, tracks };
  recipe.geometries.push({ id: 'cape-sheet', type: 'grid', segments: 24 });
  recipe.materials.push({ id: 'cape-cloth', color: [0.7, 0.1, 0.1], doubleSided: true });
  recipe.nodes.push({ id: 'cape', geometry: 'cape-sheet', material: 'cape-cloth', translation: [0, 1.05, -0.16], scale: [0.5, 0.7, 1] });
  recipe.cloth = cloth;
  return recipe;
}

export const CAPE = {
  duration: WALK_SECONDS,
  sheets: [{ node: 'cape', pin: ['top'], pinTo: { node: 'chest' }, thickness: CAPE_THICKNESS }],
  colliders: [{ armature: 'rig' }],
};
