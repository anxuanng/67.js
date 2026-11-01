// Child process of tests/kernel-offload.test.js: builds the kernel room cold (nothing cached by an earlier build) and
// prints its digest and the kernels the worker ran, as JSON. Argument: inline or worker.
import { loadAllAgentSceneModules } from '../../src/agent-scene.js';
import { buildKernelRoom, sceneDigest } from './kernel-offload-fixture.mjs';

await loadAllAgentSceneModules();
const { scene, requestedKernels } = await buildKernelRoom(process.argv[2]);
console.log(JSON.stringify({ digest: sceneDigest(scene), requestedKernels }));
