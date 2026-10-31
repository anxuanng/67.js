# Scores each 67.js render against Cycles and EEVEE with FLIP, and saves side by side images.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/score.py <work directory> <output directory>
# FLIP is 0 for identical images, and higher means a larger visible difference. EEVEE against Cycles is a yardstick:
# it shows what a good rasterizer scores on the same scene.
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image, ImageDraw

GAMMA = 2.2
LABEL_HEIGHT = 22
PANEL_WIDTH = 480
PANEL_HEIGHT = 270


def tone_map_like_67js(linear):
    """The same curve and gamma as the post-processing shader in src/post.js, so both sides meet in one display space."""
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def flip_score(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def panel(pixels, label):
    image = Image.fromarray((np.clip(pixels, 0, 1) * 255).astype(np.uint8)).resize((PANEL_WIDTH, PANEL_HEIGHT), Image.LANCZOS)
    framed = Image.new("RGB", (PANEL_WIDTH, PANEL_HEIGHT + LABEL_HEIGHT), (20, 20, 20))
    framed.paste(image, (0, LABEL_HEIGHT))
    ImageDraw.Draw(framed).text((6, 5), label, fill=(240, 240, 240))
    return framed


def side_by_side(cycles, eevee, gpu, scores):
    error_map, _, _ = flip_evaluator.evaluate(cycles.astype(np.float32), gpu.astype(np.float32), "LDR", inputsRGB=True)
    panels = [
        panel(cycles, "Cycles"),
        panel(eevee, f"EEVEE (FLIP {scores['eevee-vs-cycles']})"),
        panel(gpu, f"67.js GPU (FLIP {scores['gpu-vs-cycles']})"),
        panel(error_map, "FLIP error, 67.js GPU against Cycles"),
    ]
    sheet = Image.new("RGB", (PANEL_WIDTH * 2, (PANEL_HEIGHT + LABEL_HEIGHT) * 2))
    for index, item in enumerate(panels):
        sheet.paste(item, ((index % 2) * PANEL_WIDTH, (index // 2) * (PANEL_HEIGHT + LABEL_HEIGHT)))
    return sheet


def score_path_tracer(work_directory, output_directory):
    """FLIP of each path traced render against the Cycles render of the same scene, with the time it took."""
    timings = json.loads((work_directory / "pathtracer-timings.json").read_text(encoding="utf-8"))
    results = {}
    for scene_id in sorted(timings):
        cycles = tone_map_like_67js(np.load(work_directory / f"{scene_id}-cycles.npy"))
        traced = load_png(work_directory / f"{scene_id}-pathtracer.png")
        results[scene_id] = {"pathtracer-vs-cycles": flip_score(cycles, traced), **timings[scene_id]}
    report = {"metric": "FLIP (LDR), mean error against Cycles, lower is better", "scores": results}
    (output_directory / "path-tracer.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print("scene".ljust(20) + "pathtracer-vs-cycles".rjust(22) + "seconds".rjust(10))
    for scene_id, entry in results.items():
        print(scene_id.ljust(20) + f"{entry['pathtracer-vs-cycles']:.4f}".rjust(22) + f"{entry['seconds']:.1f}".rjust(10))


def main():
    if "--path-tracer" in sys.argv:
        score_path_tracer(Path(sys.argv[1]), Path(sys.argv[2]))
        return
    work_directory = Path(sys.argv[1])
    output_directory = Path(sys.argv[2])
    images_directory = output_directory / "images"
    images_directory.mkdir(parents=True, exist_ok=True)
    scene_ids = sorted(path.stem for path in (work_directory / "scenes").glob("*.json"))
    results = {}
    for scene_id in scene_ids:
        cycles = tone_map_like_67js(np.load(work_directory / f"{scene_id}-cycles.npy"))
        eevee = tone_map_like_67js(np.load(work_directory / f"{scene_id}-eevee.npy"))
        gpu = load_png(work_directory / f"{scene_id}-gpu.png")
        cpu = load_png(work_directory / f"{scene_id}-cpu.png")
        scores = {
            "gpu-vs-cycles": flip_score(cycles, gpu),
            "gpu-vs-eevee": flip_score(eevee, gpu),
            "cpu-vs-cycles": flip_score(cycles, cpu),
            "cpu-vs-eevee": flip_score(eevee, cpu),
            "eevee-vs-cycles": flip_score(cycles, eevee),
            "gpu-vs-cpu": flip_score(cpu, gpu),
        }
        results[scene_id] = scores
        side_by_side(cycles, eevee, gpu, scores).save(images_directory / f"{scene_id}.jpg", quality=80)
    timings = json.loads((work_directory / "blender-timings.json").read_text(encoding="utf-8"))
    graphics = json.loads((work_directory / "graphics.json").read_text(encoding="utf-8"))
    report = {"metric": "FLIP (LDR), mean error, lower is better", **timings, "graphics": graphics, "scores": results}
    (output_directory / "baseline.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    columns = ["gpu-vs-cycles", "gpu-vs-eevee", "cpu-vs-cycles", "cpu-vs-eevee", "eevee-vs-cycles", "gpu-vs-cpu"]
    print("scene".ljust(20) + "".join(column.rjust(17) for column in columns))
    for scene_id, scores in results.items():
        print(scene_id.ljust(20) + "".join(f"{scores[column]:.4f}".rjust(17) for column in columns))


main()
