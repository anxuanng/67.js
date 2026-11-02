import { createStage, sharedFragmentHeader } from '/src/camera-effects.js';
import { findWaterSurface } from '/src/water-reflection.js';

// The screen-space reflection the water reflection was compared with (issue #195). It is a post stage: every pixel whose
// depth puts it on the water plane marches the mirrored view ray through the frame's own depth, and where the ray meets
// something it shows that pixel of the frame, mixed in by Fresnel as the planar reflection does. It cannot show what the frame
// does not hold (anything off screen or hidden behind another surface). Kept here, not in src, because it lost the comparison.

const STEPS = 80;
const REFINEMENTS = 6;

const ssrFragment = `${sharedFragmentHeader}
uniform mat4 viewProjection;
uniform vec3 eye;
uniform float waterHeight;
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  float depth = texture(sceneDepth, textureCoordinate).r;
  outputColor = source;
  if (depth >= 1.0) return;
  vec3 world = worldPointAt(textureCoordinate);
  float eyeDistance = length(world - eye);
  if (abs(world.y - waterHeight) > 0.05 + eyeDistance * 0.0005) return;
  vec3 view = normalize(world - eye);
  vec3 ray = vec3(view.x, -view.y, view.z);
  float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(-view.y, 0.0, 1.0), 5.0);
  vec3 start = world + vec3(0.0, 0.05, 0.0);
  float along = 0.0;
  float stride = max(0.5, eyeDistance * 0.01);
  vec2 hitCoordinate = vec2(-1.0);
  for (int step = 0; step < ${STEPS}; step++) {
    float previous = along;
    along += stride;
    stride *= 1.1;
    vec3 point = start + ray * along;
    vec4 clip = viewProjection * vec4(point, 1.0);
    if (clip.w <= 0.0) break;
    vec2 coordinate = clip.xy / clip.w * 0.5 + 0.5;
    if (coordinate.x < 0.0 || coordinate.x > 1.0 || coordinate.y < 0.0 || coordinate.y > 1.0) break;
    float sampledDepth = texture(sceneDepth, coordinate).r;
    if (sampledDepth >= 1.0) continue;
    float rayDistance = length(point - eye);
    float sceneDistance = length(worldPointAt(coordinate) - eye);
    float gap = rayDistance - sceneDistance;
    if (gap > 0.0 && gap < stride * 2.0 + 0.5) {
      float low = previous;
      float high = along;
      for (int refine = 0; refine < ${REFINEMENTS}; refine++) {
        float middle = 0.5 * (low + high);
        vec3 middlePoint = start + ray * middle;
        vec4 middleClip = viewProjection * vec4(middlePoint, 1.0);
        vec2 middleCoordinate = middleClip.xy / middleClip.w * 0.5 + 0.5;
        float middleScene = length(worldPointAt(middleCoordinate) - eye);
        if (length(middlePoint - eye) > middleScene) high = middle; else low = middle;
      }
      vec3 hitPoint = start + ray * high;
      vec4 hitClip = viewProjection * vec4(hitPoint, 1.0);
      hitCoordinate = hitClip.xy / hitClip.w * 0.5 + 0.5;
      break;
    }
  }
  if (hitCoordinate.x < 0.0) return;
  float edge = min(min(hitCoordinate.x, 1.0 - hitCoordinate.x), min(hitCoordinate.y, 1.0 - hitCoordinate.y));
  float weight = fresnel * smoothstep(0.0, 0.08, edge);
  outputColor = vec4(mix(source.rgb, texture(sourceTexture, hitCoordinate).rgb, weight), source.a);
}`;

/** Adds the screen-space reflection stage to a renderer for the scene's water plane. Returns the surface, or null. */
export function attachScreenSpaceWater(renderer, parts) {
  const surface = findWaterSurface(parts);
  if (!surface) {
    return null;
  }
  renderer.postStages.push(createStage({
    name: 'Screen-space water',
    fragment: ssrFragment,
    uniformNames: ['viewProjection', 'eye', 'waterHeight'],
    isActive: () => true,
    setUniforms(context, uniforms, activeRenderer, frame) {
      context.uniformMatrix4fv(uniforms.viewProjection, false, activeRenderer.viewProjection);
      context.uniform3fv(uniforms.eye, frame.eye);
      context.uniform1f(uniforms.waterHeight, surface.height);
    },
  }));
  return surface;
}
