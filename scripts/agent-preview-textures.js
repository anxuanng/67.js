// Any texture map counts: replaceParts adds or changes textured parts only with an addon the preview does not load, so an
// edit that regroups a textured part (a coplanar depth layer on an imported asset) takes a new renderer instead.
const TEXTURE_MAP_FIELDS = ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];

export function hasPatternTextures(parts) {
  return parts.some(part => part.material.boxMapScale || TEXTURE_MAP_FIELDS.some(field => part.material[field]));
}
