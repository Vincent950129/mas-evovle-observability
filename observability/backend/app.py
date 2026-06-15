"""FastAPI backend for the Evolve Observability tool.

Serves:
  * Dataset inspection APIs for the breath/depth evolving benchmarks.
  * Results inspection APIs for any run directory under ``evolve_tools/results``.
  * The static frontend bundle.

The directory layout assumed at startup:

    mas_evovle_enviroment/
        evolve_tools/
            benchmark_breath/<domain>/...
            benchmark_depth/<domain>/...
            results/<run_name>/...
        observability/   <-- this app

You can override paths via env vars:
    EVOLVE_DATASET_BREATH_DIR
    EVOLVE_DATASET_DEPTH_DIR
    EVOLVE_RESULTS_DIR
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import zipfile
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from . import insights


# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
# The observability app lives at <MAS_ROOT>/observability/backend/app.py, so
# two parents up from ``HERE`` is the mas_evovle_enviroment project root.
MAS_ROOT = HERE.parent.parent
EVOLVE_TOOLS_ROOT = MAS_ROOT / "evolve_tools"
FRONTEND_DIR = HERE.parent / "frontend"

DATASET_DIRS: dict[str, Path] = {
    "breath": Path(
        os.environ.get(
            "EVOLVE_DATASET_BREATH_DIR",
            EVOLVE_TOOLS_ROOT / "benchmark_breath",
        )
    ),
    "depth": Path(
        os.environ.get(
            "EVOLVE_DATASET_DEPTH_DIR",
            EVOLVE_TOOLS_ROOT / "benchmark_depth",
        )
    ),
}

RESULTS_DIR = Path(
    os.environ.get(
        "EVOLVE_RESULTS_DIR",
        EVOLVE_TOOLS_ROOT / "results",
    )
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
TASK_ID_RE = re.compile(r"task_\d{8}_\d{6}_\d{3}_[0-9a-f]+_[0-9a-f]+")


def _safe_relpath(base: Path, target: Path) -> Path:
    """Resolve ``target`` relative to ``base`` ensuring no escape."""
    base = base.resolve()
    full = (base / target).resolve()
    if not str(full).startswith(str(base)):
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    return full


def _split_path(rel: str) -> Path:
    """Convert a slash-separated string into a Path, rejecting empty parts/'..'."""
    if not rel:
        return Path(".")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    return Path(*parts) if parts else Path(".")


def _list_subdirs(p: Path) -> list[str]:
    if not p.is_dir():
        return []
    return sorted([c.name for c in p.iterdir() if c.is_dir()])


def _list_files(p: Path, suffix: str | None = None) -> list[str]:
    if not p.is_dir():
        return []
    out = []
    for c in p.iterdir():
        if c.is_file() and (suffix is None or c.name.endswith(suffix)):
            out.append(c.name)
    return sorted(out)


import math


def _sanitize_for_json(obj: Any) -> Any:
    """Recursively replace NaN/Inf floats with ``None`` for strict JSON output."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    return obj


def _read_json(p: Path) -> Any:
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Not found: {p.name}")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Bad JSON in {p.name}: {exc}")
    return _sanitize_for_json(data)


def _read_text(p: Path, max_bytes: int = 2_000_000) -> str:
    try:
        size = p.stat().st_size
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Not found: {p.name}")
    with p.open("r", encoding="utf-8", errors="replace") as f:
        if size > max_bytes:
            return f.read(max_bytes) + f"\n\n... [truncated, file size {size} bytes] ..."
        return f.read()


def extract_task_id(filename: str) -> str | None:
    m = TASK_ID_RE.search(filename)
    return m.group(0) if m else None


