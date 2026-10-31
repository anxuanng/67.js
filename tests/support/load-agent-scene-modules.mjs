// Preloaded into every test process (see the test script) so recipes of any kind run synchronously, as agents see
// them in the MCP preview. tests/agent-scene-on-demand.test.js checks the unloaded path in clean child processes.
import { loadAllAgentSceneModules } from '../../src/agent-scene.js';

await loadAllAgentSceneModules();
