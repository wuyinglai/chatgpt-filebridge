# 文件工作室 MCP — 项目交接文档

## 项目目标

这个目录提供两套把本地能力接入 ChatGPT 的方案：

1. **FileWorks MCP（推荐）**：自写 FastAPI + FastMCP 服务，提供本地文件读写、OAuth 2.0 登录、LLM 调用工具。
2. **DevSpace MCP（备用）**：通过 `@waishnav/devspace` 暴露本地文件目录。

两套方案都通过 Cloudflare Tunnel 暴露到公网临时 HTTPS 地址。

## 目录结构

| 文件 | 用途 |
| --- | --- |
| `启动文件工作室.ps1` | 推荐启动脚本：启动 Cloudflare Tunnel + FileWorks MCP |
| `启动增强DevSpace.ps1` | 增强 DevSpace：保留 DevSpace 文件能力，并额外提供 `call_llm` |
| `启动DevSpace隧道.ps1` | DevSpace 备用方案启动脚本 |
| `启动DevSpace隧道.bat` | 调用 DevSpace PowerShell 脚本的批处理入口 |
| `切换目录.ps1` | 复用已有 DevSpace URL，只切换暴露目录 |
| `local-llm-mcp/combined_mcp_server.py` | FileWorks 主服务端：文件工具 + LLM 工具 + OAuth |
| `local-llm-mcp/local_llm_server.py` | 单独 LLM MCP 服务 |
| `local-llm-mcp/llm_config.py` | 共享 LLM 配置读取和调用逻辑 |
| `local-llm-mcp/llm_config.json.example` | LLM 配置模板 |
| `devspace-fileworks-lite/` | 本地增强版 DevSpace，复用全局 DevSpace 依赖 |
| `.gitignore` | 忽略本地真实 LLM 配置和缓存文件 |

## LLM 配置

真实配置文件放在：

```text
local-llm-mcp/llm_config.json
```

首次运行启动脚本时，如果这个文件不存在，会从 `llm_config.json.example` 复制一份。

示例：

```json
{
  "api_url": "https://apihub.agnes-ai.com/v1/chat/completions",
  "api_key": "",
  "model": "agnes-2.0-flash",
  "timeout_seconds": 120,
  "default_max_tokens": 65536
}
```

也可以用环境变量覆盖：

| 环境变量 | 说明 |
| --- | --- |
| `AGNES_API_URL` | Chat Completions API 地址 |
| `AGNES_API_KEY` | API Key |
| `AGNES_MODEL` | 模型名 |
| `AGNES_TIMEOUT_SECONDS` | 请求超时时间 |
| `AGNES_MAX_TOKENS` | 默认最大输出 token |

不要把真实 API Key 写进文档或示例文件。

## 推荐启动方式

```powershell
.\启动文件工作室.ps1 D:\xs
```

脚本会自动：

1. 检查目标目录是否存在。
2. 创建本地 `llm_config.json`（如果还没有）。
3. 停止占用 7676 端口的旧服务，以及转发到该端口的旧 Cloudflare 隧道。
4. 启动 `cloudflared tunnel --protocol http2 --url http://127.0.0.1:7676`。
5. 启动 `local-llm-mcp/combined_mcp_server.py`。
6. 输出 ChatGPT 连接器需要填写的 URL。
7. 进入 supervisor 循环：每 15 秒检查本地服务和公网 OAuth discovery；如果 Python 服务挂了，会用同一个 tunnel URL 自动重启后端。

如果 Cloudflare tunnel 进程挂了，免费 trycloudflare URL 通常无法原地恢复，需要重新运行脚本并把新的 URL 填到 ChatGPT。

## 状态页和健康检查

本地状态页：

```text
http://127.0.0.1:7676/status
```

机器可读健康检查：

```text
http://127.0.0.1:7676/health
```

`/health` 会返回当前根目录、tunnel URL、OAuth 状态、LLM 配置状态、工具列表和 uptime。ChatGPT 报 OAuth 错误时，优先检查：

1. `http://127.0.0.1:7676/health` 是否 200。
2. `https://xxx.trycloudflare.com/.well-known/oauth-authorization-server` 是否 200。
3. 启动脚本窗口是否还在显示 `[OK] Health`。

默认 OAuth 登录：

```text
Username: admin
Password: fileworks2026
```

可用环境变量覆盖：

```powershell
$env:MCP_USER = "your-user"
$env:MCP_PASS = "your-strong-password"
```

## ChatGPT 配置

1. Settings > Connectors > Add custom connector
2. URL 填脚本输出的 `https://xxx.trycloudflare.com`
3. Auth 选择 OAuth 或让 ChatGPT 自动发现
4. 浏览器弹窗登录，输入 `MCP_USER` / `MCP_PASS`

FileWorks MCP 的 URL 填根地址，不需要追加 `/mcp`。

## 增强 DevSpace 方案

如果希望以 DevSpace 为主力，并让它在 ChatGPT 拒绝直接生成文本时调用你配置的 LLM，运行：

```powershell
.\启动增强DevSpace.ps1 D:\xs
```

这个脚本会启动 `devspace-fileworks-lite`，复用全局 `@waishnav/devspace` 的依赖，并读取：

```text
local-llm-mcp\llm_config.json
```

脚本输出的连接地址需要带 `/mcp`，例如：

```text
https://xxx.trycloudflare.com/mcp
```

增强 DevSpace 的新增工具：

```text
call_llm(prompt, system="", temperature=0.7, max_tokens=null)
```

建议在 ChatGPT 里这样说：

```text
使用增强 DevSpace。如果你不能直接生成内容，就调用 call_llm，然后用文件工具写入目标文件。
```

## 可用 MCP 工具

| 工具 | 说明 |
| --- | --- |
| `list_directory(path="")` | 列出允许目录下的文件和子目录 |
| `read_file(path)` | 读取 UTF-8 文本文件 |
| `write_file(path, content)` | 写入或覆盖 UTF-8 文本文件 |
| `search_files(directory="", pattern="*")` | 按 glob 搜索文件 |
| `call_llm(prompt, system="", temperature=0.7, max_tokens=null)` | 调用配置文件指定的 LLM |

所有文件路径都会被限制在启动时传入的根目录内。

## 架构流程

```text
ChatGPT App
  -> Cloudflare Tunnel (trycloudflare.com)
  -> localhost:7676
  -> FastAPI + FastMCP
     -> OAuth routes: /.well-known, /authorize, /token, /login, /introspect
     -> MCP endpoint: /mcp, with root / proxied to /mcp
     -> file tools + call_llm
```

## 重要修复点

- MCP SDK 的 DNS rebind 保护会拒绝 tunnel Host，当前在 `TransportSecuritySettings` 中关闭。
- ChatGPT 可能 POST 到根路径 `/`，服务端用 `MCPRootProxy` 转到 `/mcp`。
- `/introspect`、`/login`、`/.well-known/openid-configuration` 由服务端显式提供。
- 路径安全检查使用 `Path.relative_to()`，避免 `D:\xs` 与 `D:\xs2` 这类前缀误判。
- LLM API Key 已移出代码，改由 `llm_config.json` 或环境变量提供。

## 安全提示

- `trycloudflare.com` 是临时公网入口，不用时请关闭脚本窗口。
- 不要把允许目录设成整个 `C:\` 或 `D:\`。
- 修改默认 OAuth 密码后再长期使用。
- `local-llm-mcp/llm_config.json` 是本机配置文件，已在 `.gitignore` 中忽略。
