import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { mat4 } from 'gl-matrix';
import { createAgentScene, needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, needsPhysics, loadPhysicsEngine, physicsEngineLoaded, loadAllAgentSceneModules, allAgentSceneModulesLoaded } from '../../src/agent-scene.js';
import { applyProjection } from '../../src/camera.js';
import { resolveAgentShadow, agentEnvironmentMap } from '../../src/agent-look.js';
import { createAgentAssetScene } from '../../src/agent-asset.js';
import { parseGltf } from '../../src/gltf.js';
import { BRANCH_LIMITS, createBranchStore, printableLabel } from '../../src/agent-branches.js';
import { sessionProblem } from '../../src/agent-errors.js';

// Runs the preview page's adapter code in a VM with a fault-injected renderer, the way the MCP preview runs it in a browser.
const source = (await readFile(new URL('../../scripts/agent-preview-browser.js', import.meta.url), 'utf8')).replace(/^import .+;\r?$/gm, '');

export function previewHarness() {
  let renderError = 0;
  let lost = false;
  let replacementError = false;
  let replacementCount = 0;
  let currentRenderer;
  let currentScene;
  const renders = [];
  const tiles = [];
  const makeCanvas = () => ({ width: 768, height: 512,
    replaceWith() {}, toDataURL: () => 'data:image/png;base64,cG5n',
    getContext: kind => kind === '2d' ? { fillRect() {}, fillText() {}, strokeText() {},
      drawImage: () => tiles.push(renders.at(-1)) } : { getExtension: () => null } });
  const canvas = makeCanvas();
  class FaultInjectedRenderer {
    memoryPlan = { estimatedBytes: 1024 };
    capabilities = { hdr: true, samples: 4 };
    constructor() { currentRenderer = this; }
    context = {
      isContextLost: () => lost,
      getError: () => renderError,
      getExtension: () => null,
      getParameter: () => 'Test renderer',
    };
    resize() {}
    updateParts() {}
    replaceParts() {
      if (replacementError) throw new Error('Injected replacement allocation failure');
      replacementCount++;
    }
    render(camera) {
      renders.push({ camera: JSON.parse(JSON.stringify(camera)),
        parts: currentScene.parts.map(part => ({ matrix: Array.from(part.matrix),
          joints: Array.from(part.skin?.jointMatrices ?? []) })) });
    }
    dispose() {}
  }
  const context = createContext({
    window: {},
    document: { querySelector: () => canvas, createElement: makeCanvas },
    // The real browser bundles these functions in one realm. Bridge only the VM realm here.
    createAgentScene: input => {
      const scene = createAgentScene(JSON.parse(JSON.stringify(input)));
      if (scene.parts.length) currentScene = scene;
      return scene;
    },
    createAgentAssetScene: (asset, input) => {
      currentScene = createAgentAssetScene(asset, JSON.parse(JSON.stringify(input)));
      const scene = currentScene;
      const bridgedMethods = new Set(['sampleFrame', 'inspect', 'inspectMeshes']);
      return new Proxy({}, { get: (target, field) => bridgedMethods.has(field)
        ? value => scene[field](JSON.parse(JSON.stringify(value ?? {}))) : scene[field] });
    },
    needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, loadAllAgentSceneModules, allAgentSceneModulesLoaded,
    // The harness loads Manifold from node_modules directly, so the preview's served-file loader is ignored.
    setManifoldModuleLoader: () => {},
    needsPhysics, loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader: () => {},
    parseGltf, Uint8Array, atob, sessionProblem,
    applyProjection, mat4, resolveAgentShadow, agentEnvironmentMap, BRANCH_LIMITS, createBranchStore, printableLabel,
    Renderer67: FaultInjectedRenderer,
    // The optional addons only plug stages into a real renderer; the fault-injected one needs none.
    installCameraEffects: renderer => renderer, installRenderPasses: renderer => renderer,
  });
  // Evaluate only trusted repository adapter code; inject the driver boundary for failure cases.
  new Script(source).runInContext(context);
  return {
    preview: context.window.__agentPreview,
    injectError: value => { renderError = value; },
    loseContext: () => { lost = true; },
    rejectReplacement: value => { replacementError = value; },
    replacementCount: () => replacementCount,
    disableHdr: () => { currentRenderer.capabilities.hdr = false; },
    scene: () => currentScene, renders, tiles,
  };
}
