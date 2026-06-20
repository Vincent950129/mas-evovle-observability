"""
Build Inspector engine -- make the *build pipeline* of the skill-track
(``evovle_skills``) and the agent-track (``evovle_agents``) legible.

Where the rest of ``observability/`` inspects RUN RESULTS of the evolving-tools
track, this module inspects how the two evolving *resources* are constructed
BEFORE any trial runs:

    evovle_skills:  dataset rows + a versioned oracle SKILL.md library
                    (per-version pool, cumulative pool)
    evovle_agents:  the tool universe re-partitioned into disjoint, COMPLETE
                    *capability* agents (each owns its whole tool bundle),
                    materialized as Codex subagents

It is a thin, read-only layer over the real build code -- it imports
``evovle_skills`` / ``evovle_agents`` and calls the very functions the harness
uses (``skill_oracle_tool_map``, ``canonical_agent_names``,
``oracle_agent_specs`` ...), so what you see here is exactly what a trial would
mount.  No values are re-implemented.  The observability backend
(``backend/app.py``) exposes it under ``/api/build/*``.

Runnable as a CLI for quick checks / JSON export without the web layer::

    python -m observability.backend.build_engine domains
    python -m observability.backend.build_engine overview hr
    python -m observability.backend.build_engine coverage hr
    python -m observability.backend.build_engine agent hr case
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

# Repo root (mas_evovle_enviroment) on path so evovle_skills/evovle_agents resolve.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from evovle_skills.src.config import DATA_ROOT  # noqa: E402
from evovle_skills.src.dataset import discover_versions, load_split  # noqa: E402
from evovle_skills.src.modes import oracle_skills_root  # noqa: E402
from evovle_agents.builder.build_agents import (  # noqa: E402
    agent_spec_to_toml,
    canonical_agent_names,
    skill_dir_to_spec,
)
from evovle_agents.src import agent_library as AL  # noqa: E402
from evovle_agents.src.capabilities import (  # noqa: E402
    agent_versions,
    task_capabilities,
)


# ---------------------------------------------------------------------------
# Dataset helpers
# ---------------------------------------------------------------------------

def list_domains() -> list[str]:
    """Domains that exist in the skills dataset (the agent track mirrors it)."""
    if not DATA_ROOT.exists():
        return []
    out = []
    for p in sorted(DATA_ROOT.iterdir()):
        if p.is_dir() and (p / "_oracle" / "skills").exists():
            out.append(p.name)
    return out


@lru_cache(maxsize=64)
def _versions(domain: str) -> tuple[int, ...]:
    try:
        return tuple(discover_versions(domain))
    except Exception:
        return ()


def _cell_rows(domain: str, version: int) -> list:
    rows = []
    for split in ("train", "test"):
        try:
            rows.extend(load_split(domain, version, split))
        except Exception:
            pass
    return rows


@lru_cache(maxsize=64)
def _all_rows(domain: str) -> tuple:
    rows = []
    for v in _versions(domain):
        rows.extend(_cell_rows(domain, v))
    return tuple(rows)


# ---------------------------------------------------------------------------
# Skill library (the evovle_skills resource)
# ---------------------------------------------------------------------------

def _skill_dir(domain: str, slug: str) -> Path:
    return oracle_skills_root(domain) / slug


def _read_skill_md(domain: str, slug: str) -> tuple[dict, str]:
    """Return (frontmatter, body) for a skill, ({}, '') if absent."""
    from evovle_agents.builder.build_agents import _parse_frontmatter
    md = _skill_dir(domain, slug) / "SKILL.md"
    if not md.exists():
        return {}, ""
    try:
        return _parse_frontmatter(md.read_text(encoding="utf-8"))
    except Exception:
        return {}, ""


def _references(domain: str, slug: str) -> list[str]:
    refs = _skill_dir(domain, slug) / "references"
    if not refs.is_dir():
        return []
    return sorted(p.name for p in refs.iterdir() if p.is_file())


def _capability_dir(domain: str, slug: str) -> Path:
    """The generated capability-agent dir (``_capabilities/<cap>``)."""
    return AL.capability_library_root(domain) / slug


def _read_capability_md(domain: str, slug: str) -> tuple[dict, str]:
    """Return (frontmatter, body) for a CAPABILITY agent's SKILL.md."""
    from evovle_agents.builder.build_agents import _parse_frontmatter
    md = _capability_dir(domain, slug) / "SKILL.md"
    if not md.exists():
        return {}, ""
    try:
        return _parse_frontmatter(md.read_text(encoding="utf-8"))
    except Exception:
        return {}, ""


@lru_cache(maxsize=64)
def _all_skill_slugs(domain: str) -> tuple[str, ...]:
    root = oracle_skills_root(domain)
    if not root.exists():
        return ()
    return tuple(sorted(p.name for p in root.iterdir() if p.is_dir()))


@lru_cache(maxsize=64)
def _version_skill_sets(domain: str) -> tuple:
    """Per-version oracle-skill sets aligned to ``_versions(domain)`` -- the
    skills the tasks AT each skills version use.

    Computed straight from the evovle_skills task rows' ``oracle_skills`` (the
    latent skill LIBRARY this benchmark tracks).  Do NOT route skills views
    through ``agent_library.version_oracle_slugs`` / ``cumulative_oracle_slugs``:
    since the capability-agent refactor those return the AGENTS capability pool
    -- a different resource staged on its own capability-frequency version axis
    (e.g. enterprise = 37 entity-agents that saturate by v5), which is why the
    "skill library evolution" panel was showing +0 new skills past v5.
    """
    out = []
    for v in _versions(domain):
        s: set[str] = set()
        for r in _cell_rows(domain, v):
            s |= set(r.oracle_skills or [])
        out.append(frozenset(s))
    return tuple(out)


@lru_cache(maxsize=64)
def _cumulative_skill_sets(domain: str) -> tuple:
    """Per-version CUMULATIVE oracle-skill sets S_1 ⊆ S_2 ⊆ … ⊆ S_K aligned to
    ``_versions(domain)`` (running union of ``_version_skill_sets``)."""
    out = []
    acc: set[str] = set()
    for s in _version_skill_sets(domain):
        acc |= set(s)
        out.append(frozenset(acc))
    return tuple(out)


