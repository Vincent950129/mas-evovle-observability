"""Analytics over the ``beyond_accuracy/*.tsv`` artifacts.

The TSVs that ``evolve_poc/beyond_accuracy_report.py`` writes already give us
per-(domain, adapt_stage k, eval_stage j, mode) rollups and per-task rows
with rich tool-call signals (``tool_f1``, ``plan_len_ratio``,
``older_distractor_rate``, ``newer_adopt_rate``, ``hallucinated_rate``,
``give_up``, …).

This module turns them into the views needed to answer:

  * Under tool drift, what changes across (k, j) cells?
  * What changes most: tool *selection* (which tools get called) or tool
    *usage* (sequence, parameters, redundancy, errors)?
  * How much of the success gap to the oracle baseline is recovered by
    memory (adapt_fwd) vs not (no_memory)?

All functions are pure: they take ``run_root`` (a path to a directory whose
``beyond_accuracy/`` subdir contains the TSVs) and return JSON-friendly
Python dicts.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import math

import numpy as np
import pandas as pd


MODES_DEFAULT = ("oracle", "no_memory", "adapt_fwd")


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------
def _ba_dir(run_root: Path) -> Path:
    p = run_root / "beyond_accuracy"
    if not p.exists():
        raise FileNotFoundError(f"beyond_accuracy/ not found under {run_root}")
    return p


def _accuracy_dir(run_root: Path) -> Path:
    p = run_root / "accuracy"
    if not p.exists():
        raise FileNotFoundError(f"accuracy/ not found under {run_root}")
    return p


def available_modes(run_root: Path) -> list[str]:
    ba = _ba_dir(run_root)
    modes = []
    for f in ba.glob("*__per_cell.tsv"):
        modes.append(f.name.split("__")[0])
    return sorted(set(modes))


def _read_report_json(p: Path) -> dict:
    import json
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)


def _read_tsv(p: Path) -> pd.DataFrame:
    return pd.read_csv(p, sep="\t")


@lru_cache(maxsize=64)
def load_per_cell(run_root_str: str) -> pd.DataFrame:
    """All per-cell rows for every available mode, concatenated."""
    run_root = Path(run_root_str)
    ba = _ba_dir(run_root)
    frames = []
    for f in sorted(ba.glob("*__per_cell.tsv")):
        df = _read_tsv(f)
        if "mode" not in df.columns:
            df["mode"] = f.name.split("__")[0]
        frames.append(df)
    if not frames:
        raise FileNotFoundError("No *__per_cell.tsv files found.")
    return pd.concat(frames, ignore_index=True)


@lru_cache(maxsize=64)
def load_per_task(run_root_str: str) -> pd.DataFrame:
    run_root = Path(run_root_str)
    ba = _ba_dir(run_root)
    frames = []
    for f in sorted(ba.glob("*__per_task.tsv")):
        df = _read_tsv(f)
        if "mode" not in df.columns:
            df["mode"] = f.name.split("__")[0]
        frames.append(df)
    if not frames:
        raise FileNotFoundError("No *__per_task.tsv files found.")
    return pd.concat(frames, ignore_index=True)


@lru_cache(maxsize=64)
def load_cross_mode(run_root_str: str) -> pd.DataFrame | None:
    run_root = Path(run_root_str)
    ba = _ba_dir(run_root)
    p = ba / "cross_mode_summary.tsv"
    return _read_tsv(p) if p.exists() else None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _safe(x):
    if x is None:
        return None
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
    return x


def _df_to_records(df: pd.DataFrame) -> list[dict]:
    out = df.where(pd.notna(df), None).to_dict("records")
    for r in out:
        for k, v in list(r.items()):
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                r[k] = None
            elif isinstance(v, np.generic):
                r[k] = v.item()
    return out


# Feature buckets. These are the columns that exist in per_task / per_cell
# (with the "__mean" suffix in per_task / per_cell). When we ask
# `_feat(df, "tool_f1")` we resolve to whichever column is present.
SELECTION_FEATS = [
    "tool_f1",
    "tool_prec",
    "tool_rec",
    "n_extra_tools",
    "n_missed_tools",
    "gold_call_rate",
    "older_distractor_rate",
    "newer_adopt_rate",
    "brand_new_rate",
    "hallucinated_rate",
]
USAGE_FEATS = [
    "n_calls",
    "n_ok_calls",
    "n_err_calls",
    "n_dup_calls",
    "n_unique_tools",
    "plan_len_ratio",
    "ai_turns",
    "all_errored",
    "give_up",
]
COST_FEATS = ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "wall_ms"]
OUTCOME_FEATS = ["success", "verifier_pr"]
ALL_FEATS = OUTCOME_FEATS + SELECTION_FEATS + USAGE_FEATS + COST_FEATS


def _feat_col(df: pd.DataFrame, name: str) -> str | None:
    """Resolve canonical feature name to actual column name in ``df``."""
    for cand in (name, f"{name}__mean"):
        if cand in df.columns:
            return cand
    return None


# ---------------------------------------------------------------------------
# Top-level overview
# ---------------------------------------------------------------------------
def overview(run_root: Path) -> dict[str, Any]:
    df = load_per_cell(str(run_root))
    modes = sorted(df["mode"].unique().tolist())
    domains = sorted(df["domain"].unique().tolist())
    ks = sorted(df["k"].unique().tolist())
    js = sorted(df["j"].unique().tolist())

    # Aggregate top-line metrics per mode
    rows = []
    for m in modes:
        sub = df[df["mode"] == m]
        rows.append(
            {
                "mode": m,
                "n_cells": int(len(sub)),
                "domains": int(sub["domain"].nunique()),
                "success__mean": _safe(sub.get(_feat_col(sub, "success"), pd.Series()).mean()),
                "verifier_pr__mean": _safe(sub.get(_feat_col(sub, "verifier_pr"), pd.Series()).mean()),
                "tool_f1__mean": _safe(sub.get(_feat_col(sub, "tool_f1"), pd.Series()).mean()),
                "plan_len_ratio__mean": _safe(sub.get(_feat_col(sub, "plan_len_ratio"), pd.Series()).mean()),
                "give_up__mean": _safe(sub.get(_feat_col(sub, "give_up"), pd.Series()).mean()),
                "hallucinated_rate__mean": _safe(
                    sub.get(_feat_col(sub, "hallucinated_rate"), pd.Series()).mean()
                ),
            }
        )

    return {
        "run_root": str(run_root),
        "modes": modes,
        "domains": domains,
        "k_values": ks,
        "j_values": js,
        "per_mode_topline": rows,
    }


# ---------------------------------------------------------------------------
# Mode comparison: oracle / no_memory / adapt_fwd side-by-side
# ---------------------------------------------------------------------------
def mode_comparison(
    run_root: Path,
    *,
    domain: str | None = None,
    only_diagonal: bool = False,
) -> dict[str, Any]:
    """One row per (domain, k, j) with metrics for each available mode.

    Always includes a derived row showing the **gap to oracle** for the
    diagonal cells (k==j). The oracle gives a near-upper-bound because it
    sees only the right tool subset; the gap to oracle quantifies how much
    capability drift hurts a given mode.
    """
    df = load_per_cell(str(run_root))
    if domain:
        df = df[df["domain"] == domain]
    if only_diagonal:
        df = df[df["k"] == df["j"]]

    feats = [f for f in ALL_FEATS if _feat_col(df, f)]
    keys = ["domain", "k", "j"]

    pivot = df.pivot_table(
        index=keys,
        columns="mode",
        values=[_feat_col(df, f) for f in feats],
        aggfunc="first",
    )
    # Flatten: (feat_col, mode) -> "feat__mode"
    pivot.columns = [f"{c[0].replace('__mean','')}__{c[1]}" for c in pivot.columns]
    pivot = pivot.reset_index()

    # Compute deltas vs oracle for diagonal rows
    has_oracle = "oracle" in df["mode"].unique()
    if has_oracle:
        for f in feats:
            for m in df["mode"].unique():
                if m == "oracle":
                    continue
                a = f"{f}__{m}"
                b = f"{f}__oracle"
                if a in pivot.columns and b in pivot.columns:
                    pivot[f"delta_oracle__{f}__{m}"] = pivot[a] - pivot[b]

    return {
        "domains": sorted(df["domain"].unique().tolist()),
        "modes_present": sorted(df["mode"].unique().tolist()),
        "features": feats,
        "rows": _df_to_records(pivot),
    }


# ---------------------------------------------------------------------------
# Drift decomposition: how does Δ(mode → oracle) split across signals?
# ---------------------------------------------------------------------------
def drift_decomposition(
    run_root: Path, mode: str = "no_memory", domain: str | None = None
) -> dict[str, Any]:
    """For every diagonal cell ``(k=j)``, compute the gap of ``mode`` vs
    ``oracle`` in *each* metric. Average across cells to see which signals
    contribute most to the drop in success.

    Output structure::

        {
          "mode": "no_memory",
          "oracle_baseline": {feat: mean_value, ...},
          "mode_value":      {feat: mean_value, ...},
          "delta_to_oracle": {feat: mean_delta, ...},
          "ranked": [(feat, |delta|), ...],
          "per_cell": [...]
        }
    """
    df = load_per_cell(str(run_root))
    if domain:
        df = df[df["domain"] == domain]
    df = df[df["k"] == df["j"]].copy()

    feats = [f for f in ALL_FEATS if _feat_col(df, f)]
    pivot_cols = ["mode"]
    pivot = df.pivot_table(
        index=["domain", "k", "j"],
        columns=pivot_cols,
        values=[_feat_col(df, f) for f in feats],
        aggfunc="first",
    )
    pivot.columns = [f"{c[0].replace('__mean','')}__{c[1]}" for c in pivot.columns]
    pivot = pivot.reset_index()

    if f"success__oracle" not in pivot.columns or f"success__{mode}" not in pivot.columns:
        return {
            "mode": mode,
            "error": f"Need both oracle and {mode} in per_cell; found columns: {list(pivot.columns)[:8]}…",
        }

    deltas = {}
    oracle_means = {}
    mode_means = {}
    per_cell_records = []

    for f in feats:
        a = f"{f}__{mode}"
        b = f"{f}__oracle"
        if a not in pivot.columns or b not in pivot.columns:
            continue
        oracle_means[f] = _safe(pivot[b].mean())
        mode_means[f] = _safe(pivot[a].mean())
        deltas[f] = _safe((pivot[a] - pivot[b]).mean())

    # Per-cell deltas (only for the most informative features)
    keep = ["domain", "k", "j"]
    for f in feats:
        a = f"{f}__{mode}"
        b = f"{f}__oracle"
        if a in pivot.columns and b in pivot.columns:
            pivot[f"delta__{f}"] = pivot[a] - pivot[b]
            keep.append(f"delta__{f}")
    per_cell_records = _df_to_records(pivot[keep])

    ranked = sorted(deltas.items(), key=lambda kv: -abs(kv[1] or 0))
    return {
        "mode": mode,
        "domain": domain,
        "n_cells": int(len(pivot)),
        "oracle_baseline": oracle_means,
        "mode_value": mode_means,
        "delta_to_oracle": deltas,
        "ranked_by_abs_delta": [{"feature": k, "delta": v} for k, v in ranked],
        "per_cell": per_cell_records,
    }


# ---------------------------------------------------------------------------
# Forgetting trajectory: fixed (j, mode), metric vs k
# ---------------------------------------------------------------------------
def trajectory(
    run_root: Path,
    *,
    mode: str = "adapt_fwd",
    domain: str | None = None,
    feature: str = "success",
) -> dict[str, Any]:
    df = load_per_cell(str(run_root))
    df = df[df["mode"] == mode]
    if domain:
        df = df[df["domain"] == domain]

    col = _feat_col(df, feature)
    if not col:
        return {"error": f"feature '{feature}' not present"}

    # group by (domain, j) → list of (k, value) sorted by k
    out = []
    for (dom, j), sub in df.groupby(["domain", "j"]):
        sub = sub.sort_values("k")
        out.append(
            {
                "domain": dom,
                "j": int(j),
                "points": [{"k": int(k), "value": _safe(v)} for k, v in zip(sub["k"], sub[col])],
            }
        )
    return {"mode": mode, "feature": feature, "series": out}


# ---------------------------------------------------------------------------
# Feature correlation: what predicts success?
# ---------------------------------------------------------------------------
def feature_correlation(
    run_root: Path,
    *,
    mode: str | None = None,
    target: str = "success",
    domain: str | None = None,
) -> dict[str, Any]:
    """Pearson correlation between each per-task feature and the target.

    A positive r for ``tool_f1`` and small |r| for ``plan_len_ratio`` would,
    for example, say "tool *selection* matters far more than tool *usage
    length* on this slice". This is computed over per-task means (each row
    is a task aggregated across its 8 runs).
    """
    df = load_per_task(str(run_root))
    if mode:
        df = df[df["mode"] == mode]
    if domain:
        df = df[df["domain"] == domain]
    if df.empty:
        return {"error": "No rows after filtering"}

    target_col = _feat_col(df, target)
    if not target_col:
        return {"error": f"target '{target}' missing"}

    rows = []
    for f in SELECTION_FEATS + USAGE_FEATS + COST_FEATS:
        col = _feat_col(df, f)
        if not col:
            continue
        x = df[col]
        y = df[target_col]
        valid = x.notna() & y.notna()
        if valid.sum() < 5 or x[valid].nunique() < 2:
            continue
        r = float(np.corrcoef(x[valid], y[valid])[0, 1])
        rows.append({"feature": f, "bucket": _bucket_of(f), "n": int(valid.sum()), "pearson_r": _safe(r)})

    rows.sort(key=lambda r: -abs(r["pearson_r"] or 0))
    return {
        "mode": mode,
        "domain": domain,
        "target": target,
        "n_tasks": int(len(df)),
        "correlations": rows,
        "buckets": {
            "selection": SELECTION_FEATS,
            "usage": USAGE_FEATS,
            "cost": COST_FEATS,
        },
    }


def _bucket_of(feat: str) -> str:
    if feat in SELECTION_FEATS:
        return "selection"
    if feat in USAGE_FEATS:
        return "usage"
    if feat in COST_FEATS:
        return "cost"
    return "other"


# ---------------------------------------------------------------------------
# Bucket attribution: rank "tool selection" vs "tool usage" by aggregate |Δ|
# ---------------------------------------------------------------------------
def bucket_attribution(
    run_root: Path, mode: str = "no_memory", domain: str | None = None
) -> dict[str, Any]:
    """For diagonal cells, average the absolute z-scored Δ per feature, then
    average within each bucket. The bucket whose features deviate most from
    oracle is the one that "moves most" under capability drift.

    Returns per-bucket aggregate plus per-feature z-score and raw Δ.
    """
    decomp = drift_decomposition(run_root, mode=mode, domain=domain)
    if "error" in decomp:
        return decomp

    df = load_per_cell(str(run_root))
    if domain:
        df = df[df["domain"] == domain]
    df = df[df["k"] == df["j"]]

    # Compute per-feature std across both oracle and mode rows so |Δ|/σ is meaningful.
    feats = [f for f, v in decomp["delta_to_oracle"].items() if v is not None]
    out_feats = []
    for f in feats:
        col = _feat_col(df, f)
        if not col:
            continue
        sigma = float(df[col].std())
        delta = decomp["delta_to_oracle"][f]
        z = abs(delta) / sigma if sigma and sigma > 1e-9 and delta is not None else None
        out_feats.append(
            {
                "feature": f,
                "bucket": _bucket_of(f),
                "delta_to_oracle": delta,
                "sigma": _safe(sigma),
                "abs_z": _safe(z),
                "mode_value": decomp["mode_value"].get(f),
                "oracle_value": decomp["oracle_baseline"].get(f),
            }
        )

    # Bucket aggregate: mean |z| within each bucket
    buckets: dict[str, list[float]] = {"selection": [], "usage": [], "cost": []}
    for f in out_feats:
        if f["abs_z"] is not None and f["bucket"] in buckets:
            buckets[f["bucket"]].append(f["abs_z"])
    bucket_summary = []
    for b, xs in buckets.items():
        bucket_summary.append(
            {
                "bucket": b,
                "n_features": len(xs),
                "mean_abs_z_to_oracle": _safe(float(np.mean(xs)) if xs else None),
                "max_abs_z_to_oracle": _safe(float(np.max(xs)) if xs else None),
            }
        )

    out_feats.sort(key=lambda r: -(r["abs_z"] or 0))
    return {
        "mode": mode,
        "domain": domain,
        "feature_breakdown": out_feats,
        "bucket_summary": bucket_summary,
        "n_cells": decomp["n_cells"],
    }


# ---------------------------------------------------------------------------
# Per-task failure attribution
# ---------------------------------------------------------------------------
def task_failures(
    run_root: Path,
    *,
    mode: str = "adapt_fwd",
    domain: str | None = None,
    top_n: int = 20,
) -> dict[str, Any]:
    """List the worst-performing tasks for ``mode`` and a per-feature comparison
    of failed-task means vs successful-task means.

    Difference of means (failed − successful) per feature reveals which signal
    discriminates failure: e.g., failed tasks have markedly lower ``tool_f1``
    means → selection problem; or higher ``plan_len_ratio`` means → usage
    problem (over-planning / loops).
    """
    df = load_per_task(str(run_root))
    if mode:
        df = df[df["mode"] == mode]
    if domain:
        df = df[df["domain"] == domain]

    succ_col = _feat_col(df, "success")
    if not succ_col:
        return {"error": "no success column"}

    df = df.copy()
    succ = df[succ_col]
    failed = df[succ < 0.5]
    succeeded = df[succ >= 0.5]

    feat_diffs = []
    for f in SELECTION_FEATS + USAGE_FEATS + COST_FEATS:
        col = _feat_col(df, f)
        if not col:
            continue
        m_fail = failed[col].mean()
        m_pass = succeeded[col].mean()
        sigma = df[col].std()
        if sigma and sigma > 1e-9 and pd.notna(m_fail) and pd.notna(m_pass):
            feat_diffs.append(
                {
                    "feature": f,
                    "bucket": _bucket_of(f),
                    "failed_mean": _safe(m_fail),
                    "succeeded_mean": _safe(m_pass),
                    "diff_failed_minus_succ": _safe(m_fail - m_pass),
                    "abs_z": _safe(abs(m_fail - m_pass) / sigma),
                }
            )
    feat_diffs.sort(key=lambda r: -(r["abs_z"] or 0))

    worst = (
        df.sort_values(succ_col)
        .head(top_n)[
            [c for c in ["domain", "k", "j", "task_id", succ_col, _feat_col(df, "verifier_pr"), _feat_col(df, "tool_f1"), _feat_col(df, "give_up"), _feat_col(df, "n_calls")] if c]
        ]
    )

    return {
        "mode": mode,
        "domain": domain,
        "n_tasks": int(len(df)),
        "n_failed": int(len(failed)),
        "n_succeeded": int(len(succeeded)),
        "feature_discriminators": feat_diffs,
        "worst_tasks": _df_to_records(worst),
    }


# ---------------------------------------------------------------------------
# Tool-catalog confusion: how do drift-specific signals evolve across k?
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Continual-learning summary table per (run, domain).
# ---------------------------------------------------------------------------
# Setup → label  + locator function (results_root, run, domain) → Path
_CL_SETUPS_DEFAULT: list[dict] = [
    {
        "key": "oracle",
        "label": "Oracle Tool",
        "is_baseline": True,
        "subdir": None,
        "external_run_candidates": ("oracle_evolving_gpt5", "oracle_evolving", "oracle"),
    },
    {
        "key": "no_memory",
        "label": "Cumulative Tool (No Memory)",
        "subdir": "no_memory",
    },
    {
        "key": "adapt_fwd",
        "label": "Cumulative Tool + Raw Memory",
        "subdir": "adapt_fwd",
    },
    {
        "key": "adapt_oracle",
        "label": "Oracle Tool + Raw Memory",
        "subdir": "adapt_oracle",
    },
]


def _resolve_setup_path(
    results_root: Path,
    run: str,
    domain: str,
    setup: dict,
    oracle_run: str | None = None,
) -> Path | None:
    if setup.get("subdir"):
        p = results_root / run / domain / setup["subdir"] / "report.json"
        return p if p.exists() else None
    # Oracle-style: prefer an external run (oracle_evolving_*).
    if oracle_run:
        p = results_root / oracle_run / domain / "report.json"
        if p.exists():
            return p
    for cand in setup.get("external_run_candidates", ()) or ():
        p = results_root / cand / domain / "report.json"
        if p.exists():
            return p
    # Fallback: also accept <run>/<domain>/oracle/report.json if it exists.
    p = results_root / run / domain / "oracle" / "report.json"
    return p if p.exists() else None


def _matrix_stats(matrix: list[list[Any]]) -> dict[str, Any]:
    """Compute Final Avg (mean over last-row non-null means), Fwd Avg
    (mean over diagonal non-null means), and per-stage Δ vs first-encounter
    (BWT-final per j = R[K,j] − R[j,j])."""
    K = len(matrix)
    if K == 0:
        return {"K": 0}

    # Diagonal values
    diag = []
    for i in range(K):
        c = matrix[i][i] if i < len(matrix[i]) else None
        if isinstance(c, dict) and c.get("mean") is not None:
            diag.append(_safe(c["mean"]))

    # Final-row values (the last available row's non-null cells)
    last_row = matrix[K - 1] if K else []
    final_vals = [
        _safe(c["mean"]) for c in last_row if isinstance(c, dict) and c.get("mean") is not None
    ]

    # Per-stage Δ
    per_stage_delta: list[dict] = []
    delta_means: list[float] = []
    for j in range(K - 1):
        cell_last = matrix[K - 1][j] if j < len(matrix[K - 1]) else None
        cell_first = matrix[j][j] if j < len(matrix[j]) else None
        if isinstance(cell_last, dict) and isinstance(cell_first, dict):
            a = cell_last.get("mean")
            b = cell_first.get("mean")
            if a is not None and b is not None:
                d = a - b
                per_stage_delta.append({"j": j, "delta": _safe(d)})
                delta_means.append(d)

    delta_final_avg = _safe(sum(delta_means) / len(delta_means)) if delta_means else None

    return {
        "K": K,
        "final_avg": _safe(sum(final_vals) / len(final_vals)) if final_vals else None,
        "fwd_avg": _safe(sum(diag) / len(diag)) if diag else None,
        "per_stage_delta": per_stage_delta,
        "delta_final_avg": delta_final_avg,
    }


def cl_summary(
    results_root: Path,
    run: str,
    *,
    oracle_run: str | None = None,
    domains: list[str] | None = None,
) -> dict[str, Any]:
    """Build a per-domain continual-learning summary for ``run``.

    For each domain, includes up to four setups:
        Oracle Tool, Cumulative Tool (No Memory), Cumulative Tool + Raw
        Memory, Oracle Tool + Raw Memory.

    Each setup ships the full results_matrix plus derived stats:
        ``final_avg`` (mean over last-row cells),
        ``fwd_avg`` (mean over diagonal cells),
        ``per_stage_delta`` (BWT-final per stage j = R[K,j] − R[j,j]),
        ``delta_final_avg`` (mean of those deltas).
    """
    run_dir = results_root / run
    if not run_dir.exists():
        raise FileNotFoundError(f"Run dir missing: {run_dir}")

    if domains is None:
        # Pick subdirectories of the run that look like a domain (have at least
        # one mode subdir with a report.json or a top-level report.json).
        candidate_domains = []
        for c in sorted(run_dir.iterdir()):
            if not c.is_dir():
                continue
            has_report = False
            for s in _CL_SETUPS_DEFAULT:
                sd = s.get("subdir")
                if sd and (c / sd / "report.json").exists():
                    has_report = True
                    break
            if has_report or (c / "report.json").exists():
                candidate_domains.append(c.name)
        domains = candidate_domains

    out_domains = []
    for dom in domains:
        rows = []
        for setup in _CL_SETUPS_DEFAULT:
            p = _resolve_setup_path(results_root, run, dom, setup, oracle_run=oracle_run)
            if p is None:
                rows.append(
                    {
                        "setup_key": setup["key"],
                        "setup_label": setup["label"],
                        "is_baseline": bool(setup.get("is_baseline")),
                        "available": False,
                    }
                )
                continue
            rep = _read_report_json(p)
            mat = rep.get("results_matrix", [])
            stats = _matrix_stats(mat)
            # Flatten cells to JSON-friendly (mean, std, n) with sanitized floats.
            clean_matrix = []
            for row in mat:
                clean_row = []
                for c in row:
                    if isinstance(c, dict):
                        clean_row.append({
                            "mean": _safe(c.get("mean")),
                            "std": _safe(c.get("std")),
                            "n": c.get("n"),
                        })
                    else:
                        clean_row.append(None)
                clean_matrix.append(clean_row)
            rows.append(
                {
                    "setup_key": setup["key"],
                    "setup_label": setup["label"],
                    "is_baseline": bool(setup.get("is_baseline")),
                    "available": True,
                    "report_path": str(p.relative_to(results_root)),
                    "num_stages": rep.get("num_stages", stats["K"]),
                    "results_matrix": clean_matrix,
                    **stats,
                }
            )

        # Compute Δ-of-Δ vs the no_memory baseline (if available) for narration.
        baseline_row = next((r for r in rows if r["setup_key"] == "no_memory" and r.get("available")), None)
        baseline_dfa = baseline_row["delta_final_avg"] if baseline_row else None
        for r in rows:
            if not r.get("available"):
                continue
            if r["setup_key"] == "no_memory":
                r["note"] = "baseline"
                r["delta_vs_baseline"] = None
                continue
            if r["setup_key"] == "oracle":
                r["note"] = "first-encounter only (no off-diagonal cells)"
                r["delta_vs_baseline"] = None
                continue
            if baseline_dfa is None or r.get("delta_final_avg") is None:
                r["note"] = None
                r["delta_vs_baseline"] = None
                continue
            dvs = r["delta_final_avg"] - baseline_dfa
            r["delta_vs_baseline"] = _safe(dvs)
            # Positive ⇒ less negative drift ⇒ less forgetting
            if dvs > 0.005:
                r["note"] = "less forgetting vs no_memory"
            elif dvs < -0.005:
                r["note"] = "more forgetting vs no_memory"
            else:
                r["note"] = "similar to no_memory"

        out_domains.append({"domain": dom, "setups": rows})

    return {
        "run": run,
        "oracle_run_used": next(
            (
                c
                for c in (oracle_run, *_CL_SETUPS_DEFAULT[0].get("external_run_candidates", ()))
                if c and (results_root / c).exists()
            ),
            None,
        ),
        "domains": out_domains,
        "setups": [
            {"key": s["key"], "label": s["label"], "is_baseline": bool(s.get("is_baseline"))}
            for s in _CL_SETUPS_DEFAULT
        ],
    }


# ---------------------------------------------------------------------------
# THE THREE KEY INSIGHTS — backed by accuracy/*.tsv (cheap, pre-computed).
# ---------------------------------------------------------------------------
def forgetting_summary(run_root: Path) -> dict[str, Any]:
    """Per-system per-domain forgetting (BWT-all and BWT-final).

    ``bwt_all   = mean_{k>j} [success(k,j) - success(j,j)]``
    ``bwt_final = mean_{k=K, j<K} [success(K,j) - success(j,j)]``

    Negative = forgetting on prior tasks. Includes an ``OVERALL`` row per mode.
    """
    p = _accuracy_dir(run_root) / "forgetting_summary.tsv"
    if not p.exists():
        # Fallback: derive from per_cell.
        return _derive_forgetting(run_root)
    df = _read_tsv(p)
    modes = df["mode"].drop_duplicates().tolist()
    domains = [d for d in df["domain"].drop_duplicates().tolist() if d != "OVERALL"]
    overall = _df_to_records(df[df["domain"] == "OVERALL"])
    per_dom = _df_to_records(df[df["domain"] != "OVERALL"])
    return {
        "source_tsv": str(p),
        "modes": modes,
        "domains": domains,
        "overall_by_mode": overall,
        "per_domain": per_dom,
    }


def memory_summary(run_root: Path) -> dict[str, Any]:
    """Return per-domain memory analytics derived from ``memory_summary.tsv``.

    Three panels (matching the existing ``memory_summary.png``):
      A · Memory composition — succeeded vs failed entries at final stage K.
      B · Tool-era mix in memory — share of tool references by catalog era
          (which V the tool was introduced in).
      C · Breadth of exposure per memory entry — total tool references /
          number of memory entries.

    Plus a per-domain ``per_stage_total`` series showing memory growth.
    """
    acc = _accuracy_dir(run_root)
    p = acc / "memory_summary.tsv"
    if not p.exists():
        raise FileNotFoundError(f"memory_summary.tsv missing under {acc}")
    df = _read_tsv(p)
    if df.empty:
        return {"systems": [], "domains": [], "panel_a": [], "panel_b": [], "panel_c": [], "overall": {}}

    # Parse comma-separated columns.
    def _parse_ints(s: str) -> list[int]:
        if not isinstance(s, str) or not s:
            return []
        out: list[int] = []
        for tok in s.split(","):
            tok = tok.strip()
            if not tok:
                continue
            try:
                out.append(int(tok))
            except ValueError:
                try:
                    out.append(int(float(tok)))
                except Exception:
                    pass
        return out

    df["era_counts_list"] = df["era_counts"].apply(_parse_ints)
    df["per_stage_total_list"] = df["per_stage_total"].apply(_parse_ints)

    systems = sorted(df["system"].dropna().unique().tolist())
    domains_in_order = (
        df["domain"].drop_duplicates().tolist()
    )
    n_eras_max = int(df["era_counts_list"].apply(len).max() or 1)

    # ---- Panel A: succeeded/failed at final stage K
    panel_a = []
    for dom in domains_in_order:
        for sys_ in systems:
            row = df[(df["domain"] == dom) & (df["system"] == sys_)]
            if row.empty:
                continue
            r = row.iloc[0]
            panel_a.append(
                {
                    "domain": dom,
                    "system": sys_,
                    "n_total": int(r["n_total"]) if pd.notna(r["n_total"]) else 0,
                    "n_succ": int(r["n_succ"]) if pd.notna(r["n_succ"]) else 0,
                    "n_fail": int(r["n_fail"]) if pd.notna(r["n_fail"]) else 0,
                    "K": int(r["K"]) if pd.notna(r["K"]) else None,
                }
            )

    # ---- Panel B: era-mix shares (fraction of total references per era)
    panel_b = []
    for dom in domains_in_order:
        for sys_ in systems:
            row = df[(df["domain"] == dom) & (df["system"] == sys_)]
            if row.empty:
                continue
            r = row.iloc[0]
            counts = list(r["era_counts_list"]) + [0] * (n_eras_max - len(r["era_counts_list"]))
            unk = int(r.get("era_unk") or 0)
            total = sum(counts) + unk
            shares = (
                [c / total for c in counts] if total > 0 else [0.0] * n_eras_max
            )
            unk_share = (unk / total) if total > 0 else 0.0
            panel_b.append(
                {
                    "domain": dom,
                    "system": sys_,
                    "era_counts": [int(c) for c in counts],
                    "era_shares": [_safe(s) for s in shares],
                    "era_unk": unk,
                    "era_unk_share": _safe(unk_share),
                    "total_refs": int(total),
                }
            )

    # ---- Panel C: avg refs per memory entry
    panel_c = []
    for dom in domains_in_order:
        for sys_ in systems:
            row = df[(df["domain"] == dom) & (df["system"] == sys_)]
            if row.empty:
                continue
            r = row.iloc[0]
            n_entries = int(r["n_total"]) if pd.notna(r["n_total"]) else 0
            total_refs = sum(r["era_counts_list"]) + int(r.get("era_unk") or 0)
            avg = total_refs / n_entries if n_entries > 0 else None
            panel_c.append(
                {
                    "domain": dom,
                    "system": sys_,
                    "total_refs": int(total_refs),
                    "n_entries": n_entries,
                    "avg_refs_per_entry": _safe(avg),
                }
            )

    # ---- Memory growth: per-stage cumulative entry counts
    growth = []
    for dom in domains_in_order:
        for sys_ in systems:
            row = df[(df["domain"] == dom) & (df["system"] == sys_)]
            if row.empty:
                continue
            r = row.iloc[0]
            growth.append(
                {
                    "domain": dom,
                    "system": sys_,
                    "per_stage_total": [int(x) for x in r["per_stage_total_list"]],
                }
            )

    # ---- Overall (sum across domains) per system
    overall = {}
    for sys_ in systems:
        rows = [d for d in panel_a if d["system"] == sys_]
        tot = sum(r["n_total"] for r in rows)
        succ = sum(r["n_succ"] for r in rows)
        fail = sum(r["n_fail"] for r in rows)
        # Era shares overall
        era_totals = [0] * n_eras_max
        unk_total = 0
        ref_total = 0
        for r in [d for d in panel_b if d["system"] == sys_]:
            for i, c in enumerate(r["era_counts"]):
                era_totals[i] += c
            unk_total += r["era_unk"]
            ref_total += r["total_refs"]
        era_shares = [c / ref_total for c in era_totals] if ref_total else [0.0] * n_eras_max
        # avg refs/entry overall
        avg_overall = ref_total / tot if tot else None
        overall[sys_] = {
            "n_total": tot,
            "n_succ": succ,
            "n_fail": fail,
            "succ_share": _safe(succ / tot if tot else None),
            "era_counts": era_totals,
            "era_shares": [_safe(s) for s in era_shares],
            "era_unk": unk_total,
            "avg_refs_per_entry": _safe(avg_overall),
            "total_refs": ref_total,
        }

    return {
        "systems": systems,
        "domains": domains_in_order,
        "n_eras": n_eras_max,
        "panel_a": panel_a,
        "panel_b": panel_b,
        "panel_c": panel_c,
        "growth": growth,
        "overall": overall,
    }


def _derive_forgetting(run_root: Path) -> dict[str, Any]:
    df = load_per_cell(str(run_root))
    feat = _feat_col(df, "success") or "success__mean"
    out_rows = []
    for m in df["mode"].unique():
        sub = df[df["mode"] == m]
        per_dom_all = []
        per_dom_fin = []
        for dom, mat in sub.groupby("domain"):
            mat = mat[["k", "j", feat]].dropna()
            if mat.empty:
                continue
            diag = {int(r["j"]): r[feat] for _, r in mat.iterrows() if r["k"] == r["j"]}
            K = int(mat["k"].max())
            xs_all = [
                r[feat] - diag.get(int(r["j"]), None)
                for _, r in mat.iterrows()
                if int(r["k"]) > int(r["j"]) and int(r["j"]) in diag
            ]
            xs_all = [x for x in xs_all if x is not None and math.isfinite(x)]
            xs_fin = [
                r[feat] - diag.get(int(r["j"]), None)
                for _, r in mat.iterrows()
                if int(r["k"]) == K and int(r["j"]) < K and int(r["j"]) in diag
            ]
            xs_fin = [x for x in xs_fin if x is not None and math.isfinite(x)]
            v_all = float(np.mean(xs_all)) if xs_all else None
            v_fin = float(np.mean(xs_fin)) if xs_fin else None
            out_rows.append(
                {"mode": m, "domain": dom, "n_all": len(xs_all), "bwt_all": v_all,
                 "n_final": len(xs_fin), "bwt_final": v_fin}
            )
            if v_all is not None:
                per_dom_all.append(v_all)
            if v_fin is not None:
                per_dom_fin.append(v_fin)
        out_rows.append(
            {
                "mode": m, "domain": "OVERALL",
                "n_all": len(per_dom_all),
                "bwt_all": float(np.mean(per_dom_all)) if per_dom_all else None,
                "n_final": len(per_dom_fin),
                "bwt_final": float(np.mean(per_dom_fin)) if per_dom_fin else None,
            }
        )
    odf = pd.DataFrame(out_rows)
    return {
        "source_tsv": None,
        "modes": sorted(odf["mode"].unique().tolist()),
        "domains": sorted([d for d in odf["domain"].unique() if d != "OVERALL"]),
        "overall_by_mode": _df_to_records(odf[odf["domain"] == "OVERALL"]),
        "per_domain": _df_to_records(odf[odf["domain"] != "OVERALL"]),
    }


def pair_deltas(run_root: Path) -> dict[str, Any]:
    """Pairwise system contrasts (tool selection / tool usage / total memory
    benefit) at FWD (k=j), BWT-all (j<k), BWT-final (k=K, j<K)."""
    p = _accuracy_dir(run_root) / "pair_deltas_success.tsv"
    if not p.exists():
        raise FileNotFoundError(f"pair_deltas_success.tsv missing under {run_root}")
    df = _read_tsv(p)
    pair_labels = {
        "oracle − no_memory": "Tool selection benefit",
        "adapt_oracle − oracle": "Tool usage benefit",
        "adapt_fwd − no_memory": "Total memory benefit",
    }
    pairs_present = df["pair"].drop_duplicates().tolist()
    return {
        "source_tsv": str(p),
        "pairs": [
            {"pair": p_, "label": pair_labels.get(p_, p_), "A": p_.split(" − ")[0], "B": p_.split(" − ")[-1]}
            for p_ in pairs_present
        ],
        "domains": [d for d in df["domain"].drop_duplicates().tolist() if d != "OVERALL"],
        "rows": _df_to_records(df),
    }


def token_cost(run_root: Path) -> dict[str, Any]:
    """Per (domain, mode, view) tokens and activity (turns, calls).

    Augmented with mean wall-time, reasoning-token, and cache-read-token
    aggregates per mode pulled from ``beyond_accuracy/{mode}__per_task.tsv``
    so we can tell the "adapt costs more wall time? or is cache absorbing
    it?" story.
    """
    p = _accuracy_dir(run_root) / "token_cost_summary.tsv"
    if not p.exists():
        raise FileNotFoundError(f"token_cost_summary.tsv missing under {run_root}")
    df = _read_tsv(p)

    # Per-mode mean wall_ms / cache_read / reasoning, averaged across every
    # (domain, k, j, task_id) row in the per-task TSV. We use a simple mean
    # so the OVERALL FWD callout can compare modes apples-to-apples.
    extra: dict[str, dict[str, float]] = {}
    ba_dir = run_root / "beyond_accuracy"
    modes = df["mode"].drop_duplicates().tolist()
    for mode in modes:
        ptask = ba_dir / f"{mode}__per_task.tsv"
        if not ptask.exists():
            continue
        try:
            pdf = _read_tsv(ptask)
        except Exception:
            continue
        rec: dict[str, float] = {}
        # FWD (k==j) is the "fresh encounter" baseline, easiest to compare.
        fwd = pdf[pdf["k"] == pdf["j"]]
        for col, key in [
            ("wall_ms__mean", "wall_ms"),
            ("cache_read_tokens__mean", "cache_read_tokens"),
            ("reasoning_tokens__mean", "reasoning_tokens"),
        ]:
            if col in fwd.columns and len(fwd):
                rec[key + "__fwd"] = _safe(float(fwd[col].mean()))
            if col in pdf.columns and len(pdf):
                rec[key + "__all"] = _safe(float(pdf[col].mean()))
        if rec:
            extra[mode] = rec

    return {
        "source_tsv": str(p),
        "modes": modes,
        "views": ["fwd", "bwt_all", "bwt_final"],
        "domains": [d for d in df["domain"].drop_duplicates().tolist() if d != "OVERALL"],
        "rows": _df_to_records(df),
        "extra_by_mode": extra,
    }


# ---------------------------------------------------------------------------
def catalog_confusion(
    run_root: Path, mode: str = "adapt_fwd", domain: str | None = None
) -> dict[str, Any]:
    """For each cell (k, j), report the four "where did calls go" rates:

    - ``gold_call_rate``        : fraction of calls hitting an oracle tool
    - ``older_distractor_rate`` : tools introduced in earlier stages but not
                                   in this oracle list
    - ``newer_adopt_rate``      : tools introduced in later stages
    - ``brand_new_rate``        : tools never seen in any stage manifest
    - ``hallucinated_rate``     : non-existent tool names

    Plotting these over k reveals whether failures come from *adopting*
    new-but-wrong tools (forward leakage) or *clinging* to old-but-now-wrong
    tools (backward leakage).
    """
    df = load_per_cell(str(run_root))
    df = df[df["mode"] == mode]
    if domain:
        df = df[df["domain"] == domain]

    cols = [
        ("gold_call_rate", _feat_col(df, "gold_call_rate")),
        ("older_distractor_rate", _feat_col(df, "older_distractor_rate")),
        ("newer_adopt_rate", _feat_col(df, "newer_adopt_rate")),
        ("brand_new_rate", _feat_col(df, "brand_new_rate")),
        ("hallucinated_rate", _feat_col(df, "hallucinated_rate")),
    ]
    cols = [(name, c) for name, c in cols if c]

    rows = []
    for (dom, k, j), sub in df.groupby(["domain", "k", "j"]):
        rec = {"domain": dom, "k": int(k), "j": int(j)}
        for name, c in cols:
            rec[name] = _safe(float(sub[c].mean()))
        rec["success"] = _safe(float(sub[_feat_col(df, "success")].mean()))
        rows.append(rec)

    rows.sort(key=lambda r: (r["domain"], r["k"], r["j"]))
    return {
        "mode": mode,
        "domain": domain,
        "feature_keys": [n for n, _ in cols],
        "rows": rows,
    }
