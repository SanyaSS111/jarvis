@echo off
rem One-time: install + enable the BlenderMCP addon in Steam Blender (writes the real %APPDATA% prefs).
"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe" --background --python "C:\LLM\tools\blender\install_addon.py"
