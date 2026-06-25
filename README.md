# ChatGPT FileBridge

Give ChatGPT secure read/write access to your local files through [MCP (Model Context Protocol)](https://modelcontextprotocol.io/). No cloud storage, no file uploads — your files stay on your machine.

FileBridge runs a local MCP server on your computer and exposes it to ChatGPT via a temporary Cloudflare Tunnel with OAuth 2.0 authentication. You point ChatGPT at the tunnel URL, log in with the owner password, and ChatGPT can read, write, edit, search files and run shell commands in the directory you choose.

## Quick Start

### Prerequisites

- **Node.js 24+** (required for native dependencies)
- **Cloudflare Tunnel** CLI: `winget install Cloudflare.cloudflared` (Windows) or `brew install cloudflared` (macOS)
- `@waishnav/devspace` installed globally:
  ```bash
  npm install -g @waishnav/devspace
  ```
- A ChatGPT Plus/Team/Enterprise account with Connector support

### 1. Clone and launch

```powershell
git clone https://github.com/wuyinglai/chatgpt-filebridge.git
cd chatgpt-filebridge
.\start-chatgpt-filebridge.ps1 C:\path\to\your\project
```

> If PowerShell blocks the script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first.

The script will:

1. Start a Cloudflare Tunnel (free `trycloudflare.com` URL)
2. Launch the MCP server on port 7676
3. Auto-open the admin console in your browser (`http://127.0.0.1:7676`)
4. Print your connector URL and owner password

### 2. Connect ChatGPT

1. Open ChatGPT → **Settings** → **Connectors** → **Add custom connector**
2. Paste the MCP URL: `https://your-tunnel.trycloudflare.com/mcp`
3. When the OAuth login page appears, enter the **owner password** shown in the startup output
4. ChatGPT now has access to your files

### 3. Use it

In ChatGPT, ask it to work with your files:

> "Read the README.md in my project and summarize it"
> "Create a new file called notes.txt with today's date"
> "Run the tests in my project"

## Admin Console

The admin console at `http://127.0.0.1:7676` provides:

- **Service status**: local/public URLs, MCP URL, ChatGPT connection status
- **Request logs**: view recent requests with filtering (All / ChatGPT / Errors / MCP)
- **Working directory**: browse and change the allowed root directory
- **LLM configuration**: manage multiple LLM profiles (API URL, key, model, timeout)
- **MCP tool descriptions**: customize tool titles and descriptions shown to ChatGPT
- **Save & Apply**: save config changes and hot-restart the server without changing the tunnel URL

The console is **localhost-only** — it cannot be accessed through the public tunnel.

## Architecture

```
┌─────────────┐     HTTPS (tunnel)     ┌──────────────────────┐
│   ChatGPT   │ ─────────────────────▶ │  Cloudflare Tunnel   │
│  Connector  │ ◀───────────────────── │  (trycloudflare.com) │
└─────────────┘                        └──────────┬───────────┘
                                                  │ localhost:7676
                                                  ▼
                                       ┌──────────────────────┐
                                       │  ChatGPT FileBridge   │
                                       │  (Node.js MCP Server) │
                                       ├──────────────────────┤
                                       │  OAuth 2.0 + PKCE     │
                                       │  MCP Streamable HTTP  │
                                       │  Admin Console        │
                                       │  File / Shell / LLM   │
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
| `open_workspace(path)` | Open a project directory as a workspace (call once per folder) |
| `read(path, workspaceId)` | Read a file inside the workspace |
| `write(path, content, workspaceId)` | Create or overwrite a file |
| `edit(path, oldText, newText, workspaceId)` | Edit a file by replacing exact text blocks |
| `bash(command, workspaceId)` | Run a shell command |
| `call_llm(prompt, ...)` | Call a configured LLM for text generation (optional) |

All file operations are sandboxed to the root directory you specify at startup. Path traversal attacks are blocked.

## LLM Configuration (Optional)

The `call_llm` tool lets ChatGPT delegate text generation to your configured model. Edit the LLM settings in the admin console, or create `local-llm-mcp/llm_config.json`:

```json
{
  "api_url": "https://api.openai.com/v1/chat/completions",
  "api_key": "sk-your-key-here",
  "model": "gpt-4o-mini",
  "timeout_seconds": 120,
  "default_max_tokens": 65536
}
```

Any OpenAI-compatible API endpoint works. Skip this if you only need file operations.

## Configuration via Admin Console

The admin console is the recommended way to configure FileBridge:

- **Working directory**: Change the allowed root via the directory browser
- **LLM profiles**: Create, switch, and delete LLM configurations
- **MCP instructions**: Add extra instructions that ChatGPT sees during initialization
- **Tool descriptions**: Customize how tools are described to ChatGPT

Changes take effect after clicking **"Save All"** (which hot-restarts the server without changing the tunnel URL).

## Persistent Tunnel URL (Optional)

Free `trycloudflare.com` tunnels generate a new URL on each restart. For a persistent URL:

1. [Create a Cloudflare account](https://dash.cloudflare.com/sign-up) and add a domain
2. Create a named tunnel: `cloudflared tunnel create filebridge`
3. Configure DNS: `cloudflared tunnel route dns filebridge mcp.yourdomain.com`
4. Run the tunnel: `cloudflared tunnel run filebridge`
5. Set `DEVSPACE_PUBLIC_BASE_URL=https://mcp.yourdomain.com` before launching

With a fixed tunnel, you only need to configure the ChatGPT connector URL once.

## Project Structure

```
chatgpt-filebridge/
├── start-chatgpt-filebridge.ps1    # Single entry point (Windows)
├── devspace-fileworks-lite/        # MCP server (Node.js, forked from @waishnav/devspace)
│   └── dist/
│       ├── server.js               # Main server with admin console
│       ├── cli.js                  # CLI entry point
│       ├── oauth-provider.js       # OAuth 2.0 + PKCE implementation
│       └── ...
├── local-llm-mcp/                  # LLM proxy configuration
│   ├── llm_config.json.example     # Config template
│   └── requirements.txt            # Python deps (for standalone LLM server)
├── devspace-fileworks/             # Stock DevSpace (reference baseline)
├── CONTRIBUTING.md
└── LICENSE
```

## Security

- The `trycloudflare.com` URL is temporary and **publicly accessible**. Close the script when done.
- OAuth 2.0 with PKCE protects the MCP endpoint. The owner password is auto-generated and shown at startup.
- The admin console is **localhost-only** — not accessible through the tunnel.
- Do not set the root directory to an entire drive. Scope it to a specific project folder.
- `llm_config.json` is in `.gitignore` — never commit real API keys.

## Troubleshooting

**ChatGPT shows "Error in message flow":**
Check the admin console's request log for failed requests. Common causes: tunnel URL mismatch (update the connector URL), or SSE stream interrupted by Cloudflare proxy.

**ChatGPT reports OAuth errors:**
1. Verify the OAuth discovery endpoint returns 200: `https://your-tunnel.trycloudflare.com/.well-known/oauth-authorization-server`
2. Check the admin console shows ChatGPT status as "initialized"
3. Make sure you entered the correct owner password during OAuth login

**Server won't start (port busy):**
The startup script automatically kills conflicting processes on port 7676. If it still fails, kill the process manually: `netstat -ano | findstr 7676` then `taskkill /PID <pid> /F`.

**Tunnel URL changed:**
Free tunnels generate a new URL each time. Update the connector URL in ChatGPT, or set up a [persistent tunnel](#persistent-tunnel-url-optional).

## License

MIT — see [LICENSE](LICENSE).
