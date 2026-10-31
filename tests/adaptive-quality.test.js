import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveResolution, createAdaptiveResolution, createGpuTimer } from '../src/adaptive-quality.js';

function feed(adaptive, milliseconds, frames) {
  let scale = adaptive.scale;
  for (let frame = 0; frame < frames; frame++) scale = adaptive.update(milliseconds);
  return scale;
}

test('slow frames lower the scale one step per window and stop at the minimum', () => {
  const adaptive = new AdaptiveResolution({ targetMilliseconds: 16, minimumScale: 0.5, step: 0.25, window: 4 });
  assert.equal(feed(adaptive, 30, 4), 0.75);
  assert.equal(feed(adaptive, 30, 4), 0.5);
  assert.equal(feed(adaptive, 30, 40), 0.5);
});

test('the scale rises again only after a full window well under the target', () => {
  const adaptive = new AdaptiveResolution({ targetMilliseconds: 16, minimumScale: 0.5, step: 0.25, window: 4 });
  feed(adaptive, 30, 8);
  assert.equal(adaptive.scale, 0.5);
  assert.equal(feed(adaptive, 14, 4), 0.5, 'a frame near the target does not raise it');
  assert.equal(feed(adaptive, 4, 3), 0.5, 'a short run of fast frames does not raise it');
  assert.equal(feed(adaptive, 4, 1), 0.75);
  assert.equal(feed(adaptive, 4, 40), 1);
});

test('the same frame times always give the same scales', () => {
  const times = Array.from({ length: 80 }, (unused, index) => 8 + ((index * 7) % 23));
  const run = () => {
    const adaptive = new AdaptiveResolution({ window: 5 });
    return times.map(time => adaptive.update(time));
  };
  assert.deepEqual(run(), run());
});

test('bad frame times are ignored and bad settings are refused', () => {
  const adaptive = new AdaptiveResolution({ window: 1 });
  assert.equal(adaptive.update(Number.NaN), 1);
  assert.equal(adaptive.update(-1), 1);
  assert.throws(() => new AdaptiveResolution({ minimumScale: 0 }), RangeError);
  assert.throws(() => new AdaptiveResolution({ step: 1 }), RangeError);
  assert.throws(() => new AdaptiveResolution({ window: 0 }), RangeError);
});

test('an export can not have adaptive resolution', () => {
  assert.throws(() => createAdaptiveResolution({ exporting: true }), /never applies to an export/);
  assert.ok(createAdaptiveResolution({ exporting: false }) instanceof AdaptiveResolution);
});

test('the GPU timer reads finished queries in order and drops a disjoint result', () => {
  const finished = new Set();
  let disjoint = false;
  let nextQuery = 0;
  const context = {
    QUERY_RESULT: 'result', QUERY_RESULT_AVAILABLE: 'available',
    getExtension: () => ({ TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 }),
    getParameter: () => disjoint,
    createQuery: () => ({ id: nextQuery++ }),
    beginQuery() {}, endQuery() {}, deleteQuery() {},
    getQueryParameter: (query, name) => (name === 'available' ? finished.has(query.id) : (query.id + 1) * 2e6),
  };
  const timer = createGpuTimer(context);
  timer.begin();
  timer.end();
  assert.equal(timer.collect(), null, 'the query is not finished yet');
  finished.add(0);
  assert.equal(timer.collect(), 2);
  timer.begin();
  timer.end();
  finished.add(1);
  disjoint = true;
  assert.equal(timer.collect(), null);
  assert.equal(createGpuTimer({ getExtension: () => null }), null);
});
