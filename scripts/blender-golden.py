# Runs each case in tests/fixtures/blender/cases.json in Blender and writes the results to golden.json beside it.
# Run it when a case changes or Blender moves to a new release:
#   blender -b --factory-startup --python scripts/blender-golden.py
import json
from math import cos, radians, sqrt
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

FIXTURE_DIRECTORY = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "blender"
DEFAULT_MAX_ANGLE = 10
ANGLE_EPSILON = 1e-9


def new_bmesh(mesh_input):
    bm = bmesh.new()
    vertices = [bm.verts.new(position) for position in mesh_input["vertices"]]
    for face in mesh_input["faces"]:
        bm.faces.new([vertices[index] for index in face])
    refresh(bm)
    return bm


def refresh(bm):
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()


def new_object(name, mesh_input):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(mesh_input["vertices"], [], mesh_input["faces"])
    mesh.update()
    mesh_object = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(mesh_object)
    return mesh_object


def selected_faces(bm, rule):
    if "faces" in rule:
        return [bm.faces[index] for index in rule["faces"]]
    if "normal" in rule:
        direction = Vector(rule["normal"]).normalized()
        limit = cos(radians(rule.get("maxAngle", DEFAULT_MAX_ANGLE))) - ANGLE_EPSILON
        return [face for face in bm.faces if face.normal.dot(direction) >= limit]
    raise ValueError(f"Unsupported face rule: {rule}")


def selected_edges(bm, rule):
    if rule.get("all"):
        return [edge for edge in bm.edges if len(edge.link_faces) == 2]
    if "along" in rule:
        direction = Vector(rule["along"]).normalized()
        limit = cos(radians(rule.get("maxAngle", DEFAULT_MAX_ANGLE))) - ANGLE_EPSILON
        return [edge for edge in bm.edges if edge_is_along(edge, direction, limit)]
    if "boundaryOf" in rule:
        inside = set(selected_faces(bm, rule["boundaryOf"]))
        return [edge for edge in bm.edges if edge_crosses(edge, inside)]
    if "between" in rule:
        first = set(selected_faces(bm, rule["between"][0]))
        second = set(selected_faces(bm, rule["between"][1]))
        return [edge for edge in bm.edges if edge_joins(edge, first, second)]
    raise ValueError(f"Unsupported edge rule: {rule}")


def edge_is_along(edge, direction, limit):
    vector = (edge.verts[1].co - edge.verts[0].co).normalized()
    return abs(vector.dot(direction)) >= limit


def edge_crosses(edge, inside):
    faces = edge.link_faces
    return len(faces) == 2 and (faces[0] in inside) != (faces[1] in inside)


def edge_joins(edge, first, second):
    faces = edge.link_faces
    if len(faces) != 2:
        return False
    return (faces[0] in first and faces[1] in second) or (faces[1] in first and faces[0] in second)


def area_weighted_normal(faces):
    total = Vector((0, 0, 0))
    for face in faces:
        total += face.normal * face.calc_area()
    return total.normalized()


def move(bm, vertices, offset):
    bmesh.ops.translate(bm, verts=list(vertices), vec=offset)


def extrude_face_region(bm, edit):
    faces = selected_faces(bm, edit["select"])
    normal = area_weighted_normal(faces)
    result = bmesh.ops.extrude_face_region(bm, geom=faces)
    new_vertices = [element for element in result["geom"] if isinstance(element, bmesh.types.BMVert)]
    move(bm, new_vertices, normal * edit["offset"])
    # Blender keeps the source faces when the extrusion is not a closed region. The operator in the editor removes them.
    bmesh.ops.delete(bm, geom=faces, context="FACES")


def extrude_individual(bm, edit):
    faces = selected_faces(bm, edit["select"])
    normals = [face.normal.copy() for face in faces]
    result = bmesh.ops.extrude_discrete_faces(bm, faces=faces)
    for face, normal in zip(result["faces"], normals):
        move(bm, face.verts, normal * edit["offset"])


def inset_region(bm, edit):
    faces = selected_faces(bm, edit["select"])
    # The editor's Inset Faces turns use_boundary on, and the operator's own default is off.
    bmesh.ops.inset_region(
        bm,
        faces=faces,
        thickness=edit["thickness"],
        depth=edit.get("depth", 0),
        use_even_offset=True,
        use_boundary=True,
    )


def inset_individual(bm, edit):
    faces = selected_faces(bm, edit["select"])
    bmesh.ops.inset_individual(bm, faces=faces, thickness=edit["thickness"], depth=edit.get("depth", 0), use_even_offset=True)


def bevel(bm, edit):
    edges = selected_edges(bm, edit["edges"])
    vertices = {vertex for edge in edges for vertex in edge.verts}
    bmesh.ops.bevel(
        bm,
        geom=edges + list(vertices),
        offset=edit["width"],
        offset_type="OFFSET",
        profile_type="SUPERELLIPSE",
        segments=edit.get("segments", 1),
        profile=edit.get("profile", 0.5),
        affect="EDGES",
        clamp_overlap=edit.get("clampOverlap", True),
        loop_slide=True,
    )


def low_vertex_first(edge):
    first, second = edge.verts
    return tuple(first.co) <= tuple(second.co)


