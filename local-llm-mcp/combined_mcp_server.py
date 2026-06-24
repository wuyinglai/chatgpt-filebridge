"""FileWorks MCP server: local files + configured LLM + OAuth 2.0.

Usage:
    python combined_mcp_server.py <port> <root_dir> <public_base_url>

ChatGPT connector URL:
    https://xxx.trycloudflare.com
"""

from __future__ import annotations

import contextlib
import os
import secrets
import sys
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from pydantic import AnyUrl

from llm_config import complete_chat, load_llm_config
from mcp.server.auth.routes import create_auth_routes
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.shared.auth import OAuthClientInformationFull
from mcp_oauth.server.auth_provider.simple_auth_provider import (
    SimpleAuthSettings,
    SimpleOAuthProvider,
)
from mcp_oauth.server.token_verifier.token_verifier import IntrospectionTokenVerifier


SERVER_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7676
ALLOWED_ROOT = (Path(sys.argv[2]) if len(sys.argv) > 2 else Path.cwd()).resolve()
TUNNEL_URL = (sys.argv[3] if len(sys.argv) > 3 else f"http://127.0.0.1:{SERVER_PORT}").rstrip("/")
TUNNEL_URL_PYD = AnyUrl(TUNNEL_URL)
LOCAL_URL = f"http://127.0.0.1:{SERVER_PORT}"

OAUTH_USER = os.environ.get("MCP_USER", "admin")
_DEFAULT_PASS = secrets.token_urlsafe(12)
OAUTH_PASS = os.environ.get("MCP_PASS") or _DEFAULT_PASS
_PASS_AUTO_GENERATED = "MCP_PASS" not in os.environ
LLM_CONFIG = load_llm_config(Path(__file__).resolve().parent)
STARTED_AT = time.time()
TOOLS = ["list_directory", "read_file", "write_file", "search_files", "call_llm"]


def safe_path(relative: str) -> Path:
    """Resolve a user path and keep it inside ALLOWED_ROOT."""
    candidate = (ALLOWED_ROOT / relative).resolve()
    try:
        candidate.relative_to(ALLOWED_ROOT)
    except ValueError as exc:
        raise ValueError(f"Path escapes allowed root: {relative}") from exc
    return candidate


oauth_provider = SimpleOAuthProvider(
    settings=SimpleAuthSettings(
        superusername=OAUTH_USER,
        superuserpassword=OAUTH_PASS,
        mcp_scope="user",
    ),
    auth_callback_url=f"{TUNNEL_URL}/login",
    server_url=TUNNEL_URL,
)

CHATGPT_CLIENT = OAuthClientInformationFull(
    client_id="chatgpt-fileworks-client",
    redirect_uris=["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method="none",
    grant_types=["authorization_code", "refresh_token"],
    response_types=["code"],
    scope="openid email user",
    client_name="ChatGPT FileWorks",
)

token_verifier = IntrospectionTokenVerifier(
    introspection_endpoint=f"{LOCAL_URL}/introspect",
    server_url=TUNNEL_URL,
    validate_resource=False,
)

mcp = FastMCP(
    name="fileworks",
    host="127.0.0.1",
    port=SERVER_PORT,
    token_verifier=token_verifier,
    auth=AuthSettings(
        issuer_url=TUNNEL_URL_PYD,
        client_registration_options=ClientRegistrationOptions(
            enabled=True,
            valid_scopes=["user"],
            default_scopes=["user"],
        ),
        required_scopes=["user"],
        resource_server_url=TUNNEL_URL_PYD,
    ),
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    ),
)


@mcp.tool()
async def list_directory(path: str = "") -> str:
    """List files and folders under the allowed root."""
    target = ALLOWED_ROOT if not path else safe_path(path)
    if not target.exists():
        return f"[ERROR] Directory does not exist: {target}"
    if not target.is_dir():
        return f"[ERROR] Not a directory: {target}"

    items: list[str] = []
    for entry in sorted(target.iterdir()):
        tag = "[DIR]" if entry.is_dir() else "[FILE]"
        try:
            size = entry.stat().st_size
        except OSError:
            size = 0
        items.append(f"{tag} {entry.name} ({size} bytes)")
    return "\n".join(items) if items else "(empty directory)"