# ---------------------------------------------------------------------------
# App + middleware
# ---------------------------------------------------------------------------
app = FastAPI(title="MAS-Evolve Bench Observability", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Top-level config
# ---------------------------------------------------------------------------
@app.get("/api/config")
def api_config():
    return {
        "datasets": {
            name: {
                "path": str(p),
                "exists": p.exists(),
                "domains": _list_subdirs(p),
            }
            for name, p in DATASET_DIRS.items()
        },
        "results": {
            "path": str(RESULTS_DIR),
            "exists": RESULTS_DIR.exists(),
            "runs": _list_subdirs(RESULTS_DIR),
        },
        "mas_root": str(MAS_ROOT),
        "evolve_tools_root": str(EVOLVE_TOOLS_ROOT),
        # Back-compat alias for older clients that read ``enterprise_root``.
        "enterprise_root": str(MAS_ROOT),
    }


# ---------------------------------------------------------------------------
# Dataset endpoints
# ---------------------------------------------------------------------------
def _dataset_root(benchmark: str) -> Path:
    if benchmark not in DATASET_DIRS:
        raise HTTPException(status_code=404, detail=f"Unknown benchmark '{benchmark}'")
    root = DATASET_DIRS[benchmark]
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"Dataset path missing: {root}")
    return root


@app.get("/api/datasets/{benchmark}")
def api_dataset_overview(benchmark: str):
    root = _dataset_root(benchmark)
    all_subdirs = _list_subdirs(root)
    domains: list[str] = []
    other: list[str] = []
    for d in all_subdirs:
        sub = root / d
        if (sub / "env_summary.json").exists() or (sub / "benchmark" / "manifest.json").exists():
            domains.append(d)
        else:
            other.append(d)
    overview_path = root / "all_domains_overview.json"
    overview: Any = None
    if overview_path.exists():
        overview = _read_json(overview_path)
    return {
        "benchmark": benchmark,
        "root": str(root),
        "domains": domains,
        "other_subdirs": other,
        "overview": overview,
    }


@app.get("/api/datasets/{benchmark}/{domain}/summary")
def api_dataset_summary(benchmark: str, domain: str):
    root = _dataset_root(benchmark) / domain
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"Domain '{domain}' missing")
    env_summary = root / "env_summary.json"
    if not env_summary.exists():
        env_summary = root / "benchmark" / "env_summary.json"
    summary = _read_json(env_summary) if env_summary.exists() else None

    bench_dir = root / "benchmark"
    manifest_path = bench_dir / "manifest.json"

    return {
        "benchmark": benchmark,
        "domain": domain,
        "env_summary": summary,
        "has_manifest": manifest_path.exists(),
        "has_constraints_report": (bench_dir / "constraints_report.json").exists(),
        "has_schedule_rebalance_report": (bench_dir / "schedule_rebalance_report.json").exists(),
        "configs_count": len(_list_files(bench_dir / "configs", ".json")),
        "configs_at_assigned_stage_count": len(
            _list_files(bench_dir / "configs_at_assigned_stage", ".json")
        ),
        "figures": _list_files(root / "figures") if (root / "figures").exists() else [],
    }


