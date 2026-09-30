@echo off
rem Start Steam Blender with the BlenderMCP server already running (for DeepSeek Harness).
start "" "C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe" --python "C:\LLM\tools\blender\start_mcp.py"
