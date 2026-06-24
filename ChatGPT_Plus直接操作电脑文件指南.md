# ChatGPT Plus 如何直接操作电脑上的文件

这套工具把本地 MCP 服务通过 Cloudflare Tunnel 暴露给 ChatGPT，让 ChatGPT 能在你授权的目录里列目录、读文件、写文件、搜索文件，并可调用你配置的外部 LLM。

## 一、原理

```text
ChatGPT 网页版
  -> Cloudflare Tunnel（公网 HTTPS）
  -> 本机 127.0.0.1:7676
  -> FileWorks MCP Server
  -> 你指定的本地文件夹
```

推荐使用本目录里的 **FileWorks MCP** 方案：

```powershell
.\启动文件工作室.ps1 D:\xs
```

DevSpace 方案仍保留为备用：

```powershell
.\启动DevSpace隧道.ps1 D:\xs1
```

如果你想继续用 DevSpace 的交互方式，同时让它能调用本地配置的 LLM，使用增强版：

```powershell
.\启动增强DevSpace.ps1 D:\xs
```

## 二、准备

### 1. 安装 Cloudflare Tunnel

当前脚本默认使用：

```text
D:\npm-global\cloudflared.cmd
```

如果你的路径不同，需要改脚本里的 `$cloudflaredCmd`。

### 2. 准备 Python 环境

当前脚本优先使用：

```text
C:\Users\wuyin\.workbuddy\binaries\python\envs\mcp-llm\Scripts\python.exe
```

如果该路径不存在，会回退到系统 `python`。

需要的 Python 包包括：

```text
mcp
mcp-oauth
fastapi
uvicorn
httpx
pydantic
```

### 3. 配置 LLM

真实配置文件：

```text
local-llm-mcp\llm_config.json
```

首次运行脚本会根据 `llm_config.json.example` 自动创建。把你的 API Key 填到：

```json
{
  "api_url": "https://apihub.agnes-ai.com/v1/chat/completions",
  "api_key": "你的 API Key",
  "model": "agnes-2.0-flash",
  "timeout_seconds": 120,
  "default_max_tokens": 65536
}
```

也可以不写文件，改用环境变量：

```powershell
$env:AGNES_API_KEY = "你的 API Key"
$env:AGNES_MODEL = "agnes-2.0-flash"
```

## 三、启动 FileWorks MCP

在本目录运行：

```powershell
.\启动文件工作室.ps1 D:\xs
```

脚本完成后会输出类似：

```text
MCP URL : https://xxxx.trycloudflare.com
Status  : http://127.0.0.1:7676/status
```

把这个根 URL 填到 ChatGPT 连接器里，不需要追加 `/mcp`。

启动脚本不要关闭。它会每 15 秒检查一次：

- 本地 FileWorks 服务是否健康。
- 公网 OAuth discovery 是否能访问。
- Python 服务如果退出，会自动重启。

如果 Cloudflare tunnel 挂了，需要重新运行脚本并使用新的 `https://xxx.trycloudflare.com`。

默认登录：

```text
Username: admin
Password: fileworks2026
```

建议启动前改成自己的账号密码：

```powershell
$env:MCP_USER = "your-user"
$env:MCP_PASS = "your-strong-password"
.\启动文件工作室.ps1 D:\xs
```

## 四、连接 ChatGPT

1. 打开 ChatGPT Settings。
2. 找到 Connectors。
3. Add custom connector。
4. URL 填脚本输出的 `https://xxx.trycloudflare.com`。
5. 认证方式选择 OAuth，或让 ChatGPT 自动发现。
6. 弹出登录页后输入上面的用户名和密码。

连接成功后，可以在对话里让 ChatGPT 读取、修改、搜索你授权目录里的文件。

## 五、可用能力

| 工具 | 作用 |
| --- | --- |
| `list_directory` | 列目录 |
| `read_file` | 读文本文件 |
| `write_file` | 写文本文件 |
| `search_files` | 搜索文件 |
| `call_llm` | 调用 `llm_config.json` 配置的 LLM |

## 六、DevSpace 备用方案

如果只想用 DevSpace：

```powershell
.\启动DevSpace隧道.ps1 D:\xs1
```

脚本会写入：

```text
%USERPROFILE%\.devspace\config.json
```

并输出：

```text
https://xxx.trycloudflare.com/mcp
```

DevSpace 方案在 ChatGPT 里通常需要填带 `/mcp` 的 URL。

增强 DevSpace 也填带 `/mcp` 的 URL，并额外提供 `call_llm`。推荐提示词：

```text
使用增强 DevSpace。如果你不能直接生成内容，就调用 call_llm，然后用文件工具写入目标文件。
```

如果 tunnel 还活着，只想换目录：

```powershell
.\切换目录.ps1 D:\projects\my-site
```

## 七、常见问题

### ChatGPT 提示连接失败

FileWorks 方案填根 URL：

```text
https://xxx.trycloudflare.com
```

DevSpace 方案填 `/mcp`：

```text
https://xxx.trycloudflare.com/mcp
```

如果 ChatGPT 提示 `does not implement OAuth`，先打开：

```text
http://127.0.0.1:7676/status
```

再检查脚本窗口里是否显示 `[OK] Health`。如果公网 discovery 失败，重新运行 `启动文件工作室.ps1` 并使用新的 tunnel URL。

### LLM 调用失败

检查 `local-llm-mcp\llm_config.json` 里的 `api_key`、`api_url`、`model` 是否正确，或检查环境变量 `AGNES_API_KEY`。

### PowerShell 中文乱码

脚本里已经设置：

```powershell
chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

如果仍有乱码，优先用 Windows Terminal / PowerShell 7 打开。

## 八、安全提示

- 不要把授权目录设成整个磁盘根目录。
- 不要把真实 API Key 写进 `llm_config.json.example` 或 Markdown 文档。
- 不用时关闭脚本窗口，断开 Cloudflare Tunnel。
- 长期使用时修改默认 OAuth 密码。
