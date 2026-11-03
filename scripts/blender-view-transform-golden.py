# Writes tests/fixtures/blender/view-transform-golden.json: Blender's AgX and Khronos PBR Neutral view transforms applied
# to a ramp of linear colours. Each colour is an emissive plane seen by an orthographic camera, so the scene-linear value
# reaches the view transform unchanged; the render is saved as a 16-bit PNG with the view transform applied and read back.
# Run it when Blender moves to a new release (through the GPU lock, Cycles runs on the CPU here):
#   blender -b --factory-startup -t 6 --python scripts/blender-view-transform-golden.py
import json
import tempfile
from pathlib import Path

import bpy

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "blender" / "view-transform-golden.json"
PATCH_PIXELS = 16
VIEW_TRANSFORMS = {"agx": "AgX", "neutral": "Khronos PBR Neutral"}
GREY_LEVELS = [0.0, 0.002, 0.01, 0.03, 0.09, 0.18, 0.36, 0.5, 0.76, 1.0, 1.5, 2.0, 4.0, 8.0, 16.0]
COLORS = [
    [0.8, 0.1, 0.05], [0.05, 0.6, 0.1], [0.05, 0.1, 0.8], [0.9, 0.7, 0.1], [0.1, 0.7, 0.8],
    [0.6, 0.15, 0.5], [2.0, 0.8, 0.1], [0.2, 4.0, 0.3], [5.0, 0.1, 0.1], [0.5, 0.35, 0.25],
    [0.04, 0.02, 0.01], [3.0, 3.0, 1.0],
]
PATCHES = [[level, level, level] for level in GREY_LEVELS] + COLORS


def build_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 8
    scene.cycles.use_denoising = False
    scene.cycles.filter_width = 0.01
    scene.render.resolution_x = PATCH_PIXELS * len(PATCHES)
    scene.render.resolution_y = PATCH_PIXELS
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "16"
    scene.render.image_settings.color_mode = "RGB"
    scene.display_settings.display_device = "sRGB"
    world = bpy.data.worlds.new("black")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0, 0, 0, 1)
    scene.world = world
    camera_data = bpy.data.cameras.new("camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = len(PATCHES)
    camera = bpy.data.objects.new("camera", camera_data)
    camera.location = (len(PATCHES) / 2, 0, 5)
    scene.collection.objects.link(camera)
    scene.camera = camera
    for index, color in enumerate(PATCHES):
        mesh = bpy.data.meshes.new(f"patch{index}")
        mesh.from_pydata([(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)], [], [(0, 1, 2, 3)])
        plane = bpy.data.objects.new(f"patch{index}", mesh)
        plane.location = (index + 0.5, 0, 0)
        scene.collection.objects.link(plane)
        material = bpy.data.materials.new(f"patch{index}")
        material.use_nodes = True
        nodes = material.node_tree.nodes
        nodes.clear()
        emission = nodes.new("ShaderNodeEmission")
        emission.inputs["Color"].default_value = (color[0], color[1], color[2], 1)
        emission.inputs["Strength"].default_value = 1.0
        output = nodes.new("ShaderNodeOutputMaterial")
        material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
        mesh.materials.append(material)
    return scene


def render_patches(scene, view_transform, directory):
    scene.view_settings.view_transform = view_transform
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    path = str(Path(directory) / (view_transform.replace(" ", "_") + ".png"))
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(path)
    image.colorspace_settings.name = "Non-Color"
    pixels = list(image.pixels)
    width = image.size[0]
    results = []
    for index in range(len(PATCHES)):
        x = index * PATCH_PIXELS + PATCH_PIXELS // 2
        y = PATCH_PIXELS // 2
        offset = (y * width + x) * 4
        results.append([round(pixels[offset + channel], 6) for channel in range(3)])
    bpy.data.images.remove(image)
    return results


def main():
    scene = build_scene()
    golden = {"blenderVersion": bpy.app.version_string, "displayDevice": "sRGB", "patches": [{"input": color} for color in PATCHES]}
    with tempfile.TemporaryDirectory() as directory:
        for name, view_transform in VIEW_TRANSFORMS.items():
            for patch, encoded in zip(golden["patches"], render_patches(scene, view_transform, directory)):
                patch[name] = encoded
    OUTPUT_PATH.write_text(json.dumps(golden, indent=1) + "\n", encoding="utf-8")
    print("wrote", OUTPUT_PATH, golden["blenderVersion"])


main()