@app.get("/api/datasets/{benchmark}/{domain}/evolution")
def api_dataset_evolution(benchmark: str, domain: str):
    """Per-stage evolution view for a domain.

    Aggregates ``env_summary.json`` plus the oracle task configs to surface
    *how* the benchmark changes across V1..VK:
        - tool catalog (new / cumulative / retired)
        - task counts (adapt vs test)
        - task complexity (avg/min/max selected_tools and verifiers per task)
        - a tool timeline matrix (rows=tools, cols=stages) marking intro/present
    """
    root = _dataset_root(benchmark) / domain
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"Domain '{domain}' missing")
    env_path = root / "env_summary.json"
    if not env_path.exists():
        env_path = root / "benchmark" / "env_summary.json"
    if not env_path.exists():
        raise HTTPException(status_code=404, detail="env_summary.json missing")
    env = _read_json(env_path)
    stages_raw = env.get("stages", []) or []

    # Map task_id -> assigned stage idx (oracle configs need stage attribution).
    task_to_stage: dict[str, int] = {}
    for s_idx, st in enumerate(stages_raw):
        for tid in st.get("adapt_task_ids", []) or []:
            task_to_stage[tid] = s_idx
        for tid in st.get("test_task_ids", []) or []:
            task_to_stage[tid] = s_idx

    # Gather per-task complexity (tools and verifiers) from oracle configs.
    cfg_dir = root / "benchmark" / "configs"
    per_stage_tools: dict[int, list[int]] = {i: [] for i in range(len(stages_raw))}
    per_stage_verifiers: dict[int, list[int]] = {i: [] for i in range(len(stages_raw))}
    per_stage_tool_usage: dict[int, dict[str, int]] = {i: {} for i in range(len(stages_raw))}
    if cfg_dir.exists():
        for f in sorted(cfg_dir.glob("oracle__*.json")):
            tid = extract_task_id(f.name)
            if not tid:
                continue
            s = task_to_stage.get(tid)
            if s is None:
                continue
            try:
                data = _read_json(f)
            except Exception:
                continue
            tools = data.get("selected_tools") or []
            verifiers = data.get("verifiers") or []
            if isinstance(tools, list):
                per_stage_tools[s].append(len(tools))
                for t in tools:
                    if isinstance(t, str):
                        per_stage_tool_usage[s][t] = per_stage_tool_usage[s].get(t, 0) + 1
            if isinstance(verifiers, list):
                per_stage_verifiers[s].append(len(verifiers))

    def _stats(xs: list[int]) -> dict:
        if not xs:
            return {"n": 0, "mean": None, "min": None, "max": None, "p50": None}
        xs2 = sorted(xs)
        n = len(xs2)
        mid = xs2[n // 2] if n % 2 else (xs2[n // 2 - 1] + xs2[n // 2]) / 2
        return {
            "n": n,
            "mean": sum(xs2) / n,
            "min": xs2[0],
            "max": xs2[-1],
            "p50": mid,
        }

    # Build tool timeline (which tools are present in each stage's cumulative set,
    # which were newly introduced, which were retired vs the previous stage).
    cumulatives = [set(st.get("cumulative_tools", []) or []) for st in stages_raw]
    all_tools: set[str] = set()
    for cs in cumulatives:
        all_tools |= cs
    prev_cum: set[str] = set()
    stages_out: list[dict] = []
    for i, st in enumerate(stages_raw):
        cum = cumulatives[i]
        declared_new = list(st.get("new_tools", []) or [])
        derived_new = sorted(cum - prev_cum)
        new_tools = declared_new if declared_new else derived_new
        retired = sorted(prev_cum - cum)
        stages_out.append(
            {
                "name": st.get("name") or f"V{i+1}",
                "description": st.get("description"),
                "new_tools": list(new_tools),
                "retired_tools": retired,
                "cumulative_tools": sorted(cum),
                "num_cumulative_tools": len(cum),
                "num_new_tools": len(new_tools),
                "num_retired_tools": len(retired),
                "num_new_tasks": st.get("num_new_tasks"),
                "num_adapt": st.get("num_adapt"),
                "num_test": st.get("num_test"),
                "tools_per_task": _stats(per_stage_tools[i]),
                "verifiers_per_task": _stats(per_stage_verifiers[i]),
                # Top-10 most-used tools in this stage's oracle solutions
                "top_tool_usage": sorted(
                    [{"tool": t, "count": c} for t, c in per_stage_tool_usage[i].items()],
                    key=lambda x: (-x["count"], x["tool"]),
                )[:15],
            }
        )
        prev_cum = cum

    # Tool timeline: rows are tools sorted by intro_stage then name.
    intro: dict[str, int] = {}
    for i, cs in enumerate(cumulatives):
        for t in cs:
            intro.setdefault(t, i)
    timeline = []
    for t in sorted(all_tools, key=lambda x: (intro.get(x, 99), x)):
        presence = []
        for i, cs in enumerate(cumulatives):
            if t not in cs:
                presence.append("absent")
            elif intro.get(t) == i:
                presence.append("new")
            else:
                presence.append("present")
        timeline.append({"tool": t, "intro_stage": intro[t], "presence": presence})

    return {
        "benchmark": benchmark,
        "domain": domain,
        "num_stages": env.get("num_stages") or len(stages_raw),
        "total_tasks": env.get("total_tasks"),
        "staging": env.get("staging"),
        "adapt_ratio": env.get("adapt_ratio"),
        "seed": env.get("seed"),
        "stages": stages_out,
        "tool_timeline": timeline,
    }


# Folder naming differs slightly between the two benchmarks. We probe both.
_REALWORLD_DIR_CANDIDATES = ("comparison_org62", "comparison_with_org62")


def _realworld_dir(benchmark: str) -> Path | None:
    root = _dataset_root(benchmark)
    for name in _REALWORLD_DIR_CANDIDATES:
        cand = root / name
        if cand.exists() and cand.is_dir():
            return cand
    return None


@lru_cache(maxsize=64)
def _domain_rank_frequency(benchmark: str, domain: str) -> tuple[int, ...] | None:
    """Empirical rank-frequency array for a simulated domain.

    For every task we count which tools appear in its ``oracle_tools`` set,
    then return the counts sorted descending — i.e. exactly the same vector
    that ``rank_freq_array(...)`` in ``compare_with_real.py`` produces, so
    the curve here matches the PNG.
    """
    root = DATASET_DIRS.get(benchmark)
    if root is None:
        return None
    manifest_path = root / domain / "benchmark" / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        with manifest_path.open("r", encoding="utf-8") as f:
            m = json.load(f)
    except Exception:
        return None
    cnt: dict[str, int] = {}
    for t in m.get("tasks", []) or []:
        for tool in t.get("oracle_tools") or []:
            cnt[tool] = cnt.get(tool, 0) + 1
    return tuple(sorted(cnt.values(), reverse=True))


@app.get("/api/datasets/{benchmark}/realworld_comparison")
def api_dataset_realworld_comparison(benchmark: str):
    """Bundle the org62 (real-world) alignment artifacts for a benchmark.

    Returns the parsed ``match_summary.json``, the list of figures that
    live alongside it, plus a freshly-computed empirical rank-frequency
    vector for every simulated domain (so the frontend can draw the same
    log–log step-curve the PNG shows). The frontend uses this to render
    a "Real-world fit" view in the Benchmark tab showing that our
    evolving benchmark mirrors the rank/frequency and complexity-growth
    structure of the real org62 trace.
    """
    rw = _realworld_dir(benchmark)
    if rw is None:
        raise HTTPException(
            status_code=404,
            detail=f"No comparison_org62/comparison_with_org62 folder under {benchmark}",
        )
    summary_path = rw / "match_summary.json"
    summary: Any = None
    if summary_path.exists():
        summary = _read_json(summary_path)
    figures = _list_files(rw, ".png")

    # Empirical rank-frequency arrays. We start from the sidecar JSON the
    # generation script writes for the real corpora (org62-all / org62-multi),
    # then overlay simulated domains computed live from each domain's
    # manifest. Without the sidecar we can only fit a theoretical Zipf line
    # to α and the chart no longer matches the source PNG.
    rank_freq: dict[str, list[int]] = {}
    rf_path = rw / "rank_frequency.json"
    if rf_path.exists():
        try:
            rf_data = _read_json(rf_path)
            if isinstance(rf_data, dict):
                for k, v in rf_data.items():
                    if isinstance(v, list):
                        rank_freq[str(k)] = [int(x) for x in v]
        except Exception:
            pass
    if summary and isinstance(summary.get("simulated"), list):
        for s in summary["simulated"]:
            name = s.get("name")
            if not name:
                continue
            arr = _domain_rank_frequency(benchmark, name)
            if arr:
                rank_freq[name] = list(arr)

    return {
        "benchmark": benchmark,
        "folder": rw.name,
        "match_summary": summary,
        "figures": figures,
        "rank_frequency": rank_freq,
    }


@app.get("/api/datasets/{benchmark}/realworld_comparison/image")
def api_dataset_realworld_image(benchmark: str, name: str):
    """Serve a PNG from the realworld-comparison folder."""
    rw = _realworld_dir(benchmark)
    if rw is None:
        raise HTTPException(
            status_code=404,
            detail=f"No comparison_org62/comparison_with_org62 folder under {benchmark}",
        )
    # Filename-only, no traversal.
    if "/" in name or ".." in name or not name.endswith(".png"):
        raise HTTPException(status_code=400, detail="Invalid image name")
    target = rw / name
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"Image missing: {name}")
    return FileResponse(target, media_type="image/png")


