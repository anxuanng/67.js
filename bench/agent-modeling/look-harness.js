// Runs in the page: draws a recipe from each fixed camera, the way the MCP preview draws a scene.
import { createAgentScene, loadMeshBooleans, needsMeshBooleans } from '/src/agent-scene.js';
import { resolveAgentShadow } from '/src/agent-look.js';
import { Renderer67 } from '/src/renderer.js';

async function renderLookViews(recipe, views) {
  if (needsMeshBooleans(recipe)) await loadMeshBooleans();
  const scene = createAgentScene(recipe);
  if (recipe.motion) scene.sampleMotion(0);
  const canvas = document.querySelector('canvas');
  const environment = scene.environment;
  const effects = scene.effects;
  const renderer = new Renderer67(canvas, scene.parts, {
    ground: false, hdr: true, depth: true, samples: 1, pixelRatio: 1, memoryBudgetMiB: 512,
    world: environment.world, environment,
    shadowBounds: resolveAgentShadow(scene.shadow, environment.lightDirection),
  });
  const images = [];
  try {
    for (const { name, camera } of views) {
      renderer.resize();
      renderer.updateParts(scene.parts);
      renderer.render({ ...camera, environment, effects, exposure: effects.exposure, time: 0 });
      renderer.render({ ...camera, environment, effects, exposure: effects.exposure, time: 0 });
      const glError = renderer.context.getError();
      if (glError !== 0) throw new Error(`${name} gave WebGL error ${glError}.`);
      images.push({ name, image: canvas.toDataURL('image/png').split(',')[1] });
    }
  } finally {
    renderer.dispose();
  }
  return images;
}

window.renderLookViews = renderLookViews;
