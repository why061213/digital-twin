import math
import os

import bpy
from mathutils import Vector


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DESIGN_DIR = os.path.join(ROOT, "design", "models")
PUBLIC_DIR = os.path.join(ROOT, "public", "models")
BLEND_PATH = os.path.join(DESIGN_DIR, "rm2-truck.blend")
PREVIEW_PATH = os.path.join(DESIGN_DIR, "rm2-truck-preview.png")
GLB_PATH = os.path.join(PUBLIC_DIR, "rm2-truck.glb")


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def material(name, color, metallic=0.0, roughness=0.5, emission=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None and "Emission" in bsdf.inputs:
        bsdf.inputs["Emission"].default_value = emission
    return mat


def add_box(name, dimensions, location, mat, bevel=0.08, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        modifier = obj.modifiers.new("Soft edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.data.materials.append(mat)
    obj.parent = parent
    return obj


def add_wheel(name, x, y, tire_mat, hub_mat, parent):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16,
        radius=0.56,
        depth=0.34,
        location=(x, y, 0.62),
        rotation=(0, math.pi / 2, 0),
    )
    tire = bpy.context.object
    tire.name = name
    tire.data.materials.append(tire_mat)
    tire.parent = parent
    for polygon in tire.data.polygons:
        polygon.use_smooth = True

    outer_x = x + (0.19 if x > 0 else -0.19)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16,
        radius=0.25,
        depth=0.035,
        location=(outer_x, y, 0.62),
        rotation=(0, math.pi / 2, 0),
    )
    hub = bpy.context.object
    hub.name = name + "_hub"
    hub.data.materials.append(hub_mat)
    hub.parent = parent
    for polygon in hub.data.polygons:
        polygon.use_smooth = True
    return [tire, hub]


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def build_truck():
    clear_scene()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    body_blue = material("Fleet blue", (0.025, 0.34, 0.58, 1), metallic=0.15, roughness=0.32)
    body_dark = material("Lower body", (0.018, 0.09, 0.14, 1), metallic=0.35, roughness=0.3)
    cargo_silver = material("Cargo silver", (0.52, 0.62, 0.68, 1), metallic=0.45, roughness=0.28)
    cargo_side = material("Cargo side", (0.18, 0.27, 0.32, 1), metallic=0.25, roughness=0.34)
    glass = material("Glass", (0.015, 0.11, 0.17, 1), metallic=0.15, roughness=0.12)
    tire_mat = material("Tire", (0.008, 0.01, 0.012, 1), roughness=0.72)
    hub_mat = material("Wheel hub", (0.42, 0.48, 0.52, 1), metallic=0.85, roughness=0.18)
    cyan = material("Visibility cyan", (0.0, 0.75, 0.9, 1), metallic=0.15, roughness=0.24, emission=(0.0, 0.18, 0.24, 1))
    headlight = material("Headlight", (0.9, 0.96, 1.0, 1), metallic=0.05, roughness=0.14, emission=(0.8, 0.9, 1.0, 1))
    taillight = material("Taillight", (0.8, 0.025, 0.02, 1), roughness=0.2, emission=(0.5, 0.0, 0.0, 1))

    root = bpy.data.objects.new("RM2_TRUCK", None)
    root.empty_display_type = "CUBE"
    root.empty_display_size = 0.5
    bpy.context.collection.objects.link(root)

    truck_objects = [root]
    truck_objects += [
        add_box("Chassis", (2.35, 11.45, 0.34), (0, 0.05, 0.70), body_dark, 0.07, root),
        add_box("CargoBox", (2.52, 7.25, 3.18), (0, 1.50, 2.30), cargo_silver, 0.12, root),
        add_box("CargoSidePanel", (2.56, 6.72, 2.62), (0, 1.47, 2.27), cargo_side, 0.07, root),
        add_box("Cab", (2.50, 3.35, 2.75), (0, -4.08, 2.05), body_blue, 0.16, root),
        add_box("CabLower", (2.56, 3.52, 0.74), (0, -4.02, 0.95), body_dark, 0.10, root),
        add_box("FrontBumper", (2.64, 0.28, 0.32), (0, -5.84, 0.62), hub_mat, 0.06, root),
        add_box("RearBumper", (2.48, 0.25, 0.28), (0, 5.55, 0.63), hub_mat, 0.05, root),
        add_box("Windshield", (2.14, 0.055, 0.92), (0, -5.765, 2.62), glass, 0.035, root),
        add_box("RoofMarker", (1.30, 0.38, 0.16), (0, -5.15, 3.50), cyan, 0.06, root),
        add_box("CargoStripeLeft", (0.035, 6.30, 0.18), (-1.295, 1.46, 2.32), cyan, 0.025, root),
        add_box("CargoStripeRight", (0.035, 6.30, 0.18), (1.295, 1.46, 2.32), cyan, 0.025, root),
    ]

    for side in (-1, 1):
        x = side * 1.276
        truck_objects.append(add_box(
            "SideWindowL" if side < 0 else "SideWindowR",
            (0.045, 1.18, 0.80),
            (x, -4.73, 2.55),
            glass,
            0.025,
            root,
        ))
        truck_objects.append(add_box(
            "MirrorL" if side < 0 else "MirrorR",
            (0.16, 0.34, 0.32),
            (side * 1.39, -5.20, 2.46),
            body_dark,
            0.035,
            root,
        ))
        truck_objects.append(add_box(
            "HeadlightL" if side < 0 else "HeadlightR",
            (0.50, 0.065, 0.27),
            (side * 0.78, -5.91, 1.12),
            headlight,
            0.04,
            root,
        ))
        truck_objects.append(add_box(
            "TaillightL" if side < 0 else "TaillightR",
            (0.36, 0.055, 0.30),
            (side * 0.82, 5.69, 0.92),
            taillight,
            0.035,
            root,
        ))

    for axle_index, axle_y in enumerate((-3.92, 2.92, 4.25)):
        for side in (-1, 1):
            truck_objects.extend(add_wheel(
                "Wheel_%d_%s" % (axle_index, "L" if side < 0 else "R"),
                side * 1.13,
                axle_y,
                tire_mat,
                hub_mat,
                root,
            ))

    # A small roof beacon makes the silhouette readable after map-scale exaggeration.
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.18, depth=0.20, location=(0, -4.55, 3.56))
    beacon = bpy.context.object
    beacon.name = "RoofBeacon"
    beacon.data.materials.append(cyan)
    beacon.parent = root
    truck_objects.append(beacon)

    for obj in truck_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root

    os.makedirs(DESIGN_DIR, exist_ok=True)
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=GLB_PATH,
        export_format="GLB",
        export_selected=True,
        export_apply=True,
        export_yup=True,
    )

    # Preview-only floor, camera and lights are excluded from the GLB export.
    ground_mat = material("Preview ground", (0.018, 0.026, 0.038, 1), metallic=0.0, roughness=0.78)
    add_box("PreviewGround", (24, 24, 0.12), (0, 0, -0.08), ground_mat, 0)

    bpy.ops.object.light_add(type="AREA", location=(7, -9, 12))
    key = bpy.context.object
    key.name = "KeyLight"
    key.data.energy = 1100
    key.data.size = 7
    look_at(key, (0, 0, 1.5))

    bpy.ops.object.light_add(type="AREA", location=(-8, 2, 7))
    fill = bpy.context.object
    fill.name = "FillLight"
    fill.data.energy = 700
    fill.data.size = 8
    look_at(fill, (0, 0, 1.8))

    bpy.ops.object.camera_add(location=(14.5, -17.5, 10.5))
    camera = bpy.context.object
    camera.name = "PreviewCamera"
    camera.data.lens = 58
    look_at(camera, (0, 0, 1.55))
    scene.camera = camera

    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.use_gtao = True
    scene.eevee.gtao_distance = 3
    scene.eevee.gtao_factor = 1.25
    scene.render.resolution_x = 960
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = PREVIEW_PATH
    scene.view_settings.look = "Medium High Contrast"
    scene.world.color = (0.008, 0.012, 0.02)

    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
    bpy.ops.render.render(write_still=True)

    mesh_objects = [obj for obj in truck_objects if obj.type == "MESH"]
    triangle_count = sum(len(obj.data.polygons) for obj in mesh_objects)
    print("RM2 truck generated")
    print("BLEND=" + BLEND_PATH)
    print("GLB=" + GLB_PATH)
    print("PREVIEW=" + PREVIEW_PATH)
    print("MESH_OBJECTS=%d" % len(mesh_objects))
    print("POLYGONS=%d" % triangle_count)


if __name__ == "__main__":
    build_truck()
