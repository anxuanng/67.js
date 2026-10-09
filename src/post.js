export const fullscreenVertex = `#version 300 es
precision highp float;
out vec2 textureCoordinate;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  textureCoordinate = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

export const postFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D frameTexture;
uniform float transparent;
uniform sampler2D bloomTexture;
uniform float bloomStrength;
uniform float hdrEnabled;
uniform vec3 grade;
uniform float vignette;
uniform float grainAmount;
uniform vec2 resolution;
uniform float monochrome;
uniform float fade;
uniform float cinematic;
uniform float time;
uniform float volumeExplosion;
uniform float explosionProgress;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform sampler2D sceneDepth;
uniform sampler2D volumeShadowMap;
uniform mat4 volumeLightProjection;
uniform vec3 volumeLightDirection;
uniform vec3 volumeLightColor;
uniform float volumeDensity;
uniform vec3 volumeMinimum;
uniform vec3 volumeMaximum;
uniform vec3 volumeColor;
uniform vec3 volumeAmbient;
uniform vec3 volumeDrift;
uniform int volumeSteps;
uniform float volumeAnisotropy;
uniform float volumeNoiseAmount;
uniform float volumeNoiseScale;
uniform float volumeMaxDistance;
uniform float orthographic;
out vec4 outputColor;
float luminance(vec3 color) { return dot(color, vec3(0.299, 0.587, 0.114)); }
float hash(vec3 position) { return fract(sin(dot(position, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float cloudNoise(vec3 position) {
  vec3 cell = floor(position);
  vec3 fraction = fract(position);
  fraction = fraction * fraction * (3.0 - 2.0 * fraction);
  float lower = mix(mix(hash(cell), hash(cell + vec3(1,0,0)), fraction.x), mix(hash(cell + vec3(0,1,0)), hash(cell + vec3(1,1,0)), fraction.x), fraction.y);
  float upper = mix(mix(hash(cell + vec3(0,0,1)), hash(cell + vec3(1,0,1)), fraction.x), mix(hash(cell + vec3(0,1,1)), hash(cell + vec3(1,1,1)), fraction.x), fraction.y);
  return mix(lower, upper, fraction.z);
}
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
vec3 volumeFog(vec3 background) {
  vec2 clipXY = textureCoordinate * 2.0 - 1.0;
  vec4 farPoint = inverseViewProjection * vec4(clipXY, 1.0, 1.0);
  vec4 nearPoint = inverseViewProjection * vec4(clipXY, -1.0, 1.0);
  vec3 origin = orthographic > 0.5 ? nearPoint.xyz / nearPoint.w : eye;
  vec3 direction = normalize(farPoint.xyz - origin * farPoint.w);
  float depth = texture(sceneDepth, textureCoordinate).r;
  vec4 surfacePoint = inverseViewProjection * vec4(clipXY, depth * 2.0 - 1.0, 1.0);
  float surfaceDistance = volumeMaxDistance;
  if (surfacePoint.w > 0.0) surfaceDistance = max(0.0, dot(surfacePoint.xyz - origin * surfacePoint.w, direction) / surfacePoint.w);
  float exitDistance = min(volumeMaxDistance, surfaceDistance);
  float entry = 0.0;
  for (int axis = 0; axis < 3; axis++) {
    if (direction[axis] == 0.0) {
      if (origin[axis] < volumeMinimum[axis] || origin[axis] > volumeMaximum[axis]) return background;
    } else {
      float first = (volumeMinimum[axis] - origin[axis]) / direction[axis];
      float second = (volumeMaximum[axis] - origin[axis]) / direction[axis];
      entry = max(entry, min(first, second));
      exitDistance = min(exitDistance, max(first, second));
    }
  }
  if (entry >= exitDistance) return background;
  float stepSize = (exitDistance - entry) / float(volumeSteps);
  vec3 lightDirection = normalize(volumeLightDirection);
  float cosine = dot(direction, lightDirection);
  float anisotropy = volumeAnisotropy;
  float phase = (1.0 - anisotropy * anisotropy) / (12.5663706 * pow(1.0 + anisotropy * anisotropy - 2.0 * anisotropy * cosine, 1.5));
  float jitter = hash(vec3(gl_FragCoord.xy, 0));
  float transmittance = 1.0;
  vec3 accumulated = vec3(0);
  for (int index = 0; index < 48; index++) {
    if (index >= volumeSteps) break;
    vec3 position = origin + direction * (entry + (float(index) + jitter) * stepSize);
    float noise = 1.0;
    if (volumeNoiseAmount > 0.0) noise = mix(1.0, cloudNoise((position - volumeDrift * time) * volumeNoiseScale) * 2.0, volumeNoiseAmount);
    float opacity = 1.0 - exp(-volumeDensity * noise * stepSize);
    vec4 lightPosition = volumeLightProjection * vec4(position, 1);
    vec3 shadow = lightPosition.xyz / lightPosition.w * 0.5 + 0.5;
    float visibility = 1.0;
    if (all(greaterThanEqual(shadow, vec3(0))) && all(lessThanEqual(shadow, vec3(1)))) {
      visibility = step(shadow.z - 0.0008, texture(volumeShadowMap, shadow.xy).r);
    }
    vec3 scattering = volumeColor * (volumeAmbient + volumeLightColor * phase * visibility);
    accumulated += transmittance * opacity * scattering;
    transmittance *= 1.0 - opacity;
    if (transmittance < 0.001) break;
  }
  return accumulated + background * transmittance;
}
void main() {
  vec2 texel = 1.0 / resolution;
  vec3 center = texture(frameTexture, textureCoordinate).rgb;
  vec3 northwest = texture(frameTexture, textureCoordinate + vec2(-1.0, -1.0) * texel).rgb;
  vec3 northeast = texture(frameTexture, textureCoordinate + vec2(1.0, -1.0) * texel).rgb;
  vec3 southwest = texture(frameTexture, textureCoordinate + vec2(-1.0, 1.0) * texel).rgb;
  vec3 southeast = texture(frameTexture, textureCoordinate + vec2(1.0, 1.0) * texel).rgb;
  float centerLuma = luminance(center);
  float northwestLuma = luminance(northwest);
  float northeastLuma = luminance(northeast);
  float southwestLuma = luminance(southwest);
  float southeastLuma = luminance(southeast);
  float minimumLuma = min(centerLuma, min(min(northwestLuma, northeastLuma), min(southwestLuma, southeastLuma)));
  float maximumLuma = max(centerLuma, max(max(northwestLuma, northeastLuma), max(southwestLuma, southeastLuma)));
  vec2 direction = vec2(-((northwestLuma + northeastLuma) - (southwestLuma + southeastLuma)), (northwestLuma + southwestLuma) - (northeastLuma + southeastLuma));
  float reduction = max((northwestLuma + northeastLuma + southwestLuma + southeastLuma) * 0.03125, 0.0078125);
  direction = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduction), vec2(-6.0), vec2(6.0)) * texel;
  vec3 first = 0.5 * (texture(frameTexture, textureCoordinate + direction * (-1.0 / 6.0)).rgb + texture(frameTexture, textureCoordinate + direction * (1.0 / 6.0)).rgb);
  vec3 second = first * 0.5 + 0.25 * (texture(frameTexture, textureCoordinate - direction * 0.5).rgb + texture(frameTexture, textureCoordinate + direction * 0.5).rgb);
  float secondLuma = luminance(second);
  vec3 color = secondLuma < minimumLuma || secondLuma > maximumLuma ? first : second;
  if (maximumLuma - minimumLuma < max(0.03, maximumLuma * 0.125)) color = center;
  float coverage = texture(frameTexture, textureCoordinate).a;
  if (transparent > 0.5) color = center / max(coverage, 0.00001);
  if (bloomStrength > 0.0) color += texture(bloomTexture, textureCoordinate).rgb * bloomStrength;
  if (volumeDensity > 0.0) color = volumeFog(color);
  if (hdrEnabled > 0.5) {
    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
    color = pow(color, vec3(1.0 / 2.2));
  }
  if (volumeExplosion > 0.5) color = explosion(color);
  color = mix(color, vec3(luminance(color)), monochrome);
  if (grade.x != 1.0) color = mix(vec3(luminance(color)), color, grade.x);
  if (grade.y != 1.0) color = (color - 0.5) * grade.y + 0.5;
  if (grade.z != 0.0) color *= vec3(1.0 + grade.z * 0.1, 1.0, 1.0 - grade.z * 0.1);
  vec2 centered = textureCoordinate * 2.0 - 1.0;
  color *= max(0.0, 1.0 - (cinematic * 0.20 + vignette) * dot(centered, centered));
  float grain = fract(sin(dot(gl_FragCoord.xy + floor(time * 24.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  color += grain * (0.018 * cinematic + grainAmount);
  float alpha = transparent > 0.5 ? coverage : 1.0;
  outputColor = vec4(color * (1.0 - fade) * alpha, alpha);
}`;