def skill_library(domain: str) -> dict:
    """Every oracle skill in the domain + which agent it becomes + usage."""
    names = canonical_agent_names(domain)
    rows = _all_rows(domain)
    # task usage per skill slug
    usage = Counter()
    for r in rows:
        for s in (r.oracle_skills or []):
            usage[s] += 1
    skills = []
    for slug in _all_skill_slugs(domain):
        fm, body = _read_skill_md(domain, slug)
        skills.append({
            "slug": slug,
            "agent_name": names.get(slug, "(unmapped)"),
            "name": fm.get("name", ""),
            "description": fm.get("description", ""),
            "references": _references(domain, slug),
            "body_chars": len(body),
            "n_tasks": usage.get(slug, 0),
        })
    return {"domain": domain, "n_skills": len(skills), "skills": skills}


def skill_detail(domain: str, slug: str) -> dict:
    fm, body = _read_skill_md(domain, slug)
    names = canonical_agent_names(domain)
    # versions where this skill is used by the tasks (the skill library, not the
    # agents capability pool -- see ``_version_skill_sets``)
    in_versions = [v for v, s in zip(_versions(domain), _version_skill_sets(domain))
                   if slug in s]
    return {
        "domain": domain,
        "slug": slug,
        "agent_name": names.get(slug, "(unmapped)"),
        "frontmatter": fm,
        "body": body,
        "references": _references(domain, slug),
        "in_versions": in_versions,
    }


# ---------------------------------------------------------------------------
# Skill DATASET (benchmark) views -- the SKILLS-track analogue of the
# evolve_tools "benchmark" dataset views (the #datasets tab).  Built straight
# from the same ``data/evovling_skills`` rows + ``_oracle/manifest.json`` the
# runner reads, these power the four skills/benchmark sub-tabs:
#   * construction ("How it's built")  -- summary + per-version skeleton
#   * evolution                         -- latent oracle library growth V1..VK
#   * real-world fit                    -- alignment with the Org62 trace
#   * task browser                      -- per-task drill-down
# Per-version / cumulative skill pools are derived from the rows' ``oracle_skills``
# (``_version_skill_sets`` / ``_cumulative_skill_sets``) -- the SKILLS library this
# track grows.  They must NOT come from ``agent_library`` (that returns the AGENTS
# capability pool on its own capability-frequency version axis).
# ---------------------------------------------------------------------------

_SKILL_COMPARISON_DIR = _REPO_ROOT / "evovle_skills" / "comparison_org62"