@app.get("/api/datasets/{benchmark}/{domain}/manifest")
def api_dataset_manifest(benchmark: str, domain: str):
    root = _dataset_root(benchmark) / domain / "benchmark"
    p = root / "manifest.json"
    if not p.exists():
        raise HTTPException(status_code=404, detail="manifest.json missing")
    return _read_json(p)


@app.get("/api/datasets/{benchmark}/{domain}/constraints_report")
def api_dataset_constraints(benchmark: str, domain: str):
    p = _dataset_root(benchmark) / domain / "benchmark" / "constraints_report.json"
    if not p.exists():
        raise HTTPException(status_code=404, detail="constraints_report.json missing")
    return _read_json(p)


@app.get("/api/datasets/{benchmark}/{domain}/tasks")
def api_dataset_tasks(
    benchmark: str,
    domain: str,
    kind: str = Query("oracle", regex="^(oracle|stage)$"),
    stage: int | None = None,
):
    """List task config filenames.

    ``kind=oracle`` returns ``configs/`` (single oracle entry per task).
    ``kind=stage`` returns ``configs_at_assigned_stage/`` (one per task per stage assignment).
    Optional ``stage`` filters stage-prefixed filenames.
    """
    root = _dataset_root(benchmark) / domain / "benchmark"
    sub = "configs" if kind == "oracle" else "configs_at_assigned_stage"
    files = _list_files(root / sub, ".json")

    # Pre-compute stage assignment from env_summary if available so we can attach it
    # to oracle entries too.
    stage_lookup: dict[str, int] = {}
    env_summary_path = _dataset_root(benchmark) / domain / "env_summary.json"
    if env_summary_path.exists():
        summary = _read_json(env_summary_path)
        for s_idx, st in enumerate(summary.get("stages", [])):
            for tid in st.get("adapt_task_ids", []):
                stage_lookup[tid] = s_idx
            for tid in st.get("test_task_ids", []):
                stage_lookup[tid] = s_idx

    items = []
    for fn in files:
        tid = extract_task_id(fn)
        s_idx = None
        if kind == "stage":
            m = re.match(r"stage(\d+)_", fn)
            if m:
                s_idx = int(m.group(1))
        if s_idx is None and tid:
            s_idx = stage_lookup.get(tid)
        if stage is not None and s_idx != stage:
            continue
        items.append({"filename": fn, "task_id": tid, "stage": s_idx})
    return {"kind": kind, "count": len(items), "tasks": items}


