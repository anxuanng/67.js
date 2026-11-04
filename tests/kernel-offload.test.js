import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { buildWithKernels, kernelKey, runKernel } from '../src/kernel-offload.js';
import { answerKernelRequest } from '../src/kernel-registry.js';
import { createInProcessWorker, kernelRoom, sceneDigest } from './support/kernel-offload-fixture.mjs';
import './support/load-agent-scene-modules.mjs';

const BUILD_SCRIPT = new URL('./support/kernel-offload-build.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOADER = new URL('./support/load-agent-scene-modules.mjs', import.meta.url).href;

// Each build runs in its own process so that nothing an earlier build cached (mesh evaluation, pattern textures) can
// stand in for the kernel under test.
function coldBuild(mode) {
  const output = execFileSync(process.execPath, ['--import', LOADER, BUILD_SCRIPT, mode], { encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').at(-1));
}

const inlineBuild = coldBuild('inline');

test('the same recipe builds to the same bytes on one thread and with kernels on a worker', () => {
  const workerBuild = coldBuild('worker');
  assert.equal(workerBuild.digest, inlineBuild.digest);
  for (const kernel of ['uvUnwrap', 'lightBake', 'cloth', 'pattern']) {
    assert.ok(workerBuild.requestedKernels.includes(kernel), `the ${kernel} kernel ran on the worker`);
  }
  assert.deepEqual(inlineBuild.requestedKernels, []);
});

test('a host without workers builds inline', async () => {
  const requested = [];
  const scene = await buildWithKernels(() => createAgentScene(kernelRoom()), {
    createWorker: () => { requested.push('started'); return {}; },
    available: false,
  });
  assert.deepEqual(requested, []);
  assert.equal(sceneDigest(scene), inlineBuild.digest);
});

test('a worker that cannot start leaves the work to the inline path with the same result', async () => {
  const scene = await buildWithKernels(() => createAgentScene(kernelRoom()), {
    createWorker: () => { throw new Error('no workers here'); },
    available: true,
  });
  assert.equal(sceneDigest(scene), inlineBuild.digest);
});

test('a worker that dies mid-job leaves the work to the inline path with the same result', async () => {
  const dying = {
    postMessage() {
      setTimeout(() => dying.onerror?.({ message: 'crashed' }), 0);
    },
    terminate() {},
  };
  const scene = await buildWithKernels(() => createAgentScene(kernelRoom()), { createWorker: () => dying, available: true });
  assert.equal(sceneDigest(scene), inlineBuild.digest);
});

test('an error a kernel raises on the worker comes back as the same class and message', async () => {
  const raised = answerKernelRequest({ name: 'pattern', args: [{ type: 'nope' }] });
  assert.equal(raised.response.error.name, 'RangeError');
  assert.match(raised.response.error.message, /type must be one of/);
  const raising = {
    postMessage() {
      setTimeout(() => raising.onmessage?.({ data: { error: { name: 'RangeError', message: 'Light bake passed maxSeconds (20).' } } }), 0);
    },
    terminate() {},
  };
  await assert.rejects(
    buildWithKernels(() => runKernel('lightBake', [[], {}, {}], () => 'inline'), { createWorker: () => raising, available: true }),
    error => error instanceof RangeError && error.message === 'Light bake passed maxSeconds (20).',
  );
});

test('an explicit bake setting over the budget fails on the worker with the message that names numbers that fit', async () => {
  // Surfaces four times as wide, so the explicit settings are over the hard path work limit in this small room too.
  const heavyRoom = () => {
    const room = kernelRoom();
    const nodes = room.nodes.map(node => (node.scale ? { ...node, scale: node.scale.map(side => side * 4) } : node));
    return { ...room, nodes, bake: { preset: 'draft', samples: 256, bounces: 3, texelsPerUnit: 12 } };
  };
  let inlineMessage = '';
  assert.throws(() => createAgentScene(heavyRoom()), error => {
    inlineMessage = error.message;
    return error instanceof RangeError;
  });
  assert.match(inlineMessage, /samples \d+ or fewer/);
  const requestedKernels = [];
  await assert.rejects(
    buildWithKernels(() => createAgentScene(heavyRoom()), { createWorker: () => createInProcessWorker(requestedKernels), available: true }),
    error => error instanceof RangeError && error.message === inlineMessage,
  );
  assert.ok(requestedKernels.includes('lightBake'), 'the budget check ran inside the worker kernel');
});

test('cancelling stops the build and ends the worker', async () => {
  const silent = { terminated: false, postMessage() {}, terminate() { silent.terminated = true; } };
  const controller = new AbortController();
  const pending = buildWithKernels(() => runKernel('pattern', [{ size: 1 }], () => 'inline'), {
    createWorker: () => silent,
    available: true,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(silent.terminated, true);
});

test('kernel keys follow the bytes of the input and refuse data that cannot be cloned', () => {
  const positions = new Float32Array([1, 2, 3]);
  assert.equal(kernelKey('cloth', [positions, { a: 1 }]), kernelKey('cloth', [new Float32Array([1, 2, 3]), { a: 1 }]));
  assert.notEqual(kernelKey('cloth', [positions]), kernelKey('cloth', [new Float32Array([1, 2, 4])]));
  assert.notEqual(kernelKey('cloth', [positions]), kernelKey('pattern', [positions]));
  assert.equal(kernelKey('cloth', [() => 1]), null);
  assert.equal(kernelKey('cloth', [new Map()]), null);
});

test('without a session a kernel computes inline', () => {
  assert.equal(runKernel('pattern', [2, 3], (left, right) => left + right), 5);
});