def _stat5(xs: list) -> dict:
    """{n,mean,min,max,p50} for a list of numbers (mirrors the tools view)."""
    if not xs:
        return {"n": 0, "mean": None, "min": None, "max": None, "p50": None}
    ys = sorted(xs)
    n = len(ys)
    mid = ys[n // 2] if n % 2 else (ys[n // 2 - 1] + ys[n // 2]) / 2
    return {"n": n, "mean": sum(ys) / n, "min": ys[0], "max": ys[-1], "p50": mid}


@lru_cache(maxsize=64)
def _skill_name_map(domain: str) -> dict:
    """slug -> human-readable skill name (SKILL.md frontmatter ``name``)."""
    out: dict[str, str] = {}
    for slug in _all_skill_slugs(domain):
        fm, _ = _read_skill_md(domain, slug)
        out[slug] = fm.get("name") or slug
    return out


@lru_cache(maxsize=64)
def _skill_desc_map(domain: str) -> dict:
    out: dict[str, str] = {}
    for slug in _all_skill_slugs(domain):
        fm, _ = _read_skill_md(domain, slug)
        out[slug] = fm.get("description") or ""
    return out


def _oracle_manifest(domain: str) -> dict:
    p = DATA_ROOT / domain / "_oracle" / "manifest.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def skill_dataset_domains() -> dict:
    """List the skills-benchmark domains (same as the agent track)."""
    return {
        "track": "evovling_skills",
        "root": str(DATA_ROOT),
        "domains": list_domains(),
    }


def skill_dataset_summary(domain: str) -> dict:
    """Domain headline: oracle library size, task counts, per-version skeleton.

    Reads the ``_oracle/manifest.json`` the builder wrote and overlays the
    per-version cumulative pool / split counts so the Task Browser can show a
    stage summary and populate the version picker.
    """
    man = _oracle_manifest(domain)
    nm = _skill_name_map(domain)
    stages: list[dict] = []
    prev_cum = 0
    all_slugs: set[str] = set()
    cum_sets = _cumulative_skill_sets(domain)
    for v, cum in zip(_versions(domain), cum_sets):
        all_slugs |= set(cum)
        n_tr = len(_safe_split(domain, v, "train"))
        n_te = len(_safe_split(domain, v, "test"))
        stages.append({
            "name": f"V{v}",
            "version": v,
            "num_cumulative_skills": len(cum),
            "num_new_skills": max(0, len(cum) - prev_cum),
            "n_train": n_tr,
            "n_test": n_te,
            "n_tasks": n_tr + n_te,
        })
        prev_cum = len(cum)

    # Domain-wide per-skill task coverage, computed from the actual task rows
    # (unique by task_id). The _oracle manifest omits ``task_count_per_skill``
    # for some domains (e.g. the hybrid has no manifest), which previously left
    # the "rank by coverage" view stuck at 0. Where a manifest exists this is
    # identical to its counts, so we always derive from rows for consistency.
    cover: dict[str, set] = {}
    seen_tasks: set[str] = set()
    for r in _all_rows(domain):
        seen_tasks.add(r.task_id)
        for s in (r.oracle_skills or []):
            cover.setdefault(s, set()).add(r.task_id)
    task_count_per_skill = {s: len(t) for s, t in cover.items()}

    n_train_total = sum(s["n_train"] for s in stages)
    n_test_total = sum(s["n_test"] for s in stages)
    active = man.get("active_skills") or sorted(
        (s for s in all_slugs if task_count_per_skill.get(s, 0) > 0),
        key=lambda s: (-task_count_per_skill.get(s, 0), s),
    )
    inactive = man.get("inactive_skills") or sorted(
        s for s in all_slugs if task_count_per_skill.get(s, 0) == 0
    )
    return {
        "domain": domain,
        "track": man.get("track", "static"),
        "n_versions": man.get("n_versions") or len(stages),
        "n_tasks_total": man.get("n_tasks_total") or len(seen_tasks),
        "n_train_total": man.get("n_train_total") or n_train_total,
        "n_test_total": man.get("n_test_total") or n_test_total,
        "active_skills": list(active),
        "inactive_skills": list(inactive),
        "task_count_per_skill": task_count_per_skill,
        "skill_names": nm,
        "stages": stages,
    }


def skill_dataset_evolution(domain: str) -> dict:
    """How the latent oracle skill library grows V1..VK.

    Mirrors the tools ``/evolution`` payload, swapping tools -> skills:
    per-version new / cumulative skills, task counts (train=adapt / test),
    complexity (skills, tools, verifiers per task), the most-used skills, and
    a skill-presence timeline matrix (rows=skills, cols=versions).
    """
    nm = _skill_name_map(domain)
    versions = _versions(domain)
    cumulatives = [set(s) for s in _cumulative_skill_sets(domain)]
    all_skills: set[str] = set()
    for cs in cumulatives:
        all_skills |= cs

    stages_out: list[dict] = []
    prev_cum: set[str] = set()
    total_tasks = 0
    for i, v in enumerate(versions):
        rows = _cell_rows(domain, v)
        cum = cumulatives[i]
        new_skills = sorted(cum - prev_cum)
        usage = Counter()
        for r in rows:
            for s in (r.oracle_skills or []):
                usage[s] += 1
        n_tr = sum(1 for r in rows if r.split == "train")
        n_te = sum(1 for r in rows if r.split == "test")
        total_tasks += len(rows)
        stages_out.append({
            "name": f"V{v}",
            "version": v,
            "new_skills": new_skills,
            "new_skill_names": [nm.get(s, s) for s in new_skills],
            "retired_skills": [],
            "cumulative_skills": sorted(cum),
            "num_cumulative_skills": len(cum),
            "num_new_skills": len(new_skills),
            "num_retired_skills": 0,
            "num_new_tasks": len(rows),
            "num_adapt": n_tr,
            "num_test": n_te,
            "skills_per_task": _stat5([len(r.oracle_skills or []) for r in rows]),
            "tools_per_task": _stat5([len(r.selected_tools or []) for r in rows]),
            "verifiers_per_task": _stat5([len(r.verifiers or []) for r in rows]),
            "top_skill_usage": sorted(
                ({"skill": s, "name": nm.get(s, s), "count": c} for s, c in usage.items()),
                key=lambda x: (-x["count"], x["skill"]),
            )[:15],
        })
        prev_cum = cum

    intro: dict[str, int] = {}
    for i, cs in enumerate(cumulatives):
        for s in cs:
            intro.setdefault(s, i)
    timeline = []
    for s in sorted(all_skills, key=lambda x: (intro.get(x, 99), x)):
        presence = []
        for i, cs in enumerate(cumulatives):
            if s not in cs:
                presence.append("absent")
            elif intro.get(s) == i:
                presence.append("new")
            else:
                presence.append("present")
        timeline.append({
            "skill": s, "name": nm.get(s, s),
            "intro_stage": intro[s], "presence": presence,
        })

    return {
        "domain": domain,
        "num_stages": len(versions),
        "total_tasks": total_tasks,
        "n_skills_total": len(all_skills),
        "stages": stages_out,
        "skill_timeline": timeline,
    }


def skill_dataset_tasks(domain: str, version: str = "", split: str = "all") -> dict:
    """Task list for the browser, optionally filtered to one version / split."""
    nm = _skill_name_map(domain)
    vers = list(_versions(domain))
    if version not in ("", None):
        try:
            vers = [int(str(version).lstrip("vV"))]
        except Exception:
            pass
    splits = ("train", "test") if split in ("", "all", None) else (split,)
    tasks: list[dict] = []
    for v in vers:
        for sp in splits:
            for r in _safe_split(domain, v, sp):
                tasks.append({
                    "task_id": r.task_id,
                    "version": r.version,
                    "split": r.split,
                    "stage": r.version - 1,
                    "n_oracle_skills": len(r.oracle_skills or []),
                    "oracle_skills": list(r.oracle_skills or []),
                    "oracle_skill_names": [nm.get(s, s) for s in (r.oracle_skills or [])],
                    "n_tools": len(r.selected_tools or []),
                    "n_verifiers": len(r.verifiers or []),
                })
    return {
        "domain": domain, "version": version, "split": split,
        "n": len(tasks), "tasks": tasks,
    }


def skill_dataset_task_detail(domain: str, version: str, split: str, task_id: str) -> dict:
    """Full per-task row: prompts, oracle + cumulative skills, tools, verifiers."""
    nm = _skill_name_map(domain)
    desc = _skill_desc_map(domain)
    try:
        v = int(str(version).lstrip("vV"))
    except Exception:
        return {"error": f"bad version {version!r}"}
    splits = (split,) if split in ("train", "test") else ("train", "test")
    row = None
    for sp in splits:
        for r in _safe_split(domain, v, sp):
            if r.task_id == task_id:
                row = r
                break
        if row is not None:
            break
    if row is None:
        return {"error": f"task {task_id} not found in {domain} v{v}"}

    def _sk(slugs) -> list[dict]:
        return [{"slug": s, "name": nm.get(s, s), "description": desc.get(s, "")}
                for s in (slugs or [])]

    return {
        "domain": domain,
        "task_id": row.task_id,
        "version": row.version,
        "split": row.split,
        "user_prompt": row.user_prompt,
        "system_prompt": row.system_prompt,
        "oracle_skills": _sk(row.oracle_skills),
        "cumulative_oracle_skills": _sk(row.cumulative_oracle_skills),
        "selected_tools": list(row.selected_tools or []),
        "verifiers": list(row.verifiers or []),
        "mcp_endpoint": row.mcp_endpoint,
        "gym_servers_config": list(row.gym_servers_config or []),
    }


_SKILL_REF_TEXT_EXT = {
    ".md", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml",
    ".py", ".sql", ".toml", ".ini", ".cfg",
}
_SKILL_REF_MAX_CHARS = 400_000


def skill_dataset_skill_detail(domain: str, slug: str) -> dict:
    """Full content of one oracle skill: SKILL.md (frontmatter + body) plus the
    contents of every file under its ``references/`` folder (text inlined,
    binaries listed by name/size). Powers the Task Browser's expandable skill
    cards so the whole latent skill — not just its description — is visible.
    """
    skill_dir = _skill_dir(domain, slug)
    if not skill_dir.exists():
        return {"error": f"no skill {slug!r} in {domain}"}
    fm, body = _read_skill_md(domain, slug)
    nm = _skill_name_map(domain)

    refs: list[dict] = []
    refs_dir = skill_dir / "references"
    if refs_dir.is_dir():
        for p in sorted(refs_dir.iterdir()):
            if not p.is_file():
                continue
            item = {
                "name": p.name,
                "size": p.stat().st_size,
                "content": None,
                "truncated": False,
                "binary": False,
            }
            if p.suffix.lower() in _SKILL_REF_TEXT_EXT:
                try:
                    raw = p.read_text(encoding="utf-8", errors="replace")
                    if len(raw) > _SKILL_REF_MAX_CHARS:
                        raw = raw[:_SKILL_REF_MAX_CHARS]
                        item["truncated"] = True
                    item["content"] = raw
                except Exception:
                    item["binary"] = True
            else:
                item["binary"] = True
            refs.append(item)

    # Other top-level files in the skill dir (e.g. index.json) for completeness.
    other_files = sorted(
        p.name for p in skill_dir.iterdir()
        if p.is_file() and p.name != "SKILL.md"
    )

    return {
        "domain": domain,
        "slug": slug,
        "name": fm.get("name") or nm.get(slug, slug),
        "description": fm.get("description", ""),
        "frontmatter": fm,
        "body": body,
        "references": refs,
        "other_files": other_files,
        "in_versions": [v for v, s in zip(_versions(domain),
                                          _version_skill_sets(domain)) if slug in s],
    }


def _denan(x):
    """Recursively replace NaN/inf floats with None (match_summary.json ships
    NaN tokens that are valid for Python's json but break JSON.parse)."""
    if isinstance(x, float):
        return None if (x != x or x in (float("inf"), float("-inf"))) else x
    if isinstance(x, dict):
        return {k: _denan(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_denan(v) for v in x]
    return x


def skill_realworld_comparison() -> dict:
    """Org62 (real) vs simulated-domain alignment for the SKILL axis.

    Bundles the ``match_summary.json`` (steps-per-skill, skills-per-task,
    reuse Zipf-alpha / Gini, ...) plus the figures that live beside it.
    """
    d = _SKILL_COMPARISON_DIR
    summary = None
    sp = d / "match_summary.json"
    if sp.exists():
        try:
            summary = _denan(json.loads(sp.read_text(encoding="utf-8")))
        except Exception:
            summary = None
    figures = []
    if d.exists():
        figures = sorted(p.name for p in d.iterdir() if p.is_file() and p.suffix == ".png")
    return {
        "folder": d.name,
        "exists": d.exists(),
        "match_summary": summary,
        "figures": figures,
    }


def skill_comparison_image_path(name: str):
    """Validated path to a PNG in the comparison folder (None if invalid)."""
    if "/" in name or ".." in name or not name.endswith(".png"):
        return None
    p = _SKILL_COMPARISON_DIR / name
    return p if (p.exists() and p.is_file()) else None


# ---------------------------------------------------------------------------
# Agent DATASET (benchmark) views -- the AGENTS-track analogue of the skills
# benchmark, built straight from ``data/evovling_agents`` (the materialized
# subagent dataset the harness mounts).  These power the four agents/benchmark
# sub-tabs (How it's built / Evolution / Real-world fit / Task Browser).
#
# The agent dataset is SELF-CONTAINED per version: every ``v{k}/`` holds its own
# cumulative ``agents/*.toml`` + ``agents/manifest.json`` (name, description,
# source skill slug, derived ``oracle_tools``) and a copy of each agent's skill
# under ``agent_skills/<slug>/``, plus ``train.jsonl`` / ``test.jsonl`` whose
# rows carry ``oracle_agents`` / ``cumulative_agents`` / ``oracle_skills``.  So
# unlike the skills views (which read the shared ``_oracle`` library) these read
# the agents tree directly -- it is exactly what a trial mounts.
# ---------------------------------------------------------------------------

_AGENTS_DATA_ROOT = _REPO_ROOT / "data" / "evovling_agents"
_AGENT_COMPARISON_DIR = _REPO_ROOT / "evovle_agents" / "comparison_org62"


def _agent_domain_dir(domain: str) -> Path:
    return _AGENTS_DATA_ROOT / domain


@lru_cache(maxsize=64)
def _agent_versions(domain: str) -> tuple[int, ...]:
    d = _agent_domain_dir(domain)
    if not d.is_dir():
        return ()
    vs = []
    for p in sorted(d.iterdir()):
        if p.is_dir() and p.name.startswith("v") and p.name[1:].isdigit():
            vs.append(int(p.name[1:]))
    return tuple(sorted(vs))


@lru_cache(maxsize=256)
def _agent_manifest(domain: str, version: int) -> dict:
    p = _agent_domain_dir(domain) / f"v{version}" / "agents" / "manifest.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _agent_pool(domain: str, version: int) -> list:
    """The (cumulative) agents mounted at a version, from its manifest."""
    return list(_agent_manifest(domain, version).get("agents", []) or [])


def _agent_rows(domain: str, version: int, split: str) -> list:
    """Raw task rows from ``v{version}/{split}.jsonl`` (small files)."""
    p = _agent_domain_dir(domain) / f"v{version}" / f"{split}.jsonl"
    if not p.exists():
        return []
    out = []
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    except Exception:
        return []
    return out


@lru_cache(maxsize=64)
def _agent_info_all(domain: str) -> dict:
    """agent name -> identity + intro version + full (unioned) tool scope.

    Tool scopes are constant across versions in this build, so the union equals
    each version's scope; we union defensively anyway.
    """
    info: dict[str, dict] = {}
    for v in _agent_versions(domain):
        for a in _agent_pool(domain, v):
            nm = a.get("name")
            if not nm:
                continue
            cur = info.get(nm)
            if cur is None:
                cur = info[nm] = {
                    "name": nm,
                    "title": a.get("title") or nm,
                    "description": a.get("description", ""),
                    "source_slug": a.get("source_slug", ""),
                    "model": a.get("model", ""),
                    "intro_version": v,
                    "in_versions": [],
                    "_tools": set(),
                }
            cur["in_versions"].append(v)
            for t in (a.get("oracle_tools") or []):
                cur["_tools"].add(t)
    out = {}
    for nm, d in info.items():
        out[nm] = {
            "name": d["name"],
            "title": d["title"],
            "description": d["description"],
            "source_slug": d["source_slug"],
            "model": d["model"],
            "intro_version": d["intro_version"],
            "in_versions": sorted(d["in_versions"]),
            "oracle_tools": sorted(d["_tools"]),
            "n_tools": len(d["_tools"]),
        }
    return out


def _read_md_at(path: Path) -> tuple[dict, str]:
    """(frontmatter, body) for an arbitrary SKILL.md path; ({}, '') if absent."""
    from evovle_agents.builder.build_agents import _parse_frontmatter
    if not path.exists():
        return {}, ""
    try:
        return _parse_frontmatter(path.read_text(encoding="utf-8"))
    except Exception:
        return {}, ""


def _read_references_at(refs_dir: Path) -> list:
    """List every file under ``refs_dir`` with text content inlined (binaries
    listed by name/size). Shared by the skill + agent detail views."""
    refs: list[dict] = []
    if not refs_dir.is_dir():
        return refs
    for p in sorted(refs_dir.iterdir()):
        if not p.is_file():
            continue
        item = {
            "name": p.name,
            "size": p.stat().st_size,
            "content": None,
            "truncated": False,
            "binary": False,
        }
        if p.suffix.lower() in _SKILL_REF_TEXT_EXT:
            try:
                raw = p.read_text(encoding="utf-8", errors="replace")
                if len(raw) > _SKILL_REF_MAX_CHARS:
                    raw = raw[:_SKILL_REF_MAX_CHARS]
                    item["truncated"] = True
                item["content"] = raw
            except Exception:
                item["binary"] = True
        else:
            item["binary"] = True
        refs.append(item)
    return refs


def agent_dataset_domains() -> dict:
    """List the agents-benchmark domains (dirs with at least one v{k})."""
    root = _AGENTS_DATA_ROOT
    domains = []
    if root.is_dir():
        for p in sorted(root.iterdir()):
            if p.is_dir() and _agent_versions(p.name):
                domains.append(p.name)
    return {"track": "evovling_agents", "root": str(root), "domains": domains}


def agent_dataset_summary(domain: str) -> dict:
    """Domain headline: agent pool growth, task counts, per-version skeleton."""
    versions = _agent_versions(domain)
    info = _agent_info_all(domain)
    title_map = {n: d["title"] for n, d in info.items()}
    usage = Counter()
    stages: list[dict] = []
    prev_cum = 0
    n_train_total = n_test_total = 0
    n_multi_total = 0
    for v in versions:
        pool = _agent_pool(domain, v)
        cum = len(pool)
        tr = _agent_rows(domain, v, "train")
        te = _agent_rows(domain, v, "test")
        n_train_total += len(tr)
        n_test_total += len(te)
        n_multi = 0
        for r in (tr + te):
            oa = r.get("oracle_agents") or []
            for a in oa:
                usage[a] += 1
            if len(oa) > 1:
                n_multi += 1
        n_multi_total += n_multi
        stages.append({
            "name": f"V{v}",
            "version": v,
            "num_cumulative_agents": cum,
            "num_new_agents": max(0, cum - prev_cum),
            "n_train": len(tr),
            "n_test": len(te),
            "n_tasks": len(tr) + len(te),
            "n_multi_agent": n_multi,
        })
        prev_cum = cum
    all_agents = sorted(info.keys())
    active = [a for a in all_agents if usage.get(a, 0) > 0]
    distractor = [a for a in all_agents if usage.get(a, 0) == 0]
    n_tasks_total = n_train_total + n_test_total
    return {
        "domain": domain,
        "track": "static",
        "n_versions": len(versions),
        "n_tasks_total": n_tasks_total,
        "n_train_total": n_train_total,
        "n_test_total": n_test_total,
        "n_agents_total": len(all_agents),
        "n_multi_agent_total": n_multi_total,
        "multi_agent_frac": (n_multi_total / n_tasks_total) if n_tasks_total else 0.0,
        "active_agents": active,
        "distractor_agents": distractor,
        "task_count_per_agent": dict(usage),
        "agent_names": title_map,
        "agent_tool_counts": {n: d["n_tools"] for n, d in info.items()},
        "stages": stages,
    }


def agent_dataset_evolution(domain: str) -> dict:
    """How the GIVEN agent pool grows A₁ ⊂ A₂ ⊂ … (mirrors skills/evolution)."""
    info = _agent_info_all(domain)
    title = {n: d["title"] for n, d in info.items()}
    versions = _agent_versions(domain)
    pools = [[a.get("name") for a in _agent_pool(domain, v)] for v in versions]
    cumulatives = [set(p) for p in pools]
    all_agents: set[str] = set()
    for cs in cumulatives:
        all_agents |= cs

    stages_out: list[dict] = []
    prev_cum: set[str] = set()
    total_tasks = 0
    for i, v in enumerate(versions):
        rows = _agent_rows(domain, v, "train") + _agent_rows(domain, v, "test")
        cum = cumulatives[i]
        new_agents = sorted(cum - prev_cum)
        usage = Counter()
        n_multi = 0
        for r in rows:
            oa = r.get("oracle_agents") or []
            for a in oa:
                usage[a] += 1
            if len(oa) > 1:
                n_multi += 1
        n_tr = sum(1 for r in rows if r.get("split") == "train")
        n_te = sum(1 for r in rows if r.get("split") == "test")
        total_tasks += len(rows)
        stages_out.append({
            "name": f"V{v}",
            "version": v,
            "new_agents": new_agents,
            "new_agent_names": [title.get(a, a) for a in new_agents],
            "retired_agents": [],
            "cumulative_agents": sorted(cum),
            "num_cumulative_agents": len(cum),
            "num_new_agents": len(new_agents),
            "num_retired_agents": 0,
            "num_new_tasks": len(rows),
            "num_adapt": n_tr,
            "num_test": n_te,
            "n_multi_agent": n_multi,
            "agents_per_task": _stat5([len(r.get("oracle_agents") or []) for r in rows]),
            "tools_per_task": _stat5([len(r.get("selected_tools") or []) for r in rows]),
            "skills_per_task": _stat5([len(r.get("oracle_skills") or []) for r in rows]),
            "verifiers_per_task": _stat5([len(r.get("verifiers") or []) for r in rows]),
            "top_agent_usage": sorted(
                ({"agent": a, "name": title.get(a, a), "count": c} for a, c in usage.items()),
                key=lambda x: (-x["count"], x["agent"]),
            )[:15],
        })
        prev_cum = cum

    intro: dict[str, int] = {}
    for i, cs in enumerate(cumulatives):
        for a in cs:
            intro.setdefault(a, i)
    timeline = []
    for a in sorted(all_agents, key=lambda x: (intro.get(x, 99), x)):
        presence = []
        for i, cs in enumerate(cumulatives):
            if a not in cs:
                presence.append("absent")
            elif intro.get(a) == i:
                presence.append("new")
            else:
                presence.append("present")
        timeline.append({
            "agent": a, "name": title.get(a, a),
            "intro_stage": intro[a], "presence": presence,
            "n_tools": info.get(a, {}).get("n_tools", 0),
        })

    return {
        "domain": domain,
        "num_stages": len(versions),
        "total_tasks": total_tasks,
        "n_agents_total": len(all_agents),
        "stages": stages_out,
        "agent_timeline": timeline,
    }


def agent_dataset_tasks(domain: str, version: str = "", split: str = "all") -> dict:
    """Task list for the browser, optionally filtered to one version / split."""
    title = {n: d["title"] for n, d in _agent_info_all(domain).items()}
    vers = list(_agent_versions(domain))
    if version not in ("", None):
        try:
            vers = [int(str(version).lstrip("vV"))]
        except Exception:
            pass
    splits = ("train", "test") if split in ("", "all", None) else (split,)
    tasks: list[dict] = []
    for v in vers:
        for sp in splits:
            for r in _agent_rows(domain, v, sp):
                oa = r.get("oracle_agents") or []
                tasks.append({
                    "task_id": r.get("task_id"),
                    "version": r.get("version", v),
                    "split": r.get("split", sp),
                    "stage": (r.get("version", v) or v) - 1,
                    "n_oracle_agents": len(oa),
                    "oracle_agents": list(oa),
                    "oracle_agent_names": [title.get(a, a) for a in oa],
                    "multi_agent": len(oa) > 1,
                    "n_cumulative_agents": len(r.get("cumulative_agents") or []),
                    "n_oracle_skills": len(r.get("oracle_skills") or []),
                    "n_tools": len(r.get("selected_tools") or []),
                    "n_verifiers": len(r.get("verifiers") or []),
                })
    return {
        "domain": domain, "version": version, "split": split,
        "n": len(tasks), "tasks": tasks,
    }


def agent_dataset_task_detail(domain: str, version: str, split: str, task_id: str) -> dict:
    """Full per-task row: prompts, oracle + cumulative agents, skills, tools."""
    info = _agent_info_all(domain)
    try:
        v = int(str(version).lstrip("vV"))
    except Exception:
        return {"error": f"bad version {version!r}"}
    splits = (split,) if split in ("train", "test") else ("train", "test")
    row = None
    for sp in splits:
        for r in _agent_rows(domain, v, sp):
            if r.get("task_id") == task_id:
                row = r
                break
        if row is not None:
            break
    if row is None:
        return {"error": f"task {task_id} not found in {domain} v{v}"}

    def _ag(names) -> list:
        out = []
        for n in (names or []):
            d = info.get(n, {})
            out.append({
                "name": n,
                "title": d.get("title", n),
                "description": d.get("description", ""),
                "source_slug": d.get("source_slug", ""),
                "n_tools": d.get("n_tools", 0),
            })
        return out

    return {
        "domain": domain,
        "task_id": row.get("task_id"),
        "version": row.get("version", v),
        "split": row.get("split"),
        "user_prompt": row.get("user_prompt"),
        "system_prompt": row.get("system_prompt"),
        "oracle_agents": _ag(row.get("oracle_agents")),
        "cumulative_agents": _ag(row.get("cumulative_agents")),
        "oracle_skills": list(row.get("oracle_skills") or []),
        "selected_tools": list(row.get("selected_tools") or []),
        "verifiers": list(row.get("verifiers") or []),
        "mcp_endpoint": row.get("mcp_endpoint"),
        "gym_servers_config": list(row.get("gym_servers_config") or []),
    }


def agent_dataset_agent_detail(domain: str, version: str, name: str) -> dict:
    """Full content of one agent: the generated ``.toml`` spec, its derived
    ``oracle_tools``, and the skill it wraps (SKILL.md body + references) — so
    the Task Browser can expand an agent into everything a trial would mount."""
    try:
        v = int(str(version).lstrip("vV"))
    except Exception:
        return {"error": f"bad version {version!r}"}
    # The agent may not be in the requested version's pool (e.g. opened from a
    # different context) — fall back to its intro version.
    info = _agent_info_all(domain).get(name)
    if info is None:
        return {"error": f"no agent {name!r} in {domain}"}
    if v not in info["in_versions"]:
        v = info["intro_version"]

    agent = None
    for a in _agent_pool(domain, v):
        if a.get("name") == name:
            agent = a
            break
    if agent is None:
        return {"error": f"agent {name!r} absent from {domain} v{v}"}

    vdir = _agent_domain_dir(domain) / f"v{v}"
    toml_path = vdir / "agents" / f"{name}.toml"
    toml_text = ""
    if toml_path.exists():
        try:
            toml_text = toml_path.read_text(encoding="utf-8")
        except Exception:
            toml_text = ""

    slug = agent.get("source_slug") or ""
    skill_dir = vdir / "agent_skills" / slug
    fm, body = _read_md_at(skill_dir / "SKILL.md")
    refs = _read_references_at(skill_dir / "references")
    other_files = []
    if skill_dir.is_dir():
        other_files = sorted(
            p.name for p in skill_dir.iterdir()
            if p.is_file() and p.name != "SKILL.md"
        )

    return {
        "domain": domain,
        "version": v,
        "name": name,
        "title": agent.get("title") or name,
        "description": agent.get("description", ""),
        "source_slug": slug,
        "model": agent.get("model", ""),
        "oracle_tools": list(agent.get("oracle_tools") or []),
        "n_tools": len(agent.get("oracle_tools") or []),
        "in_versions": info["in_versions"],
        "toml": toml_text,
        "skill": {
            "slug": slug,
            "name": fm.get("name") or slug,
            "description": fm.get("description", ""),
            "body": body,
            "references": refs,
            "other_files": other_files,
        },
    }


def agent_realworld_comparison() -> dict:
    """Org62 (real) vs simulated-domain alignment for the AGENT axis.

    Bundles ``comparison_org62/match_summary.json`` (tools-per-agent, scope
    overlap Jaccard, tool-frequency Zipf α / Gini, …) plus the PNG figures.
    """
    d = _AGENT_COMPARISON_DIR
    summary = None
    sp = d / "match_summary.json"
    if sp.exists():
        try:
            summary = _denan(json.loads(sp.read_text(encoding="utf-8")))
        except Exception:
            summary = None
    figures = []
    if d.exists():
        figures = sorted(p.name for p in d.iterdir() if p.is_file() and p.suffix == ".png")
    return {
        "folder": d.name,
        "exists": d.exists(),
        "match_summary": summary,
        "figures": figures,
    }


def agent_comparison_image_path(name: str):
    """Validated path to a PNG in the agent comparison folder (None if bad)."""
    if "/" in name or ".." in name or not name.endswith(".png"):
        return None
    p = _AGENT_COMPARISON_DIR / name
    return p if (p.exists() and p.is_file()) else None


# ---------------------------------------------------------------------------
# Tool scoping (the deterministic derivation that differentiates agents)
# ---------------------------------------------------------------------------

def tool_scoping(domain: str) -> dict:
    """Each capability agent's COMPLETE, disjoint tool bundle + cross-agent
    sharing.

    The capability partition assigns every tool to exactly ONE agent, so scopes
    are disjoint (0 shared) -- which is precisely why a task whose gold tools
    span several capabilities cannot be handled by a single agent.
    """
    tmap = AL.skill_oracle_tool_map(domain)
    names = canonical_agent_names(domain)

    tool_to_agents = defaultdict(set)
    for slug, tools in tmap.items():
        for t in tools:
            tool_to_agents[t].add(names.get(slug, slug))

    shared = {t: sorted(a) for t, a in tool_to_agents.items() if len(a) > 1}
    per_agent = sorted(
        ({"agent_name": names.get(s, s), "slug": s, "n_tools": len(ts),
          "tools": sorted(ts)} for s, ts in tmap.items()),
        key=lambda d: d["agent_name"],
    )
    n_tools = len(tool_to_agents)
    return {
        "domain": domain,
        "n_agents": len(tmap),
        "n_distinct_tools": n_tools,
        "n_shared_tools": len(shared),
        "shared_fraction": (len(shared) / n_tools) if n_tools else 0.0,
        "per_agent": per_agent,
        "shared_tools": shared,
    }


# ---------------------------------------------------------------------------
# Agent library (the evovle_agents resource: capability -> subagent)
# ---------------------------------------------------------------------------

def agent_library(domain: str) -> dict:
    """The domain's capability agents + each agent's COMPLETE, disjoint tool
    bundle.

    Each agent is a capability partition of the tool universe (see
    ``evovle_agents.src.capabilities``), NOT a workflow skill: every tool maps
    to exactly one agent, so the bundle is complete and never empty.
    """
    names = canonical_agent_names(domain)
    tmap = AL.skill_oracle_tool_map(domain)
    agents = []
    for slug in sorted(tmap):
        fm, _ = _read_capability_md(domain, slug)
        agents.append({
            "agent_name": names.get(slug, slug),
            "source_slug": slug,
            "skill_name": fm.get("name", "") or slug,
            "n_tools": len(tmap.get(slug, [])),
            "tools": list(tmap.get(slug, [])),
        })
    return {
        "domain": domain,
        "n_skills": len(agents),
        "n_agents": len(agents),
        "one_to_one": len({a["agent_name"] for a in agents}) == len(agents),
        "agents": sorted(agents, key=lambda d: d["source_slug"]),
    }


def agent_detail(domain: str, slug: str) -> dict:
    """Full generated capability agent: TOML, complete tool bundle, usage."""
    names = canonical_agent_names(domain)
    tmap = AL.skill_oracle_tool_map(domain)
    dirs = AL.named_capability_skill_dirs(domain, [slug])
    if not dirs:
        return {"error": f"no capability '{slug}' in {domain}"}
    spec = skill_dir_to_spec(dirs[0], domain=domain)
    if spec is None:
        return {"error": f"no capability skill at {dirs[0]}"}
    spec.name = names.get(slug, spec.name)
    spec.oracle_tools = list(tmap.get(slug, []))
    rel = f"agent_skills/{slug}/SKILL.md"
    toml = agent_spec_to_toml(spec, skill_config_path=rel)

    rows = _all_rows(domain)
    used_by = [r.task_id for r in rows
               if slug in task_capabilities(domain, list(r.selected_tools or []))]
    return {
        "domain": domain,
        "agent_name": spec.name,
        "source_slug": slug,
        "description": spec.description,
        "title": spec.title,
        "tools": list(spec.oracle_tools),
        "n_tools": len(spec.oracle_tools),
        "toml": toml,
        "n_tasks": len(used_by),
        "in_versions": [v for v in agent_versions(domain)
                        if slug in AL.version_oracle_slugs(domain, v)],
    }


# ---------------------------------------------------------------------------
# Per-version / cumulative pools (the "evolving" axis)
# ---------------------------------------------------------------------------

def overview(domain: str) -> dict:
    """Version-by-version layout of BOTH tracks: per-version vs cumulative
    pool sizes, task counts, and how the resource accumulates."""
    names = canonical_agent_names(domain)
    versions = []
    for v in _versions(domain):
        ver_slugs = AL.version_oracle_slugs(domain, v)
        cum_slugs = AL.cumulative_oracle_slugs(domain, v)
        n_train = len(_safe_split(domain, v, "train"))
        n_test = len(_safe_split(domain, v, "test"))
        versions.append({
            "version": v,
            "n_train": n_train,
            "n_test": n_test,
            "n_tasks": n_train + n_test,
            "version_pool": sorted(names.get(s, s) for s in ver_slugs),
            "cumulative_pool": sorted(names.get(s, s) for s in cum_slugs),
            "n_version_pool": len(ver_slugs),
            "n_cumulative_pool": len(cum_slugs),
            "n_distractors": max(0, len(cum_slugs) - len(ver_slugs)),
        })
    return {
        "domain": domain,
        "n_versions": len(versions),
        "n_skills_total": len(_all_skill_slugs(domain)),
        "versions": versions,
    }


def _safe_split(domain: str, version: int, split: str) -> list:
    try:
        return load_split(domain, version, split)
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Coverage + multi-agent forcing (the headline guarantees)
# ---------------------------------------------------------------------------

def coverage_and_forcing(domain: str) -> dict:
    """For every task: which capability agents it needs (the capabilities its
    gold tools span) and the minimum number required.

    The capability partition is COMPLETE + DISJOINT, so every task is coverable
    (0 holes) and its minimum agent count equals the number of DISTINCT
    capabilities its gold tools span -- forced multi-agent whenever that is >=2,
    solo-solvable only when all its tools live in a single capability.
    """
    names = canonical_agent_names(domain)
    rows = _all_rows(domain)

    dist = Counter()
    n_single = 0
    per_task = []
    for r in rows:
        gold = sorted(set(r.selected_tools or []))
        caps = sorted(set(task_capabilities(domain, gold)))
        k = len(caps)
        dist[k] += 1
        if k == 1:
            n_single += 1
        per_task.append({
            "task_id": r.task_id,
            "version": r.version,
            "split": r.split,
            "n_oracle_skills": k,
            "oracle_agents": [names.get(c, c) for c in caps],
            "n_gold_tools": len(gold),
            "coverable": True,
            "min_agents": k,
            "cover_set": [names.get(c, c) for c in caps],
        })

    n = len(rows)
    forced = sum(c for kk, c in dist.items() if kk and kk >= 2)
    solo = dist.get(1, 0)
    return {
        "domain": domain,
        "n_tasks": n,
        "n_single_oracle_skill_tasks": n_single,
        "coverage_holes": 0,
        "solvable_by_one": solo,
        "forced_multi_agent": forced,
        "forced_fraction": (forced / n) if n else 0.0,
        "distribution": {str(kk): dist[kk] for kk in sorted(dist)},
        "per_task": per_task,
    }


def task_detail(domain: str, task_id: str) -> dict:
    """Full per-task drill-down: gold tools, the capability agents that own
    them, each agent's coverage, and the (disjoint) tool routing."""
    tmap = AL.skill_oracle_tool_map(domain)
    names = canonical_agent_names(domain)
    row = None
    for r in _all_rows(domain):
        if r.task_id == task_id:
            row = r
            break
    if row is None:
        return {"error": f"task {task_id} not found in {domain}"}

    gold = sorted(set(row.selected_tools or []))
    caps = sorted(set(task_capabilities(domain, gold)))

    # The partition is disjoint, so each gold tool is OWNED by exactly one
    # capability agent -- that routing IS the attribution (no co-occurrence
    # heuristic needed).
    owner = {t: cap for cap, tools in tmap.items() for t in tools}
    scope_by_cap = {c: set(tmap.get(c, [])) for c in caps}
    attribution = defaultdict(list)
    for t in gold:
        c = owner.get(t)
        if c is not None:
            attribution[c].append(t)

    agents = []
    for c in caps:
        scope = scope_by_cap[c]
        covers = sorted(scope & set(gold))
        agents.append({
            "agent_name": names.get(c, c),
            "slug": c,
            "scope_size": len(scope),
            "covers": covers,
            "n_covers": len(covers),
            "covers_all": set(covers) == set(gold),
            "attributed": sorted(attribution.get(c, [])),
        })

    k = len(caps)
    who = caps
    return {
        "domain": domain,
        "task_id": task_id,
        "version": row.version,
        "split": row.split,
        "user_prompt": row.user_prompt,
        "oracle_skills": caps,
        "oracle_agents": [names.get(c, c) for c in caps],
        "gold_tools": gold,
        "agents": agents,
        "coverable": True,
        "min_agents": k,
        "cover_set": [names.get(c, c) for c in who],
        "verdict": ("solo" if k == 1 else "forced_multi"),
    }


def dataset_rows(domain: str, version: int, split: str) -> dict:
    names = canonical_agent_names(domain)
    out = []
    for r in _safe_split(domain, version, split):
        out.append({
            "task_id": r.task_id,
            "n_oracle_skills": len(r.oracle_skills or []),
            "oracle_agents": [names.get(s, s) for s in (r.oracle_skills or [])],
            "n_selected_tools": len(r.selected_tools or []),
            "selected_tools": list(r.selected_tools or []),
            "user_prompt": (r.user_prompt or "")[:280],
        })
    return {"domain": domain, "version": version, "split": split,
            "n_rows": len(out), "rows": out}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _main(argv: list[str]) -> int:
    import argparse
    p = argparse.ArgumentParser(description="Build Inspector engine (CLI).")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("domains")
    for name in ("overview", "skills", "agents", "scoping", "coverage"):
        sp = sub.add_parser(name)
        sp.add_argument("domain")
    sp = sub.add_parser("agent")
    sp.add_argument("domain"); sp.add_argument("slug")
    sp = sub.add_parser("task")
    sp.add_argument("domain"); sp.add_argument("task_id")
    args = p.parse_args(argv)

    if args.cmd == "domains":
        out = list_domains()
    elif args.cmd == "overview":
        out = overview(args.domain)
    elif args.cmd == "skills":
        out = skill_library(args.domain)
    elif args.cmd == "agents":
        out = agent_library(args.domain)
    elif args.cmd == "scoping":
        out = tool_scoping(args.domain)
    elif args.cmd == "coverage":
        out = coverage_and_forcing(args.domain)
    elif args.cmd == "agent":
        out = agent_detail(args.domain, args.slug)
    elif args.cmd == "task":
        out = task_detail(args.domain, args.task_id)
    else:
        out = {"error": "unknown"}
    print(json.dumps(out, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
