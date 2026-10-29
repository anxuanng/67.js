"""Composite scanned CC0 leaf atlases into the leaf-card textures used by the vegetation addon.

Inputs are ambientCG LeafSet atlases (1K PNG: Color, Opacity, NormalGL). Each species gets
`public/textures/leaves/<species>/color.webp` (RGBA, alpha = leaf mask) and `normal.webp` (OpenGL tangent space),
plus `crown.webp` for the far level-of-detail clump cards. The stem base sits at the bottom centre of every card,
which is where `addLeafSurface` puts the twig.

Run:
  uv run --no-project --python 3.12 --with pillow --with numpy --with scipy python -I scripts/build-leaf-cards.py <atlas folder>
where <atlas folder> holds LeafSet019/, LeafSet022/ and LeafSet024/ unzipped from ambientcg.com/get?file=LeafSetNNN_1K-PNG.zip.
"""

import math
import random
import sys
from pathlib import Path

import numpy
from PIL import Image, ImageDraw
from scipy import ndimage

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CARD_SIZE = 512
FLAT_NORMAL = (128, 128, 255)
OUTPUT_ROOT = Path(__file__).resolve().parent.parent / "public" / "textures" / "leaves"


class Leaf:
    """One leaf cut from an atlas, upright, with its stem base at the bottom centre of the image."""

    def __init__(self, color, normal):
        self.color = color
        self.normal = normal

    @property
    def length(self):
        return self.color.height


def load_atlas(folder, atlas_name):
    prefix = folder / atlas_name / f"{atlas_name}_1K-PNG"
    color = Image.open(f"{prefix}_Color.png").convert("RGB")
    opacity = Image.open(f"{prefix}_Opacity.png").convert("L")
    normal = Image.open(f"{prefix}_NormalGL.png").convert("RGB")
    return color, opacity, normal


def rotate_normal_pixels(normal_rgba, clockwise_degrees):
    """Rotating an image also rotates its tangent-space normals. Image y points down, GL green points up."""
    pixels = numpy.asarray(normal_rgba).astype(numpy.float32)
    x_component = pixels[..., 0] / 127.5 - 1
    y_component = pixels[..., 1] / 127.5 - 1
    angle = math.radians(clockwise_degrees)
    rotated_x = x_component * math.cos(angle) + y_component * math.sin(angle)
    rotated_y = -x_component * math.sin(angle) + y_component * math.cos(angle)
    pixels[..., 0] = (rotated_x + 1) * 127.5
    pixels[..., 1] = (rotated_y + 1) * 127.5
    return Image.fromarray(numpy.clip(pixels, 0, 255).astype(numpy.uint8), "RGBA")


def rotate_leaf_pair(color_rgba, normal_rgba, clockwise_degrees):
    rotated_color = color_rgba.rotate(-clockwise_degrees, resample=Image.BICUBIC, expand=True)
    rotated_normal = normal_rgba.rotate(-clockwise_degrees, resample=Image.BICUBIC, expand=True)
    return rotated_color, rotate_normal_pixels(rotated_normal, clockwise_degrees)


def cut_leaves(folder, atlas_name, base_side, minimum_pixels=4000):
    """Split an atlas into its separate leaves. `base_side` names the edge each leaf's stem points to."""
    color, opacity, normal = load_atlas(folder, atlas_name)
    mask = numpy.asarray(opacity) > 96
    labels, count = ndimage.label(mask)
    leaves = []
    for index, region in enumerate(ndimage.find_objects(labels), start=1):
        if region is None:
            continue
        component = labels[region] == index
        if component.sum() < minimum_pixels:
            continue
        box = (region[1].start, region[0].start, region[1].stop, region[0].stop)
        alpha = Image.fromarray(numpy.where(component, numpy.asarray(opacity)[region], 0).astype(numpy.uint8), "L")
        leaf_color = color.crop(box).convert("RGBA")
        leaf_color.putalpha(alpha)
        leaf_normal = normal.crop(box).convert("RGBA")
        leaf_normal.putalpha(alpha)
        turn = {"bottom": 0, "right": 90, "left": -90}[base_side]
        if turn:
            leaf_color, leaf_normal = rotate_leaf_pair(leaf_color, leaf_normal, turn)
            trimmed = leaf_color.getbbox()
            leaf_color = leaf_color.crop(trimmed)
            leaf_normal = leaf_normal.crop(trimmed)
        leaves.append(Leaf(leaf_color, leaf_normal))
    return leaves


