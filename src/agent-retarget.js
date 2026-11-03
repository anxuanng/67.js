import { mapHumanoidBones, retargetClip } from './retarget.js';
import { rigFromAssetNodes } from './skeleton-pose.js';

// Retargeting a clip of one catalog asset onto another for the asset recipe's motion layers. The bone map and the rest-pose
// correction come from retarget.js; this file only adapts decoded asset nodes to it and reports what matched.

const MAX_REPORTED_JOINTS = 24;

function jointNamesOf(nodes) {
  return nodes.filter(node => node.joint).map(node => node.name);
}

/** What the humanoid map does with an asset's joints: how many bones matched, which joints did not, which bones are missing. */
export function humanoidMapReport(nodes) {
  const { mapping, unmapped, missing } = mapHumanoidBones(jointNamesOf(nodes));
  return { mapped: Object.keys(mapping).length, unmapped: unmapped.slice(0, MAX_REPORTED_JOINTS), unmappedCount: unmapped.length, missing };
}

/** Both reports for one retarget, or an error that names the required bones a side lacks. */
export function retargetReport(sourceNodes, targetNodes, label) {
  const source = humanoidMapReport(sourceNodes);
  const target = humanoidMapReport(targetNodes);
  for (const [side, report] of [['source', source], ['target', target]]) {
    if (report.missing.length) {
      throw new RangeError(`${label}: the ${side} asset is not humanoid to the bone map. Missing bones: ${report.missing.join(', ')}. ${report.unmappedCount} joints are unmapped.`);
    }
  }
  return { source, target };
}

/**
 * The source clip (already converted with clipFromGltfAnimation) moved onto the target asset's rest pose. Tracks come back
 * named after the target's joints, so they play like any clip of the target asset.
 */
export function retargetAssetClip(sourceNodes, targetNodes, clip, { scale = 1, rootMotion = true } = {}) {
  return retargetClip(rigFromAssetNodes(sourceNodes), rigFromAssetNodes(targetNodes), clip, { scale, rootMotion });
}