def loop_cut(bm, edit):
    edges = selected_edges(bm, edit["edges"])
    cuts = edit.get("cuts", 1)
    factor = edit.get("factor", 0.5)
    edge_percents = {}
    if cuts == 1 and factor != 0.5:
        edge_percents = {edge: factor if low_vertex_first(edge) else 1 - factor for edge in edges}
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=cuts, use_grid_fill=True, edge_percents=edge_percents)


BMESH_OPERATIONS = {
    "extrude_face_region": extrude_face_region,
    "extrude_individual": extrude_individual,
    "inset_region": inset_region,
    "inset_individual": inset_individual,
    "bevel": bevel,
    "loop_cut": loop_cut,
}


def add_mirror(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Mirror", "MIRROR")
    axis = "xyz".index(edit.get("axis", "x"))
    modifier.use_axis = [index == axis for index in range(3)]
    modifier.use_mirror_merge = True
    modifier.merge_threshold = edit.get("merge", 0.001)


def add_array(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Array", "ARRAY")
    modifier.fit_type = "FIXED_COUNT"
    modifier.count = edit.get("count", 2)
    modifier.use_relative_offset = True
    modifier.relative_offset_displace = edit.get("relativeOffset", [1, 0, 0])
    modifier.use_constant_offset = True
    modifier.constant_offset_displace = edit.get("offset", [0, 0, 0])
    merge = edit.get("merge", 0)
    modifier.use_merge_vertices = merge > 0
    modifier.merge_threshold = merge


def add_solidify(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Solidify", "SOLIDIFY")
    modifier.solidify_mode = "EXTRUDE"
    modifier.thickness = edit["thickness"]
    modifier.offset = edit.get("offset", -1)
    modifier.use_even_offset = edit.get("evenThickness", True)
    modifier.use_rim = True


def add_boolean(mesh_object, edit, inputs):
    cutter = new_object("Cutter", inputs[edit["cutter"]["type"]])
    cutter.location = edit.get("translation", [0, 0, 0])
    cutter.scale = edit.get("scale", [1, 1, 1])
    cutter.hide_render = True
    modifier = mesh_object.modifiers.new("Boolean", "BOOLEAN")
    modifier.operation = edit["operation"].upper()
    modifier.solver = "MANIFOLD"
    modifier.object = cutter


MODIFIERS = {
    "mirror": add_mirror,
    "array": add_array,
    "solidify": add_solidify,
    "boolean": add_boolean,
}


def run_bmesh_case(case, inputs):
    bm = new_bmesh(inputs[case["input"]])
    BMESH_OPERATIONS[case["edit"]["op"]](bm, case["edit"])
    refresh(bm)
    return bm


def run_modifier_case(case, inputs):
    mesh_object = new_object("Input", inputs[case["input"]])
    MODIFIERS[case["edit"]["op"]](mesh_object, case["edit"], inputs)
    bpy.context.view_layer.update()
    evaluated = mesh_object.evaluated_get(bpy.context.evaluated_depsgraph_get())
    bm = bmesh.new()
    bm.from_mesh(evaluated.to_mesh())
    refresh(bm)
    evaluated.to_mesh_clear()
    return bm


def fan_triangles(face):
    corners = [vertex.co for vertex in face.verts]
    for index in range(1, len(corners) - 1):
        yield corners[0], corners[index], corners[index + 1]


def measure(bm):
    volume = 0.0
    area = 0.0
    for face in bm.faces:
        # Summing signed triangles keeps both measures right on a concave face.
        vector_area = Vector((0, 0, 0))
        for first, second, third in fan_triangles(face):
            volume += first.dot(second.cross(third)) / 6
            vector_area += (second - first).cross(third - first) / 2
        area += vector_area.length
    positions = [list(vertex.co) for vertex in bm.verts]
    face_sizes = {}
    for face in bm.faces:
        size = str(len(face.verts))
        face_sizes[size] = face_sizes.get(size, 0) + 1
    return {
        "vertexCount": len(bm.verts),
        "edgeCount": len(bm.edges),
        "faceCount": len(bm.faces),
        "faceSizes": dict(sorted(face_sizes.items(), key=lambda entry: int(entry[0]))),
        "volume": round(abs(volume), 6),
        "area": round(area, 6),
        "positions": sorted([round(value, 5) for value in position] for position in positions),
    }


def remove_all_objects():
    for mesh_object in list(bpy.data.objects):
        bpy.data.objects.remove(mesh_object)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)


def main():
    fixture = json.loads((FIXTURE_DIRECTORY / "cases.json").read_text(encoding="utf-8"))
    results = {}
    for case in fixture["cases"]:
        remove_all_objects()
        operation = case["edit"]["op"]
        runner = run_bmesh_case if operation in BMESH_OPERATIONS else run_modifier_case
        bm = runner(case, fixture["inputs"])
        results[case["id"]] = measure(bm)
        bm.free()
    output = {"blenderVersion": bpy.app.version_string, "results": results}
    (FIXTURE_DIRECTORY / "golden.json").write_text(json.dumps(output, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(results)} results from Blender {bpy.app.version_string}.")


main()
