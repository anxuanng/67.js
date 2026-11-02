import { skyVisibilityGrid } from './closed-room.js';

// The post pass (src/renderer.js) reads the grid from this texture unit.
const FOG_SKY_TEXTURE_UNIT = 5;

const uploaded = new WeakMap();

function uploadGrid(context, grid) {
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_3D, texture);
  context.pixelStorei(context.UNPACK_ALIGNMENT, 1);
  context.texImage3D(context.TEXTURE_3D, 0, context.R8, grid.size[0], grid.size[1], grid.size[2], 0, context.RED, context.UNSIGNED_BYTE, grid.data);
  context.pixelStorei(context.UNPACK_ALIGNMENT, 4);
  context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MIN_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  for (const wrap of [context.TEXTURE_WRAP_S, context.TEXTURE_WRAP_T, context.TEXTURE_WRAP_R]) {
    context.texParameteri(context.TEXTURE_3D, wrap, context.CLAMP_TO_EDGE);
  }
  return texture;
}

/**
 * The `fogSkyVisibility` option of `Renderer67`: a 3D texture of how much sky each point of the fog box sees, which the
 * fog's ambient follows. It lives outside the core entry like `skyOpenness`, and a scene without the option compiles the
 * sampling out of the post shader. The rays run once per scene and fog box, not per frame. The renderer calls it every
 * frame with its resolved `volume` and gets the texture, already bound to the grid's texture unit, or null (no fog, a
 * `shadowAmbient` the recipe set, or a scene that is empty or too large to test), which draws as before.
 */
export function fogSkyVisibility(parts, volume, context) {
  if (!(volume.density > 0) || volume.shadowAmbient !== undefined) {
    return null;
  }
  const key = `${volume.minimum}|${volume.maximum}`;
  let entry = uploaded.get(parts);
  if (entry?.context !== context || entry.key !== key) {
    const grid = skyVisibilityGrid(parts, volume.minimum, volume.maximum);
    entry = { context, key, texture: grid && uploadGrid(context, grid) };
    uploaded.set(parts, entry);
  }
  if (entry.texture) {
    context.activeTexture(context.TEXTURE0 + FOG_SKY_TEXTURE_UNIT);
    context.bindTexture(context.TEXTURE_3D, entry.texture);
  }
  return entry.texture;
}
