import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, ListPromptsRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, McpError, ReadResourceRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE, } from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { logEvent, requestIp, requestPath, commandPreview, sessionIdPrefix, } from "./logger.js";
import { editFileTool, findFilesTool, grepFilesTool, listDirectoryTool, readFileTool, runShellTool, writeFileTool, } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};
const LLM_TOOL_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};
const DEFAULT_LLM_CONFIG = {
    api_url: "https://your-api-provider.com/v1/chat/completions",
    api_key: "",
    model: "",
    timeout_seconds: 120,
    default_max_tokens: 65536,
};
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEVSPACE_DIR = join(homedir(), ".devspace");
const DEVSPACE_CONFIG_PATH = join(DEVSPACE_DIR, "config.json");
const DEVSPACE_AUTH_PATH = join(DEVSPACE_DIR, "auth.json");
function llmConfigPath() {
    return process.env.LLM_CONFIG_FILE || join(PROJECT_ROOT, "local-llm-mcp", "llm_config.json");
}
function llmProfilesPath() {
    return join(dirname(llmConfigPath()), "llm_profiles.json");
}
function mcpToolsConfigPath() {
    return join(DEVSPACE_DIR, "mcp_tools.json");
}
function readJsonFile(path, fallback = {}) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return fallback;
    }
}
function writeJsonFile(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function normalizeLlmProfile(profile = {}) {
    return {
        api_url: profile.api_url || DEFAULT_LLM_CONFIG.api_url,
        api_key: typeof profile.api_key === "string" ? profile.api_key : "",
        model: profile.model || DEFAULT_LLM_CONFIG.model,
        timeout_seconds: Number(profile.timeout_seconds || DEFAULT_LLM_CONFIG.timeout_seconds),
        default_max_tokens: Number(profile.default_max_tokens || profile.max_tokens || DEFAULT_LLM_CONFIG.default_max_tokens),
    };
}
function readLlmProfiles() {
    const currentConfig = normalizeLlmProfile(readJsonFile(llmConfigPath()));
    const data = readJsonFile(llmProfilesPath(), null);
    if (!data || typeof data !== "object") {
        return {
            current: "default",
            profiles: {
                default: currentConfig,
            },
        };
    }
    const profiles = {};
    for (const [name, profile] of Object.entries(data.profiles || {})) {
        profiles[name] = normalizeLlmProfile(profile);
    }
    if (Object.keys(profiles).length === 0) {
        profiles.default = currentConfig;
    }
    const current = data.current && profiles[data.current] ? data.current : Object.keys(profiles)[0];
    return { current, profiles };
}
function writeLlmProfiles(value) {
    writeJsonFile(llmProfilesPath(), value);
}
function readMcpToolsConfig() {
    const config = readJsonFile(mcpToolsConfigPath(), {});
    return {
        extraInstructions: typeof config.extraInstructions === "string" ? config.extraInstructions : "",
        tools: config.tools && typeof config.tools === "object" ? config.tools : {},
    };
}
function writeMcpToolsConfig(value) {
    writeJsonFile(mcpToolsConfigPath(), value);
}
function applyMcpToolOverride(mcpConfig, name, options) {
    const override = mcpConfig.tools?.[name] || {};
    return {
        ...options,
        title: typeof override.title === "string" && override.title.trim() ? override.title.trim() : options.title,
        description: typeof override.description === "string" && override.description.trim() ? override.description.trim() : options.description,
    };
}
function registerManagedAppTool(server, mcpConfig, name, options, handler) {
    return registerAppTool(server, name, applyMcpToolOverride(mcpConfig, name, options), handler);
}
function registerManagedTool(server, mcpConfig, name, options, handler) {
    return server.registerTool(name, applyMcpToolOverride(mcpConfig, name, options), handler);
}
function secretPreview(value) {
    const text = String(value || "");
    if (!text)
        return "";
    if (text.length <= 12)
        return `${text.slice(0, 3)}...`;
    return `${text.slice(0, 6)}...${text.slice(-4)}`;
}
function isLocalAdminRequest(req) {
    const host = String(req.headers.host || "").split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
    return ["localhost", "127.0.0.1", "::1"].includes(host);
}
function requireLocalAdmin(req, res, next) {
    if (!isLocalAdminRequest(req)) {
        res.status(403).type("text/plain").send("FileWorks admin console is local-only. Open http://127.0.0.1:7676/ on this machine.");
        return;
    }
    next();
}
function recentRequestSummary() {
    const logPath = process.env.DEVSPACE_REQUEST_LOG;
    if (!logPath || !existsSync(logPath)) {
        return {
            requestLog: logPath || "",
            chatgpt: "no_request_log",
            latestInitialize: null,
            latestTool: null,
            latestError: null,
        };
    }
    const lines = readFileSync(logPath, "utf8").trim().split(/\r?\n/).slice(-300);
    let latestInitialize = null;
    let latestTool = null;
    let latestError = null;
    for (const line of lines) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry.event || entry.status >= 400)
            latestError = entry;
        if (entry.mcpMethod === "initialize")
            latestInitialize = entry;
        const preview = String(entry.responsePreview || "");
        const toolMatch = preview.match(/"_meta":\{"tool":"([^"]+)"/) || preview.match(/"tool":"([^"]+)"/);
        if (entry.mcpMethod === "tools/call" || toolMatch) {
            latestTool = {
                ts: entry.ts,
                status: entry.status,
                tool: toolMatch?.[1] || "unknown",
            };
        }
    }
    return {
        requestLog: logPath,
        chatgpt: latestInitialize?.status === 200 ? "initialized" : latestInitialize ? "initialize_failed" : "not_initialized",
        latestInitialize,
        latestTool,
        latestError,
    };
}
function adminStatus(config) {
    const auth = readJsonFile(DEVSPACE_AUTH_PATH);
    const llm = readJsonFile(llmConfigPath());
    const llmProfiles = readLlmProfiles();
    const requestSummary = recentRequestSummary();
    return {
        ok: true,
        now: new Date().toISOString(),
        service: {
            status: "running",
            localUrl: `http://${config.host}:${config.port}`,
            publicBaseUrl: config.publicBaseUrl,
            mcpUrl: `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp`,
            port: config.port,
            host: config.host,
            allowedRoots: config.allowedRoots,
        },
        auth: {
            ownerPassword: auth.ownerToken || "",
            ownerPasswordPreview: secretPreview(auth.ownerToken),
        },
        llm: {
            configPath: llmConfigPath(),
            profilesPath: llmProfilesPath(),
            profiles: Object.keys(llmProfiles.profiles),
            currentProfile: llmProfiles.current,
            api_url: llm.api_url || DEFAULT_LLM_CONFIG.api_url,
            model: llm.model || DEFAULT_LLM_CONFIG.model,
            timeout_seconds: Number(llm.timeout_seconds || DEFAULT_LLM_CONFIG.timeout_seconds),
            default_max_tokens: Number(llm.default_max_tokens || llm.max_tokens || DEFAULT_LLM_CONFIG.default_max_tokens),
            api_key: llm.api_key || "",
            api_key_preview: secretPreview(llm.api_key),
            api_key_present: Boolean(llm.api_key),
        },
        logs: {
            requestLog: requestSummary.requestLog,
            serverOutLog: process.env.DEVSPACE_SERVER_OUT_LOG || "",
            serverErrLog: process.env.DEVSPACE_SERVER_ERR_LOG || "",
        },
        chatgpt: {
            status: requestSummary.chatgpt,
            latestInitialize: requestSummary.latestInitialize,
            latestTool: requestSummary.latestTool,
            latestError: requestSummary.latestError,
        },
        mcp: mcpToolCatalog(config),
    };
}
function mcpToolCatalog(config) {
    const toolNames = toolNamesFor(config);
    const mcpConfig = readMcpToolsConfig();
    const base = [
        {
            name: "open_workspace",
            title: "Open workspace",
            description: "Open a local project directory as a coding workspace and return a workspaceId for later file, shell, and edit calls.",
            enabled: true,
        },
        {
            name: toolNames.read,
            title: config.toolNaming === "short" ? "Read" : "Read file",
            description: "Read a file inside an opened workspace. Supports text files and images. Use this instead of shell commands for direct file reads.",
            enabled: true,
        },
        {
            name: toolNames.write,
            title: config.toolNaming === "short" ? "Write" : "Write file",
            description: "Create or completely overwrite a file inside an opened workspace.",
            enabled: true,
        },
        {
            name: toolNames.edit,
            title: config.toolNaming === "short" ? "Edit" : "Edit file",
            description: "Edit one file by replacing exact text blocks. Prefer this for targeted changes.",
            enabled: true,
        },
        {
            name: toolNames.shell,
            title: config.toolNaming === "short" ? "Bash" : "Run shell",
            description: "Run shell commands for tests, builds, git inspection, package scripts, search, and directory inspection. Do not use it to write project files.",
            enabled: true,
        },
        {
            name: toolNames.grep,
            title: config.toolNaming === "short" ? "Grep" : "Grep files",
            description: "Search file contents for a pattern inside an opened workspace.",
            enabled: !config.minimalTools,
        },
        {
            name: toolNames.glob,
            title: config.toolNaming === "short" ? "Glob" : "Find files",
            description: "Find files by glob pattern inside an opened workspace.",
            enabled: !config.minimalTools,
        },
        {
            name: toolNames.ls,
            title: config.toolNaming === "short" ? "Ls" : "List directory",
            description: "List a directory inside an opened workspace.",
            enabled: !config.minimalTools,
        },
        {
            name: "call_llm",
            title: "Call configured LLM",
            description: "Call the configured OpenAI-compatible LLM. It only generates text; use file tools to save results.",
            enabled: true,
        },
    ];
    return {
        extraInstructions: mcpConfig.extraInstructions,
        configPath: mcpToolsConfigPath(),
        tools: base.map((tool) => {
            const override = mcpConfig.tools?.[tool.name] || {};
            return {
                ...tool,
                title: typeof override.title === "string" && override.title.trim() ? override.title.trim() : tool.title,
                description: typeof override.description === "string" && override.description.trim() ? override.description.trim() : tool.description,
            };
        }),
    };
}
function windowsDriveRoots() {
    if (process.platform !== "win32")
        return ["/"];
    const drives = [];
    for (let code = 65; code <= 90; code++) {
        const drive = `${String.fromCharCode(code)}:\\`;
        if (existsSync(drive))
            drives.push(drive);
    }
    return drives;
}
function directoryListing(rawPath) {
    const fallback = process.platform === "win32" ? windowsDriveRoots()[0] || "C:\\" : "/";
    const current = resolve(rawPath || fallback);
    const entries = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const fullPath = join(current, entry.name);
        try {
            statSync(fullPath);
            entries.push({ name: entry.name, path: fullPath });
        }
        catch {
            // Skip directories that cannot be inspected.
        }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return {
        current,
        parent: dirname(current) === current ? "" : dirname(current),
        drives: windowsDriveRoots(),
        entries,
    };
}
function loadFileWorksLlmConfig() {
    const configUrl = process.env.LLM_CONFIG_FILE
        ? new URL(`file:///${process.env.LLM_CONFIG_FILE.replace(/\\/g, "/")}`)
        : new URL("../../local-llm-mcp/llm_config.json", import.meta.url);
    let fileConfig = {};
    try {
        fileConfig = JSON.parse(readFileSync(configUrl, "utf8"));
    }
    catch {
        fileConfig = {};
    }
    return {
        api_url: process.env.AGNES_API_URL || fileConfig.api_url || DEFAULT_LLM_CONFIG.api_url,
        api_key: process.env.AGNES_API_KEY || fileConfig.api_key || DEFAULT_LLM_CONFIG.api_key,
        model: process.env.AGNES_MODEL || fileConfig.model || DEFAULT_LLM_CONFIG.model,
        timeout_seconds: Number(process.env.AGNES_TIMEOUT_SECONDS || fileConfig.timeout_seconds || DEFAULT_LLM_CONFIG.timeout_seconds),
        default_max_tokens: Number(process.env.AGNES_MAX_TOKENS || fileConfig.default_max_tokens || fileConfig.max_tokens || DEFAULT_LLM_CONFIG.default_max_tokens),
    };
}
async function callConfiguredLlm(input) {
    const llm = loadFileWorksLlmConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, llm.timeout_seconds) * 1000);
    try {
        const messages = [];
        if (input.system)
            messages.push({ role: "system", content: input.system });
        messages.push({ role: "user", content: input.prompt });
        const headers = { "Content-Type": "application/json" };
        if (llm.api_key)
            headers.Authorization = `Bearer ${llm.api_key}`;
        const response = await fetch(llm.api_url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: llm.model,
                messages,
                temperature: input.temperature ?? 0.7,
                max_tokens: input.max_tokens ?? llm.default_max_tokens,
            }),
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `[ERROR] LLM request failed (${response.status}): ${text.slice(0, 2000)}`,
                    },
                ],
            };
        }
        const data = JSON.parse(text);
        const content = data?.choices?.[0]?.message?.content ?? "";
        return {
            content: [{ type: "text", text: content }],
            structuredContent: { result: content },
        };
    }
    catch (error) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: `[ERROR] LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
function shouldAttachWidget(mode, kind) {
    switch (mode) {
        case "off":
            return false;
        case "changes":
            return kind === "workspace" || kind === "show_changes";
        case "full":
            return true;
    }
}
function toolWidgetDescriptorMeta(config, kind) {
    if (!shouldAttachWidget(config.widgets, kind))
        return { _meta: {} };
    return {
        _meta: {
            ui: {
                resourceUri: WORKSPACE_APP_URI,
                visibility: ["model"],
            },
        },
    };
}
function toolNamesFor(config) {
    return config.toolNaming === "short"
        ? {
            openWorkspace: "open_workspace",
            read: "read",
            write: "write",
            edit: "edit",
            grep: "grep",
            glob: "glob",
            ls: "ls",
            shell: "bash",
        }
        : {
            openWorkspace: "open_workspace",
            read: "read_file",
            write: "write_file",
            edit: "edit_file",
            grep: "grep_files",
            glob: "find_files",
            ls: "list_directory",
            shell: "run_shell",
        };
}
function serverInstructions(config, toolNames) {
    const inspection = config.minimalTools
        ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
        : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;
    const skills = config.skillsEnabled
        ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
        : "";
    const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
    const showChanges = config.widgets === "changes"
        ? " After creating, editing, or overwriting files, call show_changes once after the related file changes are complete so the user can see the aggregate diff."
        : "";
    return `Use DevSpace as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChanges}`;
}
function resultOutputSchema(extra = {}) {
    return {
        result: z
            .string()
            .describe("Model-readable result text for follow-up reasoning and plain MCP hosts."),
        ...extra,
    };
}
const workspaceSkillOutputSchema = z.object({
    name: z.string(),
    description: z.string(),
    path: z.string(),
});
const workspaceAgentsFileOutputSchema = z.object({
    path: z.string(),
    content: z.string(),
});
const workspaceAvailableAgentsFileOutputSchema = z.object({
    path: z.string(),
});
const reviewFileOutputSchema = z.object({
    path: z.string(),
    previousPath: z.string().optional(),
    type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
    additions: z.number(),
    removals: z.number(),
});
const reviewSummaryOutputSchema = z.object({
    files: z.number(),
    additions: z.number(),
    removals: z.number(),
});
function sendJsonRpcError(res, status, code, message) {
    res.status(status).json({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
    });
}
function requestLogFields(req, config) {
    return {
        ip: requestIp(req, config.logging.trustProxy),
        host: req.header("host"),
        userAgent: req.header("user-agent"),
        origin: req.header("origin"),
        referer: req.header("referer"),
        contentLength: req.header("content-length"),
    };
}
function logToolCall(config, fields) {
    if (!config.logging.toolCalls)
        return;
    const { command, ...safeFields } = fields;
    logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
        ...safeFields,
        commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
    });
}
function contentText(content) {
    return content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
}
function toolErrorPreview(content) {
    const text = contentText(content).replace(/\s+/g, " ").trim();
    if (!text)
        return undefined;
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
function logFailedToolResponse(config, fields, content, startedAt) {
    logToolCall(config, {
        ...fields,
        success: false,
        durationMs: Math.round(performance.now() - startedAt),
        error: toolErrorPreview(content),
    });
}
function textBlock(text) {
    return { type: "text", text };
}
function textSummary(content) {
    const text = contentText(content);
    return {
        lines: text.length === 0 ? 0 : text.split("\n").length,
        characters: text.length,
    };
}
function contentLineCount(content) {
    if (content.length === 0)
        return 0;
    return content.endsWith("\n")
        ? content.slice(0, -1).split("\n").length
        : content.split("\n").length;
}
function countDiffStats(diff) {
    if (!diff)
        return { additions: 0, removals: 0 };
    let additions = 0;
    let removals = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++"))
            additions++;
        if (line.startsWith("-") && !line.startsWith("---"))
            removals++;
    }
    return { additions, removals };
}
function newFilePatch(path, content) {
    const lines = content.length === 0
        ? []
        : content.endsWith("\n")
            ? content.slice(0, -1).split("\n")
            : content.split("\n");
    const hunkLength = lines.length;
    const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 ${hunkRange} @@`,
        body,
    ]
        .filter((line) => line.length > 0)
        .join("\n");
}
function assetBaseUrl(config) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}
function uiManifestUrl() {
    return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}