@mcp.tool()
async def read_file(path: str) -> str:
    """Read a UTF-8 text file under the allowed root."""
    try:
        target = safe_path(path)
    except ValueError as exc:
        return f"[ERROR] {exc}"
    if not target.exists():
        return f"[ERROR] File does not exist: {target}"
    if not target.is_file():
        return f"[ERROR] Not a file: {target}"
    try:
        return target.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return f"[ERROR] Read failed: {exc}"


@mcp.tool()
async def write_file(path: str, content: str) -> str:
    """Write a UTF-8 text file under the allowed root."""
    try:
        target = safe_path(path)
    except ValueError as exc:
        return f"[ERROR] {exc}"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        size = target.stat().st_size
        return f"[OK] Wrote {target} ({size} bytes)"
    except Exception as exc:
        return f"[ERROR] Write failed: {exc}"


@mcp.tool()
async def search_files(directory: str = "", pattern: str = "*") -> str:
    """Search files under the allowed root by glob pattern."""
    try:
        base = ALLOWED_ROOT if not directory else safe_path(directory)
    except ValueError as exc:
        return f"[ERROR] {exc}"
    if not base.exists():
        return f"[ERROR] Directory does not exist: {base}"
    if not base.is_dir():
        return f"[ERROR] Not a directory: {base}"

    results = []
    for file_path in sorted(base.rglob(pattern)):
        if file_path.is_file():
            results.append(str(file_path.relative_to(ALLOWED_ROOT)))
    return "\n".join(results[:200]) if results else "(no matching files)"


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
        config=LLM_CONFIG,
    )


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    await oauth_provider.register_client(CHATGPT_CLIENT)
    print("  Client registered: chatgpt-fileworks-client")
    async with contextlib.AsyncExitStack() as stack:
        await stack.enter_async_context(mcp.session_manager.run())
        yield


fastapi_app = FastAPI(lifespan=lifespan)


@fastapi_app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "fileworks",
        "port": SERVER_PORT,
        "root": str(ALLOWED_ROOT),
        "root_exists": ALLOWED_ROOT.exists(),
        "tunnel_url": TUNNEL_URL,
        "oauth": "ready",
        "mcp_endpoint": f"{TUNNEL_URL}/mcp",
        "connector_url": TUNNEL_URL,
        "llm": {
            "model": LLM_CONFIG.model,
            "api_url": LLM_CONFIG.api_url,
            "api_key_configured": bool(LLM_CONFIG.api_key),
            "default_max_tokens": LLM_CONFIG.default_max_tokens,
            "timeout_seconds": LLM_CONFIG.timeout_seconds,
        },
        "tools": TOOLS,
        "uptime_seconds": round(time.time() - STARTED_AT, 1),
    }


