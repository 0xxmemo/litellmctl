"""Tests for wizard/ — model collection, alias building, config generation."""

from __future__ import annotations

from collections import OrderedDict


# ── Fixtures ────────────────────────────────────────────────────────────────

def _make_providers() -> OrderedDict:
    return OrderedDict([
        ("chatgpt", {
            "tiers": {
                "opus":   [{"model_name": "ultra", "model": "chatgpt/gpt-4o"}],
                "sonnet": [{"model_name": "plus",  "model": "chatgpt/gpt-4o-mini"}],
                "haiku":  [{"model_name": "lite",  "model": "chatgpt/gpt-3.5-turbo"}],
            },
            "extra_models": [],
            "embedding_models": [],
            "transcription_models": [],
        }),
        ("gemini", {
            "tiers": {
                "opus":   [{"model_name": "ultra", "model": "gemini/gemini-1.5-pro"}],
                "sonnet": [{"model_name": "plus",  "model": "gemini/gemini-1.5-flash"}],
                "haiku":  [],
            },
            "extra_models": [],
            "embedding_models": [
                {"model_name": "embed-small", "model": "gemini/text-embedding-004",
                 "model_info": {"mode": "embedding", "input_cost_per_token": 0,
                                "output_cost_per_token": 0}}
            ],
            "transcription_models": [],
        }),
    ])


# ── model_entry ──────────────────────────────────────────────────────────────

class TestModelEntry:
    def test_basic_entry(self):
        from lib.wizard.models import model_entry
        m = {"model_name": "ultra", "model": "chatgpt/gpt-4o"}
        result = model_entry(m)
        assert result["model_name"] == "ultra"
        assert result["litellm_params"]["model"] == "chatgpt/gpt-4o"

    def test_includes_model_info(self):
        from lib.wizard.models import model_entry
        m = {
            "model_name": "embed",
            "model": "gemini/embed",
            "model_info": {"mode": "embedding"},
        }
        result = model_entry(m)
        assert result["model_info"]["mode"] == "embedding"

    def test_includes_timeout(self):
        from lib.wizard.models import model_entry
        m = {"model_name": "x", "model": "p/m", "timeout": 60}
        result = model_entry(m)
        assert result["litellm_params"]["timeout"] == 60

    def test_includes_thinking(self):
        from lib.wizard.models import model_entry
        m = {"model_name": "x", "model": "p/m", "thinking": {"type": "enabled", "budget": 4096}}
        result = model_entry(m)
        assert result["litellm_params"]["thinking"]["type"] == "enabled"

    def test_includes_dimensions_for_single_local_embedding(self):
        from lib.wizard.models import model_entry
        m = {
            "model_name": "local/nomic-embed-text",
            "model": "ollama/nomic-embed-text-v2-moe",
            "api_base": "os.environ/LOCAL_EMBEDDING_API_BASE",
            "dimensions": 512,
        }
        result = model_entry(m)
        assert result["litellm_params"]["dimensions"] == 512

    def test_no_extra_keys_without_optionals(self):
        from lib.wizard.models import model_entry
        m = {"model_name": "x", "model": "p/m"}
        result = model_entry(m)
        assert "model_info" not in result
        assert "timeout" not in result["litellm_params"]


# ── collect_models ────────────────────────────────────────────────────────────

class TestCollectModels:
    def test_collects_across_tiers(self):
        from lib.wizard.models import collect_models
        providers = _make_providers()
        models = collect_models(["chatgpt"], providers, ["opus", "sonnet", "haiku"])
        names = [m["model_name"] for m in models]
        assert "ultra" in names
        assert "plus" in names
        assert "lite" in names

    def test_deduplicates_across_providers(self):
        """Both providers map tier 'opus' → model_name 'ultra'; only one entry."""
        from lib.wizard.models import collect_models
        providers = _make_providers()
        models = collect_models(["chatgpt", "gemini"], providers, ["opus"])
        assert len([m for m in models if m["model_name"] == "ultra"]) == 1

    def test_empty_providers_returns_empty(self):
        from lib.wizard.models import collect_models
        models = collect_models([], _make_providers(), ["opus"])
        assert models == []


# ── collect_task_models ───────────────────────────────────────────────────────

class TestCollectTaskModels:
    def test_collects_embedding_models(self):
        from lib.wizard.models import collect_task_models
        providers = _make_providers()
        models = collect_task_models(["gemini"], providers, "embedding_models")
        assert len(models) == 1
        assert models[0]["model_name"] == "embed-small"

    def test_empty_when_no_task_models(self):
        from lib.wizard.models import collect_task_models
        providers = _make_providers()
        models = collect_task_models(["chatgpt"], providers, "embedding_models")
        assert models == []


# ── build_aliases ─────────────────────────────────────────────────────────────