@app.get("/api/datasets/{benchmark}/{domain}/tasks/{kind}/{filename}")
def api_dataset_task(benchmark: str, domain: str, kind: str, filename: str):
    if kind not in ("oracle", "stage"):
        raise HTTPException(status_code=400, detail="kind must be oracle or stage")
    sub = "configs" if kind == "oracle" else "configs_at_assigned_stage"
    base = _dataset_root(benchmark) / domain / "benchmark" / sub
    target = _safe_relpath(base, Path(filename))
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Task file missing: {filename}")
    return _read_json(target)


# ---------------------------------------------------------------------------
# Results endpoints
# ---------------------------------------------------------------------------
@app.get("/api/results/runs")
def api_runs():
    if not RESULTS_DIR.exists():
        raise HTTPException(status_code=404, detail="Results dir missing")
    runs = []
    for c in sorted(RESULTS_DIR.iterdir()):
        if c.is_dir():
            runs.append({"name": c.name, "domains": _list_subdirs(c)})
    other = []
    for c in sorted(RESULTS_DIR.iterdir()):
        if c.is_file():
            other.append(c.name)
    return {"runs": runs, "files": other}


@app.get("/api/results/tree")
def api_results_tree(path: str = ""):
    """Return a directory listing under ``RESULTS_DIR``.

    Returns ``dirs``, ``files`` (with size in bytes), and convenience flags about
    the contents of the directory so the frontend can render the right view.
    """
    rel = _split_path(path)
    target = _safe_relpath(RESULTS_DIR, rel)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path missing: {path}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    dirs, files = [], []
    for c in sorted(target.iterdir()):
        if c.is_dir():
            dirs.append(c.name)
        else:
            try:
                files.append({"name": c.name, "size": c.stat().st_size})
            except OSError:
                files.append({"name": c.name, "size": -1})

    flags = {
        "has_report_json": (target / "report.json").exists(),
        "has_metrics_json": (target / "metrics.json").exists(),
        "has_report_tsv": (target / "report.tsv").exists(),
        "has_report_txt": (target / "report.txt").exists(),
        "has_matrix_tsv": (target / "matrix.tsv").exists(),
        "has_run_log": (target / "run.log").exists(),
        "has_env_summary": (target / "env_summary.json").exists(),
    }
    return {"path": str(rel) if str(rel) != "." else "", "dirs": dirs, "files": files, "flags": flags}


