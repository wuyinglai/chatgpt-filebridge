# Contributing to ChatGPT FileBridge

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Clone the repository
2. Install Python dependencies:
   ```bash
   cd local-llm-mcp
   pip install fastapi uvicorn httpx mcp mcp-oauth
   ```
3. Copy the LLM config template:
   ```bash
   cp llm_config.json.example llm_config.json
   ```
4. Run the server locally (no tunnel needed for local testing):
   ```bash
   python combined_mcp_server.py 7676 ./test-dir http://127.0.0.1:7676
   ```

## Reporting Issues

Use the GitHub issue templates when possible. For bugs, include:
- Your OS and Python version
- The startup command you used
- Any error messages or log output
- Steps to reproduce

## Pull Requests

1. Fork the repository and create a feature branch
2. Make your changes with clear commit messages
3. Ensure the server starts without errors and `/health` returns 200
4. Open a PR with a description of what changed and why

## Code Style

- Python: follow PEP 8, use type hints where practical
- PowerShell: use approved verbs (`Start-`, `Stop-`, `Test-`, etc.)
- Keep secrets out of code — use environment variables or config files
