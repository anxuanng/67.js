// How many lights of each kind one frame takes. Light linking keeps one mask bit for the sun and one for each of these
// lights in a 32 bit integer, so the three limits and the sun together must fit in 32 bits.
export const MAX_POINT_LIGHTS = 16;
export const MAX_SPOT_LIGHTS = 8;
export const MAX_AREA_LIGHTS = 7;
