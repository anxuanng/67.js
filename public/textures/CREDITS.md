# Texture and HDRI credits

Every file under `public/textures/` and `public/hdri/` comes from [Poly Haven](https://polyhaven.com) or [ambientCG](https://ambientcg.com) and is released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): free for any use, no attribution required. The authors are
credited here anyway.

The 1K JPG maps were downloaded through the Poly Haven API on 2026-10-29, checked against its MD5 sums and re-encoded to WebP.
Per folder: `color` (base color, sRGB), `normal` (OpenGL convention, linear), `roughness` (linear) and, for ground layers,
`height` (displacement, linear, used to blend layer edges).

| Folder | Asset | Authors |
| --- | --- | --- |
| `leafy_grass` | [Leafy Grass](https://polyhaven.com/a/leafy_grass) | Charlotte Baglioni |
| `forest_ground_04` | [Forest Ground 04](https://polyhaven.com/a/forest_ground_04) | Rob Tuytel, Rico Cilliers |
| `brown_mud_leaves_01` | [Brown Mud Leaves 01](https://polyhaven.com/a/brown_mud_leaves_01) | Rob Tuytel |
| `aerial_rocks_02` | [Aerial Rocks 02](https://polyhaven.com/a/aerial_rocks_02) | Rob Tuytel |
| `bark_willow_02` | [Bark Willow 02](https://polyhaven.com/a/bark_willow_02) | Charlotte Baglioni |
| `pine_bark` | [Pine Bark](https://polyhaven.com/a/pine_bark) | Dimitrios Savva |
| `palm_tree_bark` | [Palm Tree Bark](https://polyhaven.com/a/palm_tree_bark) | Dimitrios Savva, Rico Cilliers |
| `hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr` | [Kloofendal 48d Partly Cloudy (Pure Sky)](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | Greg Zaal, Jarod Guest |

## Leaf cards (`leaves/`)

`leaves/<species>/{color,normal,crown}.webp` are composited by `scripts/build-leaf-cards.py` from three ambientCG leaf
atlases (1K PNG, downloaded 2026-10-29), all CC0 1.0 by Lennart Demes / ambientCG:

| Species folders | Atlas |
| --- | --- |
| `broadleaf`, `birch` | [LeafSet024](https://ambientcg.com/view?id=LeafSet024) |
| `bush` | [LeafSet022](https://ambientcg.com/view?id=LeafSet022) |
| `conifer` | [LeafSet019](https://ambientcg.com/view?id=LeafSet019) |
