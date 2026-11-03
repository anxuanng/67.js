import { registerShaderFeatureCode } from './shader-registry.js';

// The volumetric explosion of the film's ignition scene, a step of the post pass. Only a renderer that draws a frame with
// volumeExplosion needs this module; post.js gives every other post program a stub. It reads cloudNoise from the post shader.
registerShaderFeatureCode('explosion', {
  post: `
vec3 explosion(vec3 background) {
  vec4 endpoint = inverseViewProjection * vec4(textureCoordinate * 2.0 - 1.0, 1.0, 1.0);
  vec3 direction = normalize(endpoint.xyz / endpoint.w - eye);
  float scale = 0.03 + explosionProgress * 0.97;
  vec3 center = vec3(0,12,0) * scale;
  float radius = 15.0 * scale;
  vec3 relative = eye - center;
  float projected = dot(relative, direction);
  float discriminant = projected * projected - dot(relative, relative) + radius * radius;
  if (discriminant <= 0.0) return background;
  float entry = max(0.0, -projected - sqrt(discriminant));
  float exitDistance = -projected + sqrt(discriminant);
  float stepSize = (exitDistance - entry) / 36.0;
  vec3 accumulated = vec3(0);
  float transmittance = 1.0;
  for (int stepIndex = 0; stepIndex < 36; stepIndex++) {
    vec3 position = (eye + direction * (entry + (float(stepIndex) + 0.5) * stepSize)) / scale;
    if (position.y < 0.0) continue;
    vec3 flow = position * 0.56 - vec3(0, time * 0.55, 0);
    float noise = cloudNoise(flow) * 0.68 + cloudNoise(flow * 2.1 + vec3(5.4,1.7,9.1)) * 0.32;
    float fireShape = 1.0 - length((position - vec3(0,7,0)) / vec3(7.0,7.6,7.0));
    float capShape = 1.0 - length((position - vec3(0,18,0)) / vec3(9.4,5.7,9.4));
    float stemShape = min(1.0 - length(position.xz) / 3.5, min((position.y - 8.0) / 3.0, (19.0 - position.y) / 3.0));
    float fireDensity = smoothstep(0.0, 0.32, fireShape + (noise - 0.5) * 0.6);
    float smokeDensity = smoothstep(0.0, 0.3, max(capShape, stemShape) + (noise - 0.5) * 0.45);
    float density = max(fireDensity * 0.7, smokeDensity * 1.2);
    float opacity = 1.0 - exp(-density * stepSize / scale * 0.30);
    float temperature = clamp(fireShape * 0.9 + noise * 0.65, 0.0, 1.0);
    vec3 fireColor = mix(vec3(0.45,0.018,0.001), vec3(2.5,0.9,0.09), smoothstep(0.25,0.95,temperature));
    fireColor = mix(fireColor, vec3(4.0,2.8,1.5), smoothstep(0.92,1.0,temperature));
    vec3 smokeColor = vec3(0.11,0.085,0.062) * (0.4 + noise * 0.8);
    smokeColor += vec3(0.18,0.028,0.002) * max(0.0,1.0 - abs(position.y - 11.0) / 7.0);
    vec3 color = mix(smokeColor, fireColor, fireDensity / max(0.001,fireDensity + smokeDensity));
    accumulated += color * opacity * transmittance;
    transmittance *= 1.0 - opacity;
    if (transmittance < 0.02) break;
  }
  accumulated = accumulated / (accumulated + 0.5);
  return accumulated + background * transmittance;
}
`,
});
