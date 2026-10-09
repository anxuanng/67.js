// Components spread in their section's mounting plane, then lift off in ordered rows.
// The base matrices and shared geometry remain assembled and never change.
function sectionLayout(section) {
  const side = section.startsWith('Left ') ? -1 : 1;
  const family = section.replace(/^(Left|Right) /, '');
  const layouts = {
    'Structural frame': { axis: 1, sign: 1, spread: 0.9, tier: 0.14, lift: 0 },
    'Battery cassette': { axis: 1, sign: 1, spread: 1.6, tier: 0.14, lift: 0 },
    'Control electronics': { axis: 1, sign: 1, spread: 1.7, tier: 0.14, lift: 0.1 },
    'Differential drive': { axis: 2, sign: -1, spread: 1.2, tier: 0.14, lift: 0.55 },
    'Front compactor panel': { axis: 2, sign: 1, spread: 1, tier: 0.05, lift: 0.2 },
    'Rear service panel': { axis: 2, sign: -1, spread: 1, tier: 0.08, lift: 0.2 },
    'Roof panel': { axis: 1, sign: 1, spread: 1, tier: 0.18, lift: 0 },
    'body panel': { axis: 0, sign: side, spread: 1, tier: 0.12, lift: 0.4 },
    'track assembly': { axis: 0, sign: side, spread: 1.7, tier: 0.1, lift: 0.72 },
    'arm and claw': { axis: 0, sign: side, spread: 1.3, tier: 0.1, lift: 0.5 },
    'Neck linkage': { axis: 1, sign: 1, spread: 1.4, tier: 0.14, lift: 0 },
    'eye housing': { axis: 2, sign: -1, spread: 1.4, tier: 0.14, lift: 0.08 },
    'optical mechanism': { axis: 2, sign: 1, spread: 1.4, tier: 0.14, lift: 0.15 },
    'lens assembly': { axis: 2, sign: 1, spread: 1.8, tier: 0.14, lift: 0.1 },
  };
  const layout = layouts[family];
  if (!layout) throw new Error(`No detail layout for assembly section: ${section}`);
  return layout;
}

// Steel shoes and wide rubber pads need separate axial lanes; the wheel stack stays nearby.
const trackLanes = {
  'Caterpillar steel shoe': 0.18,
  'Caterpillar rubber traction pad': 0.65,
  'Track sprocket drum': 0.12,
  'Track exposed wheel disc': 0.49,
  'Track wheel rim': 0.58,
  'Track wheel hub': 0.72,
  'Track hub retaining bolt': 0.86,
  'Track wheel bolt': 1,
  'Track tension beam': 1.2,
};

export function assemblyOffset(part, amount = 0) {
  if (!Number.isFinite(amount)) throw new TypeError('Assembly amount must be finite');
  const progress = Math.max(0, Math.min(1, amount));
  if (progress === 0) return [0, 0, 0];
  const detailProgress = Math.max(0, Math.min(1, (progress - 0.3) / 0.7));
  const detailAmount = detailProgress * detailProgress * (3 - 2 * detailProgress);
  const offset = part.assembly?.offset ?? [0, 0, 0];
  const detailOffset = part.assembly?.detailOffset ?? [0, 0, 0];
  return offset.map((value, axis) => value * progress + detailOffset[axis] * detailAmount);
}

export function addDetailOffsets(parts) {
  const sections = new Map();
  for (const part of parts) {
    const section = part.assembly.section;
    if (!sections.has(section)) {
      sections.set(section, { minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity], families: new Map(), layout: sectionLayout(section) });
    }
    const state = sections.get(section);
    for (let axis = 0; axis < 3; axis++) {
      state.minimum[axis] = Math.min(state.minimum[axis], part.matrix[12 + axis]);
      state.maximum[axis] = Math.max(state.maximum[axis], part.matrix[12 + axis]);
    }
  }
  return parts.map(part => {
    const state = sections.get(part.assembly.section);
    const { layout } = state;
    if (!state.families.has(part.name)) {
      state.families.set(part.name, { tier: state.families.size, count: 0 });
    }
    const family = state.families.get(part.name);
    const detailOffset = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      if (axis !== layout.axis) {
        const center = (state.minimum[axis] + state.maximum[axis]) / 2;
        detailOffset[axis] = (part.matrix[12 + axis] - center) * layout.spread;
      }
    }
    const lane = part.assembly.section.endsWith('track assembly') ? trackLanes[part.name] : undefined;
    detailOffset[layout.axis] = layout.sign * ((lane ?? 0.12 + family.tier * layout.tier) + family.count * 0.018);
    detailOffset[1] += layout.lift;
    family.count++;
    return { ...part, assembly: { ...part.assembly, detailOffset } };
  });
}