function readWorkspaceAppManifest() {
    return JSON.parse(readFileSync(uiManifestUrl(), "utf8"));
}
function getWorkspaceAppManifestEntry() {
    const manifest = readWorkspaceAppManifest();
    const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];
    if (!entry?.file) {
        throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
    }
    return entry;
}
function assetUrl(baseUrl, assetPath) {
    return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}
function workspaceAppHtml(config) {
    const baseUrl = assetBaseUrl(config);
    const entry = getWorkspaceAppManifestEntry();
    const stylesheets = (entry.css ?? [])
        .map((stylesheet) => `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`)
        .join("\n");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}
function appCsp(config) {
    const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
    return {
        resourceDomains: [publicBaseUrl],
        connectDomains: [publicBaseUrl],
    };
}
function uiBuildDirectory() {
    return fileURLToPath(new URL("../dist/ui", import.meta.url));
}
function setAssetHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
async function assertWorkspaceAppAssets() {
    const entry = getWorkspaceAppManifestEntry();
    const candidates = [entry.file, ...(entry.css ?? [])].map((assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url));
    for (const candidate of candidates) {
        await access(candidate);
    }
}
function createMcpServer(config, workspaces, reviewCheckpoints) {
    const toolNames = toolNamesFor(config);
    const mcpConfig = readMcpToolsConfig();
    const extraInstructions = mcpConfig.extraInstructions ? ` Extra user-configured MCP instructions: ${mcpConfig.extraInstructions}` : "";
    const server = new McpServer({
        name: "devspace",
        title: "DevSpace FileWorks",
        version: "0.1.0",
        description: "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, shell tools, and a configured LLM generation tool.",
    }, {
        instructions: `${serverInstructions(config, toolNames)} When the user asks for text generation that the primary model should not or cannot draft directly, call call_llm to generate the requested text, then use DevSpace file tools to save it when appropriate.${extraInstructions}`,
        capabilities: {
            resources: {},
            prompts: {},
        },
    });
    if (config.widgets !== "off") {
        registerAppResource(server, "DevSpace Diff Card", WORKSPACE_APP_URI, {
            description: "Interactive card for viewing DevSpace file diffs.",
            _meta: {
                ui: {
                    csp: appCsp(config),
                },
            },
        }, async () => {
            await assertWorkspaceAppAssets();
            return {
                contents: [
                    {
                        uri: WORKSPACE_APP_URI,
                        mimeType: RESOURCE_MIME_TYPE,
                        text: workspaceAppHtml(config),
                        _meta: {
                            ui: {
                                csp: appCsp(config),
                            },
                        },
                    },
                ],
            };
        });
    }
    else {
        server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
        server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
        server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            throw new McpError(ErrorCode.InvalidParams, `Resource ${request.params.uri} not found`);
        });
    }
    server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
    registerManagedAppTool(server, mcpConfig, "open_workspace", {
        title: "Open workspace",
        description: "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Returns a workspaceId, loaded root project instructions, and nested instruction file paths the model should read before working in those directories.",
        inputSchema: {
            path: z
                .string()
                .describe("Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root."),
            mode: z
                .enum(["checkout", "worktree"])
                .optional()
                .describe("Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work."),
            baseRef: z
                .string()
                .optional()
                .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
        },
        outputSchema: {
            workspaceId: z.string(),
            root: z.string(),
            mode: z.enum(["checkout", "worktree"]),
            sourceRoot: z.string().optional(),
            worktree: z
                .object({
                path: z.string(),
                baseRef: z.string(),
                baseSha: z.string(),
                dirtySource: z.boolean(),
                detached: z.boolean(),
                managed: z.boolean(),
            })
                .optional(),
            agentsFiles: z.array(workspaceAgentsFileOutputSchema),
            availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
            skills: z.array(workspaceSkillOutputSchema),
            skillDiagnostics: z.array(z.unknown()),
            instruction: z.string(),
        },
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: { readOnlyHint: true },
    }, async ({ path, mode, baseRef }) => {
        const startedAt = performance.now();
        const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
        if (config.widgets === "changes") {
            void reviewCheckpoints.initializeWorkspace({
                workspaceId: workspace.id,
                root: workspace.root,
            });
        }
        const visibleSkills = workspace.skills
            .filter((skill) => !skill.disableModelInvocation)
            .map((skill) => ({
            name: skill.name,
            description: skill.description,
            path: formatPathForPrompt(skill.filePath),
        }));
        const loadedAgentsFiles = agentsFiles.map((file) => ({
            path: formatAgentsPath(file.path, workspace.root),
            content: file.content,
        }));
        const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
            path: formatAgentsPath(file.path, workspace.root),
        }));
        const instruction = config.skillsEnabled
            ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
            : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
        const resultContent = [
            {
                type: "text",
                text: [
                    `Opened workspace ${workspace.id}`,
                    `Root: ${workspace.root}`,
                    `Mode: ${workspace.mode}`,
                    loadedAgentsFiles.length > 0
                        ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
                        : undefined,
                    availableAgentsFileOutputs.length > 0
                        ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
                        : undefined,
                    visibleSkills.length > 0
                        ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
                        : undefined,
                    instruction,
                ].filter(Boolean).join("\n"),
            },
        ];
        logToolCall(config, {
            tool: "open_workspace",
            workspaceId: workspace.id,
            path: workspace.root,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            content: resultContent,
            _meta: {
                tool: "open_workspace",
                card: {
                    workspaceId: workspace.id,
                    root: workspace.root,
                    path: workspace.root,
                    summary: {
                        agentsFiles: loadedAgentsFiles.length,
                        availableAgentsFiles: availableAgentsFileOutputs.length,
                        skills: visibleSkills.length,
                        skillDiagnostics: workspace.skillDiagnostics.length,
                    },
                },
            },
            structuredContent: {
                workspaceId: workspace.id,
                root: workspace.root,
                mode: workspace.mode,
                sourceRoot: workspace.sourceRoot,
                worktree: workspace.worktree,
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                skillDiagnostics: workspace.skillDiagnostics,
                instruction,
            },
        };
    });
    registerManagedAppTool(server, mcpConfig, toolNames.read, {
        title: "Read file",
        description: [
            "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
            "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
            config.skillsEnabled
                ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
                : "",
        ]
            .filter(Boolean)
            .join(" "),
        inputSchema: {
            workspaceId: z
                .string()
                .describe("Workspace identifier returned by open_workspace."),
            path: z
                .string()
                .describe(config.skillsEnabled
                ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
                : "File path to read, relative to the workspace root."),
            offset: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-indexed line number to start reading from."),
            limit: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Maximum number of lines to read."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: { readOnlyHint: true },
    }, async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const readPath = workspaces.resolveReadPath(workspace, input.path);
        const response = await readFileTool({ ...input, path: readPath.absolutePath }, {
            cwd: workspace.root,
            root: workspace.root,
            readRoots: readPath.readRoots,
        });
        if (response.isError) {
            logFailedToolResponse(config, {
                tool: toolNames.read,
                workspaceId,
                path: input.path,
            }, response.content, startedAt);
            return response;
        }
        workspaces.markReadPathLoaded(workspace, readPath);
        const summary = {
            ...textSummary(response.content),
            offset: input.offset ?? 1,
            limited: input.limit !== undefined,
        };
        logToolCall(config, {
            tool: toolNames.read,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            ...response,
            _meta: {
                tool: toolNames.read,
                card: {
                    workspaceId,
                    path: input.path,
                    summary,
                    payload: { content: response.content },
                },
            },
            structuredContent: {
                result: contentText(response.content),
            },
        };
    });
    registerManagedAppTool(server, mcpConfig, toolNames.write, {
        title: "Write file",
        description: `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
        inputSchema: {
            workspaceId: z
                .string()
                .describe("Workspace identifier returned by open_workspace."),
            path: z
                .string()
                .describe("File path to write, relative to the workspace root."),
            content: z.string().describe("Complete new file content."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "write"),
        annotations: WRITE_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await writeFileTool(input, {
            cwd: workspace.root,
            root: workspace.root,
        });
        if (response.isError) {
            logFailedToolResponse(config, {
                tool: toolNames.write,
                workspaceId,
                path: input.path,
            }, response.content, startedAt);
            return response;
        }
        const patch = newFilePatch(input.path, input.content);
        const stats = countDiffStats(patch);
        const summary = {
            ...stats,
            lines: contentLineCount(input.content),
            characters: input.content.length,
        };
        logToolCall(config, {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            ...response,
            _meta: {
                tool: toolNames.write,
                card: {
                    workspaceId,
                    path: input.path,
                    summary,
                    payload: {
                        content: response.content,
                        patch,
                    },
                },
            },
            structuredContent: {
                result: contentText(response.content),
            },
        };
    });
    registerManagedAppTool(server, mcpConfig, toolNames.edit, {
        title: "Edit file",
        description: `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
        inputSchema: {
            workspaceId: z
                .string()
                .describe("Workspace identifier returned by open_workspace."),
            path: z
                .string()
                .describe("File path to edit, relative to the workspace root."),
            edits: z
                .array(z.object({
                oldText: z
                    .string()
                    .describe("Exact text to replace. Must match uniquely in the original file."),
                newText: z.string().describe("Replacement text."),
            }))
                .min(1),
        },
        outputSchema: resultOutputSchema({
            status: z.literal("applied"),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await editFileTool(input, {
            cwd: workspace.root,
            root: workspace.root,
        });
        if (response.isError) {
            logFailedToolResponse(config, {
                tool: toolNames.edit,
                workspaceId,
                path: input.path,
            }, response.content, startedAt);
            return response;
        }
        const stats = countDiffStats(response.details?.patch ?? response.details?.diff);
        const summary = {
            ...stats,
            editCount: input.edits.length,
        };
        const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
        const editContent = [textBlock(editResultText)];
        logToolCall(config, {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            content: editContent,
            _meta: {
                tool: toolNames.edit,
                card: {
                    workspaceId,
                    path: input.path,
                    summary,
                    payload: {
                        diff: response.details?.diff,
                        patch: response.details?.patch,
                    },
                },
            },
            structuredContent: {
                status: "applied",
                result: contentText(editContent),
            },
        };
    });
    if (config.widgets === "changes") {
        registerManagedAppTool(server, mcpConfig, "show_changes", {
            title: "Show changes",
            description: "Show aggregate file changes in an open workspace since the last shown checkpoint or since the workspace was opened. After you create, edit, or overwrite files, call this once when the related file changes are complete so the user can inspect the combined diff.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                since: z
                    .enum(["last_shown", "workspace_open"])
                    .optional()
                    .describe("Defaults to last_shown. Use workspace_open to compare against the initial open_workspace checkpoint."),
                markReviewed: z
                    .boolean()
                    .optional()
                    .describe("Defaults to true. When true, advances the last shown checkpoint to the current workspace state."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "show_changes"),
            annotations: { readOnlyHint: true },
        }, async ({ workspaceId, since, markReviewed }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            const review = await reviewCheckpoints.reviewChanges({
                workspaceId,
                root: workspace.root,
                since: since ?? "last_shown",
                markReviewed: markReviewed ?? true,
            });
            const content = [textBlock(review.result)];
            logToolCall(config, {
                tool: "show_changes",
                workspaceId,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                content,
                _meta: {
                    tool: "show_changes",
                    card: {
                        workspaceId,
                        summary: review.summary,
                        files: review.files,
                        payload: {
                            patch: review.patch,
                        },
                    },
                },
                structuredContent: {
                    result: contentText(content),
                },
            };
        });
    }
    if (!config.minimalTools) {
        registerManagedAppTool(server, mcpConfig, toolNames.grep, {
            title: config.toolNaming === "short" ? "Grep" : "Grep files",
            description: "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                pattern: z.string().describe("Search pattern."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional path or glob scope relative to the workspace root."),
                include: z.string().optional().describe("Optional include glob."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "search"),
            annotations: { readOnlyHint: true },
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            if (input.path)
                workspaces.resolvePath(workspace, input.path);
            const response = await grepFilesTool(input, {
                cwd: workspace.root,
                root: workspace.root,
            });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.grep,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = {
                pattern: input.pattern,
                scope: input.path ?? ".",
                ...textSummary(response.content),
            };
            logToolCall(config, {
                tool: toolNames.grep,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.grep,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                },
            };
        });
        registerManagedAppTool(server, mcpConfig, toolNames.glob, {
            title: config.toolNaming === "short" ? "Glob" : "Find files",
            description: "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                pattern: z.string().describe("File glob pattern."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional path scope relative to the workspace root."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "search"),
            annotations: { readOnlyHint: true },
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            if (input.path)
                workspaces.resolvePath(workspace, input.path);
            const response = await findFilesTool(input, {
                cwd: workspace.root,
                root: workspace.root,
            });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.glob,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = {
                pattern: input.pattern,
                scope: input.path ?? ".",
                ...textSummary(response.content),
            };
            logToolCall(config, {
                tool: toolNames.glob,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.glob,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                },
            };
        });
        registerManagedAppTool(server, mcpConfig, toolNames.ls, {
            title: config.toolNaming === "short" ? "Ls" : "List directory",
            description: "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                path: z
                    .string()
                    .describe("Directory path to list, relative to the workspace root."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "directory"),
            annotations: { readOnlyHint: true },
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            workspaces.resolvePath(workspace, input.path);
            const response = await listDirectoryTool(input, {
                cwd: workspace.root,
                root: workspace.root,
            });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.ls,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = textSummary(response.content);
            logToolCall(config, {
                tool: toolNames.ls,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.ls,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                },
            };
        });
    }
    registerManagedAppTool(server, mcpConfig, toolNames.shell, {
        title: config.toolNaming === "short" ? "Bash" : "Run shell",
        description: config.minimalTools
            ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`
            : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
        inputSchema: {
            workspaceId: z
                .string()
                .describe("Workspace identifier returned by open_workspace."),
            command: z
                .string()
                .describe(`Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`),
            workingDirectory: z
                .string()
                .optional()
                .describe("Optional working directory relative to the workspace root. Defaults to the workspace root."),
            timeout: z
                .number()
                .positive()
                .max(300)
                .optional()
                .describe("Timeout in seconds. Defaults to 30, max 300."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: SHELL_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, workingDirectory, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
        const response = await runShellTool(input, {
            cwd,
            root: workspace.root,
        });
        if (response.isError) {
            logFailedToolResponse(config, {
                tool: toolNames.shell,
                workspaceId,
                workingDirectory: workingDirectory ?? ".",
                command: input.command,
                commandLength: input.command.length,
            }, response.content, startedAt);
            return response;
        }
        const summary = {
            command: input.command,
            workingDirectory: workingDirectory ?? ".",
            ...textSummary(response.content),
        };
        logToolCall(config, {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            ...response,
            _meta: {
                tool: toolNames.shell,
                card: {
                    workspaceId,
                    path: workingDirectory,
                    summary,
                    payload: { content: response.content },
                },
            },
            structuredContent: {
                result: contentText(response.content),
            },
        };
    });
    registerManagedTool(server, mcpConfig, "call_llm", {
        title: "Call configured LLM",
        description: "Call the user's configured OpenAI-compatible LLM from local-llm-mcp/llm_config.json or AGNES_* environment variables. Use this when the user asks to generate, rewrite, continue, or polish text and wants the external/local model to do the drafting. This tool only generates text; use DevSpace write/edit tools to save the result to files.",
        inputSchema: {
            prompt: z
                .string()
                .describe("Prompt to send to the configured LLM."),
            system: z
                .string()
                .optional()
                .describe("Optional system instruction for the configured LLM."),
            temperature: z
                .number()
                .min(0)
                .max(2)
                .optional()
                .describe("Sampling temperature. Defaults to 0.7."),
            max_tokens: z
                .number()
                .positive()
                .max(65536)
                .optional()
                .describe("Maximum generated tokens. Defaults to the LLM config value."),
        },
        annotations: LLM_TOOL_ANNOTATIONS,
    }, async (input) => {
        const startedAt = performance.now();
        const response = await callConfiguredLlm(input);
        logToolCall(config, {
            tool: "call_llm",
            promptLength: input.prompt.length,
            success: !response.isError,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return response;
    });
    return server;
}
function appendRequestTrace(entry) {
    const logPath = process.env.DEVSPACE_REQUEST_LOG;
    if (!logPath)
        return;
    try {
        appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    }
    catch {
        // Request tracing is diagnostic only; never fail MCP traffic because logging failed.
    }
}
function responseChunkToBuffer(chunk) {
    if (Buffer.isBuffer(chunk))
        return chunk;
    if (chunk instanceof Uint8Array)
        return Buffer.from(chunk);
    return Buffer.from(String(chunk));
}
function adminConsoleHtml() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FileWorks 控制台</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --line:#d9dde5; --text:#111827; --muted:#6b7280; --accent:#2563eb; --ok:#0f8a4b; --warn:#b45309; --bad:#b91c1c; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:20px; }
    h1 { margin:0; font-size:28px; }
    h2 { margin:0 0 14px; font-size:18px; }
    p { margin:6px 0; color:var(--muted); }
    .grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:16px; }
    .full { grid-column: 1 / -1; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
    .row { display:grid; grid-template-columns: 180px 1fr auto; gap:10px; align-items:center; min-height:34px; border-top:1px solid #eef0f4; padding:8px 0; }
    .row:first-of-type { border-top:0; }
    label { color:var(--muted); font-size:14px; }
    input, textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px 10px; font:inherit; background:#fff; }
    input[readonly] { background:#f9fafb; }
    button { border:1px solid var(--line); background:#fff; border-radius:6px; padding:8px 12px; font:inherit; cursor:pointer; }
    button.primary { background:var(--accent); border-color:var(--accent); color:white; }
    button.danger { color:var(--bad); }
    .status { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:6px 10px; background:#eef2ff; color:#1d4ed8; font-weight:600; }
    .status.ok { background:#e8f7ef; color:var(--ok); }
    .status.warn { background:#fff7ed; color:var(--warn); }
    .status.bad { background:#fee2e2; color:var(--bad); }
    .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; background:#0f172a; color:#e5e7eb; padding:12px; border-radius:8px; max-height:260px; overflow:auto; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .secret { -webkit-text-security: disc; }
    @media (max-width: 820px) { main{padding:16px}.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr}.row button{width:max-content} header{display:block} }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>FileWorks 控制台</h1>
      <p>本页面只允许从本机访问。公网 tunnel 不开放控制台。</p>
    </div>
    <div id="serviceStatus" class="status">加载中</div>
  </header>
  <section class="grid">
    <div class="card">
      <h2>运行状态</h2>
      <div class="row"><label>本地地址</label><input id="localUrl" readonly /><button data-copy="localUrl">复制</button></div>
      <div class="row"><label>公网地址</label><input id="publicBaseUrl" readonly /><button data-copy="publicBaseUrl">复制</button></div>
      <div class="row"><label>MCP URL</label><input id="mcpUrl" readonly /><button data-copy="mcpUrl">复制</button></div>
      <div class="row"><label>ChatGPT</label><input id="chatgptStatus" readonly /><button id="refresh">刷新</button></div>
      <div class="row"><label>最近工具</label><input id="latestTool" readonly /><span></span></div>
    </div>
    <div class="card">
      <h2>秘密与日志</h2>
      <div class="row"><label>Owner password</label><input id="ownerPassword" class="mono" readonly /><button data-copy="ownerPassword">复制</button></div>
      <div class="row"><label>请求日志</label><input id="requestLog" readonly /><button data-copy="requestLog">复制</button></div>
      <div class="row"><label>服务日志</label><input id="serverOutLog" readonly /><button data-copy="serverOutLog">复制</button></div>
      <div class="row"><label>错误日志</label><input id="serverErrLog" readonly /><button data-copy="serverErrLog">复制</button></div>
    </div>
    <div class="card">
      <h2>工作目录</h2>
      <div class="row"><label>目录</label><input id="directory" placeholder="C:\\Users\\your-name\\project" /><button id="pickDirectory">选择目录</button></div>
      <div id="dirPicker" style="display:none; margin-top:12px;"></div>
      <p>目录会在页面底部统一保存并应用。</p>
    </div>
    <div class="card">
      <h2>LLM 配置</h2>
      <div class="row"><label>当前配置</label><select id="llmProfileSelect"></select><button id="useProfile">设为当前</button></div>
      <div class="row"><label>配置名称</label><input id="llmProfileName" placeholder="default" /><button id="saveProfile">保存为配置</button></div>
      <div class="row"><label>API URL</label><input id="llmApiUrl" /><span></span></div>
      <div class="row"><label>API Key</label><input id="llmApiKey" class="mono secret" /><button id="toggleKey">显示</button></div>
      <div class="row"><label>Model</label><input id="llmModel" /><span></span></div>
      <div class="row"><label>Timeout 秒</label><input id="llmTimeout" type="number" min="1" /><span></span></div>
      <div class="row"><label>Max tokens</label><input id="llmMaxTokens" type="number" min="1" /><span></span></div>
      <div class="actions">
        <button id="testLlm">测试 LLM</button>
        <button id="deleteProfile" class="danger">删除当前配置</button>
      </div>
    </div>
    <div class="card full">
      <h2>应用更改</h2>
      <p>保存当前页面里的工作目录和 LLM 配置，然后热重启本地 Node 服务。Cloudflare URL 保持不变。</p>
      <div class="actions">
        <button id="saveAll" class="primary">保存全部并应用</button>
        <button id="saveOnly">仅保存不重启</button>
      </div>
    </div>
    <div class="card full">
      <h2>MCP 能力说明</h2>
      <p>ChatGPT 主要读取初始化说明和工具列表。这里编辑后，保存全部并应用，新的 ChatGPT 初始化会看到更新后的说明。</p>
      <div class="row"><label>额外说明</label><textarea id="mcpExtraInstructions" rows="4" placeholder="给 ChatGPT 的额外 MCP 使用说明"></textarea><span></span></div>
      <div id="mcpTools"></div>
    </div>
    <div class="card full">
      <h2>最近错误 / 测试结果</h2>
      <pre id="details">加载中...</pre>
    </div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let state = null;
function setValue(id, value) { $(id).value = value || ""; }
async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok:false, error:text }; }
  if (!res.ok) throw new Error(data.error || text || res.statusText);
  return data;
}
function formPayload() {
  const toolOverrides = {};
  document.querySelectorAll("[data-tool-name]").forEach(node => {
    const name = node.dataset.toolName;
    toolOverrides[name] = {
      title: node.querySelector("[data-tool-title]").value,
      description: node.querySelector("[data-tool-description]").value,
    };
  });
  return {
    directory: $("directory").value.trim(),
    llm: {
      api_url: $("llmApiUrl").value.trim(),
      api_key: $("llmApiKey").value,
      model: $("llmModel").value.trim(),
      timeout_seconds: Number($("llmTimeout").value || 120),
      default_max_tokens: Number($("llmMaxTokens").value || 65536),
    },
    mcp: {
      extraInstructions: $("mcpExtraInstructions").value,
      tools: toolOverrides,
    }
  };
}
function render(data) {
  state = data;
  $("serviceStatus").textContent = data.service.status === "running" ? "运行中" : data.service.status;
  $("serviceStatus").className = "status ok";
  setValue("localUrl", data.service.localUrl);
  setValue("publicBaseUrl", data.service.publicBaseUrl);
  setValue("mcpUrl", data.service.mcpUrl);
  setValue("chatgptStatus", data.chatgpt.status);
  setValue("latestTool", data.chatgpt.latestTool ? data.chatgpt.latestTool.tool + " / " + data.chatgpt.latestTool.status : "");
  setValue("ownerPassword", data.auth.ownerPassword);
  setValue("requestLog", data.logs.requestLog);
  setValue("serverOutLog", data.logs.serverOutLog);
  setValue("serverErrLog", data.logs.serverErrLog);
  setValue("directory", (data.service.allowedRoots || [])[0] || "");
  $("llmProfileSelect").innerHTML = (data.llm.profiles || []).map(name => '<option value="' + name.replaceAll('&','&amp;').replaceAll('"','&quot;') + '">' + name.replaceAll('&','&amp;') + '</option>').join("");
  $("llmProfileSelect").value = data.llm.currentProfile || "";
  setValue("llmProfileName", data.llm.currentProfile || "default");
  setValue("llmApiUrl", data.llm.api_url);
  setValue("llmApiKey", data.llm.api_key);
  setValue("llmModel", data.llm.model);
  setValue("llmTimeout", data.llm.timeout_seconds);
  setValue("llmMaxTokens", data.llm.default_max_tokens);
  setValue("mcpExtraInstructions", data.mcp.extraInstructions || "");
  $("mcpTools").innerHTML = (data.mcp.tools || []).map(tool => {
    const disabled = tool.enabled ? "" : "（当前模式未启用）";
    const safeName = tool.name.replaceAll('&','&amp;').replaceAll('"','&quot;');
    return '<div class="card" data-tool-name="' + safeName + '" style="box-shadow:none;margin:10px 0;">'
      + '<div class="row"><label>工具名</label><input readonly class="mono" value="' + safeName + '" /><span>' + disabled + '</span></div>'
      + '<div class="row"><label>标题</label><input data-tool-title value="' + (tool.title || '').replaceAll('&','&amp;').replaceAll('"','&quot;') + '" /><span></span></div>'
      + '<div class="row"><label>说明</label><textarea data-tool-description rows="3">' + (tool.description || '').replaceAll('&','&amp;').replaceAll('<','&lt;') + '</textarea><span></span></div>'
      + '</div>';
  }).join("");
  $("details").textContent = JSON.stringify({ now:data.now, latestError:data.chatgpt.latestError, latestInitialize:data.chatgpt.latestInitialize }, null, 2);
}
async function refresh() {
  render(await api("/admin/status"));
}
async function saveConfig() {
  const result = await api("/admin/config", { method:"POST", body: JSON.stringify(formPayload()) });
  $("details").textContent = JSON.stringify(result, null, 2);
  await refresh();
}
async function browseDirectory(path) {
  const result = await api("/admin/browse-directory", { method:"POST", body: JSON.stringify({ path }) });
  const picker = $("dirPicker");
  picker.style.display = "block";
  const driveButtons = (result.drives || []).map(d => '<button data-dir="' + d.replaceAll('&','&amp;').replaceAll('"','&quot;') + '">' + d + '</button>').join(" ");
  const upButton = result.parent ? '<button data-dir="' + result.parent.replaceAll('&','&amp;').replaceAll('"','&quot;') + '">上一级</button>' : "";
  const rows = (result.entries || []).map(e => '<button data-dir="' + e.path.replaceAll('&','&amp;').replaceAll('"','&quot;') + '" style="display:block;width:100%;text-align:left;margin:4px 0;">' + e.name.replaceAll('&','&amp;') + '</button>').join("");
  picker.innerHTML = '<div class="card" style="box-shadow:none;"><div class="actions">' + driveButtons + ' ' + upButton + '<button id="useCurrentDir" class="primary">使用此目录</button></div><p class="mono">' + result.current.replaceAll('&','&amp;') + '</p><div style="max-height:260px;overflow:auto;">' + rows + '</div></div>';
  picker.querySelectorAll("[data-dir]").forEach(btn => btn.onclick = () => browseDirectory(btn.dataset.dir));
  picker.querySelector("#useCurrentDir").onclick = () => {
    $("directory").value = result.current;
    picker.style.display = "none";
  };
}
async function applyRestart() {
  const result = await api("/admin/apply", { method:"POST", body: JSON.stringify({}) });
  $("details").textContent = JSON.stringify(result, null, 2);
}
document.addEventListener("click", async (event) => {
  const copyId = event.target?.dataset?.copy;
  if (copyId) await navigator.clipboard.writeText($(copyId).value || "");
});
$("refresh").onclick = refresh;
$("saveOnly").onclick = saveConfig;
$("saveAll").onclick = async () => {
  await saveConfig();
  await applyRestart();
};
$("saveProfile").onclick = async () => {
  const name = $("llmProfileName").value.trim();
  if (!name) { $("details").textContent = "配置名称不能为空"; return; }
  const result = await api("/admin/llm-profiles", { method:"POST", body: JSON.stringify({ action:"save", name, profile: formPayload().llm }) });
  $("details").textContent = JSON.stringify(result, null, 2);
  await refresh();
};
$("useProfile").onclick = async () => {
  const name = $("llmProfileSelect").value;
  const result = await api("/admin/llm-profiles", { method:"POST", body: JSON.stringify({ action:"use", name }) });
  $("details").textContent = JSON.stringify(result, null, 2);
  await refresh();
};
$("deleteProfile").onclick = async () => {
  const name = $("llmProfileSelect").value;
  const result = await api("/admin/llm-profiles", { method:"POST", body: JSON.stringify({ action:"delete", name }) });
  $("details").textContent = JSON.stringify(result, null, 2);
  await refresh();
};
$("llmProfileSelect").onchange = async () => {
  const result = await api("/admin/llm-profile?name=" + encodeURIComponent($("llmProfileSelect").value));
  if (result.profile) {
    setValue("llmProfileName", result.name);
    setValue("llmApiUrl", result.profile.api_url);
    setValue("llmApiKey", result.profile.api_key);
    setValue("llmModel", result.profile.model);
    setValue("llmTimeout", result.profile.timeout_seconds);
    setValue("llmMaxTokens", result.profile.default_max_tokens);
  }
};
$("pickDirectory").onclick = async () => {
  $("details").textContent = "正在读取目录...";
  try {
    await browseDirectory($("directory").value);
    $("details").textContent = "请选择目录，或点“使用此目录”。";
  } catch (error) {
    $("details").textContent = String(error.message || error);
  }
};
$("testLlm").onclick = async () => {
  $("details").textContent = "测试中...";
  try {
    $("details").textContent = JSON.stringify(await api("/admin/test-llm", { method:"POST", body: JSON.stringify(formPayload().llm) }), null, 2);
  } catch (error) {
    $("details").textContent = String(error.message || error);
  }
};
$("toggleKey").onclick = () => {
  $("llmApiKey").classList.toggle("secret");
  $("toggleKey").textContent = $("llmApiKey").classList.contains("secret") ? "显示" : "隐藏";
};
refresh().catch((error) => { $("details").textContent = String(error.message || error); });
</script>
</body>
</html>`;
}
export function createServer(config = loadConfig()) {
    const allowedHosts = config.allowedHosts.includes("*")
        ? undefined
        : Array.from(new Set([config.host, ...config.allowedHosts]));
    const app = createMcpExpressApp({
        host: config.host,
        ...(allowedHosts ? { allowedHosts } : {}),
    });
    const transports = new Map();
    const mcpUrl = new URL("/mcp", config.publicBaseUrl);
    const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
    const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
    const bearerAuth = requireBearerAuth({
        verifier: oauthProvider,
        requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
    const workspaceStore = createWorkspaceStore(config.stateDir);
    const workspaces = new WorkspaceRegistry(config, workspaceStore);
    const reviewCheckpoints = createReviewCheckpointManager();
    if (config.logging.trustProxy) {
        app.set("trust proxy", true);
    }
    app.use((req, res, next) => {
        const requestId = randomUUID();
        const startedAt = performance.now();
        const responseChunks = [];
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);
        res.write = (chunk, ...args) => {
            if (req.path === "/mcp" && responseChunks.length < 12 && chunk !== undefined) {
                responseChunks.push(responseChunkToBuffer(chunk));
            }
            return originalWrite(chunk, ...args);
        };
        res.end = (chunk, ...args) => {
            if (req.path === "/mcp" && responseChunks.length < 12 && chunk !== undefined) {
                responseChunks.push(responseChunkToBuffer(chunk));
            }
            return originalEnd(chunk, ...args);
        };
        res.locals.requestId = requestId;
        res.on("finish", () => {
            const path = requestPath(req);
            const responseText = responseChunks.length > 0 ? Buffer.concat(responseChunks).toString("utf8") : undefined;
            appendRequestTrace({
                ts: new Date().toISOString(),
                requestId,
                method: req.method,
                path,
                mcpMethod: req.body?.method,
                status: res.statusCode,
                durationMs: Math.round(performance.now() - startedAt),
                userAgent: req.header("user-agent"),
                hasAuthorization: Boolean(req.header("authorization")),
                hasMcpSession: Boolean(req.header("mcp-session-id")),
                responseContentType: req.path === "/mcp" ? res.getHeader("content-type") : undefined,
                responsePreview: responseText ? responseText.slice(0, 1200) : undefined,
            });
            if (!config.logging.requests)
                return;
            if (!config.logging.assets && path.startsWith("/mcp-app-assets"))
                return;
            logEvent(config.logging, "info", "http_request", {
                requestId,
                method: req.method,
                path,
                status: res.statusCode,
                durationMs: Math.round(performance.now() - startedAt),
                ...requestLogFields(req, config),
            });
        });
        next();
    });
    app.use(express.json({ limit: "1mb" }));
    app.get("/", requireLocalAdmin, (_req, res) => {
        res.type("html").send(adminConsoleHtml());
    });
    app.get("/admin/status", requireLocalAdmin, (_req, res) => {
        res.json(adminStatus(config));
    });
    app.post("/admin/config", requireLocalAdmin, (req, res) => {
        const body = req.body || {};
        const devspaceConfig = readJsonFile(DEVSPACE_CONFIG_PATH);
        if (typeof body.directory === "string" && body.directory.trim()) {
            devspaceConfig.allowedRoots = [body.directory.trim()];
        }
        devspaceConfig.port = config.port;
        devspaceConfig.publicBaseUrl = config.publicBaseUrl;
        writeJsonFile(DEVSPACE_CONFIG_PATH, devspaceConfig);
        const llmBody = body.llm || {};
        const currentLlm = readJsonFile(llmConfigPath());
        const nextLlm = {
            ...currentLlm,
            api_url: llmBody.api_url || currentLlm.api_url || DEFAULT_LLM_CONFIG.api_url,
            api_key: typeof llmBody.api_key === "string" ? llmBody.api_key : currentLlm.api_key || "",
            model: llmBody.model || currentLlm.model || DEFAULT_LLM_CONFIG.model,
            timeout_seconds: Number(llmBody.timeout_seconds || currentLlm.timeout_seconds || DEFAULT_LLM_CONFIG.timeout_seconds),
            default_max_tokens: Number(llmBody.default_max_tokens || currentLlm.default_max_tokens || currentLlm.max_tokens || DEFAULT_LLM_CONFIG.default_max_tokens),
        };
        writeJsonFile(llmConfigPath(), nextLlm);
        const profiles = readLlmProfiles();
        profiles.profiles[profiles.current || "default"] = normalizeLlmProfile(nextLlm);
        profiles.current = profiles.current || "default";
        writeLlmProfiles(profiles);
        const mcpBody = body.mcp || {};
        if (mcpBody && typeof mcpBody === "object") {
            writeMcpToolsConfig({
                extraInstructions: typeof mcpBody.extraInstructions === "string" ? mcpBody.extraInstructions : "",
                tools: mcpBody.tools && typeof mcpBody.tools === "object" ? mcpBody.tools : {},
            });
        }
        res.json({ ok: true, message: "Configuration saved. Apply changes to restart local service.", status: adminStatus(config) });
    });
    app.post("/admin/browse-directory", requireLocalAdmin, (req, res) => {
        try {
            res.json(directoryListing(req.body?.path));
        }
        catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.get("/admin/llm-profile", requireLocalAdmin, (req, res) => {
        const name = String(req.query.name || "");
        const data = readLlmProfiles();
        if (!name || !data.profiles[name]) {
            res.status(404).json({ ok: false, error: "LLM profile not found" });
            return;
        }
        res.json({ ok: true, name, profile: data.profiles[name] });
    });
    app.post("/admin/llm-profiles", requireLocalAdmin, (req, res) => {
        const action = String(req.body?.action || "");
        const name = String(req.body?.name || "").trim();
        const data = readLlmProfiles();
        if (!name) {
            res.status(400).json({ ok: false, error: "Profile name is required" });
            return;
        }
        if (action === "save") {
            data.profiles[name] = normalizeLlmProfile(req.body?.profile || {});
            data.current = name;
            writeLlmProfiles(data);
            writeJsonFile(llmConfigPath(), data.profiles[name]);
            res.json({ ok: true, message: `Saved and selected LLM profile: ${name}`, profiles: Object.keys(data.profiles), current: data.current });
            return;
        }
        if (action === "use") {
            if (!data.profiles[name]) {
                res.status(404).json({ ok: false, error: "LLM profile not found" });
                return;
            }
            data.current = name;
            writeLlmProfiles(data);
            writeJsonFile(llmConfigPath(), data.profiles[name]);
            res.json({ ok: true, message: `Selected LLM profile: ${name}`, current: data.current });
            return;
        }
        if (action === "delete") {
            if (!data.profiles[name]) {
                res.status(404).json({ ok: false, error: "LLM profile not found" });
                return;
            }
            if (Object.keys(data.profiles).length <= 1) {
                res.status(400).json({ ok: false, error: "Cannot delete the last LLM profile" });
                return;
            }
            delete data.profiles[name];
            if (data.current === name) {
                data.current = Object.keys(data.profiles)[0];
                writeJsonFile(llmConfigPath(), data.profiles[data.current]);
            }
            writeLlmProfiles(data);
            res.json({ ok: true, message: `Deleted LLM profile: ${name}`, profiles: Object.keys(data.profiles), current: data.current });
            return;
        }
        res.status(400).json({ ok: false, error: "Unknown action" });
    });
    app.post("/admin/pick-directory", requireLocalAdmin, (req, res) => {
        const current = typeof req.body?.current === "string" ? req.body.current : "";
        const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 FileWorks 工作目录'
$dialog.ShowNewFolderButton = $true
if ('${current.replace(/'/g, "''")}' -and (Test-Path -LiteralPath '${current.replace(/'/g, "''")}')) {
  $dialog.SelectedPath = '${current.replace(/'/g, "''")}'
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
`;
        const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], {
            cwd: PROJECT_ROOT,
            windowsHide: false,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
            res.status(500).json({ ok: false, error: error.message });
        });
        child.on("close", (code) => {
            const selected = stdout.trim();
            if (code !== 0) {
                res.status(500).json({ ok: false, error: stderr || `Directory picker exited with code ${code}` });
                return;
            }
            res.json({ ok: true, path: selected, cancelled: !selected });
        });
    });
    app.post("/admin/test-llm", requireLocalAdmin, async (req, res) => {
        const llmBody = req.body || {};
        const currentLlm = readJsonFile(llmConfigPath());
        const previous = { ...currentLlm };
        const testConfig = {
            ...currentLlm,
            api_url: llmBody.api_url || currentLlm.api_url || DEFAULT_LLM_CONFIG.api_url,
            api_key: typeof llmBody.api_key === "string" ? llmBody.api_key : currentLlm.api_key || "",
            model: llmBody.model || currentLlm.model || DEFAULT_LLM_CONFIG.model,
            timeout_seconds: Number(llmBody.timeout_seconds || currentLlm.timeout_seconds || DEFAULT_LLM_CONFIG.timeout_seconds),
            default_max_tokens: Number(llmBody.default_max_tokens || currentLlm.default_max_tokens || currentLlm.max_tokens || DEFAULT_LLM_CONFIG.default_max_tokens),
        };
        writeJsonFile(llmConfigPath(), testConfig);
        try {
            const result = await callConfiguredLlm({ prompt: "Reply with OK.", max_tokens: 32, temperature: 0 });
            res.json({ ok: !result.isError, result });
        }
        finally {
            writeJsonFile(llmConfigPath(), previous);
        }
    });
    app.post("/admin/apply", requireLocalAdmin, (_req, res) => {
        const restartScript = join(PROJECT_ROOT, "hot-restart-devspace.ps1");
        if (!existsSync(restartScript)) {
            res.status(500).json({ ok: false, error: `Restart script not found: ${restartScript}` });
            return;
        }
        setTimeout(() => {
            const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", restartScript], {
                cwd: PROJECT_ROOT,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            child.unref();
        }, 350);
        res.json({ ok: true, message: "Hot restart scheduled. Refresh this page in a few seconds.", mcpUrl: `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp` });
    });
    app.use(mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        resourceServerUrl,
        scopesSupported: config.oauth.scopes,
        resourceName: "DevSpace",
    }));
    app.options("/mcp-app-assets/{*asset}", (_req, res) => {
        setAssetHeaders(res);
        res.sendStatus(204);
    });
    app.use("/mcp-app-assets", express.static(uiBuildDirectory(), {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
        setHeaders: setAssetHeaders,
    }));
    app.get("/.well-known/openid-configuration", (_req, res) => {
        const baseUrl = config.publicBaseUrl.replace(/\/+$/, "");
        res.json({
            issuer: `${baseUrl}/`,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            revocation_endpoint: `${baseUrl}/revoke`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: config.oauth.scopes,
        });
    });
    app.get("/healthz", (_req, res) => {
        res.json({ ok: true, name: "devspace" });
    });
    app.all("/mcp", async (req, res) => {
        const requestId = res.locals.requestId;
        const sessionId = req.header("mcp-session-id");
        const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
        await new Promise((resolve, reject) => {
            bearerAuth(req, res, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
        if (res.headersSent)
            return;
        if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
            logEvent(config.logging, "warn", "auth_denied", {
                requestId,
                method: req.method,
                path: requestPath(req),
                reason: "invalid_oauth_resource",
                ...requestLogFields(req, config),
            });
            sendJsonRpcError(res, 401, -32001, "Unauthorized");
            return;
        }
        logEvent(config.logging, "debug", "mcp_request", {
            requestId,
            method: req.method,
            sessionIdPresent: Boolean(sessionId),
            sessionIdPrefix: sessionIdPrefix(sessionId),
            isInitialize: initializeRequest,
        });
        try {
            let transport;
            if (sessionId) {
                transport = transports.get(sessionId);
                if (!transport) {
                    sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
                    return;
                }
            }
            else if (initializeRequest) {
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (newSessionId) => {
                        if (transport)
                            transports.set(newSessionId, transport);
                        logEvent(config.logging, "info", "mcp_session_created", {
                            requestId,
                            sessionIdPrefix: sessionIdPrefix(newSessionId),
                            ...requestLogFields(req, config),
                        });
                    },
                });
                transport.onclose = () => {
                    const closedSessionId = transport?.sessionId;
                    if (closedSessionId) {
                        transports.delete(closedSessionId);
                        logEvent(config.logging, "info", "mcp_session_closed", {
                            sessionIdPrefix: sessionIdPrefix(closedSessionId),
                        });
                    }
                };
                const server = createMcpServer(config, workspaces, reviewCheckpoints);
                await server.connect(transport);
            }
            else {
                sendJsonRpcError(res, 400, -32000, "No valid MCP session");
                return;
            }
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            appendRequestTrace({
                ts: new Date().toISOString(),
                requestId,
                event: "mcp_request_error",
                method: req.method,
                path: requestPath(req),
                mcpMethod: req.body?.method,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            logEvent(config.logging, "error", "mcp_request_error", {
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
            if (!res.headersSent) {
                sendJsonRpcError(res, 500, -32603, "Internal server error");
            }
        }
    });
    let closed = false;
    return {
        app,
        config,
        close: () => {
            if (closed)
                return;
            closed = true;
            oauthProvider.close();
            workspaceStore.close?.();
        },
    };
}
async function isMainModule() {
    if (!process.argv[1])
        return false;
    const modulePath = await realpath(fileURLToPath(import.meta.url));
    const entrypointPath = await realpath(process.argv[1]);
    return modulePath === entrypointPath;
}
if (await isMainModule()) {
    const { app, config, close } = createServer();
    const httpServer = app.listen(config.port, config.host, () => {
        console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
        console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
        console.log("auth: oauth owner-token flow required");
        console.log(`logging: ${config.logging.level} ${config.logging.format}`);
        console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
        console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
        console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    });
    const shutdown = () => {
        httpServer.close(() => {
            close();
            process.exit(0);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
