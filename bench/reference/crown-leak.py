# Counts the crown pixels of `foliage` that 67js lights with the sun and Cycles leaves in shadow.
#   uv run --no-project --with numpy --with pillow python bench/reference/crown-leak.py <work directory> <67js --ambient 0 png>
# Needs <work directory>/foliage-cycles.npy (full light, to find the crown) and foliage-cycles-world0.npy (sun only, the true
# shadow mask; render it with render-blender.py ... --world-strength 0 foliage). Prints the counts and writes leak.png beside the PNG:
# red = leak, grey = lit on both sides, blue = lit only in Cycles, dark grey = the rest of the crown.
import sys
from pathlib import Path

import numpy as np
from PIL import Image

GAMMA = 2.2
CROWN_ROWS = 0.62
CYCLES_SHADOWED_BELOW = 0.02
GPU_LIT_ABOVE = 0.01
SILHOUETTE_REACH = 2
LUMINANCE_WEIGHTS = np.array([0.2126, 0.7152, 0.0722], np.float32)


def tone_map_like_67js(linear):
    """The curve of src/post.js, as in score.py (which cannot be imported: it scores on import). Returns display values."""
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def tone_mapped_luminance(display):
    return (display ** GAMMA) @ LUMINANCE_WEIGHTS


def near_any(mask, reach):
    """True where a pixel of mask lies within reach pixels (a square window)."""
    padded = np.pad(mask, reach)
    grown = np.zeros_like(mask)
    for row_shift in range(2 * reach + 1):
        for column_shift in range(2 * reach + 1):
            grown |= padded[row_shift:row_shift + mask.shape[0], column_shift:column_shift + mask.shape[1]]
    return grown


def main():
    work_directory = Path(sys.argv[1])
    gpu_path = Path(sys.argv[2])
    cycles_full = tone_map_like_67js(np.load(work_directory / "foliage-cycles.npy"))
    cycles_sun = tone_map_like_67js(np.load(work_directory / "foliage-cycles-world0.npy"))
    gpu_sun = np.asarray(Image.open(gpu_path).convert("RGB"), dtype=np.float32) / 255

    red, green, blue = cycles_full[..., 0], cycles_full[..., 1], cycles_full[..., 2]
    upper_rows = np.zeros(green.shape, bool)
    upper_rows[: int(green.shape[0] * CROWN_ROWS)] = True
    crown = upper_rows & (((green >= red) & (green >= blue)) | (cycles_full.max(-1) < 0.25))

    cycles_shadowed = crown & (tone_mapped_luminance(cycles_sun) < CYCLES_SHADOWED_BELOW)
    cycles_lit = crown & ~cycles_shadowed
    gpu_lit = crown & (tone_mapped_luminance(gpu_sun) > GPU_LIT_ABOVE)
    leak = gpu_lit & cycles_shadowed
    beside_lit_leaf = near_any(cycles_lit, SILHOUETTE_REACH)

    print(f"crown pixels {crown.sum()}")
    print(f"sun-lit: Cycles {cycles_lit.sum()}, 67js {gpu_lit.sum()}, both {(cycles_lit & gpu_lit).sum()}, Cycles only {(cycles_lit & ~gpu_lit).sum()}")
    print(f"leak (67js lit, Cycles shadowed) {leak.sum()}")
    print(f"  within {SILHOUETTE_REACH} px of a pixel Cycles lights (silhouette and placement): {(leak & beside_lit_leaf).sum()}")
    print(f"  farther away (shadow that 67js does not cast): {(leak & ~beside_lit_leaf).sum()}")

    picture = np.zeros(leak.shape + (3,), np.uint8)
    picture[crown] = 60
    picture[cycles_lit & gpu_lit] = (200, 200, 200)
    picture[cycles_lit & ~gpu_lit] = (0, 120, 255)
    picture[leak] = (255, 0, 0)
    Image.fromarray(picture).save(gpu_path.with_name("leak.png"))


main()
