// Reads and writes the glTF material extensions that map onto the material layers of material-layers.js.
// Texture slots inside these extensions (clearcoatTexture, transmissionTexture and so on) are not read: a factor is used.
import { MATERIAL_LAYER_DEFAULTS, validateMaterialLayers } from './material-layers.js';

export const GLTF_LAYER_EXTENSIONS = Object.freeze([
  'KHR_materials_clearcoat',
  'KHR_materials_transmission',
  'KHR_materials_volume',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_sheen',
]);

// Each row: extension, then the glTF property that feeds each material field.
const IMPORT_RULES = Object.freeze([
  ['KHR_materials_clearcoat', { clearcoat: 'clearcoatFactor', clearcoatRoughness: 'clearcoatRoughnessFactor' }],
  ['KHR_materials_transmission', { transmission: 'transmissionFactor' }],
  ['KHR_materials_volume', { thickness: 'thicknessFactor', attenuationDistance: 'attenuationDistance', attenuationColor: 'attenuationColor' }],
  ['KHR_materials_ior', { ior: 'ior' }],
  ['KHR_materials_specular', { specular: 'specularFactor', specularColor: 'specularColorFactor' }],
  ['KHR_materials_sheen', { sheenColor: 'sheenColorFactor', sheenRoughness: 'sheenRoughnessFactor' }],
]);

/** Layer fields of one glTF material definition, validated, as a plain object to spread onto a material. */
export function materialLayersFromGltf(definition) {
  const layers = {};
  for (const [extensionName, properties] of IMPORT_RULES) {
    const extension = definition?.extensions?.[extensionName];
    if (!extension) continue;
    for (const [field, property] of Object.entries(properties)) {
      if (extension[property] !== undefined) layers[field] = extension[property];
    }
  }
  validateMaterialLayers(layers);
  return layers;
}

function differsFromDefault(field, value) {
  return JSON.stringify(value) !== JSON.stringify(MATERIAL_LAYER_DEFAULTS[field]);
}

function extensionProperties(material, properties) {
  const written = {};
  for (const [field, property] of Object.entries(properties)) {
    if (material[field] === undefined || !differsFromDefault(field, material[field])) continue;
    written[property] = Array.isArray(material[field]) ? [...material[field]] : material[field];
  }
  return written;
}

/** The KHR_materials_* objects a material needs, keyed by extension name; empty when it uses no layer. */
export function gltfExtensionsFromLayers(material) {
  validateMaterialLayers(material);
  const extensions = {};
  for (const [extensionName, properties] of IMPORT_RULES) {
    const written = extensionProperties(material, properties);
    if (Object.keys(written).length > 0) extensions[extensionName] = written;
  }
  return extensions;
}