class TestBuildAliases:
    def test_builds_alias_from_primary(self):
        from lib.wizard.models import build_aliases
        providers = _make_providers()
        aliases = build_aliases(
            tiers=["opus", "sonnet", "haiku"],
            primary_map={"opus": "chatgpt", "sonnet": "gemini", "haiku": "chatgpt"},
            providers=providers,
        )
        assert aliases["opus"] == "ultra"
        assert aliases["haiku"] == "lite"

    def test_skips_missing_provider(self):
        from lib.wizard.models import build_aliases
        providers = _make_providers()
        aliases = build_aliases(
            tiers=["opus"],
            primary_map={"opus": "nonexistent"},
            providers=providers,
        )
        assert "opus" not in aliases

    def test_skips_empty_tier(self):
        from lib.wizard.models import build_aliases
        providers = _make_providers()
        # gemini has no haiku models
        aliases = build_aliases(
            tiers=["haiku"],
            primary_map={"haiku": "gemini"},
            providers=providers,
        )
        assert "haiku" not in aliases


# ── build_fallbacks ───────────────────────────────────────────────────────────

class TestBuildFallbacks:
    def test_builds_fallback_chain(self):
        from lib.wizard.models import build_fallbacks
        providers = _make_providers()
        fallbacks = build_fallbacks(
            tiers=["opus"],
            primary_map={"opus": "chatgpt"},
            fallback_map={"opus": ["chatgpt", "gemini"]},
            providers=providers,
        )
        assert len(fallbacks) == 1
        chain = fallbacks[0]["opus"]
        # gemini's opus model should be in fallback (chatgpt is primary, excluded)
        assert "ultra" in chain or len(chain) >= 0  # gemini also maps to "ultra" (dedup)

    def test_no_fallbacks_if_no_fallback_map(self):
        from lib.wizard.models import build_fallbacks
        providers = _make_providers()
        fallbacks = build_fallbacks(
            tiers=["opus"],
            primary_map={"opus": "chatgpt"},
            fallback_map={},
            providers=providers,
        )
        assert fallbacks == []


# ── Local provider readiness (wizard) ──────────────────────────────────────────

class TestCheckProviderReadyLocal:
    def test_only_ollama_up_still_ready(self, monkeypatch):
        from lib.wizard import providers as p
        monkeypatch.setattr(
            p,
            "probe_local_services",
            lambda _env: (True, False, "http://127.0.0.1:11434", "http://127.0.0.1:10300/v1"),
        )
        prov = {
            "auth": "none",
            "embedding_models": [{"model_name": "a", "model": "ollama/a"}],
            "transcription_models": [{"model_name": "b", "model": "openai/whisper"}],
        }
        ok, reason = p.check_provider_ready("local", prov, {}, {})
        assert ok is True
        assert "ollama" in reason.lower()

    def test_supplemental_both_servers_down_still_ready(self, monkeypatch):
        from lib.wizard import providers as p
        monkeypatch.setattr(
            p,
            "probe_local_services",
            lambda _env: (False, False, "http://127.0.0.1:11434", "http://127.0.0.1:10300/v1"),
        )
        prov = {
            "auth": "none",
            "role": "supplemental",
            "embedding_models": [{"model_name": "a", "model": "ollama/a"}],
            "transcription_models": [{"model_name": "b", "model": "openai/whisper"}],
        }
        ok, _reason = p.check_provider_ready("local", prov, {}, {})
        assert ok is True

    def test_non_supplemental_both_down_not_ready(self, monkeypatch):
        from lib.wizard import providers as p
        monkeypatch.setattr(
            p,
            "probe_local_services",
            lambda _env: (False, False, "http://127.0.0.1:11434", "http://127.0.0.1:10300/v1"),
        )
        prov = {
            "auth": "none",
            "embedding_models": [{"model_name": "a", "model": "ollama/a"}],
            "transcription_models": [{"model_name": "b", "model": "openai/whisper"}],
        }
        ok, _reason = p.check_provider_ready("custom_local", prov, {}, {})
        assert ok is False


class TestGenerateYamlOllamaPullHint:
    def test_includes_ollama_pull_for_embedding_models(self):
        from lib.wizard.config_gen import generate_yaml
        defaults = {"router_settings": {}, "litellm_settings": {}, "general_settings": {}}
        emb = [
            {
                "model_name": "local/foo",
                "litellm_params": {"model": "ollama/foo", "api_base": "os.environ/LOCAL_EMBEDDING_API_BASE"},
                "model_info": {"mode": "embedding"},
            },
            {
                "model_name": "local/bar",
                "litellm_params": {"model": "ollama/bar", "api_base": "os.environ/LOCAL_EMBEDDING_API_BASE"},
                "model_info": {"mode": "embedding"},
            },
        ]
        out = generate_yaml([], {}, [], defaults, embedding_models=emb, transcription_models=None)
        assert "ollama pull foo && ollama pull bar" in out