def new_card():
    color = Image.new("RGBA", (CARD_SIZE, CARD_SIZE), (0, 0, 0, 0))
    normal = Image.new("RGBA", (CARD_SIZE, CARD_SIZE), (*FLAT_NORMAL, 0))
    return color, normal


def tint_image(image, multiplier):
    pixels = numpy.asarray(image).astype(numpy.float32)
    pixels[..., :3] *= numpy.asarray(multiplier, dtype=numpy.float32)
    return Image.fromarray(numpy.clip(pixels, 0, 255).astype(numpy.uint8), "RGBA")


def paint_leaf(card, leaf, base_x, base_y, length, clockwise_degrees, tint=(1, 1, 1)):
    """Paint `leaf` with its stem base at (base_x, base_y), `length` pixels long, leaning clockwise from straight up."""
    card_color, card_normal = card
    scale = length / leaf.length
    width = max(1, round(leaf.color.width * scale))
    height = max(1, round(leaf.color.height * scale))
    color = tint_image(leaf.color.resize((width, height), Image.LANCZOS), tint)
    normal = leaf.normal.resize((width, height), Image.LANCZOS)
    # Pad so the stem base is the image centre, then rotate about it.
    half = math.ceil(max(width, height)) + 2
    padded_color = Image.new("RGBA", (half * 2, half * 2), (0, 0, 0, 0))
    padded_normal = Image.new("RGBA", (half * 2, half * 2), (*FLAT_NORMAL, 0))
    corner = (half - width // 2, half - height)
    padded_color.paste(color, corner)
    padded_normal.paste(normal, corner)
    rotated_color = padded_color.rotate(-clockwise_degrees, resample=Image.BICUBIC)
    rotated_normal = rotate_normal_pixels(padded_normal.rotate(-clockwise_degrees, resample=Image.BICUBIC), clockwise_degrees)
    target = (round(base_x) - half, round(base_y) - half)
    layer_color = Image.new("RGBA", card_color.size, (0, 0, 0, 0))
    layer_color.paste(rotated_color, target)
    layer_normal = Image.new("RGBA", card_normal.size, (*FLAT_NORMAL, 0))
    layer_normal.paste(rotated_normal, target)
    card_color.alpha_composite(layer_color)
    card_normal.alpha_composite(layer_normal)


def paint_stem(card, points, thickness, color):
    card_color, card_normal = card
    ImageDraw.Draw(card_color).line(points, fill=(*color, 255), width=thickness, joint="curve")
    ImageDraw.Draw(card_normal).line(points, fill=(*FLAT_NORMAL, 255), width=thickness, joint="curve")


def bleed_into_transparent(image, background):
    """Copy the nearest leaf colour into transparent pixels so mipmaps and filtering never pull in black fringes."""
    pixels = numpy.asarray(image).copy()
    covered = pixels[..., 3] > 8
    if not covered.any():
        pixels[..., :3] = background
        return Image.fromarray(pixels, "RGBA")
    _, nearest = ndimage.distance_transform_edt(~covered, return_indices=True)
    pixels[..., :3] = pixels[nearest[0], nearest[1], :3]
    return Image.fromarray(pixels, "RGBA")


def save_card(card, species, crown=None):
    folder = OUTPUT_ROOT / species
    folder.mkdir(parents=True, exist_ok=True)
    color, normal = card
    bleed_into_transparent(color, (60, 90, 30)).save(folder / "color.webp", quality=90, method=6, exact=True)
    bleed_into_transparent(normal, FLAT_NORMAL).convert("RGB").save(folder / "normal.webp", quality=92, method=6)
    if crown is not None:
        bleed_into_transparent(crown[0], (40, 70, 25)).save(folder / "crown.webp", quality=88, method=6, exact=True)
    print(f"wrote {folder.relative_to(OUTPUT_ROOT.parent.parent.parent)}")


def build_sprig(leaves, randomness, pairs, leaf_length, tint, stem_color):
    """Alternate leaves along a gently curved twig, largest in the middle, with one leaf at the tip."""
    card = new_card()
    top_y = CARD_SIZE * 0.2
    bend = randomness.uniform(-18, 18)
    stem = [(CARD_SIZE / 2 + bend * (1 - (y / CARD_SIZE)) ** 2, y) for y in numpy.linspace(CARD_SIZE - 1, top_y, 24)]
    paint_stem(card, stem, 6, stem_color)
    for pair in range(pairs):
        progress = (pair + 0.5) / pairs
        stem_index = min(len(stem) - 1, round(progress * (len(stem) - 1) * 0.92))
        base_x, base_y = stem[stem_index]
        size = leaf_length * (0.72 + 0.4 * math.sin(math.pi * (0.25 + progress * 0.7)))
        for side in (-1, 1):
            lean = side * randomness.uniform(58, 82)
            shade = randomness.uniform(0.82, 1.08)
            paint_leaf(card, randomness.choice(leaves), base_x, base_y - (10 if side > 0 else 0), size * randomness.uniform(0.9, 1.08), lean, [tint[channel] * shade for channel in range(3)])
    tip_x, tip_y = stem[-1]
    paint_leaf(card, randomness.choice(leaves), tip_x, tip_y + 8, leaf_length * 0.95, randomness.uniform(-8, 8), tint)
    return card


def build_conifer_spray(sprays, randomness, tint):
    """One long spray up the middle with two short ones close beside its base, so the card reads as a narrow branch tip."""
    card = new_card()
    longest = sorted(sprays, key=lambda spray: spray.length)[-1]
    shorter = sorted(sprays, key=lambda spray: spray.length)[:-1] or [longest]
    for side in (-1, 1):
        paint_leaf(card, randomness.choice(shorter), CARD_SIZE / 2, CARD_SIZE * 0.86, CARD_SIZE * 0.42, side * randomness.uniform(12, 18), [value * 0.85 for value in tint])
    paint_leaf(card, longest, CARD_SIZE / 2, CARD_SIZE - 2, CARD_SIZE * 0.96, randomness.uniform(-4, 4), tint)
    return card


def build_crown(leaves, randomness, count, leaf_length, tint):
    """A dense rounded clump for far crowns: darker toward the lower centre, like a lit canopy."""
    card = new_card()
    centre = CARD_SIZE / 2
    radius = CARD_SIZE * 0.3
    for _ in range(count):
        angle = randomness.uniform(0, math.tau)
        distance = math.sqrt(randomness.random()) * radius
        x = centre + math.cos(angle) * distance
        y = centre + math.sin(angle) * distance * 0.85
        light = 0.62 + 0.45 * (1 - (y - centre + radius) / (2 * radius)) + 0.12 * (distance / radius)
        paint_leaf(card, randomness.choice(leaves), x, y, leaf_length * randomness.uniform(0.8, 1.15), randomness.uniform(0, 360), [value * light for value in tint])
    return card


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    atlas_folder = Path(sys.argv[1])
    randomness = random.Random(67)
    beech = cut_leaves(atlas_folder, "LeafSet024", "bottom")
    laurel = cut_leaves(atlas_folder, "LeafSet022", "bottom")
    sprays = cut_leaves(atlas_folder, "LeafSet019", "right", minimum_pixels=8000)
    print(f"cut {len(beech)} beech leaves, {len(laurel)} laurel leaves, {len(sprays)} conifer sprays")
    bark_brown = (74, 58, 40)

    broadleaf = build_sprig(beech, randomness, pairs=4, leaf_length=132, tint=(0.82, 0.92, 0.72), stem_color=bark_brown)
    broadleaf_crown = build_crown(beech, randomness, count=120, leaf_length=86, tint=(0.72, 0.86, 0.62))
    save_card(broadleaf, "broadleaf", broadleaf_crown)

    birch = build_sprig(beech, randomness, pairs=5, leaf_length=100, tint=(1.0, 1.05, 0.72), stem_color=(92, 70, 50))
    birch_crown = build_crown(beech, randomness, count=140, leaf_length=72, tint=(0.95, 1.0, 0.66))
    save_card(birch, "birch", birch_crown)

    bush = build_sprig(laurel, randomness, pairs=4, leaf_length=160, tint=(0.78, 0.9, 0.7), stem_color=bark_brown)
    bush_crown = build_crown(laurel, randomness, count=110, leaf_length=88, tint=(0.7, 0.84, 0.62))
    save_card(bush, "bush", bush_crown)

    conifer = build_conifer_spray(sprays, randomness, tint=(0.8, 0.92, 0.86))
    conifer_crown = build_crown(sprays, randomness, count=60, leaf_length=130, tint=(0.66, 0.8, 0.72))
    save_card(conifer, "conifer", conifer_crown)


if __name__ == "__main__":
    main()
