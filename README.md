# ChatGPT FileBridge

Give ChatGPT secure read/write access to your local files through [MCP (Model Context Protocol)](https://modelcontextprotocol.io/). No cloud storage, no file uploads — your files stay on your machine.

FileBridge runs a local MCP server on your computer and exposes it to ChatGPT via a temporary Cloudflare Tunnel with OAuth 2.0 authentication. You point ChatGPT at the tunnel URL, log in, and it can list, read, write, and search files in the directory you choose.

## Why?

ChatGPT's built-in file tools require uploading documents to OpenAI's servers. For active development projects, large codebases, or workflows where you want ChatGPT to edit files in place, that's impractical. FileBridge lets ChatGPT work directly with your local filesystem while keeping everything behind OAuth authentication.

## Quick Start

### Prerequisites

- **Python 3.10+** with `pip`
- **Cloudflare Tunnel** CLI: `winget install Cloudflare.cloudflared` (Windows) or `brew install cloudflared` (macOS)
- A ChatGPT Plus/Team/Enterprise account with Connector support

### 1. Install Python dependencies

```bash
cd local-llm-mcp
pip install fastapi uvicorn httpx mcp mcp-oauth
```

### 2. Configure LLM (optional)

Copy the example config and fill in your API key:

```bash
cp local-llm-mcp/llm_config.json.example local-llm-mcp/llm_config.json
```

Edit `llm_config.json` with any OpenAI-compatible API endpoint:

```json
{
  "api_url": "https://api.openai.com/v1/chat/completions",
  "api_key": "sk-your-key-here",
  "model": "gpt-4o-mini",
  "timeout_seconds": 120,
  "default_max_tokens": 65536
}
```

This enables the `call_llm` tool, which lets ChatGPT delegate text generation to your configured model. Skip this step if you only need file operations.

### 3. Launch

#### Windows (PowerShell)

```powershell
.\启动文件工作室.ps1 C:\path\to\your\project
```

The script will:

1. Start a Cloudflare Tunnel (free `trycloudflare.com` URL)
2. Launch the FileWorks MCP server on port 7676
3. Print your connector URL and auto-generated OAuth credentials
4. Enter a supervisor loop that auto-restarts the server if it crashes

#### Manual launch (any OS)

```bash
cd local-llm-mcp
python combined_mcp_server.py 7676 /path/to/your/project https://your-tunnel-url.trycloudflare.com
```

You'll need to set up the Cloudflare Tunnel separately:

```bash
cloudflared tunnel --protocol http2 --url http://127.0.0.1:7676
```

### 4. Connect ChatGPT

1. Open ChatGPT → **Settings** → **Connectors** → **Add custom connector**
2. Paste the tunnel URL printed by the startup script (e.g. `https://abc-xyz.trycloudflare.com`)
3. When prompted, log in with the OAuth credentials shown in the server output
4. ChatGPT now has access to your files

## Architecture

```
┌─────────────┐     HTTPS (tunnel)     ┌──────────────────────┐
│   ChatGPT   │ ─────────────────────▶ │  Cloudflare Tunnel   │
│  Connector  │ ◀───────────────────── │  (trycloudflare.com) │
└─────────────┘                        └──────────┬───────────┘
                                                  │ localhost:7676
                                                  ▼
                                       ┌──────────────────────┐
                                       │  FileWorks MCP Server │
                                       │  (FastAPI + FastMCP)  │
                                       ├──────────────────────┤
                                       │  OAuth 2.0 routes     │
                                       │  MCP endpoint (/mcp)  │
                                       │  File tools           │
                                       │  LLM proxy (optional) │
                                       └──────────────────────┘
                                                  │
                                                  ▼
                                       ┌──────────────────────┐
                                       │  Your local files     │
                                       │  (restricted to the   │
                                       │   root directory you  │
                                       │   specified at start) │
                                       └──────────────────────┘
```

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `list_directory(path)` | List files and folders under the allowed root |
| `read_file(path)` | Read a UTF-8 text file |
| `write_file(path, content)` | Write or overwrite a UTF-8 text file |
| `search_files(directory, pattern)` | Search files by glob pattern |
| `call_llm(prompt, system, temperature, max_tokens)` | Call the configured LLM (requires `llm_config.json`) |

All file paths are sandboxed to the root directory you specify at startup. Path traversal attacks are blocked.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_USER` | OAuth username | `admin` |
| `MCP_PASS` | OAuth password | Auto-generated (printed at startup) |
| `AGNES_API_URL` | LLM API endpoint | Value in `llm_config.json` |
| `AGNES_API_KEY` | LLM API key | Value in `llm_config.json` |
| `AGNES_MODEL` | LLM model name | Value in `llm_config.json` |
| `AGNES_TIMEOUT_SECONDS` | LLM request timeout | `120` |
| `AGNES_MAX_TOKENS` | Max output tokens | `65536` |

### Health Check & Status

- **Status page**: `http://127.0.0.1:7676/status` — human-readable HTML dashboard
- **Health endpoint**: `http://127.0.0.1:7676/health` — machine-readable JSON for monitoring

## Alternative: Enhanced DevSpace

The `devspace-fileworks-lite/` directory contains a modified version of [@waishnav/devspace](https://github.com/waishnav/devspace) with additional features: a Chinese-language admin console, multi-profile LLM management, filesystem browsing, and the `call_llm` tool.

```powershell
.\启动增强DevSpace.ps1 C:\path\to\your\project
```

This approach requires **Node.js 24+** and the `@waishnav/devspace` package installed globally (`npm install -g @waishnav/devspace`). The connector URL for this approach must include `/mcp`:

```
https://your-tunnel.trycloudflare.com/mcp
```

The unmodified `devspace-fileworks/` directory is also included as a reference baseline.

## Project Structure

```
chatgpt-filebridge/
├── local-llm-mcp/              # Python MCP server (recommended)
│   ├── combined_mcp_server.py  # Main server: files + LLM + OAuth
│   ├── llm_config.py           # LLM config loader
│   ├── llm_config.json.example # Config template
│   └── local_llm_server.py     # Standalone LLM-only MCP server
├── devspace-fileworks-lite/    # Enhanced DevSpace fork (Node.js)
├── devspace-fileworks/         # Stock DevSpace (Node.js, reference)
├── 启动文件工作室.ps1           # FileWorks launcher (Windows)
├── 启动增强DevSpace.ps1        # Enhanced DevSpace launcher (Windows)
├── 启动DevSpace隧道.ps1        # Stock DevSpace launcher (Windows)
├── hot-restart-devspace.ps1    # Hot-restart without new tunnel URL
└── PROJECT_HANDOFF.md          # Internal design notes
```

## Security Notes

- The `trycloudflare.com` URL is temporary and public. **Close the script window when you're done** to tear down the tunnel.
- OAuth credentials are auto-generated on each startup. Set `MCP_USER`/`MCP_PASS` environment variables if you need fixed credentials.
- Do not set the root directory to an entire drive (`C:\` or `D:\`). Scope it to a specific project folder.
- The `llm_config.json` file is in `.gitignore` and should never contain real API keys in version control.
- All file operations are sandboxed to the root directory. Path traversal via `../` is blocked.

## Troubleshooting

**ChatGPT reports OAuth errors:**
1. Check `http://127.0.0.1:7676/health` returns 200.
2. Check `https://your-tunnel.trycloudflare.com/.well-known/oauth-authorization-server` returns 200.
3. Verify the startup script window is still running and shows `[OK] Health`.

**Tunnel URL changes after restart:**
Free `trycloudflare.com` tunnels generate a new URL each time. You'll need to update the connector URL in ChatGPT. For a persistent URL, consider a paid Cloudflare Tunnel with a custom domain.

**Cloudflare tunnel process crashes:**
The FileWorks launcher (`启动文件工作室.ps1`) includes a supervisor loop that restarts the Python server automatically. However, if the `cloudflared` process itself dies, you'll need to restart the entire script to get a new tunnel URL.

## License

MIT — see [LICENSE](LICENSE).
