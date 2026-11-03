/** Highest depth layer; the draw-time polygon offset grows with the layer. */
export const MAXIMUM_DEPTH_LAYER = 4;

/** The layer a part draws on: `depthLayer` if set, else 1 for `decal: true`, else 0. */
export function depthLayerOf(part) {
  return part.depthLayer ?? (part.decal ? 1 : 0);
}
