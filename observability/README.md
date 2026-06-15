# Evolve Observability

A lightweight inspector for the **EnterpriseOps-Gym evolving benchmark** and
its run results. Backend is FastAPI + the dataset/results filesystem; frontend
is a single-page app (vanilla HTML/CSS/JS, no build step).

## What it shows

There are four tabs: **Overview**, **Datasets**, **Results**, and **Insights**.
The first three are inspection views; **Insights** answers analytical questions
about capability drift.

### Insights (the analytics layer)

Backed by two precomputed artifact families:
* `<run>/accuracy/{forgetting_summary,pair_deltas_success,token_cost_summary}.tsv` — built by `evolve_poc/beyond_accuracy_plots.py`.
* `<run>/beyond_accuracy/*.tsv` — built by `evolve_poc/beyond_accuracy_report.py`.

The Insights tab is split into **Headline insights** (the three views you usually
want first) and **Diagnostic** drill-downs.

#### Headline insights

| View | Question it answers |
|---|---|
| **1. Forgetting per system** | Per-system per-domain Δ-success on prior tasks (BWT-all and BWT-final). Negative = forgetting. Diverging bar grid per system; OVERALL panel highlighted. Auto-narrates the no_memory → adapt_fwd → adapt_oracle progression. |
| **2. Pair deltas** | Three decomposed contrasts: **Tool selection benefit** (oracle − no_memory), **Tool usage benefit** (adapt_oracle − oracle), **Total memory benefit** (adapt_fwd − no_memory). Each shown for FWD / BWT-all / BWT-final. Tells you which component contributes where. |
| **3. Token cost & activity** | Per (domain, system, regime) input/output tokens and turns/calls. Switch regime tab to compare cost shapes under FWD vs BWT-all vs BWT-final. Auto-narrates the cost multiplier of adapt_fwd vs oracle. |

#### Diagnostic drill-downs

| Sub-view | Question it answers |
|---|---|
| **Drift: selection vs usage** | Under tool drift, does *which* tools get called change more than *how* they're called? Bucket bar shows mean \|z\| of feature deltas vs the oracle baseline at diagonal cells. |
| **Catalog confusion** | Per (domain, k, j) cell: gold / older / newer / brand-new / hallucinated call rates. Reveals whether failures come from *clinging to old tools* (older_distractor_rate↑) or *adopting new-but-wrong tools* (newer_adopt_rate↑). |
| **Trajectory across stages** | For fixed (domain, j), how does any feature evolve as adapt-stage k grows? Plots forgetting curves directly. |
| **What predicts success?** | Per-task Pearson r between every selection / usage / cost feature and `success__mean`. Bars colored by bucket. |
| **Mode comparison table** | oracle / no_memory / adapt_fwd side-by-side per (domain, k=j) cell with Δ-vs-oracle columns. |
| **Failure attribution** | For failed tasks, the per-feature mean diff (failed − succeeded) z-scored — tells you which signal best discriminates failure. |

#### Headline finding on the current `gpt5_evolve_evoving_tools` run

Computed via `bucket_attribution(mode="no_memory")`:

| Bucket | mean \|z\| of Δ vs oracle | top deviators |
|---|---|---|
| **selection** | **1.07** | `gold_call_rate` (-15pp, z=1.71), `tool_prec` (-23pp, z=1.58), `n_extra_tools` (+1.1, z=1.36), `older_distractor_rate` (+10pp, z=1.25), `tool_f1` (-16pp, z=1.24) |
| usage  | 0.26 | `give_up` (+10pp, z=0.81), `n_err_calls` (-0.04, z=0.43) |
| cost   | 0.33 | `input_tokens` (+62K, z=0.62) |

→ **selection deviates ≈4× more than usage**. Failures under capability drift
are dominated by *which* tools get called, not by sequence/parameter choices.
Top success-correlates per-task confirm this:

```
tool_rec       r=+0.34   (selection)
n_missed_tools r=-0.34   (selection)
tool_f1        r=+0.32   (selection)
tool_prec      r=+0.21   (selection)
give_up        r=-0.18   (usage)        ← first usage signal, much weaker
plan_len_ratio r=+0.12   (usage)
```

### Datasets

1. **Datasets** — browse `evovle_benchmark_breath` and `evovle_benchmark_depth`:
   - Per-domain stage layout (V1..VK), tool counts, adapt/test split, schedule.
   - Task list (oracle configs or `configs_at_assigned_stage`), filterable by
     stage and task id.
   - Per-task detail: user prompt, selected/restricted tools, verifiers (with
     SQL queries and expected values), gym servers, and the full system prompt
     and raw config (collapsible).