@fastapi_app.get("/status", response_class=HTMLResponse)
async def status_page():
    key_state = "configured" if LLM_CONFIG.api_key else "missing"
    root_state = "ok" if ALLOWED_ROOT.exists() else "missing"
    rows = [
        ("Service", "FileWorks MCP"),
        ("Status", "OK"),
        ("Root", f"{ALLOWED_ROOT} ({root_state})"),
        ("Connector URL", TUNNEL_URL),
        ("OAuth discovery", f"{TUNNEL_URL}/.well-known/oauth-authorization-server"),
        ("OIDC discovery", f"{TUNNEL_URL}/.well-known/openid-configuration"),
        ("MCP endpoint", f"{TUNNEL_URL}/mcp"),
        ("LLM model", LLM_CONFIG.model),
        ("LLM API key", key_state),
        ("Tools", ", ".join(TOOLS)),
        ("Uptime", f"{round(time.time() - STARTED_AT, 1)} seconds"),
    ]
    row_html = "\n".join(
        f"<tr><th>{name}</th><td>{value}</td></tr>" for name, value in rows
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FileWorks MCP Status</title>
  <style>
    body {{ font-family: Segoe UI, Arial, sans-serif; margin: 32px; color: #1f2328; }}
    main {{ max-width: 920px; }}
    h1 {{ margin-bottom: 8px; }}
    .ok {{ display: inline-block; padding: 4px 10px; border-radius: 999px; background: #dafbe1; color: #116329; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 20px; }}
    th, td {{ border-bottom: 1px solid #d8dee4; padding: 10px 12px; text-align: left; vertical-align: top; }}
    th {{ width: 180px; color: #57606a; font-weight: 600; }}
    code {{ background: #f6f8fa; padding: 2px 5px; border-radius: 4px; }}
  </style>
</head>
<body>
  <main>
    <h1>FileWorks MCP Status <span class="ok">OK</span></h1>
    <p>Use the connector URL below in ChatGPT. For FileWorks, do not append <code>/mcp</code>.</p>
    <table>{row_html}</table>
  </main>
</body>
</html>"""


@fastapi_app.get("/login")
async def login_page(request: Request, state: str = ""):
    return await oauth_provider.get_login_page(state)


@fastapi_app.post("/login/callback")
async def login_callback(request: Request):
    return await oauth_provider.handle_login_callback(request)


@fastapi_app.get("/.well-known/openid-configuration")
async def openid_configuration():
    return {
        "issuer": TUNNEL_URL,
        "authorization_endpoint": f"{TUNNEL_URL}/authorize",
        "token_endpoint": f"{TUNNEL_URL}/token",
        "registration_endpoint": f"{TUNNEL_URL}/register",
        "introspection_endpoint": f"{TUNNEL_URL}/introspect",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": [
            "none",
            "client_secret_post",
            "client_secret_basic",
        ],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": ["openid", "email", "user"],
        "claims_supported": ["sub", "email"],
    }


@fastapi_app.post("/introspect")
async def introspect_token(request: Request):
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.json()
        token = body.get("token")
    else:
        form = await request.form()
        token = form.get("token")

    if not token:
        return {"active": False}

    access_token = await oauth_provider.load_access_token(token)
    if access_token is None:
        return {"active": False}

    return {
        "active": True,
        "scope": " ".join(access_token.scopes),
        "client_id": access_token.client_id,
        "token_type": "Bearer",
        "exp": access_token.expires_at,
        "sub": access_token.subject,
    }


auth_routes = create_auth_routes(
    provider=oauth_provider,
    issuer_url=TUNNEL_URL_PYD,
    service_documentation_url=None,
    client_registration_options=ClientRegistrationOptions(
        enabled=True,
        valid_scopes=["user", "openid", "email"],
        default_scopes=["user", "openid", "email"],
    ),
    revocation_options=None,
)

for route in auth_routes:
    fastapi_app.router.routes.append(route)


mcp_app = mcp.streamable_http_app()


class MCPRootProxy:
    """Route root MCP calls from ChatGPT to the SDK /mcp endpoint."""

    def __init__(self, mcp_asgi):
        self.mcp = mcp_asgi

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] == "/":
            scope = dict(scope)
            scope["path"] = "/mcp"
            scope["raw_path"] = b"/mcp"
        await self.mcp(scope, receive, send)


fastapi_app.mount("/", MCPRootProxy(mcp_app))


if __name__ == "__main__":
    import uvicorn

    print("=== FileWorks MCP Server (OAuth + files + LLM) ===")
    print(f"Port        : {SERVER_PORT}")
    print(f"Root        : {ALLOWED_ROOT}")
    print(f"Tunnel URL  : {TUNNEL_URL}")
    print(f"OAuth User  : {OAUTH_USER}")
    if _PASS_AUTO_GENERATED:
        print(f"OAuth Pass  : {OAUTH_PASS}  (auto-generated, set MCP_PASS to override)")
    else:
        print(f"OAuth Pass  : (from MCP_PASS env)")
    print(f"LLM Model   : {LLM_CONFIG.model}")
    print(f"LLM API     : {LLM_CONFIG.api_url}")
    print(f"OIDC Config : {TUNNEL_URL}/.well-known/openid-configuration")
    print(f"MCP         : {TUNNEL_URL}")
    print("")

    uvicorn.run(fastapi_app, host="127.0.0.1", port=SERVER_PORT, log_level="info")
