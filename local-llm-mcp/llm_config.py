"""Shared LLM configuration and client helpers."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


DEFAULT_API_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_MAX_TOKENS = 65536


@dataclass(frozen=True)
class LLMConfig:
    api_url: str = DEFAULT_API_URL
    api_key: str = ""
    model: str = DEFAULT_MODEL
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    default_max_tokens: int = DEFAULT_MAX_TOKENS


def _config_path(base_dir: Path) -> Path:
    explicit = os.environ.get("LLM_CONFIG_FILE")
    if explicit:
        return Path(explicit).expanduser().resolve()
    return (base_dir / "llm_config.json").resolve()


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"LLM config must be a JSON object: {path}")
    return data


def load_llm_config(base_dir: Path | None = None) -> LLMConfig:
    base = base_dir or Path(__file__).resolve().parent
    data = _read_json(_config_path(base))

    api_url = os.environ.get("AGNES_API_URL") or data.get("api_url") or DEFAULT_API_URL
    api_key = os.environ.get("AGNES_API_KEY") or data.get("api_key") or ""
    model = os.environ.get("AGNES_MODEL") or data.get("model") or DEFAULT_MODEL

    timeout_value = os.environ.get("AGNES_TIMEOUT_SECONDS") or data.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS
    max_tokens_value = os.environ.get("AGNES_MAX_TOKENS") or data.get("default_max_tokens") or data.get("max_tokens") or DEFAULT_MAX_TOKENS

    return LLMConfig(
        api_url=str(api_url).strip(),
        api_key=str(api_key).strip(),
        model=str(model).strip(),
        timeout_seconds=int(timeout_value),
        default_max_tokens=int(max_tokens_value),
    )


async def complete_chat(
    prompt: str,
    *,
    system: str = "",
    temperature: float = 0.7,
    max_tokens: int | None = None,
    config: LLMConfig | None = None,
) -> str:
    cfg = config or load_llm_config()
    if not cfg.api_url:
        return "[ERROR] LLM api_url is empty. Set it in llm_config.json or AGNES_API_URL."

    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    headers: dict[str, str] = {}
    if cfg.api_key:
        headers["Authorization"] = f"Bearer {cfg.api_key}"

    payload = {
        "model": cfg.model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens or cfg.default_max_tokens,
    }

    async with httpx.AsyncClient(timeout=cfg.timeout_seconds) as client:
        resp = await client.post(cfg.api_url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
