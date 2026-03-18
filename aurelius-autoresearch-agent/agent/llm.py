"""LLM abstraction layer supporting Claude, OpenAI-compatible, and Ollama providers."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)


class LLMProvider(Protocol):
    """Protocol for LLM providers."""

    async def complete(self, system_prompt: str, user_message: str, max_tokens: int = 4096) -> str: ...


class ClaudeProvider:
    """Anthropic Claude API provider."""

    def __init__(self, model: str = "claude-sonnet-4-20250514", api_key: str | None = None):
        import anthropic
        self.model = model
        self.client = anthropic.AsyncAnthropic(api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"))

    async def complete(self, system_prompt: str, user_message: str, max_tokens: int = 4096) -> str:
        for attempt in range(3):
            try:
                response = await self.client.messages.create(
                    model=self.model,
                    max_tokens=max_tokens,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_message}],
                )
                return response.content[0].text
            except Exception as e:
                if attempt == 2:
                    raise
                wait = 2 ** (attempt + 1)
                logger.warning(f"Claude API error (attempt {attempt + 1}/3): {e}. Retrying in {wait}s...")
                await asyncio.sleep(wait)
        return ""  # unreachable


class OpenAICompatibleProvider:
    """OpenAI-compatible API provider (works with LeapfrogAI)."""

    def __init__(self, model: str = "gpt-4o", api_key: str | None = None, base_url: str | None = None):
        import openai
        self.model = model
        self.client = openai.AsyncOpenAI(
            api_key=api_key or os.environ.get("OPENAI_API_KEY"),
            base_url=base_url or os.environ.get("OPENAI_BASE_URL"),
        )

    async def complete(self, system_prompt: str, user_message: str, max_tokens: int = 4096) -> str:
        for attempt in range(3):
            try:
                response = await self.client.chat.completions.create(
                    model=self.model,
                    max_tokens=max_tokens,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_message},
                    ],
                )
                return response.choices[0].message.content or ""
            except Exception as e:
                if attempt == 2:
                    raise
                wait = 2 ** (attempt + 1)
                logger.warning(f"OpenAI API error (attempt {attempt + 1}/3): {e}. Retrying in {wait}s...")
                await asyncio.sleep(wait)
        return ""


class OllamaProvider:
    """Ollama local LLM provider."""

    def __init__(self, model: str = "llama3.1", base_url: str | None = None):
        self.model = model
        self.base_url = (base_url or os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")).rstrip("/")

    async def complete(self, system_prompt: str, user_message: str, max_tokens: int = 4096) -> str:
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(timeout=300.0) as client:
                    response = await client.post(
                        f"{self.base_url}/api/chat",
                        json={
                            "model": self.model,
                            "messages": [
                                {"role": "system", "content": system_prompt},
                                {"role": "user", "content": user_message},
                            ],
                            "stream": False,
                            "options": {"num_predict": max_tokens},
                        },
                    )
                response.raise_for_status()
                return response.json()["message"]["content"]
            except Exception as e:
                if attempt == 2:
                    raise
                wait = 2 ** (attempt + 1)
                logger.warning(f"Ollama API error (attempt {attempt + 1}/3): {e}. Retrying in {wait}s...")
                await asyncio.sleep(wait)
        return ""


def get_llm(provider: str = "claude", model: str = "claude-sonnet-4-20250514") -> LLMProvider:
    """Factory function to create the appropriate LLM provider."""
    if provider == "claude":
        return ClaudeProvider(model=model)
    elif provider == "openai":
        return OpenAICompatibleProvider(model=model)
    elif provider == "ollama":
        return OllamaProvider(model=model)
    else:
        raise ValueError(f"Unknown LLM provider: {provider}. Use 'claude', 'openai', or 'ollama'.")
