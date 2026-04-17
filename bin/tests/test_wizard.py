"""Tests for wizard/ — model collection, alias building, config generation."""

from __future__ import annotations

from collections import OrderedDict


# ── Fixtures ────────────────────────────────────────────────────────────────

def _make_providers() -> OrderedDict:
    return OrderedDict([
        ("chatgpt", {
            "models": [
                {"model_name": "chatgpt/gpt-3.5-turbo", "model": "chatgpt/gpt-3.5-turbo"},
                {"model_name": "chatgpt/gpt-4o", "model": "chatgpt/gpt-4o"},
                {"model_name": "chatgpt/gpt-4o-mini", "model": "chatgpt/gpt-4o-mini"},
            ],
            "embedding_models": [],
            "transcription_models": [],
        }),
        ("gemini", {
            "models": [
                {"model_name": "gemini/gemini-1.5-flash", "model": "gemini/gemini-1.5-flash"},
                {"model_name": "gemini/gemini-1.5-pro", "model": "gemini/gemini-1.5-pro"},
            ],
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
        m = {"model_name": "chatgpt/gpt-4o", "model": "chatgpt/gpt-4o"}
        result = model_entry(m)
        assert result["model_name"] == "chatgpt/gpt-4o"
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
    def test_collects_all_models(self):
        from lib.wizard.models import collect_models
        providers = _make_providers()
        models = collect_models(["chatgpt"], providers)
        names = [m["model_name"] for m in models]
        assert len(names) == 3
        assert "chatgpt/gpt-4o" in names
        assert "chatgpt/gpt-4o-mini" in names
        assert "chatgpt/gpt-3.5-turbo" in names

    def test_sorted_alphanumerically(self):
        from lib.wizard.models import collect_models
        providers = _make_providers()
        models = collect_models(["chatgpt"], providers)
        names = [m["model_name"] for m in models]
        assert names == sorted(names)

    def test_deduplicates_across_providers(self):
        """Models with the same model_name across providers are deduped."""
        from lib.wizard.models import collect_models
        providers = OrderedDict([
            ("a", {"models": [{"model_name": "shared/model", "model": "a/model"}]}),
            ("b", {"models": [{"model_name": "shared/model", "model": "b/model"}]}),
        ])
        models = collect_models(["a", "b"], providers)
        assert len([m for m in models if m["model_name"] == "shared/model"]) == 1

    def test_empty_providers_returns_empty(self):
        from lib.wizard.models import collect_models
        models = collect_models([], _make_providers())
        assert models == []

    def test_multi_provider_sorted(self):
        from lib.wizard.models import collect_models
        providers = _make_providers()
        models = collect_models(["chatgpt", "gemini"], providers)
        names = [m["model_name"] for m in models]
        assert names == sorted(names)
        assert len(names) == 5  # 3 chatgpt + 2 gemini


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
    def test_builds_alias_from_chain_sets(self):
        from lib.wizard.models import build_aliases
        chain_sets = [
            {"name": "ultra", "primary": "chatgpt/gpt-4o", "fallbacks": []},
            {"name": "plus", "primary": "chatgpt/gpt-4o-mini", "fallbacks": []},
            {"name": "lite", "primary": "chatgpt/gpt-3.5-turbo", "fallbacks": []},
        ]
        aliases = build_aliases(chain_sets)
        assert aliases["ultra"] == "chatgpt/gpt-4o"
        assert aliases["plus"] == "chatgpt/gpt-4o-mini"
        assert aliases["lite"] == "chatgpt/gpt-3.5-turbo"

    def test_empty_chain_sets(self):
        from lib.wizard.models import build_aliases
        aliases = build_aliases([])
        assert aliases == {}


# ── build_fallbacks ───────────────────────────────────────────────────────────

class TestBuildFallbacks:
    def test_builds_fallback_chain(self):
        from lib.wizard.models import build_fallbacks
        chain_sets = [
            {
                "name": "ultra",
                "primary": "chatgpt/gpt-4o",
                "fallbacks": ["gemini/gemini-1.5-pro", "gemini/gemini-1.5-flash"],
            },
        ]
        fallbacks = build_fallbacks(chain_sets)
        assert len(fallbacks) == 1
        chain = fallbacks[0]["ultra"]
        assert chain == ["gemini/gemini-1.5-pro", "gemini/gemini-1.5-flash"]

    def test_no_fallbacks_if_empty(self):
        from lib.wizard.models import build_fallbacks
        chain_sets = [
            {"name": "ultra", "primary": "chatgpt/gpt-4o", "fallbacks": []},
        ]
        fallbacks = build_fallbacks(chain_sets)
        assert fallbacks == []

    def test_multiple_chain_sets(self):
        from lib.wizard.models import build_fallbacks
        chain_sets = [
            {"name": "ultra", "primary": "a", "fallbacks": ["b", "c"]},
            {"name": "plus", "primary": "d", "fallbacks": ["e"]},
            {"name": "lite", "primary": "f", "fallbacks": []},
        ]
        fallbacks = build_fallbacks(chain_sets)
        assert len(fallbacks) == 2  # lite has no fallbacks, not included
        assert fallbacks[0]["ultra"] == ["b", "c"]
        assert fallbacks[1]["plus"] == ["e"]


# ── Provider backward compat (flatten tiers) ─────────────────────────────────

class TestFlattenTiers:
    def test_old_format_flattened(self):
        from lib.wizard.providers import _flatten_tiers
        data = {
            "tiers": {
                "ultra": [{"model_name": "a/z", "model": "x/z"}],
                "lite": [{"model_name": "a/a", "model": "x/a"}],
            },
            "extra_models": [{"model_name": "a/m", "model": "x/m"}],
        }
        _flatten_tiers(data)
        assert "tiers" not in data
        assert "extra_models" not in data
        names = [m["model_name"] for m in data["models"]]
        assert names == sorted(names)  # alphabetically sorted
        assert len(names) == 3

    def test_no_tiers_no_op(self):
        from lib.wizard.providers import _flatten_tiers
        data = {"models": [{"model_name": "x", "model": "y"}]}
        _flatten_tiers(data)
        assert len(data["models"]) == 1


# ── Local provider readiness (wizard) ──────────────────────────────────────────

class TestCheckProviderReadyLocal:
    def test_only_ollama_up_still_ready(self, monkeypatch):
        from lib.wizard import providers as p
        monkeypatch.setattr(
            p,
            "probe_local_services",
            lambda _env: (
                True, False, False,
                "http://127.0.0.1:11434", "http://127.0.0.1:10300/v1",
                "http://localhost:8888",
            ),
        )
        prov = {
            "auth": "none",
            "models": [],
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
            lambda _env: (
                False, False, False,
                "http://127.0.0.1:11434", "http://127.0.0.1:10300/v1",
                "http://localhost:8888",
            ),
        )
        prov = {
            "auth": "none",
            "role": "supplemental",
            "models": [],
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
            lambda _env: (
                False, False, False,
                "http://127.0.0.1:11434", "http://127.0.0.1:10300/v1",
                "http://localhost:8888",
            ),
        )
        prov = {
            "auth": "none",
            "models": [],
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