@app.get("/api/results/file")
def api_results_file(path: str):
    """Return the contents of a file under ``RESULTS_DIR``.

    JSON files are returned parsed; everything else as text. Large files are
    truncated for safety.
    """
    rel = _split_path(path)
    target = _safe_relpath(RESULTS_DIR, rel)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"File missing: {path}")
    if target.is_dir():
        raise HTTPException(status_code=400, detail="Path is a directory")
    if target.suffix.lower() == ".json":
        return JSONResponse({"kind": "json", "path": path, "data": _read_json(target)})
    return JSONResponse(
        {"kind": "text", "path": path, "data": _read_text(target), "size": target.stat().st_size}
    )


@app.get("/api/results/raw")
def api_results_raw(path: str, download: bool = False):
    """Send the raw file (e.g. for inline images, or as a download).

    When ``download`` is true a ``Content-Disposition: attachment`` header is
    set (via ``filename=``) so the browser saves the file with its original
    name instead of rendering it inline.
    """
    rel = _split_path(path)
    target = _safe_relpath(RESULTS_DIR, rel)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File missing")
    if download:
        return FileResponse(target, filename=target.name)
    return FileResponse(target)


@app.get("/api/results/download_zip")
def api_results_download_zip(path: str = ""):
    """Zip a directory (or a single file) under ``RESULTS_DIR`` and stream it.

    ``path`` empty ⇒ the whole results root. The archive is built into a temp
    file and deleted after the response is sent.
    """
    rel = _split_path(path)
    target = _safe_relpath(RESULTS_DIR, rel)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path missing: {path}")

    # Friendly archive base name (root dir has no useful name → "evolve_results").
    arc_base = target.name or "evolve_results"

    tmp = tempfile.NamedTemporaryFile(prefix="evolve_dl_", suffix=".zip", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            if target.is_file():
                zf.write(target, arcname=target.name)
            else:
                files = [f for f in target.rglob("*") if f.is_file()]
                for f in sorted(files):
                    zf.write(f, arcname=str(Path(arc_base) / f.relative_to(target)))
                if not files:
                    # Preserve an empty directory so the zip isn't empty.
                    zf.writestr(f"{arc_base}/", "")
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=f"{arc_base}.zip",
        background=BackgroundTask(lambda: tmp_path.unlink(missing_ok=True)),
    )