2. **Results** — generic browser over `evolve_results/`:
   - Auto-renders the **continual learning matrix** (mean ± std) when a
     directory contains `report.json`.
   - Renders **metrics tiles** and per-task pass/fail tables from
     `metrics.json`.
   - Surfaces `report.txt`, `report.tsv`, `matrix.tsv`, `env_summary.json`
     when present.
   - Click any task `.json` (e.g. `v1__task_*.json`) to render the full
     **chat trajectory** with system prompt, user message, AI tool-calls,
     tool results (parsed from the inner `content` array), final response,
     and a verifier-by-verifier pass/fail table.

## Run it

```bash
cd observability
pip install -r requirements.txt   # fastapi + uvicorn
./run.sh                          # serves on http://0.0.0.0:8765
```

Open http://localhost:8765 (or your remote host:port) in a browser.

### Custom paths

By default the server reads the sibling `../evolve_tools/` tree:

| Knob | Default |
|------|---------|
| `EVOLVE_DATASET_BREATH_DIR` | `../evolve_tools/benchmark_breath` |
| `EVOLVE_DATASET_DEPTH_DIR`  | `../evolve_tools/benchmark_depth`  |
| `EVOLVE_RESULTS_DIR`        | `../evolve_tools/results`          |

Override any of them on the command line:

```bash
EVOLVE_DATASET_BREATH_DIR=/path/to/breath \
EVOLVE_DATASET_DEPTH_DIR=/path/to/depth   \
EVOLVE_RESULTS_DIR=/path/to/results       \
PORT=9000 ./run.sh
```

### Hot reload during development

```bash
RELOAD=1 ./run.sh
```

## Layout

```
observability/
├── backend/app.py        # FastAPI server (APIs + static mount)
├── frontend/
│   ├── index.html        # 3-tab SPA shell
│   ├── styles.css
│   └── app.js
├── run.sh
├── requirements.txt
└── README.md
```

## API summary

All endpoints return JSON.

### Datasets

- `GET /api/config` — discovered paths and top-level entries.
- `GET /api/datasets/{breath|depth}` — list domains.
- `GET /api/datasets/{benchmark}/{domain}/summary` — stage layout, counts.
- `GET /api/datasets/{benchmark}/{domain}/manifest` — full manifest.json.
- `GET /api/datasets/{benchmark}/{domain}/tasks?kind=oracle|stage&stage=N`
  — list task configs (with stage badges).
- `GET /api/datasets/{benchmark}/{domain}/tasks/{kind}/{filename}` — task config.

### Results

- `GET /api/results/runs` — top-level runs in `evolve_results/`.
- `GET /api/results/tree?path=...` — directory listing under results.
- `GET /api/results/file?path=...` — file contents (json parsed, text returned as-is).
- `GET /api/results/run_summary?path=...` — bundle of `report.json`,
  `metrics.json`, `report.txt`, `matrix.tsv`, etc. for a results sub-directory.

### Insights (analytics)

Headline (backed by `<run>/accuracy/*.tsv`):

- `GET /api/insights/{run}/forgetting_summary` — per-system per-domain BWT-all / BWT-final.
- `GET /api/insights/{run}/pair_deltas` — three pairwise contrasts × FWD/BWT-all/BWT-final.
- `GET /api/insights/{run}/token_cost` — per (domain, mode, regime) tokens & activity.

Diagnostic (backed by `<run>/beyond_accuracy/*.tsv`):

- `GET /api/insights/runs` — runs that have either `accuracy/` or `beyond_accuracy/` populated.
- `GET /api/insights/{run}/overview` — modes, domains, k/j ranges, top-line per mode.
- `GET /api/insights/{run}/mode_comparison?domain=&only_diagonal=` — wide table with all modes side-by-side and Δ-vs-oracle columns.
- `GET /api/insights/{run}/decomposition?mode=&domain=` — full per-feature Δ vs oracle, ranked by \|Δ\|.
- `GET /api/insights/{run}/bucket_attribution?mode=&domain=` — selection vs usage vs cost, mean \|z\| of Δ.
- `GET /api/insights/{run}/trajectory?mode=&domain=&feature=` — per (domain, j) curve over k.
- `GET /api/insights/{run}/feature_correlation?mode=&target=success&domain=` — per-task Pearson correlations.
- `GET /api/insights/{run}/catalog_confusion?mode=&domain=` — gold/older/newer/brand-new/hallucinated rates per cell.
- `GET /api/insights/{run}/task_failures?mode=&domain=&top_n=` — failure attribution + worst-task list.

## Notes on the data shape

The frontend recognizes three kinds of result JSON automatically:

| Detected when… | Renderer |
|---|---|
| `runs[0].conversation_flow` exists | Trajectory viewer (chat + verifiers) |
| `results_matrix` present | Continual-learning matrix |
| Keys all match `^\d+,\d+$` | Per-cell metrics tiles + per-task tables |
| Otherwise | Pretty-printed JSON |
