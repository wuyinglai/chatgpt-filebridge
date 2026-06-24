"""Expose a configured chat-completions model as an MCP tool."""

import sys
from mcp.server.fastmcp import FastMCP

from llm_config import complete_chat, load_llm_config


SERVER_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7677

mcp = FastMCP("local-llm-mcp", host="127.0.0.1", port=SERVER_PORT)


@mcp.tool()
async def call_llm(
    prompt: str,
    system: str = "",
    temperature: float = 0.7,
    max_tokens: int | None = None,
) -> str:
    """Call the configured LLM and return generated text."""
    return await complete_chat(
        prompt,
        system=system,
        temperature=temperature,
        max_tokens=max_tokens,
    )


if __name__ == "__main__":
    cfg = load_llm_config()
    print(f"LLM MCP Server starting on http://127.0.0.1:{SERVER_PORT}/sse")
    print(f"Model : {cfg.model}")
    print(f"API   : {cfg.api_url}")
    print(f"Config: llm_config.json or AGNES_* environment variables")
    mcp.run(transport="sse")
