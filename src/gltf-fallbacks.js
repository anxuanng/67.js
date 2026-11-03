// Rewrites the parts of a glTF document that common Sketchfab files get wrong, so that they load instead of throwing.
// parseGltf imports this module only when a file needs it, so it adds nothing to a scene that loads a clean file.

const SPECULAR_GLOSSINESS = 'KHR_materials_pbrSpecularGlossiness';

/** Paths (as arrays of keys) to every texture reference of a material that reads TEXCOORD_0. */
function collectFirstSetTextureKeys(value, path = [], found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object') continue;
    const isTextureReference = Number.isInteger(child.index) && (child.texCoord ?? 0) === 0;
    if (isTextureReference) found.push([...path, key]);
    else collectFirstSetTextureKeys(child, [...path, key], found);
  }
  return found;
}

/**
 * KHR_materials_pbrSpecularGlossiness to metallic-roughness, the way Blender's importer approximates it: the diffuse
 * color becomes the base color, the surface is dielectric, and roughness is 1 minus the glossiness factor. The specular
 * color and the specularGlossinessTexture are dropped, because reading them needs a pass over the image pixels.
 */
function convertSpecularGlossiness(document, warnings) {
  const converted = [];
  document.materials?.forEach((material, index) => {
    const specularGlossiness = material?.extensions?.[SPECULAR_GLOSSINESS];
    if (!specularGlossiness) return;
    const pbr = { metallicFactor: 0, roughnessFactor: 1 - (specularGlossiness.glossinessFactor ?? 1) };
    if (specularGlossiness.diffuseFactor) pbr.baseColorFactor = specularGlossiness.diffuseFactor;
    if (specularGlossiness.diffuseTexture) pbr.baseColorTexture = specularGlossiness.diffuseTexture;
    material.pbrMetallicRoughness = pbr;
    delete material.extensions[SPECULAR_GLOSSINESS];
    if (!Object.keys(material.extensions).length) delete material.extensions;
    const dropped = specularGlossiness.specularGlossinessTexture ? ' and its specularGlossinessTexture' : '';
    converted.push(`${material.name ?? `material ${index}`}${dropped}`);
  });
  if (!converted.length) return;
  document.extensionsUsed = document.extensionsUsed?.filter(name => name !== SPECULAR_GLOSSINESS);
  document.extensionsRequired = document.extensionsRequired?.filter(name => name !== SPECULAR_GLOSSINESS);
  warnings.push(`${SPECULAR_GLOSSINESS} converted to metallic-roughness (diffuse color as base color, metallic 0, roughness 1 - glossiness, specular color not read) in ${converted.join(', ')}.`);
}

/**
 * A primitive without TEXCOORD_0 cannot sample a texture on the first UV set. Such a primitive gets its own copy of the
 * material without those textures, and the original stays for the primitives that do have UVs.
 */
function dropTexturesWithoutUvs(document, warnings) {
  const copiesByMaterial = new Map();
  const dropped = new Set();
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const material = document.materials?.[primitive.material];
      if (primitive.attributes?.TEXCOORD_0 !== undefined || !material) continue;
      const paths = collectFirstSetTextureKeys(material);
      if (!paths.length) continue;
      if (!copiesByMaterial.has(primitive.material)) {
        const copy = structuredClone(material);
        for (const path of paths) {
          const parent = path.slice(0, -1).reduce((node, key) => node[key], copy);
          delete parent[path.at(-1)];
          dropped.add(path.at(-1));
        }
        document.materials.push(copy);
        copiesByMaterial.set(primitive.material, document.materials.length - 1);
      }
      primitive.material = copiesByMaterial.get(primitive.material);
    }
  }
  if (!dropped.size) return;
  warnings.push(`Dropped ${[...dropped].sort().join(', ')} from primitives without TEXCOORD_0, which cannot sample a texture.`);
}

/** Rewrites the document in place and returns the warnings that tell the caller what changed. */
export function applyGltfFallbacks(document) {
  const warnings = [];
  convertSpecularGlossiness(document, warnings);
  dropTexturesWithoutUvs(document, warnings);
  return warnings;
}