export const skyFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform vec3 skyTop;
uniform vec3 skyBottom;
uniform vec3 sunDirection;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform float time;
uniform float daylight;
uniform float hdrEnabled;
out vec4 outputColor;
float noise(vec2 position) {
  return sin(position.x * 2.1 + sin(position.y * 1.3)) * 0.5 + sin(position.y * 2.8 - position.x * 0.8) * 0.3;
}
void main() {
  vec4 world = inverseViewProjection * vec4(textureCoordinate * 2.0 - 1.0, 1.0, 1.0);
  vec3 direction = normalize(world.xyz / world.w - eye);
  float height = clamp(direction.y * 1.3 + 0.12, 0.0, 1.0);
  vec3 color = mix(skyBottom, skyTop, pow(height, 0.6));
  float sun = max(dot(direction, normalize(sunDirection)), 0.0);
  color += vec3(1.0, 0.72, 0.35) * pow(sun, 300.0) * 0.7 * daylight;
  color += vec3(0.30, 0.22, 0.12) * pow(sun, 8.0) * daylight;
  vec2 cloudPosition = direction.xz / max(0.08, direction.y) * 0.5 + vec2(time * 0.006, 0.0);
  float cloud = smoothstep(0.1, 0.55, noise(cloudPosition) + noise(cloudPosition * 2.4) * 0.25);
  cloud *= smoothstep(0.02, 0.22, direction.y) * (1.0 - smoothstep(0.5, 0.95, direction.y));
  color = mix(color, mix(skyBottom, vec3(0.94, 0.93, 0.85), 0.7), cloud * 0.28 * daylight);
  outputColor = vec4(hdrEnabled > 0.5 ? pow(max(color, vec3(0)), vec3(2.2)) : color, 1.0);
}`;

export const bloomFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sourceTexture;
uniform vec2 texelDirection;
uniform float threshold;
uniform float extract;
out vec4 outputColor;
vec3 sampleBloom(vec2 coordinate) {
  vec3 color = texture(sourceTexture, coordinate).rgb;
  if (extract > 0.5) {
    float peak = max(color.r, max(color.g, color.b));
    color *= max(peak - threshold, 0.0) / max(peak, 0.00001);
  }
  return color;
}
void main() {
  vec3 color = sampleBloom(textureCoordinate) * 0.227027;
  color += sampleBloom(textureCoordinate + texelDirection * 1.384615) * 0.316216;
  color += sampleBloom(textureCoordinate - texelDirection * 1.384615) * 0.316216;
  color += sampleBloom(textureCoordinate + texelDirection * 3.230769) * 0.070270;
  color += sampleBloom(textureCoordinate - texelDirection * 3.230769) * 0.070270;
  outputColor = vec4(color, 1.0);
}`;
