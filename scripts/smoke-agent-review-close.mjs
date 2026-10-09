import assert from 'node:assert/strict';
import { constants, setPriority } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { createAgentRuntime } from './agent-runtime.mjs';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const runtime = createAgentRuntime({ backend: 'cpu', memory: 96 });
try {
  const created = await runtime.create({ recipe: createAgentPreviewFixture() });
  const pending = runtime.review({ sessionId: created.sessionId, expectedRevision: 0,
    width: 480, height: 480, shots: [{}, {}, {}, {}] }).then(
    () => ({ completed: true }), error => ({ completed: false, message: error.message }));
  const deadline = performance.now() + 5000;
  let phase;
  do {
    phase = (await runtime.capabilities()).phase;
    if (phase === 'reviewing') break;
    await delay(2);
  } while (performance.now() < deadline);
  assert.equal(phase, 'reviewing', 'Close must target a confirmed active review');
  const start = performance.now();
  await runtime.close();
  const elapsedSeconds = (performance.now() - start) / 1000;
  const outcome = await pending;
  assert.equal(outcome.completed, false);
  assert.equal((await runtime.capabilities()).phase, 'closed');
  assert.ok(elapsedSeconds < 5, 'Closing an active review must release resources promptly');
  const report = { activePhaseObserved: phase, finalPhase: 'closed', outcome, elapsedSeconds };
  await writeFile('artifacts/agent-review-close.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await runtime.close();
}