@app.get("/api/results/cl_summary")
def api_cl_summary(run: str, oracle_run: str | None = None):
    """Continual-learning summary table per (run, domain): four setups
    (Oracle Tool / Cumulative Tool (No Memory) / Cumulative Tool + Raw Memory
    / Oracle Tool + Raw Memory) with full matrix and derived Final Avg,
    Fwd Avg (diagonal), per-stage Δ (BWT-final per j) and Δ Final Avg.
    """
    return insights.cl_summary(RESULTS_DIR, run, oracle_run=oracle_run)


@app.get("/api/results/run_summary")
def api_run_summary(path: str):
    """Auto-aggregate the most useful artifacts at a results sub-path.

    Returns ``report.json`` / ``metrics.json`` / ``report.tsv`` content if present,
    along with a flat list of every task json available below this directory.
    """
    rel = _split_path(path)
    target = _safe_relpath(RESULTS_DIR, rel)
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory missing")

    out: dict[str, Any] = {"path": path}
    rj = target / "report.json"
    if rj.exists():
        out["report_json"] = _read_json(rj)
    mj = target / "metrics.json"
    if mj.exists():
        out["metrics_json"] = _read_json(mj)
    rt = target / "report.tsv"
    if rt.exists():
        out["report_tsv"] = _read_text(rt, max_bytes=200_000)
    rtxt = target / "report.txt"
    if rtxt.exists():
        out["report_txt"] = _read_text(rtxt, max_bytes=200_000)
    mtv = target / "matrix.tsv"
    if mtv.exists():
        out["matrix_tsv"] = _read_text(mtv, max_bytes=200_000)
    es = target / "env_summary.json"
    if es.exists():
        out["env_summary"] = _read_json(es)

    return out


