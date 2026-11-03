// Time of the CPU sort alone, in Node, for a camera that moves a little every frame: node bench/gaussian-splats/sort-time.mjs
// It reports the median and the range of 40 sorts for each splat count. The browser frame time in run.mjs includes this sort.
import { mat4 } from 'gl-matrix';
import { createSplatSorter } from '../../src/gaussian-splat-sort.js';
import { syntheticRoom } from './scene-data.js';

const SORTS = 40;

function sortTimes(count) {
  const data = syntheticRoom(count);
  const sorter = createSplatSorter(data.positions, count, data.bounds);
  const view = mat4.create();
  const times = [];
  for (let index = 0; index < SORTS; index++) {
    const angle = index * 0.04;
    mat4.lookAt(view, [Math.sin(angle) * 3, 1.7, Math.cos(angle) * 3], [0, 1.5, 0], [0, 1, 0]);
    const start = performance.now();
    const { changed } = sorter.sort(view);
    times.push(performance.now() - start);
    if (!changed) throw new Error('the sort did not run');
  }
  return times.sort((first, second) => first - second);
}

for (const count of [100_000, 1_000_000]) {
  const times = sortTimes(count);
  const format = value => value.toFixed(1);
  console.log(`${count} splats: median ${format(times[SORTS / 2])} ms, range ${format(times[0])} to ${format(times[SORTS - 1])} ms`);
}
