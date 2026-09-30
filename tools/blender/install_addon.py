# Run with: blender.exe --background --python C:\LLM\tools\blender\install_addon.py
# Installs + enables the BlenderMCP addon, turns telemetry off, saves user prefs,
# and writes a small report to C:\LLM\tools\blender\install-result.txt.
import bpy
import os
import traceback

SRC = r"C:\LLM\tools\blender\blender_mcp_addon.py"
MODULE = "blender_mcp_addon"
REPORT = r"C:\LLM\tools\blender\install-result.txt"

lines = [f"blender {bpy.app.version_string}"]
try:
    bpy.ops.preferences.addon_install(filepath=SRC, overwrite=True)
    lines.append("addon_install: ok")
    bpy.ops.preferences.addon_enable(module=MODULE)
    lines.append("addon_enable: ok")
    addon = bpy.context.preferences.addons.get(MODULE)
    if addon and hasattr(addon.preferences, "telemetry_consent"):
        addon.preferences.telemetry_consent = False
        lines.append("telemetry_consent: False")
    bpy.context.preferences.use_preferences_save = True
    bpy.ops.wm.save_userpref()
    lines.append("save_userpref: ok")
    addons_dir = bpy.utils.user_resource("SCRIPTS", path="addons")
    lines.append(f"user addons dir: {addons_dir}")
    lines.append(f"addon file present: {os.path.exists(os.path.join(addons_dir, MODULE + '.py'))}")
    lines.append(f"enabled now: {MODULE in bpy.context.preferences.addons}")
except Exception:
    lines.append("ERROR:\n" + traceback.format_exc())

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