# ---------------------------------------------------------------------------
# Insights endpoints (built on beyond_accuracy/*.tsv)
# ---------------------------------------------------------------------------
def _insights_root(run_name: str) -> Path:
    p = (RESULTS_DIR / run_name).resolve()
    if not str(p).startswith(str(RESULTS_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Path traversal")
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Run '{run_name}' missing")
    if not (p / "beyond_accuracy").exists() and not (p / "accuracy").exists():
        raise HTTPException(
            status_code=404,
            detail=f"No beyond_accuracy/ or accuracy/ under '{run_name}'.",
        )
    return p


@app.get("/api/insights/runs")
def api_insights_runs():
    """List runs that have either beyond_accuracy/ or accuracy/."""
    out = []
    if RESULTS_DIR.exists():
        for c in sorted(RESULTS_DIR.iterdir()):
            if not c.is_dir():
                continue
            has_ba = (c / "beyond_accuracy").exists()
            has_acc = (c / "accuracy").exists()
            if not (has_ba or has_acc):
                continue
            modes = insights.available_modes(c) if has_ba else []
            out.append(
                {
                    "name": c.name,
                    "modes": modes,
                    "has_beyond_accuracy": has_ba,
                    "has_accuracy": has_acc,
                }
            )
    return {"runs": out}


@app.get("/api/insights/{run}/overview")
def api_insights_overview(run: str):
    return insights.overview(_insights_root(run))


# --- The three headline insights (backed by accuracy/*.tsv) ---
@app.get("/api/insights/{run}/forgetting_summary")
def api_insights_forgetting(run: str):
    return insights.forgetting_summary(_insights_root(run))


@app.get("/api/insights/{run}/pair_deltas")
def api_insights_pair_deltas(run: str):
    return insights.pair_deltas(_insights_root(run))


@app.get("/api/insights/{run}/token_cost")
def api_insights_token_cost(run: str):
    return insights.token_cost(_insights_root(run))


@app.get("/api/insights/{run}/memory_summary")
def api_insights_memory(run: str):
    """Memory composition / tool-era mix / breadth panels derived from
    ``accuracy/memory_summary.tsv``."""
    return insights.memory_summary(_insights_root(run))


@app.get("/api/insights/{run}/mode_comparison")
def api_insights_mode_comparison(
    run: str,
    domain: str | None = None,
    only_diagonal: bool = False,
):
    return insights.mode_comparison(
        _insights_root(run), domain=domain, only_diagonal=only_diagonal
    )


@app.get("/api/insights/{run}/decomposition")
def api_insights_decomposition(run: str, mode: str = "no_memory", domain: str | None = None):
    return insights.drift_decomposition(_insights_root(run), mode=mode, domain=domain)


@app.get("/api/insights/{run}/bucket_attribution")
def api_insights_bucket(run: str, mode: str = "no_memory", domain: str | None = None):
    return insights.bucket_attribution(_insights_root(run), mode=mode, domain=domain)


@app.get("/api/insights/{run}/trajectory")
def api_insights_trajectory(
    run: str,
    mode: str = "adapt_fwd",
    domain: str | None = None,
    feature: str = "success",
):
    return insights.trajectory(_insights_root(run), mode=mode, domain=domain, feature=feature)


@app.get("/api/insights/{run}/feature_correlation")
def api_insights_feature_corr(
    run: str,
    mode: str | None = None,
    target: str = "success",
    domain: str | None = None,
):
    return insights.feature_correlation(
        _insights_root(run), mode=mode, target=target, domain=domain
    )


@app.get("/api/insights/{run}/catalog_confusion")
def api_insights_catalog(run: str, mode: str = "adapt_fwd", domain: str | None = None):
    return insights.catalog_confusion(_insights_root(run), mode=mode, domain=domain)


@app.get("/api/insights/{run}/task_failures")
def api_insights_task_failures(
    run: str, mode: str = "adapt_fwd", domain: str | None = None, top_n: int = 20
):
    return insights.task_failures(_insights_root(run), mode=mode, domain=domain, top_n=top_n)


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
@app.middleware("http")
async def _no_cache_static(request, call_next):
    """Disable caching for the HTML/JS/CSS so port-forwarded users always
    fetch the latest assets. Cheap to do for a dev observability tool."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    # The SPA has two URL spaces:
    #   * `/`           — the root landing (Tools / Skills / Agents cards).
    #   * `/tools/*`    — the tool-observability views (Overview, Benchmark,
    #                     Results, Insights).
    # Direct visits to any of these paths (or a refresh while inside one) must
    # re-serve index.html so the SPA can route client-side.
    SPA_TAB_NAMES: tuple[str, ...] = ("overview", "benchmark", "results", "insights")
    SPA_ROUTES: tuple[str, ...] = (
        "/tools",
        *(f"/tools/{name}" for name in SPA_TAB_NAMES),
    )

    def _spa_index() -> FileResponse:
        return FileResponse(
            FRONTEND_DIR / "index.html",
            headers={"Cache-Control": "no-store, max-age=0"},
        )

    @app.get("/")
    def index() -> FileResponse:
        return _spa_index()

    # Explicit SPA tab routes. Listed individually (rather than as a single
    # catch-all) so unrecognised paths still 404 instead of silently
    # returning the SPA shell.
    for _route in SPA_ROUTES:
        app.add_api_route(_route, _spa_index, methods=["GET"])
else:  # pragma: no cover

    @app.get("/")
    def index():
        return {"detail": f"Frontend dir not found at {FRONTEND_DIR}"}


@app.get("/api/health")
def health():
    return {"ok": True}
