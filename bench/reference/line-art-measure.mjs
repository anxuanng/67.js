// Measures outlines from two renders of the same frame, one without lines and one with. The difference of the two is the
// line mask, so shading, sky and tone mapping drop out.
import sharp from 'sharp';

export async function readPixels(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Per pixel: the largest channel change from the frame without lines to the frame with them, 0 to 1.
export function lineStrength(withoutLines, withLines) {
  const strength = new Float32Array(withLines.width * withLines.height);
  for (let pixel = 0; pixel < strength.length; pixel++) {
    let largest = 0;
    for (let channel = 0; channel < 3; channel++) {
      const index = pixel * 3 + channel;
      largest = Math.max(largest, Math.abs(withLines.data[index] - withoutLines.data[index]));
    }
    strength[pixel] = largest / 255;
  }
  return strength;
}

export function lineMask(strength, threshold = 0.15) {
  return strength.map(value => (value >= threshold ? 1 : 0));
}

// Intersection over union of two masks of the same size.
export function maskOverlap(maskA, maskB) {
  let both = 0;
  let either = 0;
  for (let pixel = 0; pixel < maskA.length; pixel++) {
    if (maskA[pixel] && maskB[pixel]) both++;
    if (maskA[pixel] || maskB[pixel]) either++;
  }
  return { intersection: both, union: either, iou: either ? both / either : 1 };
}

// Mask A dilated by `radius` pixels, so a line that sits one or two pixels off still counts as found.
export function dilate(mask, width, height, radius) {
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) result[ny * width + nx] = 1;
        }
      }
    }
  }
  return result;
}

// Line width in pixels across near-vertical edges. Each scan row is cut into runs of line pixels; a run counts only when
// the same edge sits at nearly the same x a few rows further down (a vertical edge, not a diagonal one), and its width is
// the strength summed over the run divided by the strongest pixel in it, so a half covered pixel counts as half.
export function verticalEdgeWidths(strength, width, height, { rowStep = 1, slopeRows = 6, minimum = 0.08 } = {}) {
  const widths = [];
  const runsInRow = row => {
    const runs = [];
    let x = 0;
    while (x < width) {
      if (strength[row * width + x] < minimum) {
        x++;
        continue;
      }
      let end = x;
      let sum = 0;
      let peak = 0;
      let weighted = 0;
      while (end < width && strength[row * width + end] >= minimum) {
        const value = strength[row * width + end];
        sum += value;
        weighted += value * end;
        peak = Math.max(peak, value);
        end++;
      }
      runs.push({ center: weighted / sum, width: sum / peak, length: end - x });
      x = end;
    }
    return runs;
  };
  const margin = Math.round(height * 0.05);
  for (let row = margin; row < height - margin - slopeRows; row += rowStep) {
    const here = runsInRow(row);
    const below = runsInRow(row + slopeRows);
    for (const run of here) {
      const partner = below.find(candidate => Math.abs(candidate.center - run.center) <= 0.1 * slopeRows);
      if (partner && Math.abs(partner.width - run.width) < 0.5) widths.push(run.width);
    }
  }
  widths.sort((a, b) => a - b);
  return widths;
}

export function median(sorted) {
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}
