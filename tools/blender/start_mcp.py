# Run with: blender.exe --python C:\LLM\tools\blender\start_mcp.py
# Opens Blender normally and starts the BlenderMCP socket server (port 9876)
# once the UI is ready, so DeepSeek Harness can drive it without clicking.
import bpy
import traceback

MODULE = "blender_mcp_addon"
REPORT = r"C:\LLM\tools\blender\start-result.txt"


def _write(msg):
    with open(REPORT, "a", encoding="utf-8") as fh:
        fh.write(msg + "\n")


def _start():
    try:
        if MODULE not in bpy.context.preferences.addons:
            bpy.ops.preferences.addon_enable(module=MODULE)
            _write("addon enabled at startup")
        server = getattr(bpy.types, "blendermcp_server", None)
        if not (server and server.running):
            bpy.ops.blendermcp.start_server()
        server = getattr(bpy.types, "blendermcp_server", None)
        _write(f"server running: {bool(server and server.running)} on port {getattr(server, 'port', '?')}")
    except Exception:
        _write("ERROR:\n" + traceback.format_exc())
    return None  # run once


open(REPORT, "w", encoding="utf-8").close()
bpy.app.timers.register(_start, first_interval=2.0)
