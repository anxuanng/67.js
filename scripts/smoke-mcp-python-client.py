"""Drive scripts/mcp-server.mjs through the official MCP Python SDK client.

Usage: python -I smoke-mcp-python-client.py <node> <server script> <recipe json>
"""
import asyncio
import base64
import json
import sys
import time

import mcp
from mcp.client.stdio import stdio_client

EXPECTED_TOOL_COUNT = 22
PNG_SIGNATURE = bytes([137, 80, 78, 71, 13, 10, 26, 10])


async def run(node_path, server_script, recipe_path):
    with open(recipe_path, encoding="utf-8") as recipe_file:
        recipe = json.load(recipe_file)
    parameters = mcp.StdioServerParameters(
        command=node_path,
        args=[server_script, "--backend", "cpu", "--memory", "192"],
    )
    async with stdio_client(parameters) as (read_stream, write_stream):
        async with mcp.ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            listing = await session.list_tools()
            assert len(listing.tools) == EXPECTED_TOOL_COUNT, len(listing.tools)
            created = await session.call_tool("scene_create", {"recipe": recipe})
            assert not created.is_error, created.content
            look = await session.call_tool("scene_look", {"width": 256, "height": 192})
            assert not look.is_error, look.content
            images = [block for block in look.content if block.type == "image"]
            assert len(images) == 1, "scene_look returned no image"
            assert images[0].mime_type == "image/png"
            png_bytes = base64.b64decode(images[0].data)
            assert png_bytes[:8] == PNG_SIGNATURE
            return {"tools": len(listing.tools), "pngBytes": len(png_bytes)}


started = time.time()
outcome = asyncio.run(run(*sys.argv[1:4]))
outcome["seconds"] = round(time.time() - started, 1)
print(json.dumps(outcome))
