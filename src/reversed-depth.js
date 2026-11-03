// Reversed-Z depth (issue #310): with EXT_clip_control the depth range is zero to one, the projection maps the near plane to 1 and
// the far plane to 0, and the buffer is cleared to 0 and tested with GREATER. Floating point numbers are densest near 0, which is
// where the far surfaces land, so a 32-bit float buffer keeps its precision at distance instead of losing it as 1 / z does.

/**
 * Turns a projection that maps depth to -1..1 into one that maps it to 1..0 (the clip control range is 0..1).
 * Only the third row changes: the new z is (w - z) / 2, so it works for perspective, orthographic and oblique matrices.
 */
export function reverseProjectionDepth(out, projection) {
  for (let column = 0; column < 4; column++) {
    const depthIndex = column * 4 + 2;
    const clipDepth = projection[depthIndex];
    const clipW = projection[depthIndex + 1];
    out[column * 4] = projection[column * 4];
    out[column * 4 + 1] = projection[column * 4 + 1];
    out[depthIndex] = (clipW - clipDepth) / 2;
    out[depthIndex + 1] = clipW;
  }
  return out;
}

/** GLSL that turns a depth texture sample into the standard 0 (near) to 1 (far) value the rest of the shader decodes. */
export const STANDARD_DEPTH_GLSL = `uniform float depthReversed;
float standardDepth(float depth) {
  return mix(depth, 1.0 - depth, depthReversed);
}
`;
