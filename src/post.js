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
uniform vec2 resolution;
uniform float monochrome;
uniform float fade;
uniform float cinematic;
uniform float time;
out vec4 outputColor;
float luminance(vec3 color) { return dot(color, vec3(0.299, 0.587, 0.114)); }
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
  color = mix(color, vec3(luminance(color)), monochrome);
  vec2 centered = textureCoordinate * 2.0 - 1.0;
  color *= 1.0 - cinematic * 0.20 * dot(centered, centered);
  float grain = fract(sin(dot(gl_FragCoord.xy + floor(time * 24.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  color += grain * 0.018 * cinematic;
  outputColor = vec4(color * (1.0 - fade), 1.0);
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
  outputColor = vec4(color, 1.0);
}`;
