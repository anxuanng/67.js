import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS } from './light-limits.js';

// Which bit of a part's `material.lightMask` belongs to which light, in the order of the environment lists. Kept apart
// from the shader code in light-linking.js so the path tracer can read the masks without pulling in the shaders.
export const SUN_BIT = 0;
export const POINT_FIRST_BIT = 1;
export const SPOT_FIRST_BIT = POINT_FIRST_BIT + MAX_POINT_LIGHTS;
export const AREA_FIRST_BIT = SPOT_FIRST_BIT + MAX_SPOT_LIGHTS;
