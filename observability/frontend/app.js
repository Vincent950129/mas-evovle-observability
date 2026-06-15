// Evolve Observability — single-page frontend.
//
// Plain JS, no build step, no external deps. Everything is fetched from the
// FastAPI backend at /api/...

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[m]));
}

function fmtBytes(n) {
  if (n == null || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtPct(x, digits = 1) {
  if (x == null) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " error" : "");
  setTimeout(() => t.classList.remove("show"), 3500);
}

// ---------------------------------------------------------------------------
// Mode naming — the four systems form a 2×2 design across two axes:
//   • Tool catalog:  Oracle tools (Tᵢ — only the ground-truth set)  vs
//                    Cumulative tools (Cₖ — every tool available at this stage)
//   • Memory:        no memory  vs  + raw memory of past experiences
// We expose a single label map and a few helpers so every chart, legend and
// callout uses the same 2×2 language instead of the raw mode IDs.
const MODE_LABELS = {
  oracle:       { full: "Oracle tools, no memory",       short: "Oracle / -mem",  tool: "Oracle",     mem: "no memory",    toolCode: "O", memCode: "−" },
  no_memory:    { full: "Cumulative tools, no memory",   short: "Cumul. / -mem",  tool: "Cumulative", mem: "no memory",    toolCode: "C", memCode: "−" },
  adapt_oracle: { full: "Oracle tools + raw memory",     short: "Oracle / +mem",  tool: "Oracle",     mem: "+ raw memory", toolCode: "O", memCode: "+" },
  adapt_fwd:    { full: "Cumulative tools + raw memory", short: "Cumul. / +mem",  tool: "Cumulative", mem: "+ raw memory", toolCode: "C", memCode: "+" },
};
function modeLabel(mode, form = "full") {
  const e = MODE_LABELS[mode];
  if (!e) return mode || "?";
  return e[form] ?? e.full;
}
function modeTag(mode) {
  const e = MODE_LABELS[mode];
  if (!e) return mode || "?";
  return `${e.toolCode}/${e.memCode}`;
}
function _humanizeModeName(s) {
  // Last-resort: best effort for ad-hoc names that aren't in the map.
  return String(s || "").replace(/_/g, " ");
}

// 2×2 legend card — renders the four systems as a small grid so the reader
// can see at a glance what differs between them (tool catalog × memory).
// Used at the top of every Insights headline view.
function buildSystemsLegend(activeModes) {
  const present = new Set(Array.isArray(activeModes) && activeModes.length ? activeModes : Object.keys(MODE_LABELS));
  const cell = (mode) => {
    const e = MODE_LABELS[mode];
    if (!e) return null;
    const dim = !present.has(mode);
    return el(
      "div",
      { class: "sys-cell" + (dim ? " dim" : ""), title: e.full },
      [
        el("div", { class: "tag" }, modeTag(mode)),
        el("div", { class: "name" }, e.full),
      ]
    );
  };
  return el("div", { class: "sys-legend card" }, [
    el("div", { class: "sys-legend-head" }, [
      el("strong", {}, "The four systems"),
      el(
        "span",
        { class: "muted small" },
        " — a 2×2 design across two axes. Tag = ",
        el("code", {}, "tool / memory"),
        " (O = Oracle tools Tᵢ · C = Cumulative tools Cₖ · − = no memory · + = raw memory)."
      ),
    ]),
    el("div", { class: "sys-legend-grid" }, [
      el("div", { class: "sys-legend-row" }, [
        el("div", { class: "sys-legend-axis" }, [
          el("span", { class: "muted small" }, "Oracle tools (Tᵢ)"),
        ]),
        cell("oracle"),
        cell("adapt_oracle"),
      ]),
      el("div", { class: "sys-legend-row" }, [
        el("div", { class: "sys-legend-axis" }, [
          el("span", { class: "muted small" }, "Cumulative tools (Cₖ)"),
        ]),
        cell("no_memory"),
        cell("adapt_fwd"),
      ]),
      el("div", { class: "sys-legend-row sys-legend-foot" }, [
        el("div", {}, ""),
        el("div", { class: "muted small", style: "text-align:center;" }, "no memory"),
        el("div", { class: "muted small", style: "text-align:center;" }, "+ raw memory"),
      ]),
    ]),
  ]);
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let detail;
    try {
      detail = (await r.json()).detail;
    } catch {
      detail = await r.text();
    }
    throw new Error(`${r.status} ${detail}`);
  }
  return r.json();
}

// ---------------------------------------------------------------------------
// Tabs + URL routing
// ---------------------------------------------------------------------------
// The SPA has two URL spaces:
//   * `/`         — the root landing (Tools / Skills / Agents cards).
//   * `/tools/*`  — the tool-observability views (Overview, Benchmark,
//                   Results, Insights).
// Each section is bookmarkable, shows up in the browser history, and
// survives a refresh; the backend serves index.html for any of these
// paths so direct navigation and refreshes work too.
const TAB_TO_PATH = {
  landing: "/",
  home: "/tools/overview",
  datasets: "/tools/benchmark",
  results: "/tools/results",
  insights: "/tools/insights",
};
const PATH_TO_TAB = (() => {
  const m = {};
  Object.entries(TAB_TO_PATH).forEach(([k, v]) => { m[v] = k; });
  m["/tools"] = "home";
  return m;
})();

// Which tabs belong to which URL space, used to show/hide the per-space
// nav in the header.
const TOOLS_TABS = new Set(["home", "datasets", "results", "insights"]);

function tabFromLocation() {
  // Strip a trailing slash (except for the root) so /tools/insights/ also matches.
  const p = (window.location.pathname || "/").replace(/\/+$/, "") || "/";
  return PATH_TO_TAB[p] || "landing";
}

// The feedback U-loop on the landing diagram is positioned via two CSS
// custom properties (--loop-left, --loop-right). They need to track the
// actual screen position of the `Lead agent` and `Environment` columns
// in the flex row, which depend on viewport width because the row is
// centered (`justify-content: center`). We measure once after layout
// settles, on resize, and whenever the landing view becomes visible.
function alignFeedbackLoop() {
  const fb   = document.querySelector("#landing .cd-feedback");
  const lead = document.querySelector("#landing .cd-lead");
  const env  = document.querySelector("#landing .cd-env");
  if (!fb || !lead || !env) return;
  const fbR = fb.getBoundingClientRect();
  if (fbR.width < 50) return;          // hidden / not laid out yet
  const leadR = lead.getBoundingClientRect();
  const envR  = env.getBoundingClientRect();
  const leftPct  = ((leadR.left + leadR.width / 2) - fbR.left) / fbR.width * 100;
  const rightPct = (fbR.right - (envR.left + envR.width / 2)) / fbR.width * 100;
  fb.style.setProperty("--loop-left",  leftPct.toFixed(2)  + "%");
  fb.style.setProperty("--loop-right", rightPct.toFixed(2) + "%");
}
window.addEventListener("resize", alignFeedbackLoop);

function showTab(name, opts) {
  opts = opts || {};
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === name));
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));

  // Hide the tools nav on the root landing; show it for any /tools/* view.
  const tabs = document.getElementById("tabs");
  if (tabs) tabs.classList.toggle("tabs-hidden", name === "landing");
  // Also flag the body so we can swap the topbar background, etc.
  document.body.classList.toggle("at-landing", name === "landing");

  // Re-align the diagram feedback loop whenever the landing view becomes
  // visible — the elements report 0-width while hidden so a fresh
  // measurement is needed each time.
  if (name === "landing") {
    requestAnimationFrame(alignFeedbackLoop);
    setTimeout(alignFeedbackLoop, 120);
  }

  // The Home (Overview) view inside /tools is lazy-loaded the first time
  // a user actually opens it, so we don't pay for its 4 insight fetches
  // when the root landing is what they wanted.
  if (TOOLS_TABS.has(name) && !state.home.loaded) {
    state.home.loaded = true;
    loadHome();
  }
  if (name === "datasets" && !state.ds.loaded) {
    state.ds.loaded = true;
    onBenchmarkChange();
  }
  if (name === "results" && !state.rs.loaded) {
    state.rs.loaded = true;
    if (state.rs.mode === "summary") initCLSummary();
    else loadResults("");
  }
  if (name === "insights" && !state.ins.loaded) {
    state.ins.loaded = true;
    initInsights();
  }

  // Update the URL when this is a real navigation (not the popstate
  // handler re-asserting state, and not the initial load).
  if (!opts.skipPushState) {
    const target = TAB_TO_PATH[name] || "/";
    const current = (window.location.pathname || "/").replace(/\/+$/, "") || "/";
    if (current !== target) {
      window.history.pushState({ tab: name }, "", target);
    }
  }
}

window.addEventListener("popstate", () => {
  showTab(tabFromLocation(), { skipPushState: true });
});

document.addEventListener("click", (e) => {
  // Landing cards / topbar brand button both use data-tab.
  const tabTrigger = e.target.closest("[data-tab]");
  if (tabTrigger && tabTrigger.dataset.tab) {
    // Skip disabled (TODO) landing cards.
    if (tabTrigger.classList.contains("landing-card--todo")) return;
    showTab(tabTrigger.dataset.tab);
    return;
  }
  const goto = e.target.closest("[data-goto]");
  if (goto) {
    showTab(goto.dataset.goto);
    // Allow a "see full chart" link to deep-link into a specific Insights view.
    const insView = goto.dataset.insView;
    if (insView && goto.dataset.goto === "insights") {
      const trySwitch = () => {
        const sel = document.getElementById("ins-view");
        if (sel) {
          sel.value = insView;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };
      // initInsights() runs async on first visit; retry briefly until the picker exists.
      trySwitch();
      setTimeout(trySwitch, 60);
      setTimeout(trySwitch, 250);
      setTimeout(trySwitch, 700);
    }
  }
});

// ---------------------------------------------------------------------------
// Home — claim → proof → caveat → feasibility, in that order.
//   1. Headline takeaway.
//   2. Proof strip:  two decisive comparisons that directly establish the
//      claim, inline under the headline.
//   3. Logic chain:  narrow memory forgets more  →  broad memory yields the
//      largest gain  →  cost stays in budget.
//   4. Primary evidence (forgetting + pair deltas) — the direct support.
//   5. Supporting + feasibility (memory composition with caveat + cost).
//   6. 2×2 systems legend.
//   7. Tab navigation.
// ---------------------------------------------------------------------------
async function loadHome() {
  const root = $("#home-summary");
  root.innerHTML = "";

  // Headline + placeholder slots, so the page renders meaningfully even
  // before the four endpoints come back.
  root.appendChild(buildHomeHeadline());
  const proofSlot = el("div", { id: "home-proof" }, [el("div", { class: "muted small" }, "Loading proof strip…")]);
  root.appendChild(proofSlot);
  const logicSlot = el("div", { id: "home-logic" });
  root.appendChild(logicSlot);

  const snapshotSlot = el("div", { id: "home-snapshot" }, [el("div", { class: "muted small" }, "Loading snapshot…")]);
  root.appendChild(snapshotSlot);

  root.appendChild(buildHomeSystems());
  root.appendChild(buildHomeNav());

  try {
    const runs = (await fetchJson("/api/insights/runs"))?.runs || [];
    if (!runs.length) {
      proofSlot.innerHTML = "";
      proofSlot.appendChild(el("div", { class: "empty" }, "No analysed run found — open the Insights tab to set one up."));
      snapshotSlot.innerHTML = "";
      return;
    }
    const run = runs[0].name;

    const [forget, pairs, mem, cost] = await Promise.allSettled([
      fetchJson(`/api/insights/${run}/forgetting_summary`),
      fetchJson(`/api/insights/${run}/pair_deltas`),
      fetchJson(`/api/insights/${run}/memory_summary`),
      fetchJson(`/api/insights/${run}/token_cost`),
    ]);
    const F = forget.status === "fulfilled" ? forget.value : null;
    const P = pairs.status === "fulfilled" ? pairs.value : null;
    const M = mem.status === "fulfilled" ? mem.value : null;
    const C = cost.status === "fulfilled" ? cost.value : null;

    proofSlot.replaceWith(buildHomeProofStrip(F, P, run));
    logicSlot.appendChild(buildHomeLogicChain());

    snapshotSlot.replaceWith(buildHomeSnapshot(F, P, M, C, run));
  } catch (e) {
    proofSlot.innerHTML = "";
    proofSlot.appendChild(el("div", { class: "empty" }, `Could not load evidence: ${e}`));
    snapshotSlot.innerHTML = "";
  }
}

// ---------- Proof strip: the two decisive comparisons ----------
function buildHomeProofStrip(F, P, run) {
  const strip = el("div", { id: "home-proof", class: "home-proof-strip" });
  strip.appendChild(
    el("div", { class: "home-proof-head" }, [
      el("span", { class: "home-proof-eyebrow" }, "Why we believe this"),
      el("span", { class: "muted small" }, `Run · ${run}`),
    ])
  );

  const cards = el("div", { class: "home-proof-cards" });

  // Block 1 (Claim B): narrow ground-truth memory forgets more.
  const byMode = new Map((F?.overall_by_mode || []).map((r) => [r.mode, r]));
  const ao = byMode.get("adapt_oracle"), af = byMode.get("adapt_fwd");
  const aoBwt = ao ? (ao.bwt_final || 0) * 100 : null;
  const afBwt = af ? (af.bwt_final || 0) * 100 : null;
  const bwtGap = aoBwt != null && afBwt != null ? Math.abs(aoBwt) - Math.abs(afBwt) : null;
  cards.appendChild(
    el("div", { class: "home-proof-card" }, [
      el("div", { class: "home-proof-tag" }, "Claim B · narrow-memory forgets more"),
      el("div", { class: "home-proof-row" }, [
        el("span", { class: "k" }, modeLabel("adapt_oracle")),
        el("span", { class: "v neg" }, aoBwt != null ? signed(aoBwt, 1) + " pp" : "—"),
      ]),
      el("div", { class: "home-proof-row" }, [
        el("span", { class: "k" }, modeLabel("adapt_fwd")),
        el("span", { class: "v neg" }, afBwt != null ? signed(afBwt, 1) + " pp" : "—"),
      ]),
      el(
        "div",
        { class: "home-proof-foot" },
        bwtGap != null
          ? [el("strong", {}, `${signed(bwtGap, 1)} pp`), " more forgetting when memory is built on the oracle-only catalog."]
          : "OVERALL BWT-final per system."
      ),
    ])
  );

  // Block 2 (Claim A): broad-memory benefit dwarfs tool-selection benefit.
  const overall = (P?.rows || []).filter((r) => r.domain === "OVERALL");
  const sel = overall.find((r) => r.pair === "oracle − no_memory");
  const memPair = overall.find((r) => r.pair === "adapt_fwd − no_memory");
  const sFwd = sel ? (sel.fwd || 0) * 100 : null;
  const mFwd = memPair ? (memPair.fwd || 0) * 100 : null;
  const ratio = sFwd != null && Math.abs(sFwd) > 1e-6 && mFwd != null ? mFwd / sFwd : null;
  cards.appendChild(
    el("div", { class: "home-proof-card" }, [
      el("div", { class: "home-proof-tag" }, "Claim A · broad memory yields the largest gain"),
      el("div", { class: "home-proof-row" }, [
        el("span", { class: "k" }, "Tool-selection benefit"),
        el("span", { class: "v" }, sFwd != null ? signed(sFwd, 1) + " pp" : "—"),
      ]),
      el("div", { class: "home-proof-row" }, [
        el("span", { class: "k" }, "Broad-memory benefit"),
        el("span", { class: "v pos" }, mFwd != null ? signed(mFwd, 1) + " pp" : "—"),
      ]),
      el(
        "div",
        { class: "home-proof-foot" },
        ratio != null && Number.isFinite(ratio)
          ? [
              el("strong", {}, `${ratio >= 0 ? "+" : ""}${ratio.toFixed(1)}×`),
              " the FWD gain of pre-picking the oracle subset.",
            ]
          : "OVERALL FWD pair deltas."
      ),
    ])
  );

  strip.appendChild(cards);
  return strip;
}

// ---------- One snapshot figure across all 4 insights --------------------
// Four mini-panels in a single SVG. Each panel surfaces the OVERALL signal
// from one of the four headline insights — no per-domain detail, no
// per-time-step breakdown. The four together tell the same story the proof
// strip stated in text, in one glanceable picture.
function buildHomeSnapshot(F, P, M, C, run) {
  const wrap = el("div", { class: "home-snap card", id: "home-snapshot" });
  wrap.appendChild(
    el("div", { class: "home-section-head" }, [
      el("h3", {}, "Snapshot · the 4 insights in one figure"),
      el("span", { class: "muted small" }, `Run · ${run} · OVERALL`),
    ])
  );

  const W = 1040, H = 360;
  const padOuter = 14;
  const panelGap = 16;
  const panelW = (W - 2 * padOuter - panelGap) / 2;
  const panelH = (H - 2 * padOuter - panelGap) / 2;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "home-snap-svg");
  svg.style.width = "100%";
  svg.style.height = "auto";

  // 2×2 panel layout
  const panels = [
    { x: padOuter,                    y: padOuter,                    w: panelW, h: panelH, draw: drawSnapForget,  data: F },
    { x: padOuter + panelW + panelGap, y: padOuter,                   w: panelW, h: panelH, draw: drawSnapPairs,   data: P },
    { x: padOuter,                    y: padOuter + panelH + panelGap, w: panelW, h: panelH, draw: drawSnapMemory,  data: M },
    { x: padOuter + panelW + panelGap, y: padOuter + panelH + panelGap, w: panelW, h: panelH, draw: drawSnapCost,   data: C },
  ];
  panels.forEach((p) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `translate(${p.x}, ${p.y})`);
    // Subtle panel background
    g.appendChild(svgRect(0, 0, p.w, p.h, "#ffffff", "#e2e8f0", 8));
    p.draw(g, p.w, p.h, p.data);
    svg.appendChild(g);
  });

  wrap.appendChild(svg);
  wrap.appendChild(
    el(
      "div",
      { class: "muted small home-snap-cap" },
      "Read top-left → top-right → bottom-left → bottom-right: narrow-memory forgets more · broad-memory is the largest pair gain · broader memory entries cite more distinct tools · all costs stay inside the 400k context."
    )
  );

  // Deep-link to each full chart from the panel title.
  wrap.appendChild(
    el("div", { class: "home-snap-links" }, [
      el("button", { class: "link-btn", "data-goto": "insights", "data-ins-view": "key_forgetting" },  "Full · forgetting →"),
      el("button", { class: "link-btn", "data-goto": "insights", "data-ins-view": "key_pair_deltas" }, "Full · pair deltas →"),
      el("button", { class: "link-btn", "data-goto": "insights", "data-ins-view": "key_memory" },      "Full · memory →"),
      el("button", { class: "link-btn", "data-goto": "insights", "data-ins-view": "key_token_cost" },  "Full · token cost →"),
    ])
  );

  return wrap;
}

// Compact horizontal-bar mini-chart helper used by every snapshot panel.
// items: array of { label, value, signed?, color, suffix?, badge? }.
// pad: top reserved for title + footnote.
function drawSnapBars(g, w, h, title, subtitle, items, opts) {
  opts = opts || {};
  const padL = 12, padR = 12, padT = 38, padB = 28;
  const barH = Math.min(18, Math.max(10, (h - padT - padB) / Math.max(1, items.length) - 6));
  const rowGap = 6;

  g.appendChild(svgText(padL, 18, title, "#0f172a", "start", 13, 700));
  if (subtitle) g.appendChild(svgText(padL, 32, subtitle, "#64748b", "start", 10.5, 500));

  if (!items.length) {
    g.appendChild(svgText(w / 2, h / 2, "no data", "#64748b", "middle", 11));
    return;
  }

  // axis range from values (with optional clamping to be friendly)
  const vals = items.map((it) => it.value || 0);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const range = Math.max(1e-9, Math.max(Math.abs(minV), Math.abs(maxV)));
  const labelW = opts.labelW || 130;
  const numW = opts.numW || 60;
  const chartL = padL + labelW + 4;
  const chartR = w - padR - numW;
  const zeroX = minV < 0 && maxV > 0
    ? chartL + ((-minV) / (maxV - minV)) * (chartR - chartL)
    : (minV < 0 ? chartR : chartL);

  // zero/baseline
  g.appendChild(svgLine(zeroX, padT, zeroX, h - padB, "#cbd5e1"));

  items.forEach((it, i) => {
    const y = padT + i * (barH + rowGap);
    // Row label
    g.appendChild(svgText(padL, y + barH * 0.72, it.label, "#334155", "start", 11.5, 600));

    const v = it.value;
    if (v == null || !isFinite(v)) {
      g.appendChild(svgText(chartR + 6, y + barH * 0.72, "—", "#64748b", "start", 11));
      return;
    }
    const isNeg = v < 0;
    const span = Math.abs(v) / range;
    const barW_ = span * (isNeg ? (zeroX - chartL) : (chartR - zeroX));
    const bx = isNeg ? zeroX - barW_ : zeroX;
    const fill = it.color || (isNeg ? "#dc2626" : "#2563eb");
    g.appendChild(svgRect(bx, y, Math.max(1, barW_), barH, fill, "none", 3));
    if (it.best) {
      // small ring on the best-in-panel bar
      const ring = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      ring.setAttribute("x", bx - 1); ring.setAttribute("y", y - 1);
      ring.setAttribute("width", Math.max(1, barW_) + 2); ring.setAttribute("height", barH + 2);
      ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "#16a34a");
      ring.setAttribute("stroke-width", 1.6); ring.setAttribute("rx", 4);
      g.appendChild(ring);
    }
    // Value text on the side away from the bar
    const valStr = it.fmt ? it.fmt(v) : (it.signed ? signed(v, 1) : num(v, 1)) + (it.suffix || "");
    const tx = isNeg ? bx - 4 : (bx + barW_ + 4);
    g.appendChild(svgText(tx, y + barH * 0.72, valStr, "#0f172a", isNeg ? "end" : "start", 11.5, 700));
  });

  if (opts.foot) {
    g.appendChild(svgText(padL, h - 8, opts.foot, "#64748b", "start", 10.5, 500));
  }
}

function drawSnapForget(g, w, h, F) {
  if (!F?.overall_by_mode?.length) {
    g.appendChild(svgText(w / 2, h / 2, "no data", "#64748b", "middle", 11));
    return;
  }
  // Order: most-forgetting first; pin oracle to top (it's the no-memory ground-truth).
  const order = ["adapt_oracle", "adapt_fwd", "no_memory", "oracle"];
  const byMode = new Map(F.overall_by_mode.map((r) => [r.mode, r]));
  const items = order
    .filter((m) => byMode.has(m))
    .map((m) => {
      const v = (byMode.get(m).bwt_final || 0) * 100;
      return { label: modeLabel(m, "short"), value: v, signed: true, suffix: " pp", color: v < 0 ? "#dc2626" : "#16a34a" };
    });
  // Mark the cell with smallest magnitude as best (less forgetting = better).
  if (items.length) {
    let bestIdx = 0, bestMag = Infinity;
    items.forEach((it, i) => { const m = Math.abs(it.value); if (m < bestMag) { bestMag = m; bestIdx = i; } });
    items[bestIdx].best = true;
  }
  drawSnapBars(g, w, h, "1 · Forgetting (BWT-final)", "Negative = past tasks regressed by time step K. Smaller |·| is better.", items, {
    foot: "Narrow-catalog memory forgets the most.",
  });
}

function drawSnapPairs(g, w, h, P) {
  if (!P?.rows?.length) {
    g.appendChild(svgText(w / 2, h / 2, "no data", "#64748b", "middle", 11));
    return;
  }
  const overall = P.rows.filter((r) => r.domain === "OVERALL");
  const pick = (pair) => {
    const r = overall.find((x) => x.pair === pair);
    return r ? (r.fwd || 0) * 100 : null;
  };
  const items = [
    { label: "Broad memory",   value: pick("adapt_fwd − no_memory"),   signed: true, suffix: " pp", color: "#2563eb" },
    { label: "Tool usage",     value: pick("adapt_oracle − oracle"),   signed: true, suffix: " pp", color: "#6366f1" },
    { label: "Tool selection", value: pick("oracle − no_memory"),       signed: true, suffix: " pp", color: "#94a3b8" },
  ];
  // Best = largest positive value
  let bestIdx = -1, bestV = -Infinity;
  items.forEach((it, i) => { if (it.value != null && it.value > bestV) { bestV = it.value; bestIdx = i; } });
  if (bestIdx >= 0) items[bestIdx].best = true;
  drawSnapBars(g, w, h, "2 · What each component buys you", "FWD pair deltas. Bigger positive = better.", items, {
    foot: "Broad memory > tool usage > tool selection.",
  });
}

function drawSnapMemory(g, w, h, M) {
  if (!M?.overall) {
    g.appendChild(svgText(w / 2, h / 2, "no data", "#64748b", "middle", 11));
    return;
  }
  const order = ["adapt_fwd", "adapt_oracle"];
  const items = order
    .filter((m) => M.overall[m])
    .map((m) => ({
      label: modeLabel(m, "short"),
      value: M.overall[m].avg_refs_per_entry || 0,
      suffix: "",
      color: m === "adapt_fwd" ? "#2563eb" : "#6366f1",
    }));
  let bestIdx = -1, bestV = -Infinity;
  items.forEach((it, i) => { if (it.value > bestV) { bestV = it.value; bestIdx = i; } });
  if (bestIdx >= 0) items[bestIdx].best = true;
  drawSnapBars(g, w, h, "3 · Memory breadth", "Avg distinct tool refs per stored entry. Bigger = broader exposure.", items, {
    foot: "Cumulative-catalog memory cites more distinct tools per entry.",
  });
}

function drawSnapCost(g, w, h, C) {
  if (!C?.rows?.length) {
    g.appendChild(svgText(w / 2, h / 2, "no data", "#64748b", "middle", 11));
    return;
  }
  const overallFwd = C.rows.filter((r) => r.domain === "OVERALL" && r.view === "fwd");
  const order = ["adapt_fwd", "adapt_oracle", "no_memory", "oracle"];
  const byMode = new Map(overallFwd.map((r) => [r.mode, r]));
  const items = order
    .filter((m) => byMode.has(m))
    .map((m) => ({
      label: modeLabel(m, "short"),
      value: (byMode.get(m).input_tokens || 0) / 1000,
      fmt: (v) => `${v.toFixed(0)}k`,
      color: m === "adapt_fwd" ? "#2563eb" : (m === "adapt_oracle" ? "#6366f1" : "#94a3b8"),
    }));
  // Best = smallest cost.
  let bestIdx = -1, bestV = Infinity;
  items.forEach((it, i) => { if (it.value < bestV) { bestV = it.value; bestIdx = i; } });
  if (bestIdx >= 0) items[bestIdx].best = true;
  drawSnapBars(g, w, h, "4 · Input-token cost", "FWD avg input tokens per attempt. 400k = model context budget.", items, {
    foot: "All systems stay well below the 400k context limit.",
  });
}

// ---------- Logic chain ----------
function buildHomeLogicChain() {
  return el("div", { class: "home-logic-chain" }, [
    el("div", { class: "home-logic-step" }, [
      el("span", { class: "n" }, "1"),
      el("span", {}, [el("strong", {}, "Narrow memory forgets more"), " (insight 1)"]),
    ]),
    el("div", { class: "home-logic-arrow" }, "→"),
    el("div", { class: "home-logic-step" }, [
      el("span", { class: "n" }, "2"),
      el("span", {}, [el("strong", {}, "Broad memory yields the largest gain"), " (insight 2)"]),
    ]),
    el("div", { class: "home-logic-arrow" }, "→"),
    el("div", { class: "home-logic-step" }, [
      el("span", { class: "n" }, "3"),
      el("span", {}, [el("strong", {}, "Cost stays inside the 400k budget"), " (insight 4)"]),
    ]),
  ]);
}

function buildHomeHeadline() {
  return el("div", { class: "home-headline" }, [
    el("div", { class: "home-headline-eyebrow" }, "Key takeaway from this exploration"),
    el(
      "div",
      { class: "home-headline-quote" },
      [
        "Memory should cover a ",
        el("strong", {}, "broad and diverse capability set"),
        ". Remembering only the ",
        el("em", {}, "ground-truth"),
        " capability is not enough for generalization.",
      ]
    ),
    el(
      "div",
      { class: "home-headline-sub muted" },
      [
        "Across the 2×2 design (",
        el("code", {}, "tool catalog × memory"),
        "), the variants that adapt over the ",
        el("strong", {}, "cumulative tool catalog"),
        " — not the narrow per-task oracle subset — produce the lowest forgetting and the largest forward-transfer gains. ",
        "The remaining sections back this up with numbers from the current run.",
      ]
    ),
  ]);
}

function buildHomeSystems() {
  const wrap = el("div", { class: "home-systems" });
  wrap.appendChild(el("h3", {}, "The four systems"));
  wrap.appendChild(buildSystemsLegend(Object.keys(MODE_LABELS)));
  return wrap;
}

function buildHomeNav() {
  const grid = el("div", { class: "card-grid" });
  grid.appendChild(
    el("div", { class: "card" }, [
      el("h3", {}, "Benchmark"),
      el("p", {}, [
        "How the evolving benchmark is constructed, how tools accumulate from ",
        el("code", {}, "T₁"), " to ", el("code", {}, "Tₖ"),
        ", and how it aligns with real corpora (org62).",
      ]),
      el("button", { class: "primary", "data-goto": "datasets" }, "Open benchmark →"),
    ])
  );
  grid.appendChild(
    el("div", { class: "card" }, [
      el("h3", {}, "Results"),
      el("p", {}, [
        "Continual-learning summary tables, per-domain matrices and full chat trajectories under ",
        el("code", {}, "evolve_results"), ".",
      ]),
      el("button", { class: "primary", "data-goto": "results" }, "Open results →"),
    ])
  );
  grid.appendChild(
    el("div", { class: "card" }, [
      el("h3", {}, "Insights"),
      el("p", {}, [
        "Four key insights: forgetting per system, pair deltas (selection / usage / broad memory), token-cost activity, and memory composition.",
      ]),
      el("button", { class: "primary", "data-goto": "insights" }, "Open insights →"),
    ])
  );
  return grid;
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------
const state = {
  home: { loaded: false },
  ds: { bench: null, domain: null, kind: "oracle", stage: "", filter: "", tasks: [], loaded: false, mode: "construct", evo: { data: null, loading: false }, rw: { data: null, loading: false, bench: null } },
  rs: { path: "", loaded: false, mode: "summary", sum: { run: null, oracleRun: "", data: null, loading: false } },
  ins: { runs: [], run: null, domains: [], modes: [], loaded: false },
};

async function onBenchmarkChange() {
  const bench = $("#ds-benchmark").value;
  state.ds.bench = bench;
  if (state.ds.rw.bench !== bench) {
    state.ds.rw.data = null;
    state.ds.rw.bench = bench;
  }
  const data = await fetchJson(`/api/datasets/${bench}`);
  const sel = $("#ds-domain");
  sel.innerHTML = "";
  for (const d of data.domains) {
    sel.appendChild(el("option", { value: d }, d));
  }
  if (data.domains.length) {
    sel.value = data.domains[0];
    state.ds.domain = data.domains[0];
    await onDomainChange();
  }
  if (state.ds.mode === "realworld") loadRealworldComparison();
}

async function onDomainChange() {
  const bench = $("#ds-benchmark").value;
  const domain = $("#ds-domain").value;
  state.ds.domain = domain;

  // Load summary for stage info
  const summary = await fetchJson(`/api/datasets/${bench}/${domain}/summary`);
  renderStagesSummary(summary);

  // Populate stage dropdown
  const stageSel = $("#ds-stage");
  stageSel.innerHTML = `<option value="">all</option>`;
  const numStages = summary?.env_summary?.stages?.length || 0;
  for (let i = 0; i < numStages; i++) {
    stageSel.appendChild(el("option", { value: i }, `T${i + 1} (${summary.env_summary.stages[i].name || ""})`));
  }

  await reloadTaskList();
  // Evolution / Construct views depend on (benchmark, domain) — invalidate.
  state.ds.evo.data = null;
  if (state.ds.mode === "evolution" || state.ds.mode === "construct") loadEvolution();
}

// --- Datasets: Construct / Evolution / Task Browser switcher --------------
function setDatasetsMode(mode) {
  state.ds.mode = mode;
  $$("#ds-modes [data-ds-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.dsMode === mode)
  );
  $(".ds-browser-tools").style.display = mode === "browser" ? "" : "none";
  $("#ds-browser").style.display = mode === "browser" ? "" : "none";
  $("#ds-evolution").style.display = mode === "evolution" ? "" : "none";
  $("#ds-construct").style.display = mode === "construct" ? "" : "none";
  const rw = $("#ds-realworld");
  if (rw) rw.style.display = mode === "realworld" ? "" : "none";
  if ((mode === "evolution" || mode === "construct") && !state.ds.evo.data) loadEvolution();
  else if (mode === "construct" && state.ds.evo.data) renderConstruction($("#ds-construct"), state.ds.evo.data);
  if (mode === "realworld") loadRealworldComparison();
}

async function loadEvolution() {
  const bench = state.ds.bench;
  const domain = state.ds.domain;
  if (!bench || !domain) return;
  const root = $("#ds-evolution");
  if (state.ds.evo.loading) return;
  state.ds.evo.loading = true;
  root.innerHTML = `<div class="empty">Loading evolution for <code>${escapeHtml(bench)} / ${escapeHtml(domain)}</code>…</div>`;
  try {
    const data = await fetchJson(`/api/datasets/${bench}/${domain}/evolution`);
    state.ds.evo.data = data;
    renderEvolution(root, data);
    const cRoot = $("#ds-construct");
    if (cRoot) renderConstruction(cRoot, data);
  } catch (e) {
    root.innerHTML = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
  } finally {
    state.ds.evo.loading = false;
  }
}

function renderEvolution(root, data) {
  root.innerHTML = "";

  // -- Header
  root.appendChild(
    el("div", { class: "evo-header" }, [
      el("h2", { class: "evo-title" }, `${data.benchmark} / ${data.domain}`),
      el(
        "p",
        { class: "muted" },
        `${data.total_tasks ?? "?"} tasks · ${data.num_stages ?? "?"} time steps · staging=${data.staging || "?"} · adapt_ratio=${data.adapt_ratio ?? "?"}`
      ),
    ])
  );

  // -- Per-stage summary cards
  const cardsWrap = el("div", { class: "evo-cards" });
  data.stages.forEach((s, i) => {
    const newToolChips = (s.new_tools || []).slice(0, 12).map((t) =>
      el("span", { class: "chip chip-new", title: t }, t)
    );
    const moreNew = (s.new_tools || []).length - newToolChips.length;
    if (moreNew > 0) newToolChips.push(el("span", { class: "chip chip-more" }, `+${moreNew} more`));
    const retiredChips = (s.retired_tools || []).slice(0, 6).map((t) =>
      el("span", { class: "chip chip-retired", title: t }, t)
    );

    const card = el("div", { class: "evo-card" }, [
      el("div", { class: "evo-card-head" }, [
        el("div", { class: "evo-card-name" }, s.name || `T${i + 1}`),
        el("div", { class: "evo-card-meta" }, `|C|=${s.num_cumulative_tools} · +${s.num_new_tools}${s.num_retired_tools ? ` · −${s.num_retired_tools}` : ""}`),
      ]),
      el("div", { class: "evo-card-stats" }, [
        evoStat("tasks", s.num_new_tasks),
        evoStat("adapt", s.num_adapt),
        evoStat("test", s.num_test),
        evoStat("tools/task", fmtStat(s.tools_per_task)),
        evoStat("verifiers/task", fmtStat(s.verifiers_per_task)),
      ]),
      el("div", { class: "evo-card-section" }, [
        el("div", { class: "evo-card-sublabel" }, `+${s.num_new_tools} new tools`),
        el("div", { class: "chip-row" }, newToolChips.length ? newToolChips : [el("span", { class: "muted" }, "—")]),
      ]),
      retiredChips.length
        ? el("div", { class: "evo-card-section" }, [
            el("div", { class: "evo-card-sublabel" }, `−${s.num_retired_tools} retired`),
            el("div", { class: "chip-row" }, retiredChips),
          ])
        : null,
      el("div", { class: "evo-card-section" }, [
        el("div", { class: "evo-card-sublabel" }, `top tools in oracle solutions`),
        el(
          "div",
          { class: "chip-row" },
          (s.top_tool_usage || []).slice(0, 10).map((u) =>
            el("span", { class: "chip chip-usage", title: `used in ${u.count} tasks` }, [
              el("span", {}, u.tool),
              el("span", { class: "chip-count" }, String(u.count)),
            ])
          )
        ),
      ]),
    ]);
    cardsWrap.appendChild(card);
  });
  root.appendChild(cardsWrap);

  // -- Complexity-over-stages mini chart
  root.appendChild(buildComplexityChart(data));

  // -- Tool timeline matrix
  root.appendChild(buildToolTimeline(data));
}

function fmtStat(s) {
  if (!s || s.mean == null) return "—";
  return `${num(s.mean, 1)} (${s.min}–${s.max})`;
}

// =========================================================================
// REAL-WORLD FIT — alignment of our benchmark against the org62 trace
// =========================================================================
async function loadRealworldComparison() {
  const bench = state.ds.bench;
  if (!bench) return;
  const root = $("#ds-realworld");
  if (!root) return;
  if (state.ds.rw.loading) return;
  // Cache hit
  if (state.ds.rw.data && state.ds.rw.bench === bench) {
    renderRealworldComparison(root, state.ds.rw.data);
    return;
  }
  state.ds.rw.loading = true;
  root.innerHTML = `<div class="empty">Loading real-world comparison for <code>${escapeHtml(bench)}</code>…</div>`;
  try {
    const data = await fetchJson(`/api/datasets/${bench}/realworld_comparison`);
    state.ds.rw.data = data;
    state.ds.rw.bench = bench;
    renderRealworldComparison(root, data);
  } catch (e) {
    root.innerHTML = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
  } finally {
    state.ds.rw.loading = false;
  }
}

function renderRealworldComparison(root, data) {
  root.innerHTML = "";
  const bench = data.benchmark;
  const ms = data.match_summary || {};
  // Only keep org62 reference corpora; shiva is dropped everywhere.
  const realByName = Object.fromEntries(
    Object.entries(ms.real || {}).filter(([name]) =>
      name.toLowerCase().startsWith("org62")
    )
  );
  const simulated = ms.simulated || [];

  // Header
  root.appendChild(
    el("div", { class: "rw-header" }, [
      el("h2", { class: "rw-title" }, `Does our evolving ${bench} benchmark look like the real world?`),
      el(
        "p",
        { class: "muted rw-subtitle" },
        `We compare every domain in the simulated ${bench} benchmark against ` +
          `the org62 production tool-use trace (3.1M tasks, 7.3K tools). ` +
          `Two structural fingerprints — the rank-frequency law and how complexity ` +
          `grows as the tool catalog grows — line up on the same regime, evidencing ` +
          `that our synthetic time steps are a faithful microcosm of real tool ecosystems.`
      ),
    ])
  );

  // Reference corpora explainer — explains the -all / -multi distinction.
  root.appendChild(buildReferenceCorporaCard(realByName));

  // Headline charts — rendered natively from match_summary numbers.
  const rankFreq = data.rank_frequency || {};
  const figGrid = el("div", { class: "rw-fig-grid" });
  figGrid.appendChild(
    el("figure", { class: "rw-fig card" }, [
      el("figcaption", { class: "rw-fig-cap" }, [
        el("strong", {}, "Rank-frequency law (log–log, normalised PMF)"),
        el(
          "p",
          { class: "muted small" },
          "Per-tool usage frequency vs rank, normalised by total calls so corpora of very different sizes overlay on the same scale. Real-world traces are heavy-tailed; the slope on log–log is the Zipf exponent α. Real org62 corpora are drawn dashed gold; simulated domains are colored solid lines. They sit on the same regime."
        ),
      ]),
      buildRankFrequencyChart(simulated, realByName, rankFreq),
    ])
  );
  figGrid.appendChild(
    el("figure", { class: "rw-fig card" }, [
      el("figcaption", { class: "rw-fig-cap" }, [
        el("strong", {}, "Complexity growth over time"),
        el(
          "p",
          { class: "muted small" },
          "Mean tools-per-task at each time step of the evolving catalog. In real evolving systems the curve stays roughly flat — adding tools opens new tasks rather than making old tasks harder. Our simulated time steps exhibit the same near-flat slope."
        ),
      ]),
      buildComplexityGrowthChart(simulated, realByName),
    ])
  );
  figGrid.appendChild(
    el("figure", { class: "rw-fig card" }, [
      el("figcaption", { class: "rw-fig-cap" }, [
        el("strong", {}, "Tool emergence over time"),
        el(
          "p",
          { class: "muted small" },
          "Cumulative share of the final tool universe revealed by each time step. The curve rises from a small core at T₁ to the full catalog at the last time step. Real and simulated traces follow the same gradual-emergence shape — most tools are introduced early, with a longer tail of rare additions in later time steps."
        ),
      ]),
      buildToolEmergenceChart(simulated, realByName),
    ])
  );
  root.appendChild(figGrid);

  // Metric explainer — what every column in the table below means.
  root.appendChild(buildRWMetricExplainer());

  // Per-domain side-by-side stat table.
  if (simulated.length && Object.keys(realByName).length) {
    root.appendChild(buildRWStatsTable(simulated, realByName));
  }

  // Takeaway
  root.appendChild(
    el("div", { class: "rw-takeaway card" }, [
      el("strong", {}, "Takeaway"),
      el(
        "p",
        { class: "muted" },
        `Across rank-frequency and complexity growth, the simulated ${bench} ` +
          `domains mirror the real org62 trace at smaller scale. Continual-learning ` +
          `conclusions drawn here should therefore transfer to real evolving tool ecosystems.`
      ),
    ])
  );
}

// ---- Chart: Rank-frequency law (empirical, two-panel like the PNG) ------
function buildRankFrequencyChart(simulated, realByName, rankFreq) {
  // Each simulated and real series carries empirical sorted-descending
  // tool-usage counts. When rank_frequency.json provides per-tool counts
  // for the real corpora (org62-all / org62-multi), we plot them as
  // dashed gold step curves — exactly like the source PNG. If the sidecar
  // is missing we fall back to a fitted-Zipf reference line.
  const PAL = ["#60a5fa", "#34d399", "#a78bfa", "#22d3ee", "#f472b6", "#fb923c", "#ca8a04", "#f87171"];
  const simSeries = [];
  simulated.forEach((s, i) => {
    const ys = rankFreq?.[s.name];
    if (!Array.isArray(ys) || !ys.length) return;
    simSeries.push({
      name: s.name,
      ys,
      color: PAL[i % PAL.length],
      alpha: s.zipf_alpha,
    });
  });
  // Real corpora — only the org62 traces (skip shiva when present).
  const realSeries = [];
  const REAL_PAL = { primary: "#fbbf24", secondary: "#a16207" };
  let realIdx = 0;
  for (const [name, r] of Object.entries(realByName)) {
    if (!name.toLowerCase().startsWith("org62")) continue;
    const ys = rankFreq?.[name];
    const color = realIdx === 0 ? REAL_PAL.primary : REAL_PAL.secondary;
    if (Array.isArray(ys) && ys.length) {
      realSeries.push({ name, ys, color, alpha: r?.zipf_alpha, N: r?.n_universe, empirical: true });
    } else if (r?.zipf_alpha != null) {
      realSeries.push({ name, color, alpha: r.zipf_alpha, N: r.n_universe || 1000, empirical: false });
    }
    realIdx++;
  }
  const topPeak = Math.max(
    0,
    ...simSeries.map((s) => s.ys[0]),
    ...realSeries.filter((r) => r.empirical).map((r) => r.ys[0])
  );

  // Precompute series sums so we can plot the log-log panel as a PMF
  // (rf / rf.sum()), matching the source script exactly.
  for (const s of simSeries) s.sum = s.ys.reduce((a, b) => a + b, 0) || 1;
  for (const r of realSeries) if (r.empirical) r.sum = r.ys.reduce((a, b) => a + b, 0) || 1;

  // Single log-log panel. y = normalised PMF (rf / rf.sum()) so corpora of
  // very different sizes overlay on the same scale — same as the script.
  const W = 560, H = 360;
  const padL = 68, padR = 16, padT = 26, padB = 54;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "rw-svg");
  svg.style.width = "100%";
  svg.style.height = "auto";

  const grid = "#e2e8f0", axis = "#cbd5e1", mute = "#64748b";

  const xOff = padL;
  const w = W - padL - padR, h = H - padT - padB;

  let xMax = 1;
  for (const s of simSeries) xMax = Math.max(xMax, s.ys.length);
  for (const r of realSeries) xMax = Math.max(xMax, r.empirical ? r.ys.length : (r.N || 1));
  let topPmf = 0, totalN = 0;
  for (const s of simSeries) { topPmf = Math.max(topPmf, s.ys[0] / s.sum); totalN = Math.max(totalN, s.sum); }
  for (const r of realSeries) {
    if (r.empirical) { topPmf = Math.max(topPmf, r.ys[0] / r.sum); totalN = Math.max(totalN, r.sum); }
  }
  const yMax = Math.pow(10, Math.ceil(Math.log10(Math.max(topPmf, 1e-2))));
  const yMin = Math.pow(10, Math.floor(Math.log10(Math.max(1 / Math.max(totalN, 100), 1e-7))));

  const xAt = (r) => xOff + (Math.log10(Math.max(1, r)) / Math.log10(xMax)) * w;
  const yAt = (v) => padT + (1 - (Math.log10(Math.max(yMin, v)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * h;

  svg.appendChild(svgText(xOff + w / 2, padT - 10, "log–log · normalised PMF (full range, Zipf slope visible)", mute, "middle", 12, 700));

  svg.appendChild(svgLine(xOff, padT, xOff, padT + h, axis));
  svg.appendChild(svgLine(xOff, padT + h, xOff + w, padT + h, axis));

  const yPmin = Math.floor(Math.log10(yMin)), yPmax = Math.ceil(Math.log10(yMax));
  for (let p = yPmin; p <= yPmax; p++) {
    const v = Math.pow(10, p);
    if (v < yMin || v > yMax) continue;
    const y = yAt(v);
    svg.appendChild(svgLine(xOff, y, xOff + w, y, grid));
    svg.appendChild(svgText(xOff - 6, y + 3, `10^${p}`, mute, "end", 10));
  }
  const xPmax = Math.ceil(Math.log10(xMax));
  for (let p = 0; p <= xPmax; p++) {
    const x = xAt(Math.pow(10, p));
    if (x < xOff || x > xOff + w) continue;
    svg.appendChild(svgLine(x, padT, x, padT + h, grid));
    svg.appendChild(svgText(x, padT + h + 14, `10^${p}`, mute, "middle", 10));
  }
  svg.appendChild(svgText(xOff + w / 2, padT + h + 34, "tool rank (most → least used)", mute, "middle", 11, 600));
  const yLab = document.createElementNS("http://www.w3.org/2000/svg", "text");
  const ycx = padT + h / 2, xcx = xOff - 50;
  yLab.setAttribute("x", xcx); yLab.setAttribute("y", ycx);
  yLab.setAttribute("transform", `rotate(-90 ${xcx} ${ycx})`);
  yLab.setAttribute("fill", mute); yLab.setAttribute("font-size", 11); yLab.setAttribute("font-weight", 600);
  yLab.setAttribute("text-anchor", "middle");
  yLab.textContent = "normalised tool frequency";
  svg.appendChild(yLab);

  function drawPoly(ys, sum, color, opts) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const L = ys.length;
    const norm = 1 / sum;
    const idx = [];
    const K = 400;
    for (let k = 0; k <= K; k++) {
      const r = Math.pow(10, (k / K) * Math.log10(L));
      const i = Math.min(L - 1, Math.max(0, Math.round(r) - 1));
      if (idx.length === 0 || idx[idx.length - 1] !== i) idx.push(i);
    }
    const pts = idx.map((i) => `${xAt(i + 1).toFixed(2)},${yAt(Math.max(yMin, ys[i] * norm)).toFixed(2)}`);
    path.setAttribute("d", "M" + pts.join(" L"));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", opts.lw);
    if (opts.dashed) path.setAttribute("stroke-dasharray", "6,4");
    path.setAttribute("opacity", opts.opacity ?? 0.9);
    if (opts.title) {
      const tt = document.createElementNS("http://www.w3.org/2000/svg", "title");
      tt.textContent = opts.title;
      path.appendChild(tt);
    }
    svg.appendChild(path);
  }

  for (const s of simSeries) {
    drawPoly(s.ys, s.sum, s.color, {
      lw: 1.4, opacity: 0.9,
      title: `${s.name} · empirical · α≈${s.alpha?.toFixed?.(2) ?? "?"} · |C|=${s.ys.length}`,
    });
  }
  for (const r of realSeries) {
    if (r.empirical) {
      drawPoly(r.ys, r.sum, r.color, {
        lw: 2.4, dashed: true, opacity: 0.95,
        title: `${r.name} · empirical · α=${r.alpha?.toFixed?.(2) ?? "?"} · |C|=${r.ys.length}`,
      });
    } else {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const pts = [];
      const xStop = Math.max(xMax, r.N || xMax);
      const anchorTop = simSeries[0] ? simSeries[0].ys[0] / simSeries[0].sum : 1;
      const Kp = 200;
      for (let i = 0; i <= Kp; i++) {
        const xr = Math.pow(10, (i / Kp) * Math.log10(xStop));
        const yv = anchorTop * Math.pow(xr, -r.alpha);
        pts.push(`${xAt(xr).toFixed(2)},${yAt(Math.max(yMin, yv)).toFixed(2)}`);
      }
      path.setAttribute("d", "M" + pts.join(" L"));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", r.color);
      path.setAttribute("stroke-width", 2.2);
      path.setAttribute("stroke-dasharray", "6,4");
      path.setAttribute("opacity", 0.95);
      const tt = document.createElementNS("http://www.w3.org/2000/svg", "title");
      tt.textContent = `${r.name} · fitted-Zipf reference · α=${r.alpha.toFixed(2)} · |C|=${r.N}`;
      path.appendChild(tt);
      svg.appendChild(path);
    }
  }

  const wrap = el("div", { class: "rw-chart-wrap" });
  wrap.appendChild(svg);
  const lg = el("div", { class: "rw-legend" });
  for (const r of realSeries) {
    const label = r.empirical
      ? `${r.name} · empirical (α=${r.alpha?.toFixed?.(2) ?? "?"}, |C|=${r.ys.length})`
      : `${r.name} · fitted Zipf (α=${r.alpha?.toFixed?.(2) ?? "?"})`;
    lg.appendChild(
      el("span", { class: "rw-legend-item real" }, [
        el("span", { class: "rw-legend-sw", style: `background:${r.color}` }),
        label,
      ])
    );
  }
  for (const s of simSeries) {
    lg.appendChild(
      el("span", { class: "rw-legend-item" }, [
        el("span", { class: "rw-legend-sw", style: `background:${s.color}` }),
        `${s.name} (α≈${s.alpha?.toFixed?.(2) ?? "?"}, |C|=${s.ys.length})`,
      ])
    );
  }
  wrap.appendChild(lg);
  return wrap;
}

function fmtNumShort(v) {
  if (v === 0) return "0";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1) + "k";
  return String(Math.round(v));
}

function niceStep(maxVal, n) {
  if (maxVal <= 0) return 1;
  const raw = maxVal / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let m = 1;
  if (norm > 5) m = 10;
  else if (norm > 2) m = 5;
  else if (norm > 1) m = 2;
  return m * mag;
}

// ---- Chart: Complexity growth over time ----------------------------
function buildComplexityGrowthChart(simulated, realByName) {
  // X = stage index normalized to [0,1], Y = mean_size_per_bucket.
  // Real corpora plotted with dashed gold; simulated solid colored.
  // Only show org62 reference traces (skip shiva when present).
  const series = [];
  for (const [name, r] of Object.entries(realByName)) {
    if (!name.toLowerCase().startsWith("org62")) continue;
    const ys = r?.mean_size_per_bucket;
    if (!Array.isArray(ys) || ys.length === 0) continue;
    series.push({ name, ys, kind: "real" });
  }
  const PAL = ["#60a5fa", "#34d399", "#a78bfa", "#22d3ee", "#f472b6", "#fb923c", "#ca8a04", "#f87171"];
  simulated.forEach((s, i) => {
    const ys = s?.mean_size_per_bucket;
    if (!Array.isArray(ys) || ys.length === 0) return;
    series.push({ name: s.name, ys, kind: "sim", color: PAL[i % PAL.length] });
  });

  const W = 600, H = 320;
  const padL = 50, padR = 18, padT = 18, padB = 50;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "rw-svg");
  svg.style.width = "100%";
  svg.style.height = "auto";

  let yMax = 0;
  for (const s of series) yMax = Math.max(yMax, ...s.ys);
  yMax = Math.max(2, Math.ceil(yMax + 1));
  const yMin = 0;

  const xAt = (i, K) => padL + (K <= 1 ? 0.5 : i / (K - 1)) * (W - padL - padR);
  const yAt = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);
  const grid = "#e2e8f0", axis = "#cbd5e1";
  for (let yv = 0; yv <= yMax; yv += Math.ceil(yMax / 5)) {
    const y = yAt(yv);
    svg.appendChild(svgLine(padL, y, W - padR, y, grid));
    svg.appendChild(svgText(padL - 6, y + 3, String(yv), "#64748b", "end", 10));
  }
  svg.appendChild(svgLine(padL, H - padB, W - padR, H - padB, axis));
  svg.appendChild(svgLine(padL, padT, padL, H - padB, axis));
  svg.appendChild(svgText((W + padL) / 2, H - 6, "time progression (T₁ → Tₖ, normalized)", "#64748b", "middle", 11, 600));
  const yLab = document.createElementNS("http://www.w3.org/2000/svg", "text");
  yLab.setAttribute("x", 12); yLab.setAttribute("y", (H - padB + padT) / 2);
  yLab.setAttribute("transform", `rotate(-90 12 ${(H - padB + padT) / 2})`);
  yLab.setAttribute("fill", "#64748b"); yLab.setAttribute("font-size", 11); yLab.setAttribute("font-weight", 600);
  yLab.setAttribute("text-anchor", "middle");
  yLab.textContent = "mean tools per task";
  svg.appendChild(yLab);

  for (const s of series) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const K = s.ys.length;
    const pts = s.ys.map((v, i) => `${xAt(i, K).toFixed(2)},${yAt(v).toFixed(2)}`);
    path.setAttribute("d", "M" + pts.join(" L"));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", s.kind === "real" ? "#fbbf24" : s.color);
    path.setAttribute("stroke-width", s.kind === "real" ? 2.5 : 1.5);
    if (s.kind === "real") path.setAttribute("stroke-dasharray", "5,4");
    path.setAttribute("opacity", s.kind === "real" ? 0.95 : 0.85);
    const tt = document.createElementNS("http://www.w3.org/2000/svg", "title");
    tt.textContent = `${s.name} · ${s.ys.map((v) => v.toFixed(2)).join(", ")}`;
    path.appendChild(tt);
    svg.appendChild(path);
    // Endpoint dots for clarity
    s.ys.forEach((v, i) => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", xAt(i, K)); c.setAttribute("cy", yAt(v));
      c.setAttribute("r", s.kind === "real" ? 3 : 2.5);
      c.setAttribute("fill", s.kind === "real" ? "#fbbf24" : s.color);
      c.setAttribute("opacity", 0.95);
      svg.appendChild(c);
    });
  }

  const wrap = el("div", { class: "rw-chart-wrap" });
  wrap.appendChild(svg);
  const lg = el("div", { class: "rw-legend" });
  for (const s of series) {
    const slope = s.ys.length > 1 ? (s.ys[s.ys.length - 1] - s.ys[0]) / (s.ys.length - 1) : 0;
    lg.appendChild(
      el("span", { class: "rw-legend-item" + (s.kind === "real" ? " real" : "") }, [
        el("span", {
          class: "rw-legend-sw",
          style: `background:${s.kind === "real" ? "#fbbf24" : s.color}`,
        }),
        `${s.name} (Δ/step ≈ ${slope >= 0 ? "+" : ""}${slope.toFixed(2)})`,
      ])
    );
  }
  wrap.appendChild(lg);
  return wrap;
}

// ---- Chart: Tool emergence over time -----------------------------------
function buildToolEmergenceChart(simulated, realByName) {
  // X = stage index normalized to [0,1], Y = cumulative tool-universe
  // fraction (from match_summary's universe_fraction_per_bucket).
  // Real corpora plotted dashed gold; simulated solid colored. Mirrors the
  // right panel of the source complexity_growth.png.
  const series = [];
  for (const [name, r] of Object.entries(realByName)) {
    if (!name.toLowerCase().startsWith("org62")) continue;
    const ys = r?.universe_fraction_per_bucket;
    if (!Array.isArray(ys) || ys.length === 0) continue;
    series.push({ name, ys, kind: "real" });
  }
  const PAL = ["#60a5fa", "#34d399", "#a78bfa", "#22d3ee", "#f472b6", "#fb923c", "#ca8a04", "#f87171"];
  simulated.forEach((s, i) => {
    const ys = s?.universe_fraction_per_bucket;
    if (!Array.isArray(ys) || ys.length === 0) return;
    series.push({ name: s.name, ys, kind: "sim", color: PAL[i % PAL.length] });
  });

  const W = 600, H = 320;
  const padL = 50, padR = 18, padT = 18, padB = 50;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "rw-svg");
  svg.style.width = "100%";
  svg.style.height = "auto";

  const yMax = 1.0, yMin = 0;
  const xAt = (i, K) => padL + (K <= 1 ? 0.5 : i / (K - 1)) * (W - padL - padR);
  const yAt = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);
  const grid = "#e2e8f0", axis = "#cbd5e1";
  for (let yv = 0; yv <= yMax + 1e-6; yv += 0.2) {
    const y = yAt(yv);
    svg.appendChild(svgLine(padL, y, W - padR, y, grid));
    svg.appendChild(svgText(padL - 6, y + 3, yv.toFixed(1), "#64748b", "end", 10));
  }
  svg.appendChild(svgLine(padL, H - padB, W - padR, H - padB, axis));
  svg.appendChild(svgLine(padL, padT, padL, H - padB, axis));
  svg.appendChild(svgText((W + padL) / 2, H - 6, "time progression (T₁ → Tₖ, normalized)", "#64748b", "middle", 11, 600));
  const yLab = document.createElementNS("http://www.w3.org/2000/svg", "text");
  yLab.setAttribute("x", 12); yLab.setAttribute("y", (H - padB + padT) / 2);
  yLab.setAttribute("transform", `rotate(-90 12 ${(H - padB + padT) / 2})`);
  yLab.setAttribute("fill", "#64748b"); yLab.setAttribute("font-size", 11); yLab.setAttribute("font-weight", 600);
  yLab.setAttribute("text-anchor", "middle");
  yLab.textContent = "cumulative tool-universe fraction";
  svg.appendChild(yLab);

  for (const s of series) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const K = s.ys.length;
    const pts = s.ys.map((v, i) => `${xAt(i, K).toFixed(2)},${yAt(v).toFixed(2)}`);
    path.setAttribute("d", "M" + pts.join(" L"));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", s.kind === "real" ? "#fbbf24" : s.color);
    path.setAttribute("stroke-width", s.kind === "real" ? 2.5 : 1.5);
    if (s.kind === "real") path.setAttribute("stroke-dasharray", "5,4");
    path.setAttribute("opacity", s.kind === "real" ? 0.95 : 0.85);
    const tt = document.createElementNS("http://www.w3.org/2000/svg", "title");
    tt.textContent = `${s.name} · ${s.ys.map((v) => (v * 100).toFixed(0) + "%").join(", ")}`;
    path.appendChild(tt);
    svg.appendChild(path);
    s.ys.forEach((v, i) => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", xAt(i, K)); c.setAttribute("cy", yAt(v));
      c.setAttribute("r", s.kind === "real" ? 3 : 2.5);
      c.setAttribute("fill", s.kind === "real" ? "#fbbf24" : s.color);
      c.setAttribute("opacity", 0.95);
      svg.appendChild(c);
    });
  }

  const wrap = el("div", { class: "rw-chart-wrap" });
  wrap.appendChild(svg);
  const lg = el("div", { class: "rw-legend" });
  for (const s of series) {
    const v1Pct = (s.ys[0] || 0) * 100;
    lg.appendChild(
      el("span", { class: "rw-legend-item" + (s.kind === "real" ? " real" : "") }, [
        el("span", {
          class: "rw-legend-sw",
          style: `background:${s.kind === "real" ? "#fbbf24" : s.color}`,
        }),
        `${s.name} (T₁ already covers ${v1Pct.toFixed(0)}%)`,
      ])
    );
  }
  wrap.appendChild(lg);
  return wrap;
}

// ---- Explainer card: what each column of the alignment table means -----
function buildRWMetricExplainer() {
  const items = [
    {
      name: "Zipf α",
      what: "Power-law exponent of the rank–frequency curve.",
      how: "Fit a least-squares line to log(frequency) vs log(rank); α is the negative slope.",
      read: "Higher α ⇒ more concentrated (a few tools dominate). Real org62 α ≈ 2.1.",
    },
    {
      name: "Gini",
      what: "Inequality of tool-usage frequencies across the catalog.",
      how: "Standard Gini coefficient on the sorted usage counts.",
      read: "0 = perfectly uniform usage, 1 = a single tool dominates. Real org62 ≈ 0.97.",
    },
    {
      name: "Top-20 cov",
      what: "Share of all tool calls explained by the 20 most-used tools.",
      how: "Σ count(top 20 tools) / Σ count(all tools).",
      read: "High value ⇒ a small core carries the workload, long tail is sparse. Real org62 ≈ 99%.",
    },
    {
      name: "Tools/task",
      what: "Average number of distinct tools used to solve one task.",
      how: "Mean of |Tᵢ| (ground-truth tool set size) across tasks.",
      read: "Real org62-all averages 1.2 (mostly single-call); org62-multi averages 2.3 (multi-step). Our enterprise tasks are richer (multi-step by design), but the per-time-step shape matches.",
    },
    {
      name: "Multi-task %",
      what: "Share of tasks that require more than one tool.",
      how: "|{i : |Tᵢ| > 1}| / N.",
      read: "100% in our domains by construction; ~19% in org62-all (it includes many single-call tasks).",
    },
    {
      name: "Complexity slope",
      what: "How tools/task grows as the catalog grows over time.",
      how: "Least-squares slope of mean_tools_per_task vs time index.",
      read: "Near zero ⇒ flat complexity (the right behavior for an evolving system that adds new tasks rather than harder ones). Both org62 and our domains stay close to 0.",
    },
  ];
  const card = el("div", { class: "rw-explainer card" });
  card.appendChild(el("div", { class: "rw-explainer-head" }, [
    el("strong", {}, "Metric guide"),
    el(
      "span",
      { class: "muted small" },
      "What each column in the alignment table below measures and how to read it."
    ),
  ]));
  const grid = el("div", { class: "rw-explainer-grid" });
  for (const it of items) {
    grid.appendChild(
      el("div", { class: "rw-explainer-item" }, [
        el("div", { class: "rw-explainer-name" }, it.name),
        el("div", { class: "rw-explainer-row" }, [
          el("span", { class: "rw-explainer-tag" }, "what"),
          el("span", {}, it.what),
        ]),
        el("div", { class: "rw-explainer-row" }, [
          el("span", { class: "rw-explainer-tag" }, "how"),
          el("span", { class: "muted" }, it.how),
        ]),
        el("div", { class: "rw-explainer-row" }, [
          el("span", { class: "rw-explainer-tag" }, "read"),
          el("span", {}, it.read),
        ]),
      ])
    );
  }
  card.appendChild(grid);
  return card;
}

function buildReferenceCorporaCard(realByName) {
  // Map of known reference traces and what they mean.
  const blurbs = {
    "org62-all": {
      role: "Ambient ecosystem",
      what: "The full Org62 production corpus — every session, including the many single-tool ones.",
      use: "Reveals the underlying tool ecosystem (heavy tail, tiny popular core) that any subset inherits its shape from.",
      color: "#fbbf24",
    },
    "org62-multi": {
      role: "Compound-task baseline",
      what: "Same corpus filtered to sessions that use ≥2 distinct tools.",
      use: "The fair head-to-head for our benchmark, since every simulated task is multi-step by construction.",
      color: "#f59e0b",
    },
    "shiva-all": {
      role: "Ambient ecosystem (SalesAgent)",
      what: "All sessions from the SalesAgent (shiva_split) production trace.",
      use: "Secondary reference when an Org62 corpus is not available.",
      color: "#fbbf24",
    },
    "shiva-multi": {
      role: "Compound-task baseline (SalesAgent)",
      what: "SalesAgent sessions filtered to ≥2 distinct tools.",
      use: "Secondary fair head-to-head for multi-tool tasks.",
      color: "#f59e0b",
    },
  };

  const card = el("div", { class: "rw-refs card" });
  card.appendChild(
    el("div", { class: "rw-refs-head" }, [
      el("strong", {}, "Reference corpora"),
      el(
        "span",
        { class: "muted small" },
        "We compare against two filters of the same real Org62 production trace. " +
          "Each filter answers a different question."
      ),
    ])
  );
  const grid = el("div", { class: "rw-refs-grid" });
  for (const [name, r] of Object.entries(realByName)) {
    const meta = blurbs[name] || {
      role: "Reference corpus",
      what: `Aggregated stats for ${name}.`,
      use: "Used as a baseline for the alignment comparison.",
      color: "#fbbf24",
    };
    grid.appendChild(
      el("div", { class: "rw-ref-card" }, [
        el("div", { class: "rw-ref-head" }, [
          el("span", { class: "rw-ref-dot", style: `background:${meta.color}` }),
          el("span", { class: "rw-ref-name" }, name),
          el("span", { class: "rw-ref-role" }, meta.role),
        ]),
        el("div", { class: "rw-ref-stats" }, [
          rwInlineStat("# tasks", r.n_tasks?.toLocaleString?.() ?? r.n_tasks ?? "—"),
          rwInlineStat("# tools", r.n_universe?.toLocaleString?.() ?? r.n_universe ?? "—"),
          rwInlineStat("mean tools/task", num(r.mean_tools_per_task, 2)),
          rwInlineStat("multi-tool %", fmtPct(r.multi_task_frac, 0)),
          rwInlineStat("Zipf α", num(r.zipf_alpha, 2)),
        ]),
        el("div", { class: "rw-ref-row" }, [
          el("span", { class: "rw-ref-tag" }, "what"),
          el("span", {}, meta.what),
        ]),
        el("div", { class: "rw-ref-row" }, [
          el("span", { class: "rw-ref-tag" }, "use"),
          el("span", { class: "muted" }, meta.use),
        ]),
      ])
    );
  }
  card.appendChild(grid);
  // Footnote tying the two together.
  card.appendChild(
    el(
      "p",
      { class: "muted small rw-refs-note" },
      "Why both? Our simulated benchmark is multi-tool by construction, so the direct apples-to-apples baseline is the *-multi subset. But the *-all corpus reveals the ambient ecosystem shape (heavy tail, tiny popular core) that any subset inherits — without it, you can't tell whether the *-multi statistics are intrinsic to the workload or an artefact of filtering. The simulated curves should sit between (or near) the two."
    )
  );
  return card;
}

function rwInlineStat(label, value) {
  return el("span", { class: "rw-inline-stat" }, [
    el("span", { class: "rw-inline-stat-lbl" }, label),
    el("span", { class: "rw-inline-stat-val" }, String(value)),
  ]);
}

function rwStat(label, value, extra = "") {
  return el("div", { class: "rw-stat " + extra }, [
    el("span", { class: "rw-stat-lbl" }, label),
    el("span", { class: "rw-stat-val" }, value == null ? "—" : String(value)),
  ]);
}

function buildRWStatsTable(simulated, realByName) {
  const wrap = el("div", { class: "rw-table-wrap card" });
  wrap.appendChild(
    el("div", { class: "rw-table-head" }, [
      el("strong", {}, "Per-domain alignment with org62"),
      el(
        "span",
        { class: "muted small" },
        "Lower distance to org62 numbers ⇒ closer to real-world structure. Tools/task is naturally larger in our enterprise domains because every task in our benchmark is multi-step."
      ),
    ])
  );
  const cols = [
    { key: "zipf_alpha", label: "Zipf α", fmt: (v) => num(v, 2) },
    { key: "gini_tool_freq", label: "Gini", fmt: (v) => num(v, 2) },
    { key: "top20_coverage", label: "Top-20 cov", fmt: (v) => fmtPct(v, 0) },
    { key: "mean_tools_per_task", label: "Tools/task", fmt: (v) => num(v, 2) },
    { key: "multi_task_frac", label: "Multi-task %", fmt: (v) => fmtPct(v, 0) },
    { key: "complexity_slope", label: "Complexity slope", fmt: (v) => num(v, 3) },
  ];
  const table = el("table", { class: "rw-table" });
  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", {}, "Domain"));
  cols.forEach((c) => hr.appendChild(el("th", {}, c.label)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");

  // Add real reference rows first.
  for (const [name, r] of Object.entries(realByName)) {
    const tr = el("tr", { class: "rw-real-row" });
    tr.appendChild(el("td", { class: "rw-cell-name" }, [
      el("span", { class: "rw-real-tag" }, "real"),
      el("span", {}, name),
    ]));
    cols.forEach((c) => tr.appendChild(el("td", {}, c.fmt(r[c.key]))));
    tbody.appendChild(tr);
  }

  // Simulated rows.
  for (const s of simulated) {
    const tr = el("tr");
    tr.appendChild(el("td", { class: "rw-cell-name" }, [
      el("span", { class: "rw-sim-tag" }, "sim"),
      el("span", {}, s.name),
    ]));
    cols.forEach((c) => tr.appendChild(el("td", {}, c.fmt(s[c.key]))));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// =========================================================================
// CONSTRUCTION VIEW — how the evolving benchmark is built
// =========================================================================
function renderConstruction(root, data) {
  root.innerHTML = "";

  const stages = data.stages || [];
  // Build a "tool frequency rank" using cumulative-tools order of first-appearance:
  // tools introduced at T1 first (most fundamental), T2 next, etc.
  // Within each time step we keep the declared order which corresponds to the
  // frequency_anchors in manifest.json.
  const orderedTools = [];
  const introOf = {};
  stages.forEach((s, i) => {
    (s.new_tools || []).forEach((t) => {
      if (!(t in introOf)) {
        introOf[t] = i;
        orderedTools.push({ tool: t, intro: i });
      }
    });
  });

  // Header
  root.appendChild(
    el("div", { class: "evo-header" }, [
      el("h2", { class: "evo-title" }, `How the benchmark is built · ${data.benchmark} / ${data.domain}`),
      el(
        "p",
        { class: "muted" },
        `An evolving benchmark grows a tool catalog Tₖ over time and ships exactly the tasks that become solvable each time step. ` +
          `Below we walk through the four construction steps, instantiated on the current domain (${orderedTools.length} tools, ${stages.length} time steps, ${data.total_tasks ?? "?"} tasks).`
      ),
    ])
  );

  // Step 1: anatomy of a sample
  root.appendChild(buildConstructStep1());

  // Step 2: collecting & ordering tools
  root.appendChild(buildConstructStep2(orderedTools, stages));

  // Step 3: cumulative catalogs C1 ⊂ C2 ⊂ …
  root.appendChild(buildConstructStep3(stages, orderedTools));

  // Step 4: assign tasks to earliest solvable time step
  root.appendChild(buildConstructStep4(stages));

  // Step 5: construction constraints + breath / depth
  root.appendChild(buildConstructStep5(data));
}

function constructStepCard(stepNum, title, intro, body) {
  const card = el("div", { class: "construct-step card" }, [
    el("div", { class: "construct-step-head" }, [
      el("div", { class: "construct-step-num" }, String(stepNum)),
      el("div", { class: "construct-step-title" }, title),
    ]),
    el("p", { class: "muted construct-step-intro" }, intro),
    body,
  ]);
  return card;
}

// --- Step 1: each sample's anatomy ---------------------------------------
function buildConstructStep1() {
  const W = 700, H = 200;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "construct-svg");
  svg.style.width = "100%";
  svg.style.maxWidth = `${W}px`;
  svg.style.height = "auto";

  const gold = "#ca8a04";
  const blue = "#60a5fa";
  const green = "#34d399";
  const txt = "#0f172a";
  const sub = "#64748b";

  // Three big boxes: X (task) → T (gold tool set) → Y (verifier outcome)
  const labels = [
    { id: "X", title: "Xᵢ", sub: "user task", desc: '"Schedule a meeting with Alice next Friday at 3pm"', color: blue },
    { id: "T", title: "Tᵢ", sub: "ground-truth tool set", desc: "{ list_calendars, create_event, send_invite }", color: gold },
    { id: "Y", title: "Yᵢ", sub: "expected outcome", desc: "verifier passes (event exists, attendee added)", color: green },
  ];
  const boxW = 200, boxH = 110;
  const gapX = (W - boxW * 3) / 4;
  labels.forEach((b, i) => {
    const x = gapX + i * (boxW + gapX), y = 30;
    svg.appendChild(svgRect(x, y, boxW, boxH, "#f8fafc", b.color, 8));
    svg.appendChild(svgText(x + boxW / 2, y + 24, b.title, b.color, "middle", 22, 800));
    svg.appendChild(svgText(x + boxW / 2, y + 44, b.sub, sub, "middle", 11, 600));
    // wrap the desc into 3 lines manually-ish
    svg.appendChild(svgText(x + boxW / 2, y + 70, b.desc.slice(0, 28), txt, "middle", 10));
    if (b.desc.length > 28) svg.appendChild(svgText(x + boxW / 2, y + 84, b.desc.slice(28, 56), txt, "middle", 10));
    if (b.desc.length > 56) svg.appendChild(svgText(x + boxW / 2, y + 98, b.desc.slice(56), txt, "middle", 10));
    // arrow to next
    if (i < labels.length - 1) {
      const ax = x + boxW + 4, ay = y + boxH / 2, ex = x + boxW + gapX - 4;
      const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
      ln.setAttribute("x1", ax); ln.setAttribute("y1", ay);
      ln.setAttribute("x2", ex); ln.setAttribute("y2", ay);
      ln.setAttribute("stroke", "#64748b"); ln.setAttribute("stroke-width", 1.5);
      ln.setAttribute("marker-end", "url(#construct-arrow)");
      svg.appendChild(ln);
      svg.appendChild(svgText((ax + ex) / 2, ay - 8, i === 0 ? "needs" : "yields", sub, "middle", 10, 600));
    }
  });
  // Arrow defs
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `<marker id="construct-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b"/></marker>`;
  svg.insertBefore(defs, svg.firstChild);

  // Bottom caption
  svg.appendChild(
    svgText(W / 2, H - 12, "Every task carries its prompt Xᵢ, the minimal correct tool set Tᵢ, and a verifier-checkable outcome Yᵢ.", sub, "middle", 11, 500)
  );

  return constructStepCard(
    1,
    "Each sample = (Xᵢ, Tᵢ, Yᵢ)",
    "The atomic unit of the benchmark is a tuple of (a) the user prompt, (b) the ground-truth tool set the task requires, and (c) the expected verifier outcome.",
    svg
  );
}

// --- Step 2: collect & order tools ---------------------------------------
function buildConstructStep2(orderedTools, stages) {
  // Build a visual: tool catalog as a horizontal ribbon, colored by intro stage.
  // Bar chart of "simulated frequency" (decreasing) with labels on bars.
  const wrap = el("div", { class: "construct-step-body" });
  const N = orderedTools.length;
  const stageColors = ["#3a6fb0", "#d97044", "#9b59b6", "#34d399", "#fbbf24", "#f87171", "#22d3ee", "#a78bfa"];
  // Simulated frequency = decreasing exponential, just for visualization
  const freqs = orderedTools.map((_, i) => Math.max(0.06, Math.exp(-i / Math.max(4, N / 3))));

  const W = Math.max(720, N * 28 + 80);
  const H = 240;
  const padL = 70, padR = 18, padT = 32, padB = 100;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "construct-svg");
  svg.style.width = "100%";
  svg.style.height = `${H}px`;

  const yScale = (v) => padT + (H - padT - padB) * (1 - v);
  // Axis labels
  svg.appendChild(svgText(8, padT - 10, "frequency / importance →", "#64748b", "start", 11, 600));
  svg.appendChild(svgText(padL, H - padB + 60, "tools sorted by rank (low rank = core/popular, high rank = long-tail)", "#64748b", "start", 11, 500));
  svg.appendChild(svgLine(padL, H - padB, W - padR, H - padB, "#cbd5e1"));

  const barW = (W - padL - padR) / N - 4;
  orderedTools.forEach((t, i) => {
    const x = padL + i * (barW + 4);
    const y = yScale(freqs[i]);
    const c = stageColors[t.intro % stageColors.length];
    const r = svgRect(x, y, barW, (H - padB) - y, c, c, 3);
    r.appendChild(_svgTitle(`#${i + 1} ${t.tool} · introduced at T${t.intro + 1}`));
    svg.appendChild(r);
    // Vertical label rotated under bar
    const tx = x + barW / 2, ty = H - padB + 6;
    const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    lbl.setAttribute("x", tx); lbl.setAttribute("y", ty);
    lbl.setAttribute("transform", `rotate(45 ${tx} ${ty})`);
    lbl.setAttribute("fill", "#334155"); lbl.setAttribute("font-size", 9);
    lbl.setAttribute("text-anchor", "start");
    lbl.setAttribute("font-family", "ui-monospace, SFMono-Regular, Menlo, monospace");
    lbl.textContent = t.tool.length > 24 ? t.tool.slice(0, 24) + "…" : t.tool;
    svg.appendChild(lbl);
  });

  wrap.appendChild(svg);

  // Legend: stage colors
  const legend = el("div", { class: "construct-legend" });
  stages.forEach((s, i) => {
    legend.appendChild(
      el("span", { class: "item" }, [
        el("span", { class: "sw", style: `background:${stageColors[i % stageColors.length]}` }),
        `joins at ${s.name || `T${i + 1}`}`,
      ])
    );
  });
  wrap.appendChild(legend);

  // Inline narrative
  wrap.appendChild(
    el("div", { class: "muted small construct-note" },
      "Tools are collected from oracle annotations across all tasks, then sorted by frequency (or importance). " +
      "Core / popular tools come first; long-tail / edge-case APIs come later — this becomes the canonical rank used to define time steps."
    )
  );

  return constructStepCard(
    2,
    "Collect tools and rank them",
    "Pool all tools touched by any task's ground-truth Tᵢ. Rank them by frequency (or any importance metric). Core APIs come first, long-tail / edge-case APIs come last.",
    wrap
  );
}

// --- Step 3: cumulative catalogs C1 ⊂ C2 ⊂ … -----------------------------
function buildConstructStep3(stages, orderedTools) {
  const wrap = el("div", { class: "construct-step-body" });
  const stageColors = ["#3a6fb0", "#d97044", "#9b59b6", "#34d399", "#fbbf24", "#f87171", "#22d3ee", "#a78bfa"];

  // Visual: nested rings, each ring is a stage's catalog. Use real numbers.
  const sizes = stages.map((s) => s.num_cumulative_tools || (s.cumulative_tools || []).length);
  const W = 700, H = 300;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "construct-svg");
  svg.style.width = "100%"; svg.style.maxWidth = `${W}px`;
  svg.style.height = "auto";

  // Two columns: left = nested rings (with side legend), right = formula card
  const cx = 160, cy = 150, maxR = 100;
  const maxSize = Math.max(1, ...sizes);
  // Draw outermost first
  const ringInfo = [];
  stages.slice().reverse().forEach((s, revIdx) => {
    const i = stages.length - 1 - revIdx;
    const r = Math.max(20, maxR * Math.sqrt(sizes[i] / maxSize));
    const c = stageColors[i % stageColors.length];
    const circ = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circ.setAttribute("cx", cx); circ.setAttribute("cy", cy);
    circ.setAttribute("r", r);
    circ.setAttribute("fill", c);
    circ.setAttribute("fill-opacity", 0.18);
    circ.setAttribute("stroke", c);
    circ.setAttribute("stroke-width", 2);
    circ.appendChild(_svgTitle(`${s.name || `T${i + 1}`}: |C${i + 1}|=${sizes[i]} tools (+${s.num_new_tools || 0} new at this time step)`));
    svg.appendChild(circ);
    ringInfo.push({ i, r, c, name: s.name || `T${i + 1}`, size: sizes[i] });
  });
  // Legend on the right side of the rings: one row per ring, sorted small→large
  ringInfo.sort((a, b) => a.r - b.r);
  const legX = cx + maxR + 30;
  const legY0 = cy - (ringInfo.length * 22) / 2;
  ringInfo.forEach((ri, k) => {
    const ly = legY0 + k * 22;
    // swatch
    svg.appendChild(svgRect(legX, ly - 8, 14, 14, ri.c, ri.c, 3));
    svg.appendChild(svgText(legX + 22, ly + 4, `${ri.name}  |C${ri.i + 1}| = ${ri.size}`, ri.c, "start", 12, 700));
    // leader line from swatch back to ring edge (top point)
    const topX = cx, topY = cy - ri.r;
    const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
    ln.setAttribute("x1", legX); ln.setAttribute("y1", ly);
    ln.setAttribute("x2", topX + Math.cos(-Math.PI / 4) * ri.r);
    ln.setAttribute("y2", cy + Math.sin(-Math.PI / 4) * ri.r);
    ln.setAttribute("stroke", ri.c); ln.setAttribute("stroke-width", 0.6);
    ln.setAttribute("stroke-dasharray", "2 3");
    ln.setAttribute("opacity", 0.6);
    svg.appendChild(ln);
  });
  svg.appendChild(svgText(cx, cy + maxR + 28, "cumulative catalogs (real sizes)", "#64748b", "middle", 11, 500));

  // Formula card on right
  const fx = 440, fy = 36;
  svg.appendChild(svgRect(fx, fy, 240, 220, "#f8fafc", "#cbd5e1", 8));
  svg.appendChild(svgText(fx + 16, fy + 22, "CONSTRUCTION RULE", "#64748b", "start", 10, 700));
  svg.appendChild(svgText(fx + 16, fy + 48, "C₁ = top N₁ tools by rank", "#0f172a", "start", 13, 700));
  svg.appendChild(svgText(fx + 16, fy + 70, "C₂ = top N₂ tools  (N₂ > N₁)", "#0f172a", "start", 13, 700));
  svg.appendChild(svgText(fx + 16, fy + 92, "Cₖ = top Nₖ tools  (Nₖ ↑)", "#0f172a", "start", 13, 700));
  svg.appendChild(svgText(fx + 16, fy + 124, "⇒  C₁ ⊂ C₂ ⊂ … ⊂ Cₖ", "#ca8a04", "start", 16, 800));
  svg.appendChild(svgText(fx + 16, fy + 156, "(each time step strictly expands the previous catalog)", "#64748b", "start", 10));
  // Real numbers row
  const sizesStr = sizes.map((n, i) => `|C${i + 1}|=${n}`).join("  ⊂  ");
  svg.appendChild(svgText(fx + 16, fy + 184, sizesStr, "#047857", "start", 11, 700));

  wrap.appendChild(svg);

  return constructStepCard(
    3,
    "Define time steps as nested tool catalogs",
    "Time step Tₖ is realized as a tool catalog Cₖ — the top-Nₖ tools by rank. The sequence is nested: C₁ ⊂ C₂ ⊂ … ⊂ Cₖ. " +
      "Bigger catalogs simulate more capabilities (and more distractors).",
    wrap
  );
}

// --- Step 5: construction constraints + breath / depth -------------------
function buildConstructStep5(data) {
  const wrap = el("div", { class: "construct-step-body" });

  const stages = data.stages || [];
  const currentBenchmark = (data.benchmark || "").toLowerCase();

  // Compute live values for each constraint, so the user can see whether
  // the rendered domain actually satisfies them.
  const testCounts = stages.map((s) => s.num_test || 0);
  const adaptCounts = stages.map((s) => s.num_adapt || 0);
  const newToolCounts = stages.map((s) => s.num_new_tools || 0);
  const newTaskCounts = stages.map((s) => s.num_new_tasks || 0);

  const constraints = [
    {
      id: "c1",
      icon: "🧪",
      title: "Minimum test size per time step",
      desc: "Every Tₖ must ship enough test tasks so the evaluation matrix has well-resolved cells.",
      values: testCounts,
      label: "test tasks",
      threshold: 2,
      ok: testCounts.every((x) => x >= 2),
    },
    {
      id: "c2",
      icon: "🎓",
      title: "Minimum adaptation size per time step",
      desc: "Each Tₖ needs enough adapt examples so the agent (or memory) has something to learn from.",
      values: adaptCounts,
      label: "adapt tasks",
      threshold: 2,
      ok: adaptCounts.every((x) => x >= 2),
    },
    {
      id: "c3",
      icon: "🔧",
      title: "Minimum new-tool usage",
      desc: "Every newly introduced tool should appear in at least some task after it's added — otherwise the new capability is dead weight.",
      values: newToolCounts,
      label: "new tools",
      threshold: 1,
      ok: newToolCounts.every((x) => x >= 1),
    },
    {
      id: "c4",
      icon: "⚖",
      title: "Balanced growth",
      desc: "Avoid one time step dumping disproportionately many new tools or new tasks. Keeps time steps comparable.",
      values: newTaskCounts,
      label: "new tasks",
      threshold: null,
      ok: newTaskCounts.length > 1
        ? (Math.max(...newTaskCounts) / Math.max(1, Math.min(...newTaskCounts))) <= 8
        : true,
    },
    {
      id: "c5",
      icon: "🚫∅",
      title: "No empty evaluation time step",
      desc: "After all assignments, no Tₖ may end up with zero test tasks (every cell of the eval matrix is reachable).",
      values: testCounts,
      label: "test tasks",
      threshold: 1,
      ok: testCounts.every((x) => x >= 1),
    },
  ];

  // Constraint cards grid
  const grid = el("div", { class: "constraint-grid" });
  constraints.forEach((c) => {
    grid.appendChild(
      el("div", { class: "constraint-card " + (c.ok ? "ok" : "warn") }, [
        el("div", { class: "constraint-head" }, [
          el("span", { class: "constraint-icon" }, c.icon),
          el("span", { class: "constraint-title" }, c.title),
          el("span", { class: "constraint-badge" }, c.ok ? "✓ holds in this domain" : "⚠ check"),
        ]),
        el("div", { class: "muted small" }, c.desc),
        el(
          "div",
          { class: "constraint-values" },
          stages.map((s, i) =>
            el("span", { class: "constraint-pill " + (c.threshold != null && (c.values[i] ?? 0) < c.threshold ? "fail" : "pass") }, [
              el("span", { class: "constraint-pill-lbl" }, s.name || `T${i + 1}`),
              el("span", { class: "constraint-pill-val" }, String(c.values[i] ?? 0)),
            ])
          ).concat([el("span", { class: "constraint-pill-axis muted" }, c.label)])
        ),
      ])
    );
  });
  wrap.appendChild(grid);

  // The "complexity flat" optional constraint — explains breath vs depth.
  const isBreath = currentBenchmark === "breath";
  const isDepth = currentBenchmark === "depth";
  wrap.appendChild(
    el("div", { class: "breath-depth card" }, [
      el("div", { class: "breath-depth-title" }, [
        el("span", { class: "construct-rule-label" }, "Optional · Complexity-Flat"),
        el("span", { class: "muted small" }, "controls how task difficulty grows across time steps"),
      ]),
      el("div", { class: "breath-depth-row" }, [
        el(
          "div",
          { class: "breath-depth-cell" + (isBreath ? " active" : "") },
          [
            el("div", { class: "breath-depth-pill" }, ["breath", isBreath ? el("span", { class: "active-tag" }, "current") : null]),
            el("div", { class: "breath-depth-eq" }, "Complexity-Flat ON"),
            el(
              "div",
              { class: "muted small" },
              "Tasks at every Tₖ have roughly the same difficulty (similar |Tᵢ|, similar verifier load). The only thing that grows is the catalog — so drops measure pure tool-selection failure under distractors.",
            ),
          ]
        ),
        el(
          "div",
          { class: "breath-depth-cell" + (isDepth ? " active" : "") },
          [
            el("div", { class: "breath-depth-pill" }, ["depth", isDepth ? el("span", { class: "active-tag" }, "current") : null]),
            el("div", { class: "breath-depth-eq" }, "Complexity-Flat OFF"),
            el(
              "div",
              { class: "muted small" },
              "Tasks are allowed to grow more complex with each Tₖ (longer Tᵢ, more verifiers). Drops here mix catalog growth with intrinsic task difficulty — closer to real product workloads.",
            ),
          ]
        ),
      ]),
    ])
  );

  return constructStepCard(
    5,
    "Constraints applied during construction",
    "The scheduler runs assignment under several hard / soft constraints so each time step is a usable test bed. Pass/fail status below uses the current domain's actual numbers.",
    wrap
  );
}

// --- Step 4: assign tasks to earliest solvable time step --------------------
function buildConstructStep4(stages) {
  const wrap = el("div", { class: "construct-step-body" });

  // Diagram: 3 example tasks getting matched to T1/T2/T3.
  const W = 760, H = 260;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "construct-svg");
  svg.style.width = "100%"; svg.style.maxWidth = `${W}px`;
  svg.style.height = "auto";

  const stageColors = ["#3a6fb0", "#d97044", "#9b59b6", "#34d399", "#fbbf24"];

  // Left column: task icons with their Tᵢ chips
  const tasks = [
    { name: "task α", T: ["list_events"], assignedTo: 0 },
    { name: "task β", T: ["list_events", "update_event"], assignedTo: 1 },
    { name: "task γ", T: ["list_events", "update_event", "watch_events"], assignedTo: 2 },
  ];
  const tx0 = 18, ty0 = 22, tw = 220, th = 56, gap = 16;
  tasks.forEach((t, i) => {
    const ty = ty0 + i * (th + gap);
    svg.appendChild(svgRect(tx0, ty, tw, th, "#f8fafc", "#60a5fa", 8));
    svg.appendChild(svgText(tx0 + 10, ty + 18, t.name, "#1d4ed8", "start", 12, 700));
    svg.appendChild(svgText(tx0 + 10, ty + 34, "Tᵢ =", "#64748b", "start", 11));
    let chipX = tx0 + 42;
    t.T.forEach((tool) => {
      const tw2 = Math.max(60, tool.length * 6 + 12);
      svg.appendChild(svgRect(chipX, ty + 24, tw2, 14, "rgba(250,204,21,0.18)", "#ca8a04", 4));
      svg.appendChild(svgText(chipX + tw2 / 2, ty + 34, tool, "#92400e", "middle", 10));
      chipX += tw2 + 4;
    });
  });

  // Right column: stage columns showing whether T ⊆ Cₖ
  const stageBoxX0 = 320;
  const stageBoxW = (W - stageBoxX0 - 18) / Math.max(1, stages.length);
  // Header row
  svg.appendChild(svgText(stageBoxX0 + (W - stageBoxX0 - 18) / 2, 14, "Catalog Cₖ at each time step", "#64748b", "middle", 11, 700));
  // Each task row mapped
  tasks.forEach((t, i) => {
    const ty = ty0 + i * (th + gap);
    stages.forEach((s, k) => {
      const sx = stageBoxX0 + k * stageBoxW + 4;
      const sw = stageBoxW - 8;
      const ok = k >= t.assignedTo;
      const col = stageColors[k % stageColors.length];
      const fill = ok ? "rgba(52,211,153,0.18)" : "rgba(148,163,184,0.08)";
      const stroke = ok ? "#34d399" : "rgba(148,163,184,0.4)";
      svg.appendChild(svgRect(sx, ty, sw, th, fill, stroke, 6));
      svg.appendChild(svgText(sx + sw / 2, ty + 14, s.name || `T${k + 1}`, col, "middle", 11, 700));
      svg.appendChild(svgText(sx + sw / 2, ty + 32, ok ? "Tᵢ ⊆ Cₖ ✓" : "Tᵢ ⊄ Cₖ", ok ? "#047857" : "#64748b", "middle", 10, 600));
      if (k === t.assignedTo) {
        svg.appendChild(svgText(sx + sw / 2, ty + 48, "★ earliest", "#fbbf24", "middle", 9, 700));
      }
    });
  });

  wrap.appendChild(svg);

  // Rule callout below the diagram, in HTML so it can't overlap the SVG.
  wrap.appendChild(
    el("div", { class: "construct-rule" }, [
      el("span", { class: "construct-rule-label" }, "Assign rule"),
      el(
        "span",
        { class: "construct-rule-eq" },
        ["K(task i) = min{ k : Tᵢ ⊆ Cₖ }"]
      ),
      el(
        "span",
        { class: "construct-rule-note" },
        "task appears at the earliest time step that makes it solvable",
      ),
    ])
  );
  wrap.appendChild(
    el("div", { class: "muted small construct-note" },
      "Each task is placed at the earliest Tₖ whose catalog contains its required tools. So later time steps don't just have more tools — they also unlock new tasks that need those tools."
    )
  );

  return constructStepCard(
    4,
    "Assign each task to its earliest solvable time step",
    "For task i: K(i) = min{k : Tᵢ ⊆ Cₖ}. The capacity unlocked at Tₖ deterministically defines which tasks first appear there. " +
      "Earlier time steps get simpler tasks (small Tᵢ); later time steps get tasks that need newly-added tools.",
    wrap
  );
}

function evoStat(label, value) {
  return el("div", { class: "evo-stat" }, [
    el("div", { class: "evo-stat-lbl" }, label),
    el("div", { class: "evo-stat-val" }, value == null ? "—" : String(value)),
  ]);
}

function buildComplexityChart(data) {
  const wrap = el("div", { class: "evo-chart card" });
  wrap.appendChild(el("h3", { class: "evo-section-title" }, "Catalog growth & task complexity over time"));
  const stages = data.stages || [];
  if (!stages.length) {
    wrap.appendChild(el("div", { class: "muted" }, "No time steps."));
    return wrap;
  }
  // 4 metric series: |C| cumulative tools, +N new tools, avg tools/task, avg verifiers/task
  const W = Math.max(420, stages.length * 90);
  const H = 220;
  const padL = 50, padR = 80, padT = 18, padB = 36;
  const xs = stages.map((_, i) => padL + (i * (W - padL - padR)) / Math.max(1, stages.length - 1));
  const series = [
    { name: "|C| (cumulative tools)", color: "#60a5fa", values: stages.map((s) => s.num_cumulative_tools), yAxis: "left" },
    { name: "+N new tools", color: "#34d399", values: stages.map((s) => s.num_new_tools), yAxis: "left" },
    { name: "avg tools/task", color: "#f59e0b", values: stages.map((s) => s.tools_per_task?.mean ?? null), yAxis: "right" },
    { name: "avg verifiers/task", color: "#a78bfa", values: stages.map((s) => s.verifiers_per_task?.mean ?? null), yAxis: "right" },
  ];
  // Compute y ranges
  const leftVals = series.filter((s) => s.yAxis === "left").flatMap((s) => s.values).filter((v) => v != null);
  const rightVals = series.filter((s) => s.yAxis === "right").flatMap((s) => s.values).filter((v) => v != null);
  const leftMax = Math.max(1, ...leftVals);
  const rightMax = Math.max(1, ...rightVals);
  const yL = (v) => padT + (H - padT - padB) * (1 - v / leftMax);
  const yR = (v) => padT + (H - padT - padB) * (1 - v / rightMax);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "evo-svg");
  svg.style.width = "100%";
  svg.style.maxWidth = "100%";
  svg.style.height = `${H}px`;

  // Axes
  const axisL = mkSvgLine(padL, padT, padL, H - padB, "#cbd5e1");
  const axisR = mkSvgLine(W - padR, padT, W - padR, H - padB, "#cbd5e1");
  const axisB = mkSvgLine(padL, H - padB, W - padR, H - padB, "#cbd5e1");
  svg.appendChild(axisL); svg.appendChild(axisR); svg.appendChild(axisB);

  // X labels
  stages.forEach((s, i) => {
    const t = mkSvgText(xs[i], H - padB + 18, s.name || `T${i + 1}`, "#64748b", "middle");
    svg.appendChild(t);
  });
  // Y left ticks
  for (let k = 0; k <= 4; k++) {
    const v = Math.round((leftMax * k) / 4);
    const y = yL(v);
    svg.appendChild(mkSvgText(padL - 6, y + 3, String(v), "#64748b", "end", 10));
    svg.appendChild(mkSvgLine(padL, y, W - padR, y, "rgba(15,23,42,0.07)"));
  }
  // Y right ticks
  for (let k = 0; k <= 4; k++) {
    const v = ((rightMax * k) / 4).toFixed(1);
    const y = yR(parseFloat(v));
    svg.appendChild(mkSvgText(W - padR + 6, y + 3, v, "#64748b", "start", 10));
  }

  // Series
  series.forEach((ser) => {
    const yFn = ser.yAxis === "left" ? yL : yR;
    let prev = null;
    ser.values.forEach((v, i) => {
      if (v == null) { prev = null; return; }
      const cx = xs[i], cy = yFn(v);
      if (prev != null) {
        svg.appendChild(mkSvgLine(prev.x, prev.y, cx, cy, ser.color, 2));
      }
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", 3.5);
      c.setAttribute("fill", ser.color);
      svg.appendChild(c);
      // Value label
      const lbl = mkSvgText(cx, cy - 8, typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v), ser.color, "middle", 10);
      svg.appendChild(lbl);
      prev = { x: cx, y: cy };
    });
  });

  // Legend
  const legend = el("div", { class: "evo-legend" });
  series.forEach((ser) => {
    legend.appendChild(
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-dot", style: `background:${ser.color}` }, ""),
        `${ser.name} (${ser.yAxis === "left" ? "left axis" : "right axis"})`,
      ])
    );
  });

  wrap.appendChild(svg);
  wrap.appendChild(legend);
  return wrap;
}

function mkSvgLine(x1, y1, x2, y2, color, width = 1) {
  const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
  l.setAttribute("x1", x1); l.setAttribute("y1", y1);
  l.setAttribute("x2", x2); l.setAttribute("y2", y2);
  l.setAttribute("stroke", color); l.setAttribute("stroke-width", width);
  return l;
}
function mkSvgText(x, y, text, color, anchor = "start", size = 11) {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("fill", color); t.setAttribute("font-size", size);
  t.setAttribute("text-anchor", anchor);
  t.textContent = text;
  return t;
}

function buildToolTimeline(data) {
  const wrap = el("div", { class: "evo-timeline card" });
  wrap.appendChild(
    el("h3", { class: "evo-section-title" },
      `Tool catalog timeline — when each tool joined (${(data.tool_timeline || []).length} tools, ${data.num_stages} time steps)`
    )
  );
  const stages = data.stages || [];
  const rows = data.tool_timeline || [];
  if (!rows.length) {
    wrap.appendChild(el("div", { class: "muted" }, "No tools."));
    return wrap;
  }

  const table = el("table", { class: "evo-timeline-table" });
  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", { class: "tool-col" }, "Tool"));
  stages.forEach((s) => hr.appendChild(el("th", {}, s.name || "")));
  hr.appendChild(el("th", {}, "Intro"));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  rows.forEach((row) => {
    const tr = el("tr");
    tr.appendChild(el("td", { class: "tool-name" }, row.tool));
    row.presence.forEach((p) => {
      const td = el("td", { class: `cell cell-${p}` });
      td.title = `${row.tool} · ${p}`;
      if (p === "new") td.textContent = "●";
      else if (p === "present") td.textContent = "▪";
      else td.textContent = "";
      tr.appendChild(td);
    });
    tr.appendChild(
      el("td", { class: "intro-cell" }, stages[row.intro_stage]?.name || `T${row.intro_stage + 1}`)
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  // Legend
  wrap.appendChild(
    el("div", { class: "evo-legend" }, [
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-new" }, ""), "newly introduced"]),
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-present" }, ""), "present"]),
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-absent" }, ""), "absent"]),
    ])
  );
  return wrap;
}

function renderStagesSummary(summary) {
  const root = $("#ds-stages");
  root.innerHTML = "";
  const env = summary?.env_summary;
  if (!env) {
    root.appendChild(el("div", { class: "muted" }, "No env_summary."));
    return;
  }
  const head = el("div", { class: "section-header" }, [
    el("div", { class: "title" }, `${state.ds.bench} / ${state.ds.domain}`),
    el("div", { class: "sub" }, `${env.total_tasks ?? "?"} tasks · ${env.num_stages ?? env.stages?.length ?? 0} time steps · staging=${env.staging || "?"}`),
  ]);
  root.appendChild(head);
  (env.stages || []).forEach((s, i) => {
    const tools = s.cumulative_tools?.length ?? "?";
    const newTools = s.new_tools?.length ?? 0;
    const adapt = s.num_adapt ?? s.adapt_task_ids?.length ?? 0;
    const test = s.num_test ?? s.test_task_ids?.length ?? 0;
    root.appendChild(
      el("div", { class: "stage-pill" }, [
        el("span", { class: "lbl" }, `${i}. ${s.name || `T${i + 1}`}`),
        el("span", { class: "meta" }, `tools=${tools} (+${newTools}) · adapt=${adapt} · test=${test}`),
      ])
    );
  });
}

async function reloadTaskList() {
  const bench = $("#ds-benchmark").value;
  const domain = $("#ds-domain").value;
  const kind = $("#ds-kind").value;
  const stage = $("#ds-stage").value;
  const url = new URL(`/api/datasets/${bench}/${domain}/tasks`, location.origin);
  url.searchParams.set("kind", kind);
  if (stage !== "") url.searchParams.set("stage", stage);
  const data = await fetchJson(url);
  state.ds.tasks = data.tasks;
  renderTaskList();
}

function renderTaskList() {
  const filter = $("#ds-filter").value.toLowerCase();
  const list = $("#ds-task-list");
  list.innerHTML = "";
  const filtered = state.ds.tasks.filter(
    (t) => !filter || (t.task_id && t.task_id.toLowerCase().includes(filter)) || t.filename.toLowerCase().includes(filter)
  );
  $("#ds-task-count").textContent = `${filtered.length} / ${state.ds.tasks.length} tasks`;
  for (const t of filtered) {
    const li = el("li", { onclick: () => openTask(t) }, [
      t.stage != null
        ? el("span", { class: `badge stage-${t.stage}` }, `T${t.stage + 1}`)
        : el("span", { class: "badge" }, "—"),
      el("span", {}, t.task_id || t.filename),
    ]);
    li.dataset.filename = t.filename;
    list.appendChild(li);
  }
}

async function openTask(t) {
  $$("#ds-task-list li").forEach((li) => li.classList.toggle("active", li.dataset.filename === t.filename));
  const bench = $("#ds-benchmark").value;
  const domain = $("#ds-domain").value;
  const kind = $("#ds-kind").value;
  const detail = $("#ds-detail");
  detail.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const cfg = await fetchJson(
      `/api/datasets/${bench}/${domain}/tasks/${kind}/${encodeURIComponent(t.filename)}`
    );
    renderTaskDetail(detail, t, cfg);
  } catch (e) {
    detail.innerHTML = "";
    detail.appendChild(el("div", { class: "empty" }, String(e)));
  }
}

function renderTaskDetail(root, t, cfg) {
  root.innerHTML = "";
  const head = el("div", { class: "detail-section" }, [
    el("h2", {}, t.task_id || t.filename),
    el("div", { class: "muted" }, `${t.filename}${t.stage != null ? ` · T${t.stage + 1}` : ""}`),
  ]);
  root.appendChild(head);

  // Key/Value summary
  const rows = [];
  if (cfg.user_prompt != null) rows.push(["User prompt", cfg.user_prompt]);
  if (cfg.number_of_runs != null) rows.push(["Runs", cfg.number_of_runs]);
  if (cfg.reset_database_between_runs != null)
    rows.push(["Reset DB between runs", cfg.reset_database_between_runs ? "yes" : "no"]);
  if (cfg.mcp_endpoint) rows.push(["MCP endpoint", cfg.mcp_endpoint]);

  if (rows.length) {
    const grid = el("div", { class: "kv detail-section" });
    for (const [k, v] of rows) {
      grid.appendChild(el("div", { class: "k" }, k));
      grid.appendChild(el("div", { class: "v" }, String(v)));
    }
    root.appendChild(grid);
  }

  // Selected/Restricted tools
  const selected = cfg.selected_tools || [];
  const restricted = cfg.restricted_tools || [];
  if (selected.length || restricted.length) {
    const sec = el("div", { class: "detail-section" }, [
      el("h3", {}, `Tools (selected: ${selected.length}, restricted: ${restricted.length})`),
    ]);
    const wrap = el("div", {});
    selected.forEach((tn) => wrap.appendChild(el("span", { class: "tag tool" }, tn)));
    restricted.forEach((tn) => wrap.appendChild(el("span", { class: "tag tool restricted" }, `! ${tn}`)));
    sec.appendChild(wrap);
    root.appendChild(sec);
  }

  // Verifiers
  const verifiers = cfg.verifiers || [];
  if (verifiers.length) {
    const sec = el("div", { class: "detail-section" }, [el("h3", {}, `Verifiers (${verifiers.length})`)]);
    const tbl = el("table", { class: "verif" });
    tbl.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, "#"),
          el("th", {}, "Name"),
          el("th", {}, "Type"),
          el("th", {}, "Description"),
          el("th", {}, "Expected"),
          el("th", {}, "Compare"),
          el("th", {}, "Query / Config"),
        ]),
      ])
    );
    const tbody = el("tbody", {});
    verifiers.forEach((v, i) => {
      const vc = v.validation_config || {};
      tbody.appendChild(
        el("tr", {}, [
          el("td", {}, String(i + 1)),
          el("td", {}, v.name || ""),
          el("td", {}, v.verifier_type || ""),
          el("td", {}, v.description || ""),
          el("td", {}, vc.expected_value != null ? JSON.stringify(vc.expected_value) : ""),
          el("td", {}, vc.comparison_type || ""),
          el("td", { class: "query" }, vc.query || JSON.stringify(vc, null, 2)),
        ])
      );
    });
    tbl.appendChild(tbody);
    sec.appendChild(tbl);
    root.appendChild(sec);
  }

  // gym_servers_config
  if (cfg.gym_servers_config) {
    const det = el("details", { class: "collapse" }, [el("summary", {}, "Gym servers config"), el("pre", { class: "collapse-body" }, JSON.stringify(cfg.gym_servers_config, null, 2))]);
    root.appendChild(det);
  }

  // System prompt collapsible
  if (cfg.system_prompt) {
    const det = el("details", { class: "collapse" }, [
      el("summary", {}, "System prompt"),
      el("pre", { class: "collapse-body" }, cfg.system_prompt),
    ]);
    root.appendChild(det);
  }

  // Raw JSON
  const det = el("details", { class: "collapse" }, [el("summary", {}, "Raw config JSON"), el("pre", { class: "collapse-body" }, JSON.stringify(cfg, null, 2))]);
  root.appendChild(det);
}

// Wire dataset toolbar
$("#ds-benchmark").addEventListener("change", onBenchmarkChange);
$("#ds-domain").addEventListener("change", onDomainChange);
$("#ds-kind").addEventListener("change", reloadTaskList);
$("#ds-stage").addEventListener("change", reloadTaskList);
$("#ds-filter").addEventListener("input", () => renderTaskList());
$("#ds-modes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-ds-mode]");
  if (!b) return;
  setDatasetsMode(b.dataset.dsMode);
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
async function loadResults(path) {
  state.rs.path = path;
  const url = new URL("/api/results/tree", location.origin);
  if (path) url.searchParams.set("path", path);
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    toast(String(e), true);
    return;
  }
  renderBreadcrumb(path);
  const dlFolder = $("#rs-dl-folder");
  if (dlFolder) {
    dlFolder.href = `/api/results/download_zip?path=${encodeURIComponent(path || "")}`;
    dlFolder.title = path
      ? `Download "${path}" as .zip`
      : "Download the entire evolve_results folder as .zip";
  }
  renderTree(data);
  // Auto-render report view if present, else placeholder.
  if (data.flags.has_report_json || data.flags.has_metrics_json || data.flags.has_matrix_tsv) {
    renderRunSummary(path);
  } else {
    $("#rs-detail").innerHTML = "";
    $("#rs-detail").appendChild(
      el("div", { class: "empty" }, [
        path === "" ? "Top of evolve_results. Pick a run to drill in." : "No report.json here. Open a file on the left.",
      ])
    );
  }
}

function renderBreadcrumb(path) {
  const root = $("#rs-breadcrumb");
  root.innerHTML = "";
  root.appendChild(
    el("span", { class: "crumb", onclick: () => loadResults("") }, "evolve_results")
  );
  if (!path) return;
  const parts = path.split("/").filter(Boolean);
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    const partAcc = acc;
    root.appendChild(document.createTextNode(" / "));
    root.appendChild(el("span", { class: "crumb", onclick: () => loadResults(partAcc) }, p));
  }
}

// A small "↓" download control used in the Results browser tree. Stops click
// propagation so downloading doesn't also navigate into / open the item.
function downloadLink(href, title, label = "") {
  return el(
    "a",
    {
      class: "dl-btn",
      href,
      title,
      download: "",
      onclick: (e) => e.stopPropagation(),
    },
    [el("span", { class: "dl-ico" }, "↓"), label ? el("span", { class: "dl-lbl" }, label) : null]
  );
}

function renderTree(data) {
  const dirs = $("#rs-dirs");
  const files = $("#rs-files");
  dirs.innerHTML = "";
  files.innerHTML = "";

  for (const d of data.dirs) {
    const dirPath = state.rs.path ? `${state.rs.path}/${d}` : d;
    dirs.appendChild(
      el(
        "li",
        {
          onclick: () => loadResults(dirPath),
        },
        [
          el("span", { style: "flex:1" }, d),
          downloadLink(`/api/results/download_zip?path=${encodeURIComponent(dirPath)}`, "Download folder as .zip", "zip"),
        ]
      )
    );
  }
  for (const f of data.files) {
    const path = state.rs.path ? `${state.rs.path}/${f.name}` : f.name;
    const li = el(
      "li",
      {
        class: "file",
        onclick: () => openResultFile(path, f.name),
      },
      [
        el("span", { style: "flex:1" }, f.name),
        el("span", { class: "muted", style: "font-size:11px;font-family:inherit;" }, fmtBytes(f.size)),
        downloadLink(`/api/results/raw?path=${encodeURIComponent(path)}&download=1`, "Download file", ""),
      ]
    );
    li.dataset.path = path;
    files.appendChild(li);
  }
  if (!data.dirs.length && !data.files.length) {
    dirs.appendChild(el("li", { class: "muted" }, "(empty)"));
  }
}

$("#rs-up").addEventListener("click", () => {
  if (!state.rs.path) return;
  const parts = state.rs.path.split("/").filter(Boolean);
  parts.pop();
  loadResults(parts.join("/"));
});

// --- Results: Browser / CL Summary mode switcher ---------------------------
$("#rs-modes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-rs-mode]");
  if (!b) return;
  setResultsMode(b.dataset.rsMode);
});
$("#rs-sum-refresh").addEventListener("click", () => loadCLSummary(true));
$("#rs-sum-run").addEventListener("change", () => {
  state.rs.sum.run = $("#rs-sum-run").value;
  loadCLSummary(true);
});
$("#rs-sum-oracle").addEventListener("change", () => {
  state.rs.sum.oracleRun = $("#rs-sum-oracle").value;
  loadCLSummary(true);
});

function setResultsMode(mode) {
  state.rs.mode = mode;
  $$("#rs-modes [data-rs-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.rsMode === mode)
  );
  $(".rs-browser-tools").style.display = mode === "browser" ? "" : "none";
  $(".rs-summary-tools").style.display = mode === "summary" ? "" : "none";
  $("#rs-browser").style.display = mode === "browser" ? "" : "none";
  $("#rs-summary").style.display = mode === "summary" ? "" : "none";
  if (mode === "summary") initCLSummary();
  if (mode === "browser" && !state.rs._browserLoaded) {
    state.rs._browserLoaded = true;
    loadResults("");
  }
}

async function initCLSummary() {
  if (state.rs.sum._initialized) {
    if (!state.rs.sum.data) loadCLSummary(true);
    return;
  }
  state.rs.sum._initialized = true;
  let runs;
  try {
    runs = await fetchJson("/api/results/runs");
  } catch (e) {
    $("#rs-summary").innerHTML = `<div class="empty error">Failed to list runs: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const runSel = $("#rs-sum-run");
  const oracleSel = $("#rs-sum-oracle");
  runSel.innerHTML = "";
  // Default oracle dropdown to runs whose name contains "oracle"
  for (const r of runs.runs || []) {
    runSel.appendChild(el("option", { value: r.name }, r.name));
    oracleSel.appendChild(el("option", { value: r.name }, r.name));
  }
  // Prefer the canonical evolving run if present
  const prefer = (runs.runs || []).find((r) => /evolve.*tool|evoving_tools/i.test(r.name)) ||
                 (runs.runs || []).find((r) => !/oracle/i.test(r.name));
  if (prefer) runSel.value = prefer.name;
  state.rs.sum.run = runSel.value || null;
  // Auto-pick oracle run
  const autoOracle = (runs.runs || []).find((r) => /^oracle/i.test(r.name));
  if (autoOracle) oracleSel.value = ""; // keep "(auto)" since backend resolves it
  loadCLSummary(true);
}

async function loadCLSummary(force = false) {
  if (!state.rs.sum.run) return;
  const root = $("#rs-summary");
  if (state.rs.sum.loading) return;
  if (!force && state.rs.sum.data) return;
  state.rs.sum.loading = true;
  root.innerHTML = `<div class="empty">Loading continual-learning summary for <code>${escapeHtml(state.rs.sum.run)}</code>…</div>`;
  const params = new URLSearchParams({ run: state.rs.sum.run });
  if (state.rs.sum.oracleRun) params.set("oracle_run", state.rs.sum.oracleRun);
  let data;
  try {
    data = await fetchJson(`/api/results/cl_summary?${params.toString()}`);
  } catch (e) {
    root.innerHTML = `<div class="empty error">Failed to load CL summary: ${escapeHtml(e.message)}</div>`;
    state.rs.sum.loading = false;
    return;
  }
  state.rs.sum.data = data;
  state.rs.sum.loading = false;
  renderCLSummary(root, data);
}

function renderCLSummary(root, data) {
  root.innerHTML = "";
  // Header / legend
  const header = el("div", { class: "cl-header" });
  header.appendChild(
    el(
      "p",
      { class: "muted" },
      [
        `Run `,
        el("code", {}, data.run),
        data.oracle_run_used
          ? [` · Oracle data from `, el("code", {}, data.oracle_run_used)]
          : ` · No Oracle run found`,
        ". Each domain shows the four CL setups, the full lower-triangular result matrix, ",
        "and per-time-step Δ (= R[K,j] − R[j,j], i.e. final-time-step performance minus first-encounter, ",
        "averaged into Δ Final Avg).",
      ].flat()
    )
  );
  root.appendChild(header);

  // Continual learning protocol: explains how each row in the per-domain
  // tables below is produced (adapt → evaluate → matrix R[k, j]).
  root.appendChild(buildLearningProtocol());

  // 2×2 systems primer.
  root.appendChild(buildSystemsPrimer());

  if (!data.domains || data.domains.length === 0) {
    root.appendChild(el("div", { class: "empty" }, "No domains found in this run."));
    return;
  }

  for (const dom of data.domains) {
    root.appendChild(buildDomainCLTable(dom));
  }
}

function buildSystemsPrimer() {
  const card = el("details", { class: "primer card", open: "" });
  card.appendChild(
    el("summary", { class: "primer-summary" }, [
      el("span", { class: "primer-title" }, "The four systems · what each ablation tests"),
      el(
        "span",
        { class: "primer-tag" },
        "2×2 of (tool catalog) × (memory of past tasks)"
      ),
    ])
  );

  const grid = el("div", { class: "primer-grid" });
  // Top-left header
  grid.appendChild(el("div", { class: "primer-corner" }, ""));
  grid.appendChild(
    el("div", { class: "primer-colhead" }, [
      el("div", { class: "primer-axis-name" }, "Tool catalog: ORACLE"),
      el("div", { class: "primer-axis-desc" }, "Only the gold tools needed for the task. No distractors."),
    ])
  );
  grid.appendChild(
    el("div", { class: "primer-colhead" }, [
      el("div", { class: "primer-axis-name" }, "Tool catalog: CUMULATIVE"),
      el("div", { class: "primer-axis-desc" }, "All tools added through T₁..Tₖ. Model must pick the right one."),
    ])
  );
  // Row 1 header
  grid.appendChild(
    el("div", { class: "primer-rowhead" }, [
      el("div", { class: "primer-axis-name" }, "Memory: NONE"),
      el("div", { class: "primer-axis-desc" }, "Fresh chat. No past tasks visible."),
    ])
  );
  grid.appendChild(systemCell({
    key: "oracle",
    name: "Oracle Tool",
    color: "#60a5fa",
    role: "Upper bound",
    tests: "Pure capability ceiling",
    desc: "Only the correct tools are in the catalog and the agent has never seen any related task before. The cleanest possible signal — there is nothing to forget and nothing distracting.",
    isolates: ["tool selection: trivial", "tool usage only"],
  }));
  grid.appendChild(systemCell({
    key: "no_memory",
    name: "Cumulative Tool (No Memory)",
    color: "#f59e0b",
    role: "Plain CL baseline",
    tests: "Catalog growth in isolation",
    desc: "Tool catalog accumulates over T₁..Tₖ (more distractors at each time step) but the agent has no memory of past task examples. Drops here are pure tool-selection failures under growth.",
    isolates: ["tool selection ↑", "no memory"],
  }));
  // Row 2 header
  grid.appendChild(
    el("div", { class: "primer-rowhead" }, [
      el("div", { class: "primer-axis-name" }, "Memory: RAW past tasks"),
      el("div", { class: "primer-axis-desc" }, "Past task trajectories are appended to the context."),
    ])
  );
  grid.appendChild(systemCell({
    key: "adapt_oracle",
    name: "Oracle Tool + Raw Memory",
    color: "#a78bfa",
    role: "Memory-only effect",
    tests: "Does just-remembering help / hurt?",
    desc: "Same clean tool catalog as Oracle, but past task experiences are stuffed into the prompt. Isolates the cost/benefit of raw memory without the confound of catalog growth.",
    isolates: ["tool selection: trivial", "raw memory ✓"],
  }));
  grid.appendChild(systemCell({
    key: "adapt_fwd",
    name: "Cumulative Tool + Raw Memory",
    color: "#34d399",
    role: "Full system",
    tests: "Real-world combination",
    desc: "Cumulative catalog AND raw memory of past tasks. The realistic continual-learning agent. Wins here mean memory rescues selection under growth.",
    isolates: ["tool selection ↑", "raw memory ✓"],
  }));

  card.appendChild(grid);
  return card;
}

// ---------------------------------------------------------------------------
// Continual-learning protocol: how a single row of the per-domain CL table is
// produced.  Walks the reader through (1) adapt at each Tₖ, (2) evaluate on
// every prior+current test set, (3) the resulting lower-triangular matrix
// R[k, j], and (4) the metrics derived from it.
// ---------------------------------------------------------------------------
function buildLearningProtocol() {
  const card = el("details", { class: "protocol card", open: "" });
  card.appendChild(
    el("summary", { class: "protocol-summary" }, [
      el("span", { class: "protocol-title" }, "Continual learning protocol · how each row in the table below is produced"),
      el(
        "span",
        { class: "protocol-tag" },
        "adapt → evaluate (all prior tests) → matrix R[k, j]"
      ),
    ])
  );

  card.appendChild(
    el("p", { class: "muted protocol-intro" }, [
      "Time progresses T₁ → T₂ → … → Tₖ. ",
      "At each time step ", el("strong", {}, "Tₖ"),
      " the agent first ", el("strong", {}, "adapts"), " on a fresh training set ",
      el("code", {}, "Dₖᵃᵈᵃᵖᵗ"),
      " (tasks that became newly solvable when capability set ",
      el("code", {}, "Cₖ"),
      " was unlocked), then is ", el("strong", {}, "evaluated"), " on every accumulated test set ",
      el("code", {}, "Dⱼᵗᵉˢᵗ"),
      " for ", el("code", {}, "j ≤ k"),
      ". The (k, j) score is ", el("code", {}, "R[k, j]"),
      " — exactly the cells you see in each per-domain table below.",
    ])
  );

  card.appendChild(buildProtocolDiagram(4));
  card.appendChild(buildProtocolMetrics());
  return card;
}

// SVG: rows = k (adapt time), columns = j (eval test set). Matches the table
// orientation in `buildDomainCLTable`. Diagonal (k=j) highlights FWD; the
// bottom row (k=K) is what `BWT-final` and the Δ row compare against.
function buildProtocolDiagram(K = 4) {
  const wrap = el("div", { class: "protocol-diagram" });
  const SUB = "₁₂₃₄₅₆";

  const adaptW = 130;
  const adaptX = 70;
  const cellW = 122;
  const matrixX0 = adaptX + adaptW + 70;
  const W = matrixX0 + K * cellW + 180;

  const headerY = 40;
  const rowStartY = 64;
  const rowH = 50;
  const H = rowStartY + K * rowH + 70;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "protocol-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Continual learning protocol diagram");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="protoArrH" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#94a3b8"/>
    </marker>
    <marker id="protoArrV" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#94a3b8"/>
    </marker>
  `;
  svg.appendChild(defs);

  // Top axis label: "j → evaluation time"
  svg.appendChild(
    svgText(matrixX0 + (K * cellW) / 2, 16, "j  →   evaluation time (test set Dⱼᵗᵉˢᵗ)", "#64748b", "middle", 11, 600)
  );

  // Column headers (eval time)
  for (let j = 0; j < K; j++) {
    const cx = matrixX0 + j * cellW + cellW / 2;
    svg.appendChild(svgRect(matrixX0 + j * cellW + 4, headerY - 16, cellW - 8, 22, "#f1f5f9", "#cbd5e1", 5));
    svg.appendChild(svgText(cx, headerY - 1, `T${SUB[j]}`, "#0f172a", "middle", 13, 700));
  }

  // Left axis label: "k → adapt time"  (rotated)
  const yAx = document.createElementNS("http://www.w3.org/2000/svg", "text");
  yAx.setAttribute("x", 20);
  yAx.setAttribute("y", rowStartY + (K * rowH) / 2);
  yAx.setAttribute("fill", "#64748b");
  yAx.setAttribute("font-size", "11");
  yAx.setAttribute("font-weight", "600");
  yAx.setAttribute("text-anchor", "middle");
  yAx.setAttribute(
    "transform",
    `rotate(-90, 20, ${rowStartY + (K * rowH) / 2})`
  );
  yAx.textContent = "k  →   adapt time";
  svg.appendChild(yAx);

  // Time arrow on the very left, pointing downward
  const timeLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  timeLine.setAttribute("x1", 40); timeLine.setAttribute("y1", rowStartY + 6);
  timeLine.setAttribute("x2", 40); timeLine.setAttribute("y2", rowStartY + K * rowH - 6);
  timeLine.setAttribute("stroke", "#cbd5e1"); timeLine.setAttribute("stroke-width", 1.5);
  timeLine.setAttribute("marker-end", "url(#protoArrV)");
  svg.appendChild(timeLine);

  // Rows: one per adapt time k
  for (let k = 0; k < K; k++) {
    const ry = rowStartY + k * rowH;
    const cy = ry + rowH / 2;

    // -- adapt-on-Dₖ box --
    svg.appendChild(svgRect(adaptX, ry + 6, adaptW, rowH - 12, "#fff7ed", "#ea580c", 7));
    svg.appendChild(svgText(adaptX + adaptW / 2, cy - 4, `adapt on D${SUB[k]}ᵃ`, "#9a3412", "middle", 12, 700));
    svg.appendChild(svgText(adaptX + adaptW / 2, cy + 11, `(at time T${SUB[k]})`, "#9a3412", "middle", 10, 500));

    // arrow from adapt → first matrix cell
    const al = document.createElementNS("http://www.w3.org/2000/svg", "line");
    al.setAttribute("x1", adaptX + adaptW + 4);
    al.setAttribute("y1", cy);
    al.setAttribute("x2", matrixX0 - 2);
    al.setAttribute("y2", cy);
    al.setAttribute("stroke", "#94a3b8");
    al.setAttribute("stroke-width", 1.5);
    al.setAttribute("marker-end", "url(#protoArrH)");
    svg.appendChild(al);

    // small "evaluate" label over the arrow
    svg.appendChild(
      svgText((adaptX + adaptW + matrixX0) / 2, cy - 6, "then evaluate", "#64748b", "middle", 9, 600)
    );

    // matrix cells in this row
    for (let j = 0; j < K; j++) {
      const cx = matrixX0 + j * cellW;
      const isDiag = j === k;
      const inLowerTri = j <= k;
      const isFinalRow = k === K - 1;

      if (!inLowerTri) {
        // future test set — not evaluable yet
        const r = svgRect(cx + 4, ry + 6, cellW - 8, rowH - 12, "transparent", "#e2e8f0", 7);
        r.setAttribute("stroke-dasharray", "4 4");
        svg.appendChild(r);
        svg.appendChild(svgText(cx + cellW / 2, cy + 3, "— not yet —", "#cbd5e1", "middle", 10, 500));
        continue;
      }

      let bg, stroke, fg, badge;
      if (isDiag) {
        bg = "#dbeafe"; stroke = "#2563eb"; fg = "#1e40af"; badge = "FWD";
      } else if (isFinalRow) {
        bg = "#ede9fe"; stroke = "#7c3aed"; fg = "#6d28d9"; badge = "→ Δ";
      } else {
        bg = "#f5f3ff"; stroke = "#a78bfa"; fg = "#6d28d9"; badge = "";
      }
      const r = svgRect(cx + 4, ry + 6, cellW - 8, rowH - 12, bg, stroke, 7);
      r.setAttribute("stroke-width", isDiag || isFinalRow ? 1.6 : 1);
      svg.appendChild(r);
      svg.appendChild(svgText(cx + cellW / 2, cy - 3, `R[${k + 1}, ${j + 1}]`, fg, "middle", 12, 700));
      if (badge) {
        svg.appendChild(svgText(cx + cellW / 2, cy + 13, badge, fg, "middle", 9.5, 700));
      }
    }
  }

  // Right-side annotations (FWD diagonal & BWT-final)
  const annX = matrixX0 + K * cellW + 16;
  // FWD swatch + label (at row 0 = diagonal start)
  svg.appendChild(svgRect(annX, rowStartY + 12, 14, 14, "#dbeafe", "#2563eb", 3));
  svg.appendChild(svgText(annX + 20, rowStartY + 23, "FWD = R[k, k]", "#1e40af", "start", 11, 700));
  svg.appendChild(svgText(annX + 20, rowStartY + 36, "diagonal — current-time perf", "#64748b", "start", 9.5, 500));

  // BWT-final swatch + label (at last row)
  const bwtY = rowStartY + (K - 1) * rowH + 12;
  svg.appendChild(svgRect(annX, bwtY, 14, 14, "#ede9fe", "#7c3aed", 3));
  svg.appendChild(svgText(annX + 20, bwtY + 11, "BWT-final", "#6d28d9", "start", 11, 700));
  svg.appendChild(svgText(annX + 20, bwtY + 24, "row K vs diagonal R[j, j]", "#64748b", "start", 9.5, 500));

  // Below-matrix footer: arrows hint where the Δ row in the table comes from.
  const footY = rowStartY + K * rowH + 18;
  svg.appendChild(
    svgText(
      adaptX,
      footY,
      "Per-time-step Δⱼ in the table = R[K, j] − R[j, j]  (final-time retention vs first-encounter; negative = forgetting).",
      "#475569",
      "start",
      11,
      500
    )
  );
  svg.appendChild(
    svgText(
      adaptX,
      footY + 16,
      "Δ Final Avg = mean of those Δⱼ across j < K.",
      "#475569",
      "start",
      11,
      500
    )
  );

  wrap.appendChild(svg);
  return wrap;
}

function buildProtocolMetrics() {
  const wrap = el("div", { class: "protocol-metrics" });

  const items = [
    {
      label: "Fwd Avg (diag)",
      formula: "(1 / K) · Σₖ R[k, k]",
      desc: "How well each Tₖ task is solved at its own time step. Pure capability acquisition signal.",
      tone: "blue",
    },
    {
      label: "Final Avg",
      formula: "(1 / K) · Σⱼ R[K, j]",
      desc: "Average over the last-time-step row R[K, ·]. Where the agent ends up overall.",
      tone: "purple",
    },
    {
      label: "Δⱼ (per-time-step)",
      formula: "R[K, j] − R[j, j],   j < K",
      desc: "Last-row retention vs first-encounter. Negative ⇒ catastrophic forgetting on Tⱼ tasks.",
      tone: "purpleDark",
    },
    {
      label: "Δ Final Avg",
      formula: "avgⱼ<K  (R[K, j] − R[j, j])",
      desc: "Single number that summarizes net forgetting across all earlier time steps.",
      tone: "purpleDark",
    },
  ];

  for (const it of items) {
    const card = el("div", { class: `protocol-metric tone-${it.tone}` }, [
      el("div", { class: "protocol-metric-head" }, [
        el("span", { class: "protocol-metric-label" }, it.label),
        el("code", { class: "protocol-metric-formula" }, it.formula),
      ]),
      el("div", { class: "protocol-metric-desc" }, it.desc),
    ]);
    wrap.appendChild(card);
  }
  return wrap;
}

// Stage colors for tool chips: gold = "this task's correct tool", grey = distractors.
function systemCell({ key, name, color, role, tests, desc, isolates }) {
  const oracleCatalog = key === "oracle" || key === "adapt_oracle";
  const hasMemory = key === "adapt_oracle" || key === "adapt_fwd";

  const cell = el("div", { class: "primer-cell", "data-system": key }, [
    buildSystemFigure({ oracleCatalog, hasMemory, color }),
    el("div", { class: "primer-cell-head" }, [
      el("span", { class: "primer-dot", style: `background:${color}` }, ""),
      el("span", { class: "primer-cell-name" }, name),
    ]),
    el("div", { class: "primer-cell-role", style: `color:${color}` }, role),
    el("div", { class: "primer-cell-tests" }, tests),
    el("div", { class: "primer-cell-desc" }, desc),
    el(
      "div",
      { class: "primer-cell-tags" },
      isolates.map((t) => el("span", { class: "primer-cell-tag" }, t))
    ),
  ]);
  return cell;
}

function buildSystemFigure({ oracleCatalog, hasMemory, color }) {
  const W = 300, H = 230;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "primer-figure");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const gold = "#ca8a04";
  const grey = "rgba(148,163,184,0.55)";
  const good = "#34d399";
  const bad = "#f87171";
  const purple = "#a78bfa";
  const txtMuted = "#64748b";

  // Arrow marker defs (one per fig, color-matched to system).
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const arrowId = `arr-${Math.random().toString(36).slice(2, 9)}`;
  defs.innerHTML = `<marker id="${arrowId}" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${color}"/></marker>`;
  svg.appendChild(defs);

  // ============ 1. Tool catalog box (top)
  const tx = 8, ty = 8, tw = W - 16, th = 60;
  svg.appendChild(svgRect(tx, ty, tw, th, "#f8fafc", "rgba(96,165,250,0.35)", 8));
  svg.appendChild(svgText(tx + 8, ty + 14, "TOOL CATALOG", txtMuted, "start", 9, 700));
  svg.appendChild(
    svgText(
      tx + tw - 8,
      ty + 14,
      oracleCatalog ? "ORACLE — just the gold tools" : "CUMULATIVE — all T₁..Tₖ tools",
      oracleCatalog ? gold : "#60a5fa",
      "end",
      9,
      700
    )
  );

  const chipR = 6, chipGapX = 4, chipGapY = 4;
  const chipsAreaX = tx + 10, chipsAreaY = ty + 22;
  const chipsCols = Math.floor((tw - 20) / (chipR * 2 + chipGapX));
  const tools = [];
  for (let i = 0; i < 3; i++) tools.push({ kind: "gold", title: `gold tool ${i + 1}` });
  if (!oracleCatalog) for (let i = 0; i < 17; i++) tools.push({ kind: "grey", title: `distractor ${i + 1}` });
  tools.forEach((t, i) => {
    const col = i % chipsCols, row = Math.floor(i / chipsCols);
    const cx = chipsAreaX + col * (chipR * 2 + chipGapX) + chipR;
    const cy = chipsAreaY + row * (chipR * 2 + chipGapY) + chipR;
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", chipR);
    c.setAttribute("fill", t.kind === "gold" ? gold : grey);
    c.setAttribute("class", t.kind === "gold" ? "fig-chip fig-gold" : "fig-chip fig-grey");
    c.appendChild(_svgTitle(t.title));
    svg.appendChild(c);
  });

  // ============ 2. Raw memory box
  const mx = 8, my = 74, mw = W - 16, mh = 64;
  svg.appendChild(svgRect(mx, my, mw, mh, "#f8fafc", "rgba(167,139,250,0.35)", 8));
  svg.appendChild(svgText(mx + 8, my + 14, "RAW MEMORY", txtMuted, "start", 9, 700));
  if (hasMemory) {
    svg.appendChild(
      svgText(mx + mw - 8, my + 14, "all past adapt-set tasks · successes + failures", purple, "end", 8.5, 700)
    );
    // 4 memory entries with success/failure tags. Show "task → tools → ✓/✗".
    const entries = [
      { ok: true,  tools: ["▪", "▪"],     label: "task #1" },
      { ok: false, tools: ["▪", "▪", "▪"], label: "task #2" },
      { ok: true,  tools: ["▪"],          label: "task #3" },
      { ok: true,  tools: ["▪", "▪"],     label: "task #4" },
    ];
    const eY = my + 22;
    const eW = (mw - 12) / entries.length - 4;
    entries.forEach((e, i) => {
      const eX = mx + 6 + i * (eW + 4);
      const c = e.ok ? good : bad;
      svg.appendChild(svgRect(eX, eY, eW, 36, e.ok ? "rgba(52,211,153,0.14)" : "rgba(248,113,113,0.16)", c, 4));
      // tag chip
      svg.appendChild(svgText(eX + 4, eY + 10, e.label, "#334155", "start", 8.5, 600));
      svg.appendChild(svgText(eX + eW - 4, eY + 10, e.ok ? "✓" : "✗", c, "end", 11, 700));
      // tiny tool-icon row
      e.tools.forEach((sym, j) => {
        const tch = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        tch.setAttribute("cx", eX + 6 + j * 7);
        tch.setAttribute("cy", eY + 22);
        tch.setAttribute("r", 2.5);
        tch.setAttribute("fill", gold);
        svg.appendChild(tch);
      });
      // result label
      svg.appendChild(
        svgText(
          eX + eW / 2,
          eY + 32,
          e.ok ? "what worked" : "why it failed",
          e.ok ? "rgba(167,243,208,0.85)" : "rgba(252,165,165,0.85)",
          "middle",
          7.5,
          600
        )
      );
      // Title hover with full description
      const grpTitle = _svgTitle(
        e.ok
          ? `Stored ${e.label}: SUCCEEDED. Includes user prompt, tools used, full tool-call sequence with arguments and outcomes.`
          : `Stored ${e.label}: FAILED. Includes user prompt, full tool-call sequence with errors, failure reason, and failed-verifier details so the agent can avoid the same mistake.`
      );
      svg.lastChild.appendChild(grpTitle);
    });
  } else {
    svg.appendChild(svgText(mx + mw - 8, my + 14, "∅  none", txtMuted, "end", 9, 700));
    svg.appendChild(svgText(mx + mw / 2, my + 38, "fresh chat — no past tasks injected", txtMuted, "middle", 10));
  }

  // ============ 3. Agent multi-turn trajectory (bottom)
  const ax = 8, ay = 144, aw = W - 16, ah = 78;
  svg.appendChild(svgRect(ax, ay, aw, ah, "#f8fafc", color, 8));
  svg.appendChild(svgText(ax + 8, ay + 14, "AGENT · multi-turn trajectory", txtMuted, "start", 9, 700));

  // Steps left→right: user → LLM → tool → LLM → tool → LLM → result
  const steps = [
    { kind: "user", label: "user task", short: "user" },
    { kind: "llm",  label: "LLM picks a tool", short: "LLM" },
    { kind: "tool", label: "tool call ✓", short: "tool", ok: true },
    { kind: "llm",  label: "LLM thinks", short: "LLM" },
    { kind: "tool", label: "tool call ✓", short: "tool", ok: true },
    { kind: "llm",  label: "LLM answers", short: "LLM" },
    { kind: "result", label: "result", short: "✓" },
  ];
  const sy = ay + 38;
  const innerW = aw - 16;
  const stepW = innerW / steps.length - 4;
  const stepH = 22;
  steps.forEach((s, i) => {
    const sx = ax + 8 + i * (stepW + 4);
    let fill = "rgba(96,165,250,0.16)", stroke = "rgba(96,165,250,0.45)", txt = "#1d4ed8";
    if (s.kind === "llm") { fill = "rgba(96,165,250,0.20)"; stroke = "rgba(96,165,250,0.65)"; txt = "#1d4ed8"; }
    if (s.kind === "tool") { fill = "rgba(250,204,21,0.16)"; stroke = "rgba(250,204,21,0.55)"; txt = "#92400e"; }
    if (s.kind === "result") { fill = "rgba(52,211,153,0.18)"; stroke = good; txt = "#047857"; }
    if (s.kind === "user") { fill = "rgba(148,163,184,0.15)"; stroke = "rgba(148,163,184,0.5)"; txt = "#334155"; }
    const r = svgRect(sx, sy, stepW, stepH, fill, stroke, 4);
    r.appendChild(_svgTitle(s.label));
    svg.appendChild(r);
    svg.appendChild(svgText(sx + stepW / 2, sy + 15, s.short, txt, "middle", 9.5, 600));
    // arrow to next
    if (i < steps.length - 1) {
      const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
      ln.setAttribute("x1", sx + stepW);
      ln.setAttribute("y1", sy + stepH / 2);
      ln.setAttribute("x2", sx + stepW + 4);
      ln.setAttribute("y2", sy + stepH / 2);
      ln.setAttribute("stroke", color);
      ln.setAttribute("stroke-width", 1.2);
      ln.setAttribute("marker-end", `url(#${arrowId})`);
      svg.appendChild(ln);
    }
  });

  // "Turn 1 / Turn 2 / Final" annotations under the rows
  const annY = sy + stepH + 12;
  svg.appendChild(svgText(ax + 8 + (stepW + 4) * 1.5, annY, "Turn 1", txtMuted, "middle", 8.5, 600));
  svg.appendChild(svgText(ax + 8 + (stepW + 4) * 3.5, annY, "Turn 2", txtMuted, "middle", 8.5, 600));
  svg.appendChild(svgText(ax + 8 + (stepW + 4) * 5.5, annY, "Final", txtMuted, "middle", 8.5, 600));

  return svg;
}

function svgRect(x, y, w, h, fill, stroke, rx = 4) {
  const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  r.setAttribute("x", x); r.setAttribute("y", y);
  r.setAttribute("width", w); r.setAttribute("height", h);
  r.setAttribute("rx", rx);
  r.setAttribute("fill", fill); r.setAttribute("stroke", stroke);
  r.setAttribute("stroke-width", 1);
  return r;
}
function svgText(x, y, text, fill, anchor = "start", size = 11, weight = 400) {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("fill", fill); t.setAttribute("font-size", size);
  t.setAttribute("text-anchor", anchor);
  if (weight !== 400) t.setAttribute("font-weight", weight);
  t.setAttribute("font-family", "ui-sans-serif, system-ui, -apple-system, sans-serif");
  t.textContent = text;
  return t;
}
function _svgTitle(s) {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
  t.textContent = s;
  return t;
}

function buildDomainCLTable(dom) {
  const wrap = el("div", { class: "cl-domain card" });
  const K = Math.max(
    0,
    ...dom.setups.filter((s) => s.available).map((s) => s.num_stages || s.K || 0)
  );

  wrap.appendChild(
    el("h3", { class: "cl-title" }, `${dom.domain}  (K = ${K})`)
  );

  const table = el("table", { class: "cl-matrix" });
  const thead = el("thead");
  const headRow = el("tr");
  headRow.appendChild(el("th", { class: "setup-col" }, "Setup"));
  for (let j = 0; j < K; j++) headRow.appendChild(el("th", {}, `T${j + 1}`));
  headRow.appendChild(el("th", { class: "summary-col" }, "Final Avg"));
  headRow.appendChild(el("th", { class: "summary-col" }, "Fwd Avg (Diag)"));
  headRow.appendChild(el("th", { class: "note-col" }, "Note"));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const setup of dom.setups) {
    appendSetupBlock(tbody, setup, K);
  }
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

function appendSetupBlock(tbody, setup, K) {
  if (!setup.available) {
    const tr = el("tr", { class: "cl-row missing" });
    tr.appendChild(el("td", { class: "setup-label" }, setup.setup_label));
    tr.appendChild(
      el("td", { colspan: String(K + 3), class: "muted" }, "(not available for this domain)")
    );
    tbody.appendChild(tr);
    return;
  }
  const mat = setup.results_matrix || [];

  // Oracle: collapse to a single row of diagonal values (no Δ row).
  if (setup.is_baseline) {
    const tr = el("tr", { class: "cl-row oracle-row" });
    const labelTd = el("td", { class: "setup-label" });
    labelTd.appendChild(el("div", { class: "setup-name" }, setup.setup_label));
    labelTd.appendChild(el("div", { class: "setup-tag" }, "first-encounter only"));
    tr.appendChild(labelTd);
    for (let j = 0; j < K; j++) {
      const cell = (mat[j] || [])[j];
      tr.appendChild(renderMatrixCell(cell, true));
    }
    tr.appendChild(renderStatCell(setup.final_avg));
    tr.appendChild(renderStatCell(setup.fwd_avg));
    tr.appendChild(el("td", { class: "note-cell" }, setup.note || ""));
    tbody.appendChild(tr);
    return;
  }

  const Krows = mat.length;

  // Render one tr per adapt stage k (0..Krows-1); label only on first row
  for (let k = 0; k < Krows; k++) {
    const tr = el("tr", { class: "cl-row" });
    if (k === 0) {
      const td = el("td", { class: "setup-label", rowspan: String(Krows + 1) });
      td.appendChild(el("div", { class: "setup-name" }, setup.setup_label));
      if (setup.is_baseline) td.appendChild(el("div", { class: "setup-tag" }, "first-encounter only"));
      tbody.appendChild(tr);
      tr.appendChild(td);
    }
    for (let j = 0; j < K; j++) {
      const cell = (mat[k] || [])[j];
      tr.appendChild(renderMatrixCell(cell, k === j));
    }
    // Final Avg / Fwd Avg / Note only on the *last* data row of this setup
    if (k === Krows - 1) {
      tr.appendChild(renderStatCell(setup.final_avg));
      tr.appendChild(renderStatCell(setup.fwd_avg));
      tr.appendChild(
        el("td", { class: "note-cell" }, setup.note || "")
      );
    } else {
      tr.appendChild(el("td", {}, ""));
      tr.appendChild(el("td", {}, ""));
      tr.appendChild(el("td", {}, ""));
    }
    if (k > 0) tbody.appendChild(tr);
  }

  // Δ row (skip oracle / setups without per-time-step deltas)
  const deltaTr = el("tr", { class: "cl-row delta-row" });
  const dmap = {};
  for (const d of setup.per_stage_delta || []) dmap[d.j] = d.delta;
  // No left-label cell (rowspan from above already covers it). Actually
  // we used rowspan = Krows + 1 to include this delta row.
  // Now per-time-step delta cells:
  for (let j = 0; j < K; j++) {
    if (j in dmap) {
      deltaTr.appendChild(renderDeltaCell(dmap[j]));
    } else {
      deltaTr.appendChild(el("td", { class: "delta-cell" }, ""));
    }
  }
  // Δ Final Avg in the Final Avg column, blank Fwd Avg, narrative note
  deltaTr.appendChild(renderDeltaCell(setup.delta_final_avg, true));
  deltaTr.appendChild(el("td", { class: "delta-cell" }, ""));
  const vsNote = (setup.delta_vs_baseline != null)
    ? `Δ vs ${modeLabel("no_memory", "short")}: ${signedPct(setup.delta_vs_baseline)} · ${setup.note || ""}`
    : (setup.note || "");
  deltaTr.appendChild(el("td", { class: "note-cell" }, vsNote));
  tbody.appendChild(deltaTr);
}

function renderMatrixCell(cell, isDiag) {
  const td = el("td", { class: "matrix-cell" + (isDiag ? " diag" : "") });
  if (!cell || cell.mean == null) {
    td.appendChild(el("span", { class: "muted" }, ""));
    return td;
  }
  const m = cell.mean;
  const s = cell.std;
  td.appendChild(el("span", { class: "m" }, fmtPct(m)));
  if (s != null) {
    td.appendChild(el("span", { class: "pm" }, "±"));
    td.appendChild(el("span", { class: "s" }, fmtPct(s)));
  }
  return td;
}

function renderStatCell(v) {
  const td = el("td", { class: "stat-cell" });
  td.textContent = v == null ? "—" : fmtPct(v);
  return td;
}

function renderDeltaCell(v, bold = false) {
  const td = el("td", { class: "delta-cell" + (bold ? " strong" : "") });
  if (v == null) {
    td.textContent = "";
    return td;
  }
  const pct = v * 100;
  td.textContent = (v >= 0 ? "+" : "") + pct.toFixed(1) + " pp";
  // diverging color: green for positive (improvement), red for negative (drop)
  const a = Math.min(1, Math.abs(pct) / 20);
  td.style.backgroundColor = v >= 0
    ? `rgba(56, 161, 105, ${0.12 + 0.4 * a})`
    : `rgba(229, 62, 62, ${0.12 + 0.4 * a})`;
  return td;
}

function signedPct(v) {
  if (v == null) return "—";
  const p = v * 100;
  return (p >= 0 ? "+" : "") + p.toFixed(1) + " pp";
}

function heatColor(v, alphaScale = 0.6) {
  // v in [0,1] → light red (0) to light green (1) via white center
  if (v == null) return "transparent";
  const x = Math.max(0, Math.min(1, v));
  if (x >= 0.5) {
    const a = (x - 0.5) * 2 * alphaScale;
    return `rgba(56, 161, 105, ${a.toFixed(3)})`;
  } else {
    const a = (0.5 - x) * 2 * alphaScale;
    return `rgba(229, 62, 62, ${a.toFixed(3)})`;
  }
}

async function renderRunSummary(path) {
  const detail = $("#rs-detail");
  detail.innerHTML = `<div class="empty">Loading run summary…</div>`;
  let data;
  try {
    data = await fetchJson(`/api/results/run_summary?path=${encodeURIComponent(path)}`);
  } catch (e) {
    detail.innerHTML = "";
    detail.appendChild(el("div", { class: "empty" }, String(e)));
    return;
  }
  detail.innerHTML = "";
  detail.appendChild(el("h2", {}, path || "evolve_results"));
  detail.appendChild(el("div", { class: "muted" }, "auto-aggregated run summary"));

  // Matrix from report.json
  if (data.report_json) {
    detail.appendChild(buildReportSection(data.report_json));
  }

  // Metrics tiles from metrics.json
  if (data.metrics_json) {
    detail.appendChild(buildMetricsSection(data.metrics_json));
  }

  // env_summary
  if (data.env_summary) {
    const det = el("details", { class: "collapse" }, [
      el("summary", {}, "env_summary.json"),
      el("pre", { class: "collapse-body" }, JSON.stringify(data.env_summary, null, 2)),
    ]);
    detail.appendChild(det);
  }

  // report_txt (continual learning summary)
  if (data.report_txt) {
    const det = el("details", { class: "collapse", open: "open" }, [
      el("summary", {}, "report.txt"),
      el("pre", { class: "collapse-body" }, data.report_txt),
    ]);
    detail.appendChild(det);
  }

  // matrix_tsv
  if (data.matrix_tsv) {
    const det = el("details", { class: "collapse" }, [
      el("summary", {}, "matrix.tsv (raw)"),
      el("pre", { class: "collapse-body" }, data.matrix_tsv),
    ]);
    detail.appendChild(det);
  }

  if (data.report_tsv) {
    const det = el("details", { class: "collapse" }, [
      el("summary", {}, "report.tsv (raw)"),
      el("pre", { class: "collapse-body" }, data.report_tsv),
    ]);
    detail.appendChild(det);
  }
}

function buildReportSection(report) {
  const root = el("div", { class: "detail-section" });
  root.appendChild(el("h3", {}, "Continual learning matrix (mean ± std)"));
  const matrix = report.results_matrix || [];
  const n = report.num_stages || matrix.length;
  const wrap = el("div", { class: "matrix-wrap" });
  const tbl = el("table", { class: "matrix" });
  const thead = el("thead", {});
  const head = el("tr", {}, [el("th", {}, "Adapt \\ Eval")]);
  for (let j = 0; j < n; j++) head.appendChild(el("th", {}, `eval ${j}`));
  thead.appendChild(head);
  tbl.appendChild(thead);
  const tbody = el("tbody", {});
  for (let i = 0; i < n; i++) {
    const tr = el("tr", {}, [el("th", {}, `adapt ${i}`)]);
    for (let j = 0; j < n; j++) {
      const c = matrix[i]?.[j];
      if (c) {
        tr.appendChild(
          el("td", { class: "cell-data", title: `n=${c.n}` }, `${fmtPct(c.mean)} ± ${fmtPct(c.std)}`)
        );
      } else {
        tr.appendChild(el("td", { class: "cell-empty" }, "—"));
      }
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  root.appendChild(wrap);
  return root;
}

function buildMetricsSection(metrics) {
  const root = el("div", { class: "detail-section" });
  root.appendChild(el("h3", {}, "Per (adapt time-step k, eval time-step j) cell metrics"));

  const cells = Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b));
  if (!cells.length) {
    root.appendChild(el("div", { class: "muted" }, "Empty metrics."));
    return root;
  }

  // Tile grid showing the diagonal first.
  const tiles = el("div", { class: "metrics-grid" });
  for (const [k, v] of cells) {
    const tile = el("div", { class: "metric-tile" }, [
      el("div", { class: "lbl" }, `cell ${k} (${v.num_tasks} tasks · ${v.num_runs ?? 1} runs)`),
      el("div", { class: "val" }, fmtPct(v.success_rate)),
      el(
        "div",
        { class: "muted", style: "font-size:11px;margin-top:2px;" },
        `verifier: ${fmtPct(v.verifier_pass_rate)}`
      ),
    ]);
    tiles.appendChild(tile);
  }
  root.appendChild(tiles);

  // Per-task table for each cell as collapsible
  for (const [k, v] of cells) {
    const det = el("details", { class: "collapse" }, [
      el("summary", {}, `cell ${k} — per task (n=${v.num_tasks})`),
    ]);
    const body = el("div", { class: "collapse-body" });
    const tbl = el("table", { class: "verif" });
    tbl.appendChild(
      el("thead", {}, [
        el("tr", {}, [el("th", {}, "task_id"), el("th", {}, "success"), el("th", {}, "pass_rate")]),
      ])
    );
    const tbody = el("tbody", {});
    (v.per_task || []).forEach((t) => {
      tbody.appendChild(
        el("tr", {}, [
          el("td", {}, t.task_id || ""),
          el(
            "td",
            {},
            el("span", { class: `pill ${t.success ? "pass" : "fail"}` }, t.success ? "pass" : "fail")
          ),
          el("td", {}, fmtPct(t.pass_rate)),
        ])
      );
    });
    tbl.appendChild(tbody);
    body.appendChild(tbl);
    det.appendChild(body);
    root.appendChild(det);
  }
  return root;
}

// Extensions the browser can render inline as <img>. PNGs (and friends) must
// NOT go through /api/results/file, which reads bytes as text and dumps raw
// binary into a <pre>. Serve them from /api/results/raw (FileResponse →
// correct image/* content-type) instead.
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"];

function fileExt(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

async function openResultFile(path, name) {
  $$("#rs-files li").forEach((li) => li.classList.toggle("active", li.dataset.path === path));
  const detail = $("#rs-detail");

  // Image files: render inline instead of as raw bytes.
  if (IMAGE_EXTS.includes(fileExt(name))) {
    detail.innerHTML = "";
    detail.appendChild(el("h2", {}, name));
    detail.appendChild(el("div", { class: "muted" }, path));
    const rawUrl = `/api/results/raw?path=${encodeURIComponent(path)}`;
    const img = el("img", { src: rawUrl, alt: name, loading: "lazy" });
    img.addEventListener("error", () => {
      img.replaceWith(el("div", { class: "empty error" }, "Could not load image."));
    });
    detail.appendChild(el("div", { class: "img-view" }, [img]));
    detail.appendChild(
      el("div", { class: "img-actions" }, [
        el("a", { href: rawUrl, target: "_blank", rel: "noopener" }, "Open original ↗"),
      ])
    );
    return;
  }

  detail.innerHTML = `<div class="empty">Loading ${escapeHtml(name)}…</div>`;
  try {
    const data = await fetchJson(`/api/results/file?path=${encodeURIComponent(path)}`);
    detail.innerHTML = "";
    detail.appendChild(el("h2", {}, name));
    detail.appendChild(el("div", { class: "muted" }, path));

    if (data.kind === "json") {
      // Try detect a "task trajectory" file.
      const obj = data.data;
      if (looksLikeTrajectory(obj)) {
        renderTrajectory(detail, obj);
      } else if (obj && Array.isArray(obj.results_matrix)) {
        detail.appendChild(buildReportSection(obj));
        const det = el("details", { class: "collapse" }, [
          el("summary", {}, "Raw JSON"),
          el("pre", { class: "collapse-body" }, JSON.stringify(obj, null, 2)),
        ]);
        detail.appendChild(det);
      } else if (looksLikeMetrics(obj)) {
        detail.appendChild(buildMetricsSection(obj));
        const det = el("details", { class: "collapse" }, [
          el("summary", {}, "Raw JSON"),
          el("pre", { class: "collapse-body" }, JSON.stringify(obj, null, 2)),
        ]);
        detail.appendChild(det);
      } else {
        const pre = el("pre", { class: "codeblock" }, JSON.stringify(obj, null, 2));
        detail.appendChild(pre);
      }
    } else {
      detail.appendChild(el("pre", { class: "codeblock" }, data.data));
    }
  } catch (e) {
    detail.innerHTML = "";
    detail.appendChild(el("div", { class: "empty" }, String(e)));
  }
}

function looksLikeTrajectory(obj) {
  return (
    obj &&
    Array.isArray(obj.runs) &&
    obj.runs.length > 0 &&
    Array.isArray(obj.runs[0].conversation_flow)
  );
}

function looksLikeMetrics(obj) {
  if (!obj || typeof obj !== "object") return false;
  const keys = Object.keys(obj);
  if (!keys.length) return false;
  // metrics.json has keys like "0,0", "1,0", "1,1" ...
  return keys.every((k) => /^\d+,\d+$/.test(k));
}

function renderTrajectory(root, obj) {
  const cfg = obj.benchmark_config || {};
  root.appendChild(
    el("div", { class: "kv detail-section" }, [
      el("div", { class: "k" }, "model"),
      el("div", { class: "v" }, cfg.model || "?"),
      el("div", { class: "k" }, "user_prompt"),
      el("div", { class: "v" }, cfg.user_prompt || ""),
      el("div", { class: "k" }, "tools available"),
      el("div", { class: "v" }, String(cfg.total_tools_available ?? "?")),
      el("div", { class: "k" }, "runs"),
      el("div", { class: "v" }, String(obj.runs.length)),
    ])
  );

  if (obj.statistics) {
    const s = obj.statistics;
    const tiles = el("div", { class: "metrics-grid" }, [
      el("div", { class: "metric-tile" }, [el("div", { class: "lbl" }, "pass@1"), el("div", { class: "val" }, fmtPct(s.pass_at_1))]),
      el("div", { class: "metric-tile" }, [el("div", { class: "lbl" }, "verifier pass"), el("div", { class: "val" }, fmtPct(s.verifier_level_pass_rate))]),
      el("div", { class: "metric-tile" }, [el("div", { class: "lbl" }, "runs"), el("div", { class: "val" }, String(s.total_runs ?? obj.runs.length))]),
      el("div", { class: "metric-tile" }, [
        el("div", { class: "lbl" }, "successful"),
        el("div", { class: "val" }, String(s.successful_runs ?? "?")),
      ]),
      el("div", { class: "metric-tile" }, [
        el("div", { class: "lbl" }, "mean exec ms"),
        el("div", { class: "val" }, s.mean_execution_time_ms ? Math.round(s.mean_execution_time_ms).toLocaleString() : "?"),
      ]),
    ]);
    root.appendChild(tiles);
  }

  obj.runs.forEach((run, idx) => renderTrajectoryRun(root, run, idx));
}

function renderTrajectoryRun(root, run, idx) {
  const head = el("div", { class: "section-header" }, [
    el("div", { class: "title" }, `Run ${run.run_number ?? idx + 1}`),
    el(
      "div",
      { class: "sub" },
      [
        run.overall_success != null
          ? el("span", { class: `pill ${run.overall_success ? "pass" : "fail"}` }, run.overall_success ? "success" : "fail")
          : null,
        run.execution_time_ms != null ? ` · ${Math.round(run.execution_time_ms).toLocaleString()} ms` : "",
        run.started_at ? ` · ${run.started_at}` : "",
      ].filter(Boolean)
    ),
  ]);
  root.appendChild(head);

  // Verification results
  if (run.verification_results) {
    const tbl = el("table", { class: "verif" });
    tbl.appendChild(el("thead", {}, [el("tr", {}, [el("th", {}, "Verifier"), el("th", {}, "Result"), el("th", {}, "Expected"), el("th", {}, "Actual"), el("th", {}, "Details / Query")])]));
    const tbody = el("tbody", {});
    Object.entries(run.verification_results).forEach(([name, v]) => {
      tbody.appendChild(
        el("tr", {}, [
          el("td", {}, name),
          el("td", {}, el("span", { class: `pill ${v.passed ? "pass" : "fail"}` }, v.passed ? "pass" : "fail")),
          el("td", {}, JSON.stringify(v.expected ?? "")),
          el("td", {}, JSON.stringify(v.actual ?? "")),
          el("td", { class: "query" }, [v.details || "", v.query ? "\n" + v.query : ""].join("")),
        ])
      );
    });
    tbl.appendChild(tbody);
    root.appendChild(tbl);
  }

  // Final response
  if (run.model_response) {
    root.appendChild(
      el("details", { class: "collapse", open: "open" }, [
        el("summary", {}, "Final model response"),
        el("pre", { class: "collapse-body" }, run.model_response),
      ])
    );
  }

  // Conversation flow as chat bubbles, system prompt collapsed
  const chat = el("div", { class: "chat" });
  (run.conversation_flow || []).forEach((m) => chat.appendChild(renderMessage(m)));
  root.appendChild(
    el("details", { class: "collapse", open: "open" }, [
      el("summary", {}, `Conversation flow (${(run.conversation_flow || []).length} messages)`),
      chat,
    ])
  );

  // Tools used summary
  if (run.tools_used && run.tools_used.length) {
    const det = el("details", { class: "collapse" }, [
      el("summary", {}, `Tools used (${run.tools_used.length})`),
      el(
        "div",
        { class: "collapse-body" },
        run.tools_used.map((t) => el("span", { class: "tag tool" }, typeof t === "string" ? t : t.name || JSON.stringify(t)))
      ),
    ]);
    root.appendChild(det);
  }
}

function renderMessage(m) {
  const type = m.type || "unknown";
  if (type === "system_message") {
    return el("details", { class: "collapse" }, [
      el("summary", {}, "System prompt"),
      el("pre", { class: "collapse-body" }, m.content || ""),
    ]);
  }
  if (type === "user_message") {
    return el("div", { class: "bubble user" }, [
      el("div", { class: "head" }, [el("span", { class: "role" }, "USER")]),
      el("div", { class: "body" }, m.content || ""),
    ]);
  }
  if (type === "ai_message") {
    const calls = (m.tool_calls || []).map((tc) =>
      el("div", { class: "tool-call" }, [
        el("span", { class: "fn" }, (tc.name || "?") + "("),
        document.createTextNode(JSON.stringify(tc.args || tc.arguments || {}, null, 2)),
        document.createTextNode(")"),
      ])
    );
    return el("div", { class: "bubble ai" }, [
      el("div", { class: "head" }, [
        el("span", { class: "role" }, "AI"),
        m.response_metadata?.model_name ? el("span", {}, `· ${m.response_metadata.model_name}`) : null,
        m.usage_metadata?.total_tokens ? el("span", {}, `· ${m.usage_metadata.total_tokens} tok`) : null,
      ]),
      m.content
        ? el("div", { class: "body" }, m.content)
        : el("div", { class: "muted", style: "font-size:12px" }, "(no text content)"),
      ...calls,
    ]);
  }
  if (type === "tool_result") {
    const result = m.result || {};
    const ok = result.success !== false && !result.error;
    let preview = "";
    try {
      const inner = result.result || result;
      if (inner && Array.isArray(inner.content)) {
        preview = inner.content.map((c) => c.text || JSON.stringify(c)).join("\n");
      } else {
        preview = JSON.stringify(inner, null, 2);
      }
    } catch {
      preview = String(result);
    }
    return el("div", { class: "bubble tool" + (ok ? "" : " error") }, [
      el("div", { class: "head" }, [
        el("span", { class: "role" }, "TOOL"),
        el("span", {}, `· ${m.tool_name || "?"}`),
        m.gym_server ? el("span", {}, `· ${m.gym_server}`) : null,
        el("span", {}, ok ? "· ok" : "· error"),
      ]),
      el("pre", { class: "tool-call" }, preview.slice(0, 6000) + (preview.length > 6000 ? "\n... (truncated)" : "")),
    ]);
  }
  return el("div", { class: "bubble" }, [
    el("div", { class: "head" }, [el("span", { class: "role" }, type)]),
    el("pre", { class: "tool-call" }, JSON.stringify(m, null, 2).slice(0, 4000)),
  ]);
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------
async function initInsights() {
  try {
    const data = await fetchJson("/api/insights/runs");
    state.ins.runs = data.runs || [];
    const sel = $("#ins-run");
    sel.innerHTML = "";
    if (!state.ins.runs.length) {
      $("#ins-detail").innerHTML = `<div class="empty">No runs with a <code>beyond_accuracy/</code> directory found.</div>`;
      return;
    }
    state.ins.runs.forEach((r) => sel.appendChild(el("option", { value: r.name }, r.name)));
    sel.value = state.ins.runs[0].name;
    state.ins.run = state.ins.runs[0].name;
    state.ins.modes = state.ins.runs[0].modes || [];
    await onInsightsRunChange();
  } catch (e) {
    $("#ins-detail").innerHTML = "";
    $("#ins-detail").appendChild(el("div", { class: "empty" }, String(e)));
  }
}

async function onInsightsRunChange() {
  state.ins.run = $("#ins-run").value;
  const run = state.ins.runs.find((r) => r.name === state.ins.run);
  state.ins.modes = run?.modes || [];
  try {
    await renderInsightsView();
  } catch (e) {
    $("#ins-detail").innerHTML = "";
    $("#ins-detail").appendChild(el("div", { class: "empty" }, String(e)));
  }
}

async function renderInsightsView(overviewData) {
  const view = $("#ins-view").value;
  const root = $("#ins-detail");
  root.innerHTML = `<div class="empty">Loading…</div>`;
  const run = state.ins.run;
  try {
    if (view === "key_forgetting") {
      const data = await fetchJson(`/api/insights/${run}/forgetting_summary`);
      renderKeyForgetting(root, data);
      root.prepend(buildSystemsLegend(data?.modes || []));
    } else if (view === "key_pair_deltas") {
      const data = await fetchJson(`/api/insights/${run}/pair_deltas`);
      renderKeyPairDeltas(root, data);
      // pair_deltas data exposes "pairs" not "modes"; pull mode IDs from pair endpoints.
      const pairModes = new Set();
      (data?.pairs || []).forEach((p) => { pairModes.add(p.A); pairModes.add(p.B); });
      root.prepend(buildSystemsLegend(Array.from(pairModes)));
    } else if (view === "key_token_cost") {
      const data = await fetchJson(`/api/insights/${run}/token_cost`);
      renderKeyTokenCost(root, data);
      root.prepend(buildSystemsLegend(data?.modes || []));
    } else if (view === "key_memory") {
      const data = await fetchJson(`/api/insights/${run}/memory_summary`);
      renderKeyMemory(root, data);
      root.prepend(buildSystemsLegend(data?.systems || []));
    }
  } catch (e) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "empty" }, String(e)));
  }
}

// ---------- Overview ----------
function renderInsOverview(root, ov) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Run overview"));
  root.appendChild(
    el("div", { class: "muted" }, `${ov.modes.length} modes · ${ov.domains.length} domains · k=[${ov.k_values.join(",")}], j=[${ov.j_values.join(",")}]`)
  );

  // Top-line tiles per mode
  const grid = el("div", { class: "metrics-grid" });
  ov.per_mode_topline.forEach((m) => {
    grid.appendChild(
      el("div", { class: "metric-tile" }, [
        el("div", { class: "lbl", title: modeLabel(m.mode) }, `${modeLabel(m.mode)}  · ${m.n_cells} cells`),
        el("div", { class: "val" }, fmtPct(m.success__mean)),
        el(
          "div",
          { class: "muted", style: "font-size:11px;margin-top:2px;" },
          `verifier=${fmtPct(m.verifier_pr__mean)} · tool_f1=${num(m.tool_f1__mean, 2)} · plan=${num(m.plan_len_ratio__mean, 2)} · give_up=${fmtPct(m.give_up__mean)}`
        ),
      ])
    );
  });
  root.appendChild(grid);

  // Comparison table
  root.appendChild(el("h3", {}, "Mode top-line comparison"));
  const tbl = el("table", { class: "dense" });
  const cols = ["mode", "n_cells", "success__mean", "verifier_pr__mean", "tool_f1__mean", "plan_len_ratio__mean", "give_up__mean", "hallucinated_rate__mean"];
  tbl.appendChild(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        cols.map((c) => el("th", {}, c))
      )
    )
  );
  const tbody = el("tbody", {});
  ov.per_mode_topline.forEach((m) => {
    tbody.appendChild(
      el(
        "tr",
        {},
        cols.map((c) =>
          el("td", { class: typeof m[c] === "number" ? "num" : "" }, fmtCell(c, m[c]))
        )
      )
    );
  });
  tbl.appendChild(tbody);
  root.appendChild(tbl);

  root.appendChild(
    el("div", { class: "callout" }, [
      el(
        "span",
        {},
        "Pick a sub-view in the toolbar above to dig in. Best starting points: "
      ),
      el("strong", {}, "Drift: selection vs usage"),
      " (single bar chart that answers your main question), then ",
      el("strong", {}, "What predicts success?"),
      " (per-task correlations).",
    ])
  );
}

// ---------- Bucket attribution: selection vs usage ----------
function renderInsBucket(root, data, mode, domain) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Drift decomposition: selection vs usage"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      `mode = ${mode}, vs oracle baseline at diagonal cells${domain ? `, domain = ${domain}` : ""}. ` +
        `n_cells = ${data.n_cells}.`
    )
  );

  // Bucket cards
  const grid = el("div", { class: "bucket-summary-grid" });
  const buckets = data.bucket_summary || [];
  const maxZ = Math.max(...buckets.map((b) => b.mean_abs_z_to_oracle || 0), 0.0001);
  buckets.forEach((b) => {
    grid.appendChild(
      el("div", { class: "bucket-card" }, [
        el("div", { class: `bucket-name ${b.bucket}` }, b.bucket),
        el("div", { class: "bucket-z" }, num(b.mean_abs_z_to_oracle, 3)),
        el("div", { class: "bucket-meta" }, `mean |z| · max=${num(b.max_abs_z_to_oracle, 3)} · n=${b.n_features}`),
      ])
    );
  });
  root.appendChild(grid);

  // Auto-narrate
  const sel = buckets.find((b) => b.bucket === "selection")?.mean_abs_z_to_oracle || 0;
  const use = buckets.find((b) => b.bucket === "usage")?.mean_abs_z_to_oracle || 0;
  const ratio = use > 0 ? (sel / use).toFixed(1) : "∞";
  if (sel > 0 && use > 0) {
    root.appendChild(
      el("div", { class: "callout" }, [
        `Under capability drift, the `,
        el("strong", {}, "tool selection"),
        ` bucket deviates ${ratio}× more from the oracle baseline than the `,
        el("strong", {}, "tool usage"),
        ` bucket. Failures are dominated by which tools get called, not by how the calls are sequenced.`,
      ])
    );
  }

  // Feature breakdown bar chart
  root.appendChild(el("h3", {}, "Feature breakdown — |z-score of Δ vs oracle| per metric"));
  root.appendChild(
    el("div", { class: "legend" }, [
      el("span", {}, [el("span", { class: "dot selection" }), "selection"]),
      el("span", {}, [el("span", { class: "dot usage" }), "usage"]),
      el("span", {}, [el("span", { class: "dot cost" }), "cost"]),
    ])
  );
  const feats = data.feature_breakdown || [];
  const fmax = Math.max(...feats.map((f) => f.abs_z || 0), 0.0001);
  feats.forEach((f) => {
    const pct = ((f.abs_z || 0) / fmax) * 100;
    root.appendChild(
      el("div", { class: "bar-row" }, [
        el("div", { class: "name" }, f.feature),
        el("div", { class: "bar-track" }, el("div", { class: `bar-fill bucket-${f.bucket}`, style: `width:${pct}%` })),
        el(
          "div",
          { class: "val" },
          `Δ=${signed(f.delta_to_oracle, 3)} · z=${num(f.abs_z, 2)}`
        ),
      ])
    );
  });
}

// ---------- Catalog confusion ----------
function renderInsCatalog(root, data, mode, domain) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Catalog confusion across cells"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      `Tool calls binned by which catalog era they come from. mode = ${mode}${domain ? `, domain = ${domain}` : ""}.`
    )
  );
  root.appendChild(
    el("div", { class: "callout" }, [
      el("strong", {}, "Reading: "),
      "high ",
      el("code", {}, "older_distractor_rate"),
      " when k > j means the model clings to old/now-deprecated tools. High ",
      el("code", {}, "newer_adopt_rate"),
      " when j < k means it grabs newly-introduced tools that the eval task didn't need (forward leakage).",
    ])
  );

  const tbl = el("table", { class: "dense" });
  const cols = ["domain", "k", "j", "success", "gold_call_rate", "older_distractor_rate", "newer_adopt_rate", "brand_new_rate", "hallucinated_rate"];
  tbl.appendChild(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        cols.map((c) => el("th", {}, c))
      )
    )
  );
  const tbody = el("tbody", {});
  (data.rows || []).forEach((r) => {
    tbody.appendChild(
      el(
        "tr",
        {},
        cols.map((c) => {
          const v = r[c];
          const cls = typeof v === "number" ? "num" : "";
          if (["gold_call_rate", "older_distractor_rate", "newer_adopt_rate", "success", "hallucinated_rate", "brand_new_rate"].includes(c)) {
            return el("td", { class: cls }, heatCell(v, c === "older_distractor_rate" || c === "hallucinated_rate" ? "neg" : "pos"));
          }
          return el("td", { class: cls }, fmtCell(c, v));
        })
      )
    );
  });
  tbl.appendChild(tbody);
  root.appendChild(tbl);
}

function heatCell(v, polarity) {
  if (v == null) return el("span", {}, "—");
  const t = Math.max(0, Math.min(1, v));
  // pos = blue, neg = red
  const rgb =
    polarity === "neg"
      ? `rgba(248, 113, 113, ${0.1 + 0.55 * t})`
      : `rgba(96, 165, 250, ${0.1 + 0.55 * t})`;
  return el("span", { class: "heatcell", style: `background:${rgb}` }, fmtPct(v));
}

// ---------- Trajectory ----------
async function renderInsTrajectoryView(root, run, mode, domain) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Trajectory across adapt time step k"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      "For each (domain, eval time-step j), how does a metric evolve as k grows? Drops below the diagonal point are forgetting."
    )
  );

  const ctrl = el("div", { class: "toolbar" }, [
    el("label", {}, "Feature"),
    (() => {
      const s = el("select", { id: "ins-traj-feat" });
      [
        "success",
        "verifier_pr",
        "tool_f1",
        "tool_prec",
        "tool_rec",
        "plan_len_ratio",
        "older_distractor_rate",
        "newer_adopt_rate",
        "give_up",
        "n_calls",
      ].forEach((f) => s.appendChild(el("option", { value: f }, f)));
      s.value = "success";
      return s;
    })(),
  ]);
  root.appendChild(ctrl);

  const chartHolder = el("div", {});
  root.appendChild(chartHolder);

  const draw = async () => {
    const feature = $("#ins-traj-feat").value;
    chartHolder.innerHTML = `<div class="muted">loading…</div>`;
    const data = await fetchJson(
      `/api/insights/${run}/trajectory?mode=${mode}&feature=${feature}${domain ? `&domain=${domain}` : ""}`
    );
    chartHolder.innerHTML = "";
    chartHolder.appendChild(buildTrajectoryChart(data, feature));
  };
  $("#ins-traj-feat").addEventListener("change", draw);
  draw();
}

function buildTrajectoryChart(data, feature) {
  const wrap = el("div", { class: "traj-chart" });
  const series = data.series || [];
  if (!series.length) {
    wrap.appendChild(el("div", { class: "empty" }, "No data."));
    return wrap;
  }
  // Compute ranges
  let kMin = Infinity, kMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  series.forEach((s) => {
    s.points.forEach((p) => {
      if (p.value == null) return;
      kMin = Math.min(kMin, p.k);
      kMax = Math.max(kMax, p.k);
      vMin = Math.min(vMin, p.value);
      vMax = Math.max(vMax, p.value);
    });
  });
  if (!isFinite(kMin)) {
    wrap.appendChild(el("div", { class: "empty" }, "No data."));
    return wrap;
  }
  if (vMin === vMax) {
    vMin -= 0.05;
    vMax += 0.05;
  }
  // Create SVG
  const W = 880, H = 280, padL = 50, padR = 110, padT = 18, padB = 28;
  const xScale = (k) => padL + ((k - kMin) / Math.max(1, kMax - kMin)) * (W - padL - padR);
  const yScale = (v) => padT + (1 - (v - vMin) / (vMax - vMin)) * (H - padT - padB);

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");

  // Axes
  const axis = document.createElementNS(ns, "g");
  axis.setAttribute("class", "axis");
  // y ticks
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = vMin + (i / yTicks) * (vMax - vMin);
    const y = yScale(v);
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", padL); ln.setAttribute("x2", W - padR);
    ln.setAttribute("y1", y); ln.setAttribute("y2", y);
    ln.setAttribute("stroke-opacity", "0.4");
    ln.setAttribute("class", "grid");
    axis.appendChild(ln);
    const tx = document.createElementNS(ns, "text");
    tx.setAttribute("x", padL - 6); tx.setAttribute("y", y + 3); tx.setAttribute("text-anchor", "end");
    tx.textContent = num(v, 2);
    axis.appendChild(tx);
  }
  // x ticks
  for (let k = kMin; k <= kMax; k++) {
    const x = xScale(k);
    const tx = document.createElementNS(ns, "text");
    tx.setAttribute("x", x); tx.setAttribute("y", H - padB + 16); tx.setAttribute("text-anchor", "middle");
    tx.textContent = `k=${k}`;
    axis.appendChild(tx);
  }
  svg.appendChild(axis);

  const palette = ["#60a5fa", "#a78bfa", "#34d399", "#fbbf24", "#f87171", "#22d3ee", "#f472b6", "#fb923c", "#10b981", "#64748b"];
  // Group series by domain → multiple lines per domain (one per j)
  let colorIdx = 0;
  const seriesG = document.createElementNS(ns, "g");
  seriesG.setAttribute("class", "series");
  series.forEach((s) => {
    const color = palette[colorIdx++ % palette.length];
    const pts = s.points.filter((p) => p.value != null);
    if (!pts.length) return;
    const path = document.createElementNS(ns, "polyline");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("points", pts.map((p) => `${xScale(p.k)},${yScale(p.value)}`).join(" "));
    seriesG.appendChild(path);
    pts.forEach((p) => {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", xScale(p.k));
      c.setAttribute("cy", yScale(p.value));
      c.setAttribute("r", p.k === s.j ? 4 : 2.5);
      c.setAttribute("fill", color);
      c.setAttribute("stroke", p.k === s.j ? "#fff" : "transparent");
      c.setAttribute("stroke-width", "1");
      const t = document.createElementNS(ns, "title");
      t.textContent = `${s.domain} (j=${s.j}) k=${p.k}: ${num(p.value, 3)}`;
      c.appendChild(t);
      seriesG.appendChild(c);
    });
    // Label at end of line
    const last = pts[pts.length - 1];
    const lbl = document.createElementNS(ns, "text");
    lbl.setAttribute("x", xScale(last.k) + 6);
    lbl.setAttribute("y", yScale(last.value) + 3);
    lbl.setAttribute("fill", color);
    lbl.textContent = `${s.domain} j=${s.j}`;
    seriesG.appendChild(lbl);
  });
  svg.appendChild(seriesG);
  wrap.appendChild(svg);
  return wrap;
}

// ---------- Feature correlation with success ----------
function renderInsCorrelation(root, data, mode, domain) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "What predicts success?"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      `Per-task Pearson correlation with success__mean across ${data.n_tasks} tasks (mode=${mode}${domain ? `, domain=${domain}` : ""}).`
    )
  );
  root.appendChild(
    el("div", { class: "legend" }, [
      el("span", {}, [el("span", { class: "dot selection" }), "selection"]),
      el("span", {}, [el("span", { class: "dot usage" }), "usage"]),
      el("span", {}, [el("span", { class: "dot cost" }), "cost"]),
    ])
  );

  const corrs = data.correlations || [];
  const maxAbs = Math.max(...corrs.map((c) => Math.abs(c.pearson_r || 0)), 0.0001);
  corrs.forEach((c) => {
    const r = c.pearson_r || 0;
    const pct = (Math.abs(r) / maxAbs) * 100;
    root.appendChild(
      el("div", { class: "bar-row" }, [
        el("div", { class: "name" }, c.feature),
        el(
          "div",
          { class: "bar-track" },
          el("div", {
            class: `bar-fill bucket-${c.bucket}` + (r < 0 ? " neg" : ""),
            style: `width:${pct}%`,
          })
        ),
        el("div", { class: "val" }, `r=${signed(r, 3)} · n=${c.n}`),
      ])
    );
  });
}

// ---------- Mode comparison ----------
function renderInsComparison(root, data) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Mode comparison (diagonal cells, k = j)"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      `Side-by-side ${modeLabel("oracle", "short")} / ${modeLabel("no_memory", "short")} / ${modeLabel("adapt_fwd", "short")} at every (domain, k=j) cell. Δ columns are vs ${modeLabel("oracle", "short")}.`
    )
  );

  const rows = data.rows || [];
  if (!rows.length) {
    root.appendChild(el("div", { class: "empty" }, "No rows."));
    return;
  }
  const modes = data.modes_present || [];
  const featuredFeats = ["success", "verifier_pr", "tool_f1", "plan_len_ratio", "give_up"];
  const cols = ["domain", "k"];
  featuredFeats.forEach((f) => modes.forEach((m) => cols.push(`${f}__${m}`)));
  if (modes.includes("oracle")) {
    featuredFeats.forEach((f) => modes.forEach((m) => {
      if (m !== "oracle" && rows[0][`delta_oracle__${f}__${m}`] !== undefined) {
        cols.push(`delta_oracle__${f}__${m}`);
      }
    }));
  }

  const tbl = el("table", { class: "dense" });
  tbl.appendChild(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        cols.map((c) => el("th", {}, c))
      )
    )
  );
  const tbody = el("tbody", {});
  rows.forEach((r) => {
    tbody.appendChild(
      el(
        "tr",
        {},
        cols.map((c) => el("td", { class: typeof r[c] === "number" ? "num" : "" }, fmtCell(c, r[c])))
      )
    );
  });
  tbl.appendChild(tbody);
  root.appendChild(tbl);
}

// ---------- Failure attribution ----------
function renderInsFailures(root, data, mode, domain) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Failure attribution"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      `mode=${mode}${domain ? `, domain=${domain}` : ""} · ${data.n_failed} failed / ${data.n_tasks} tasks. ` +
        `Difference in feature means (failed − succeeded), z-scored by overall σ.`
    )
  );

  root.appendChild(el("h3", {}, "Top discriminators"));
  const feats = data.feature_discriminators || [];
  const maxZ = Math.max(...feats.map((f) => f.abs_z || 0), 0.0001);
  feats.slice(0, 16).forEach((f) => {
    const pct = ((f.abs_z || 0) / maxZ) * 100;
    const neg = (f.diff_failed_minus_succ || 0) < 0;
    root.appendChild(
      el("div", { class: "bar-row" }, [
        el("div", { class: "name" }, f.feature),
        el(
          "div",
          { class: "bar-track" },
          el("div", { class: `bar-fill bucket-${f.bucket}` + (neg ? " neg" : ""), style: `width:${pct}%` })
        ),
        el(
          "div",
          { class: "val" },
          `Δ(fail−ok)=${signed(f.diff_failed_minus_succ, 3)} · z=${num(f.abs_z, 2)}`
        ),
      ])
    );
  });

  root.appendChild(el("h3", {}, "Worst tasks"));
  const tbl = el("table", { class: "dense" });
  const wt = data.worst_tasks || [];
  if (!wt.length) {
    tbl.appendChild(el("tbody", {}, el("tr", {}, el("td", {}, "(none)"))));
  } else {
    const cols = Object.keys(wt[0]);
    tbl.appendChild(el("thead", {}, el("tr", {}, cols.map((c) => el("th", {}, c)))));
    const tb = el("tbody", {});
    wt.forEach((r) => tb.appendChild(el("tr", {}, cols.map((c) => el("td", { class: typeof r[c] === "number" ? "num" : "" }, fmtCell(c, r[c]))))));
    tbl.appendChild(tb);
  }
  root.appendChild(tbl);
}

// ===========================================================================
// HEADLINE INSIGHT 1 — Forgetting per system
// ===========================================================================
function renderKeyForgetting(root, data) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Forgetting per system"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      "Per-domain Δ-success on prior tasks vs the agent's own first encounter at k = j. " +
        "BWT-all averages over every (k > j) cell; BWT-final compares only the final time step (K, j < K) cell."
    )
  );

  // Hero cards: OVERALL row per mode
  const overall = data.overall_by_mode || [];
  const hero = el("div", { class: "insight-hero" });
  overall.forEach((r) => {
    const a = r.bwt_all;
    const f = r.bwt_final;
    hero.appendChild(
      el("div", { class: "hero-card" }, [
        el("div", { class: "lbl" }, `${modeLabel(r.mode)} · OVERALL`),
        el(
          "div",
          { class: "num " + (a == null ? "" : a >= 0 ? "pos" : "neg") },
          signed((a || 0) * 100, 1) + " pp"
        ),
        el(
          "div",
          { class: "ctx" },
          `BWT-all over ${r.n_all} domains · BWT-final = ${signed((f || 0) * 100, 1)} pp over ${r.n_final}`
        ),
      ])
    );
  });
  root.appendChild(hero);

  // Auto-narrate using the user-defined observation pattern (#1):
  //   On average, *adapt* has more forgetting; adapting on a narrow
  //   tool catalog (adapt_oracle) has the *most* forgetting.
  const byMode = new Map(overall.map((r) => [r.mode, r]));
  const nm = byMode.get("no_memory");
  const oc = byMode.get("oracle");
  const af = byMode.get("adapt_fwd");
  const ao = byMode.get("adapt_oracle");
  if (nm && af && ao) {
    const nmF = (nm.bwt_final || 0) * 100;
    const ocF = (oc?.bwt_final || 0) * 100;
    const afF = (af.bwt_final || 0) * 100;
    const aoF = (ao.bwt_final || 0) * 100;
    root.appendChild(
      el("div", { class: "callout" }, [
        el("strong", {}, "Observation: "),
        "on average, systems with raw memory forget more than the no-memory baseline. ",
        "And among the memory variants, the one with the ", el("strong", {}, "narrow oracle tool catalog"), " forgets the most. ",
        el(
          "div",
          { class: "muted small", style: "margin-top:6px;" },
          `OVERALL BWT-final: ` +
            `${modeLabel("no_memory")} = ${signed(nmF, 1)} pp · ` +
            (oc ? `${modeLabel("oracle")} = ${signed(ocF, 1)} pp · ` : "") +
            `${modeLabel("adapt_fwd")} = ${signed(afF, 1)} pp · ` +
            `${modeLabel("adapt_oracle")} = ${signed(aoF, 1)} pp ` +
            `→ |${modeLabel("adapt_oracle", "short")}| > |${modeLabel("adapt_fwd", "short")}| > |${modeLabel("no_memory", "short")}|: ` +
            `the narrower the per-time-step toolkit, the larger the drop on earlier tasks.`
        ),
      ])
    );
  }

  // Legend
  root.appendChild(
    el("div", { class: "layer-legend" }, [
      el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:#d97044" }), "BWT-all (any k > j)"]),
      el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:#9b59b6" }), "BWT-final (only k = K, j < K)"]),
    ])
  );

  // Per-system grouped chart: one panel per (mode); within each, x = domains, two bars (bwt_all, bwt_final)
  const modes = data.modes || [];
  const domains = data.domains || [];
  root.appendChild(el("h3", {}, "Per system, per domain"));
  const grid = el("div", { class: "gbar-grid" });
  // Range across all values for symmetric y-axis
  let absMax = 0.0001;
  (data.per_domain || []).forEach((r) => {
    absMax = Math.max(absMax, Math.abs(r.bwt_all || 0), Math.abs(r.bwt_final || 0));
  });
  overall.forEach((r) => {
    absMax = Math.max(absMax, Math.abs(r.bwt_all || 0), Math.abs(r.bwt_final || 0));
  });
  modes.forEach((m) => {
    const panel = buildForgettingPanel(m, data.per_domain.filter((r) => r.mode === m), overall.find((r) => r.mode === m), absMax);
    grid.appendChild(panel);
  });
  root.appendChild(grid);
}

function buildForgettingPanel(mode, perDomain, overallRow, absMax) {
  const panel = el("div", { class: "gbar-panel" }, [
    el("div", { class: "title" }, [
      el("span", {}, modeLabel(mode)),
      el("small", {}, `${perDomain.length} domains`),
    ]),
  ]);
  const layers = [
    { key: "bwt_all", color: "#d97044" },
    { key: "bwt_final", color: "#9b59b6" },
  ];
  const rows = [...perDomain];
  if (overallRow) rows.push({ ...overallRow, _overall: true });
  panel.appendChild(buildDivergingChart(rows, layers, absMax));
  return panel;
}

// ===========================================================================
// HEADLINE INSIGHT 2 — Pair deltas: selection / usage / total memory benefit
// ===========================================================================
function renderKeyPairDeltas(root, data) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Pair deltas — what does each system component buy you?"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      "Three contrasts decompose where the gains come from. Positive bars mean A > B. " +
        "FWD = current/future (k = j). BWT-all = all past cells. BWT-final = final time-step retention only."
    )
  );

  const pairs = data.pairs || [];
  const rows = data.rows || [];
  const overall = rows.filter((r) => r.domain === "OVERALL");

  // Hero: one card per pair × view, focused on OVERALL · final retention.
  const hero = el("div", { class: "insight-hero" });
  pairs.forEach((p) => {
    const r = overall.find((x) => x.pair === p.pair);
    if (!r) return;
    hero.appendChild(
      el("div", { class: "hero-card" }, [
        el("div", { class: "lbl" }, p.label),
        el(
          "div",
          { class: "num " + ((r.bwt_final || 0) >= 0 ? "pos" : "neg") },
          signed((r.bwt_final || 0) * 100, 1) + " pp"
        ),
        el(
          "div",
          { class: "ctx" },
          `OVERALL · BWT-final · A = ${modeLabel(p.A)} − B = ${modeLabel(p.B)}. ` +
            `FWD = ${signed((r.fwd || 0) * 100, 1)} pp · BWT-all = ${signed((r.bwt_all || 0) * 100, 1)} pp.`
        ),
      ])
    );
  });
  root.appendChild(hero);

  // Auto-narrate using the user-defined observation pattern (#2):
  //   tool-selection benefit  <  tool-usage benefit  <  adapt with broad
  //   tool coverage. The decisive variable is *how* you use a broad/
  //   diverse tool set, not whether you pre-pick the right subset.
  const sel = overall.find((r) => r.pair === "oracle − no_memory");
  const use = overall.find((r) => r.pair === "adapt_oracle − oracle");
  const mem = overall.find((r) => r.pair === "adapt_fwd − no_memory");
  if (sel && use && mem) {
    const sFwd = (sel.fwd || 0) * 100;
    const uFwd = (use.fwd || 0) * 100;
    const mFwd = (mem.fwd || 0) * 100;
    root.appendChild(
      el("div", { class: "callout" }, [
        el("strong", {}, "Observation: "),
        "tool selection < tool usage < adapt with broad tool coverage. ",
        "The win comes from learning how to use a broad/diverse toolkit, not from pre-picking the right subset. ",
        el(
          "div",
          { class: "muted small", style: "margin-top:6px;" },
          `OVERALL FWD: ` +
            `tool-selection benefit (${modeLabel("oracle", "short")} − ${modeLabel("no_memory", "short")}) = ${signed(sFwd, 1)} pp · ` +
            `tool-usage benefit (${modeLabel("adapt_oracle", "short")} − ${modeLabel("oracle", "short")}) = ${signed(uFwd, 1)} pp · ` +
            `broad-memory benefit (${modeLabel("adapt_fwd", "short")} − ${modeLabel("no_memory", "short")}) = ${signed(mFwd, 1)} pp ` +
            `→ same ordering at BWT-final: ${signed((sel.bwt_final || 0) * 100, 1)} / ${signed((use.bwt_final || 0) * 100, 1)} / ${signed((mem.bwt_final || 0) * 100, 1)} pp.`
        ),
      ])
    );
  }

  root.appendChild(
    el("div", { class: "layer-legend" }, [
      el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:#3a6fb0" }), "FWD (k = j)"]),
      el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:#d97044" }), "BWT-all (j < k)"]),
      el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:#9b59b6" }), "BWT-final (k = K, j < K)"]),
    ])
  );

  // Per pair panel: each domain group has 3 bars (fwd/bwt_all/bwt_final). Show as grouped chart.
  root.appendChild(el("h3", {}, "Per pair · per domain"));
  let absMax = 0.0001;
  rows.forEach((r) => {
    ["fwd", "bwt_all", "bwt_final"].forEach((k) => {
      if (r[k] != null) absMax = Math.max(absMax, Math.abs(r[k]));
    });
  });
  const grid = el("div", { class: "gbar-grid" });
  pairs.forEach((p) => {
    const panel = buildPairPanel(p, rows, absMax);
    grid.appendChild(panel);
  });
  root.appendChild(grid);
}

function buildPairPanel(pairInfo, rows, absMax) {
  const sub = rows.filter((r) => r.pair === pairInfo.pair);
  const overallRow = sub.find((r) => r.domain === "OVERALL");
  const perDom = sub.filter((r) => r.domain !== "OVERALL");
  const panel = el("div", { class: "gbar-panel" }, [
    el("div", { class: "title" }, [
      el("span", {}, pairInfo.label),
      el("small", {}, `${modeLabel(pairInfo.A, "short")} − ${modeLabel(pairInfo.B, "short")}`),
    ]),
  ]);
  const layers = [
    { key: "fwd", color: "#3a6fb0" },
    { key: "bwt_all", color: "#d97044" },
    { key: "bwt_final", color: "#9b59b6" },
  ];
  const groups = [...perDom];
  if (overallRow) groups.push({ ...overallRow, _overall: true });
  panel.appendChild(buildDivergingChart(groups, layers, absMax));
  return panel;
}

// Shared diverging bar chart builder.
// rows: array of {domain, _overall?, [key]: value} where value is a fraction
//       (so 0.05 means 5pp). layers: [{key, color}, ...]. absMax: max |value|.
function buildDivergingChart(rows, layers, absMax) {
  const chart = el("div", { class: "gbar-chart" });
  chart.appendChild(el("div", { class: "zero-line" }));

  const nLayers = layers.length;
  const barWidth = nLayers === 2 ? 14 : 11;
  const gap = 2;
  const totalWidth = nLayers * barWidth + (nLayers - 1) * gap;

  rows.forEach((r) => {
    const grp = el("div", { class: "gbar-group" + (r._overall ? " overall-grp" : "") });
    const axisZone = el("div", { class: "axis-zone" });
    const bars = el("div", { class: "bars" });
    layers.forEach((L, idx) => {
      const v = r[L.key];
      if (v == null) return;
      const heightPct = (Math.abs(v) / absMax) * 50; // half the panel
      const isPos = v >= 0;
      const xOffset = idx * (barWidth + gap) - totalWidth / 2 + barWidth / 2;
      const bar = el("div", {
        class: `bar ${isPos ? "pos" : "neg"}`,
        style: [
          `background:${L.color}`,
          `width:${barWidth}px`,
          `height:${heightPct}%`,
          `left:calc(50% + ${xOffset}px - ${barWidth / 2}px)`,
          isPos ? `bottom:50%` : `top:50%`,
        ].join(";"),
        title: `${L.key}=${signed(v * 100, 2)} pp`,
      });
      bar.appendChild(el("span", { class: "val" }, signed(v * 100, 1)));
      bars.appendChild(bar);
    });
    axisZone.appendChild(bars);
    grp.appendChild(axisZone);
    grp.appendChild(
      el("div", { class: "xlabel", style: r._overall ? "color:var(--accent);font-weight:700;" : "" }, r.domain || "")
    );
    chart.appendChild(grp);
  });
  return chart;
}

// ===========================================================================
// HEADLINE INSIGHT 3 — Token cost & activity
// ===========================================================================
function renderKeyTokenCost(root, data) {
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Test-time token cost & activity"));
  root.appendChild(
    el(
      "div",
      { class: "muted" },
      "Per (domain, system, regime) average tokens spent and conversation activity per attempt. " +
        "Solid = input tokens / AI turns. Hatched = output tokens / tool calls."
    )
  );

  // Sub-controls: pick view (fwd / bwt_all / bwt_final)
  const tabs = el("div", { class: "view-tabs" });
  let activeView = "fwd";
  const renderForView = (v) => {
    activeView = v;
    Array.from(tabs.children).forEach((c) => c.classList.toggle("active", c.dataset.v === v));
    drawTokenGrid(root, data, v);
  };
  ["fwd", "bwt_all", "bwt_final"].forEach((v) => {
    const t = el(
      "button",
      { class: "view-tab" + (v === activeView ? " active" : ""), onclick: () => renderForView(v) },
      v.toUpperCase()
    );
    t.dataset.v = v;
    tabs.appendChild(t);
  });
  root.appendChild(tabs);

  // Hero: OVERALL fwd for each mode
  const overallRows = data.rows.filter((r) => r.domain === "OVERALL");
  const hero = el("div", { class: "insight-hero" });
  data.modes.forEach((m) => {
    const r = overallRows.find((x) => x.mode === m && x.view === "fwd");
    if (!r) return;
    hero.appendChild(
      el("div", { class: "hero-card" }, [
        el("div", { class: "lbl" }, `${modeLabel(m)} · FWD · OVERALL`),
        el("div", { class: "num" }, Math.round(r.total_tokens || 0).toLocaleString() + " tok"),
        el(
          "div",
          { class: "ctx" },
          `in=${Math.round(r.input_tokens || 0).toLocaleString()} · out=${Math.round(r.output_tokens || 0).toLocaleString()} · turns=${num(r.ai_turns, 1)} · calls=${num(r.n_calls, 1)}`
        ),
      ])
    );
  });
  root.appendChild(hero);

  // Auto-narrate using the user-defined observation pattern (#3):
  //   Token usage stays well within the 400k context window. adapt_fwd
  //   consumes the most input/output/turns/tool-calls, yet *doesn't* cost
  //   the most wall time because the prompt-cache absorbs the repeated
  //   prefix.
  const oracleFwd = overallRows.find((r) => r.mode === "oracle" && r.view === "fwd");
  const noMemFwd = overallRows.find((r) => r.mode === "no_memory" && r.view === "fwd");
  const adFwdFwd = overallRows.find((r) => r.mode === "adapt_fwd" && r.view === "fwd");
  const adOrcFwd = overallRows.find((r) => r.mode === "adapt_oracle" && r.view === "fwd");
  if (oracleFwd && noMemFwd && adFwdFwd) {
    const maxInTok = Math.max(
      noMemFwd.input_tokens || 0,
      oracleFwd.input_tokens || 0,
      adOrcFwd?.input_tokens || 0,
      adFwdFwd.input_tokens || 0
    );
    const extra = (data.extra_by_mode || {});
    const wallOf = (m) => extra[m]?.wall_ms__fwd || 0;
    const cacheOf = (m) => extra[m]?.cache_read_tokens__fwd || 0;
    const wallNM = wallOf("no_memory"), wallAF = wallOf("adapt_fwd");
    const cacheNM = cacheOf("no_memory"), cacheAF = cacheOf("adapt_fwd");
    const fmtSec = (ms) => `${(ms / 1000).toFixed(1)}s`;
    const fmtK = (n) => `${(n / 1000).toFixed(0)}k`;
    root.appendChild(
      el("div", { class: "callout" }, [
        el("strong", {}, "Observation: "),
        `every system stays within the 400k context window. ${modeLabel("adapt_fwd")} is by far the heaviest in input, output, turns and tool calls, `,
        "yet it does ", el("em", {}, "not"), " cost the most wall time — the prompt cache absorbs the bloated prefix. ",
        el(
          "div",
          { class: "muted small", style: "margin-top:6px;" },
          `OVERALL FWD inputs: ` +
            `${modeLabel("no_memory", "short")} = ${fmtK(noMemFwd.input_tokens)} · ` +
            `${modeLabel("oracle", "short")} = ${fmtK(oracleFwd.input_tokens)} · ` +
            (adOrcFwd ? `${modeLabel("adapt_oracle", "short")} = ${fmtK(adOrcFwd.input_tokens)} · ` : "") +
            `${modeLabel("adapt_fwd", "short")} = ${fmtK(adFwdFwd.input_tokens)} (max = ${fmtK(maxInTok)}, well under the 400k limit). ` +
            `Turns/calls: ${modeLabel("adapt_fwd", "short")} = ${num(adFwdFwd.ai_turns, 1)}t / ${num(adFwdFwd.n_calls, 1)}c vs ` +
            `${modeLabel("no_memory", "short")} ${num(noMemFwd.ai_turns, 1)}t / ${num(noMemFwd.n_calls, 1)}c. ` +
            (wallAF && wallNM ?
              `Wall time tells a different story: ${modeLabel("no_memory", "short")} = ${fmtSec(wallNM)} but ` +
              `${modeLabel("adapt_fwd", "short")} = ${fmtSec(wallAF)} — ` +
              `cache_read tokens absorb the extra context (${modeLabel("adapt_fwd", "short")} ${fmtK(cacheAF)} cached vs ` +
              `${modeLabel("no_memory", "short")} ${fmtK(cacheNM)}, ${num(cacheAF / Math.max(1, cacheNM), 1)}× more).`
              : "")
        ),
      ])
    );
  }

  // Render grid
  drawTokenGrid(root, data, activeView);
}

function drawTokenGrid(root, data, view) {
  // Remove old grid if any
  Array.from(root.querySelectorAll(".token-grid")).forEach((n) => n.remove());
  const rows = data.rows.filter((r) => r.view === view);
  const domains = data.domains || [];
  const modes = data.modes || [];

  let tokenMax = 1;
  let countMax = 1;
  rows.forEach((r) => {
    tokenMax = Math.max(tokenMax, r.total_tokens || 0);
    countMax = Math.max(countMax, (r.ai_turns || 0) + (r.n_calls || 0), r.n_calls || 0);
  });

  const grid = el("div", { class: "token-grid" });

  const drawPanel = (dom, isOverall) => {
    const panel = el("div", { class: "token-panel" + (isOverall ? " overall" : "") });
    panel.appendChild(
      el("div", { class: "title" }, [
        el("span", {}, dom),
        el("small", { class: "muted", style: "margin-left:8px;font-weight:400;" }, view.toUpperCase()),
      ])
    );
    modes.forEach((m) => {
      const r = rows.find((x) => x.domain === dom && x.mode === m);
      if (!r) return;
      const widthIn = ((r.input_tokens || 0) / tokenMax) * 100;
      const widthOut = ((r.output_tokens || 0) / tokenMax) * 100;
      const widthTurns = ((r.ai_turns || 0) / countMax) * 100;
      const widthCalls = ((r.n_calls || 0) / countMax) * 100;
      panel.appendChild(
        el("div", { class: "token-row" }, [
          el("div", { class: "mode", title: modeLabel(m) }, modeLabel(m, "short")),
          el("div", { class: "token-stack", title: `in=${Math.round(r.input_tokens)} out=${Math.round(r.output_tokens)}` }, [
            el("div", { class: "seg in", style: `width:${widthIn}%` }, widthIn > 6 ? `${Math.round(r.input_tokens / 1000)}k` : ""),
            el("div", { class: "seg out", style: `width:${widthOut}%` }, widthOut > 6 ? `${Math.round(r.output_tokens / 1000)}k` : ""),
            el("span", { class: "lbl-right" }, `${Math.round(r.total_tokens / 1000)}k`),
          ]),
          el("div", { class: "count-bar", title: `turns=${num(r.ai_turns, 1)} calls=${num(r.n_calls, 1)}` }, [
            el("div", { class: "seg-turns", style: `width:${widthTurns}%; height:100%` }),
            el("div", { class: "seg-calls", style: `width:${widthCalls}%; height:100%` }),
            el("span", { class: "lbl-right" }, `${num(r.ai_turns, 1)}t / ${num(r.n_calls, 1)}c`),
          ]),
          el("div", { style: "" }, ""), // filler
        ])
      );
    });
    // Header strip
    return panel;
  };

  // Per-domain panels first, OVERALL last and emphasized
  domains.forEach((d) => grid.appendChild(drawPanel(d, false)));
  if (rows.some((r) => r.domain === "OVERALL")) {
    grid.appendChild(drawPanel("OVERALL", true));
  }
  root.appendChild(grid);

  // Legend
  if (!root.querySelector(".token-legend")) {
    root.appendChild(
      el("div", { class: "layer-legend token-legend" }, [
        el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:#3a6fb5" }), "input tokens"]),
        el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:#d6c63a" }), "output tokens"]),
        el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:#34d399" }), "AI turns"]),
        el("span", { class: "item" }, [el("span", { class: "swatch", style: "background:rgba(248,113,113,0.55)" }), "tool calls"]),
      ])
    );
  }
}

// ---------- Key insight #4: memory composition / content ----------
function renderKeyMemory(root, data) {
  root.innerHTML = "";
  if (!data || !data.systems || data.systems.length === 0) {
    root.appendChild(el("div", { class: "empty" }, "No memory_summary.tsv data available."));
    return;
  }

  root.appendChild(el("h2", { class: "headline-title" }, "Memory — what's inside at the end of each run"));
  root.appendChild(
    el(
      "p",
      { class: "muted headline-sub" },
      `${modeLabel("adapt_fwd")} accumulates experiences while the agent runs on the full cumulative catalog Cₖ; ${modeLabel("adapt_oracle")} accumulates them while it runs on the per-task oracle subset Tᵢ. Below: how big the memory is, how successful those stored experiences were, what eras of tools they reference, and how broad each entry is.`
    )
  );

  // ----- Overall hero cards (one per system)
  const heroGrid = el("div", { class: "insight-hero" });
  data.systems.forEach((sys_) => {
    const o = data.overall[sys_];
    if (!o) return;
    const succPct = (o.succ_share != null ? (o.succ_share * 100).toFixed(0) + "%" : "—");
    heroGrid.appendChild(
      el("div", { class: "hero-card" }, [
        el("div", { class: "lbl" }, modeLabel(sys_)),
        el("div", { class: "val" }, `${o.n_total} entries`),
        el(
          "div",
          { class: "muted", style: "font-size:11px;margin-top:2px;" },
          `${o.n_succ}✓ / ${o.n_fail}✗ (${succPct} succeeded) · ${num(o.avg_refs_per_entry, 1)} tool refs / entry`
        ),
      ])
    );
  });
  root.appendChild(heroGrid);

  // Auto-narrate using the user-defined observation pattern (#4):
  //   Most stored memory is incorrect (failures) and dominated by early-
  //   stage / foundational tools; later-era references are rare. Breadth
  //   of exposure matters.
  const fwd = data.overall["adapt_fwd"];
  const orc = data.overall["adapt_oracle"];
  if (fwd && orc) {
    const failFwd = (1 - (fwd.succ_share || 0)) * 100;
    const failOrc = (1 - (orc.succ_share || 0)) * 100;
    const v1FwdShare = (fwd.era_shares?.[0] || 0) * 100;
    const v1OrcShare = (orc.era_shares?.[0] || 0) * 100;
    const recentFwd = (fwd.era_shares || []).slice(1).reduce((a, b) => a + b, 0) * 100;
    const refsRatio = (orc.avg_refs_per_entry || 0) > 0
      ? (fwd.avg_refs_per_entry || 0) / (orc.avg_refs_per_entry || 1)
      : 1;
    root.appendChild(
      el("div", { class: "callout" }, [
        el("strong", {}, "Observation: "),
        "most of the memory is failure traces, and the referenced tools are dominated by the early/foundational time steps. ",
        "Breadth of exposure is what differs between the two memory systems. ",
        el(
          "div",
          { class: "muted small", style: "margin-top:6px;" },
          `Composition: ${modeLabel("adapt_fwd", "short")} = ${failFwd.toFixed(0)}% failed entries · ` +
            `${modeLabel("adapt_oracle", "short")} = ${failOrc.toFixed(0)}% failed. ` +
            `Tool-era mix: T₁ accounts for ${v1FwdShare.toFixed(0)}% (${modeLabel("adapt_fwd", "short")}) and ` +
            `${v1OrcShare.toFixed(0)}% (${modeLabel("adapt_oracle", "short")}) of all tool references; only ~${recentFwd.toFixed(0)}% comes from T₂+ tools. ` +
            `Breadth: ${modeLabel("adapt_fwd", "short")} entries cite ${num(fwd.avg_refs_per_entry, 1)} distinct tools/entry vs ` +
            `${modeLabel("adapt_oracle", "short")}'s ${num(orc.avg_refs_per_entry, 1)} ` +
            `(${refsRatio >= 1 ? "+" : ""}${((refsRatio - 1) * 100).toFixed(0)}%), because the cumulative-tools agent has a wider live catalog to pull from.`
        ),
      ])
    );
  }

  // ----- Panel A: composition (succ/fail) per domain
  root.appendChild(buildMemoryPanelA(data));

  // ----- Panel B: era-mix shares per domain
  root.appendChild(buildMemoryPanelB(data));

  // ----- Panel C: avg refs/entry per domain
  root.appendChild(buildMemoryPanelC(data));
}

function buildMemoryPanelA(data) {
  const wrap = el("div", { class: "mem-panel card" });
  wrap.appendChild(
    el("h3", { class: "mem-panel-title" }, "A · Memory composition — succeeded vs failed entries")
  );
  wrap.appendChild(
    el(
      "div",
      { class: "muted small" },
      "Stored experiences include both successful and failed past tasks. Failure traces include the failure reason and failed-verifier details so the agent can avoid the same mistake."
    )
  );

  const domains = data.domains;
  const systems = data.systems;
  const W = Math.max(560, domains.length * 130 + 60);
  const H = 220;
  const padL = 44, padR = 18, padT = 24, padB = 60;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "mem-svg");
  svg.style.width = "100%";
  svg.style.height = `${H}px`;

  const maxTotal = Math.max(
    1,
    ...data.panel_a.map((r) => r.n_total || 0)
  );
  const yScale = (v) => padT + (H - padT - padB) * (1 - v / maxTotal);
  // Y axis ticks
  for (let k = 0; k <= 4; k++) {
    const v = Math.round((maxTotal * k) / 4);
    const y = yScale(v);
    svg.appendChild(svgText(padL - 6, y + 3, String(v), "#64748b", "end", 10));
    svg.appendChild(svgLine(padL, y, W - padR, y, "rgba(15,23,42,0.07)"));
  }
  svg.appendChild(svgText(8, padT - 6, "memory entries", "#64748b", "start", 10, 600));

  const groupW = (W - padL - padR) / domains.length;
  const barW = Math.min(28, groupW / (systems.length + 1) - 2);
  domains.forEach((dom, di) => {
    const gx = padL + di * groupW + (groupW - barW * systems.length - 4) / 2;
    systems.forEach((sys_, si) => {
      const row = data.panel_a.find((r) => r.domain === dom && r.system === sys_);
      if (!row) return;
      const bx = gx + si * (barW + 4);
      const fail = row.n_fail || 0;
      const succ = row.n_succ || 0;
      const total = row.n_total || 0;
      const sucY = yScale(succ);
      const failY = yScale(total);
      // Failed stack on top (red)
      const failR = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      failR.setAttribute("x", bx); failR.setAttribute("y", failY);
      failR.setAttribute("width", barW); failR.setAttribute("height", sucY - failY);
      failR.setAttribute("fill", "rgba(248,113,113,0.7)");
      failR.appendChild(_svgTitle(`${dom} · ${modeLabel(sys_, "short")}: ${fail} failed`));
      if (sys_ === "adapt_oracle") failR.setAttribute("fill", "url(#hatch-fail)");
      svg.appendChild(failR);
      // Succeeded on bottom (green)
      const sucR = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      sucR.setAttribute("x", bx); sucR.setAttribute("y", sucY);
      sucR.setAttribute("width", barW); sucR.setAttribute("height", (H - padB) - sucY);
      sucR.setAttribute("fill", "rgba(52,211,153,0.78)");
      sucR.appendChild(_svgTitle(`${dom} · ${modeLabel(sys_, "short")}: ${succ} succeeded`));
      if (sys_ === "adapt_oracle") sucR.setAttribute("fill", "url(#hatch-succ)");
      svg.appendChild(sucR);
      // total label above bar
      svg.appendChild(svgText(bx + barW / 2, failY - 4, `${succ}/${fail}/${total}`, "#334155", "middle", 8.5, 600));
    });
    svg.appendChild(svgText(gx + (barW * systems.length + 4) / 2, H - padB + 14, dom, "#64748b", "middle", 10));
  });

  // X axis baseline
  svg.appendChild(svgLine(padL, H - padB, W - padR, H - padB, "#cbd5e1"));

  // Hatching for adapt_oracle bars (visual distinction)
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <pattern id="hatch-fail" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="rgba(248,113,113,0.7)"/>
      <rect width="3" height="6" fill="rgba(248,113,113,0.35)"/>
    </pattern>
    <pattern id="hatch-succ" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="rgba(52,211,153,0.78)"/>
      <rect width="3" height="6" fill="rgba(52,211,153,0.4)"/>
    </pattern>`;
  svg.insertBefore(defs, svg.firstChild);

  wrap.appendChild(svg);
  wrap.appendChild(
    el("div", { class: "mem-legend" }, [
      el("span", { class: "item" }, [el("span", { class: "sw sw-succ" }), "succeeded"]),
      el("span", { class: "item" }, [el("span", { class: "sw sw-fail" }), "failed"]),
      el("span", { class: "item" }, [el("span", { class: "sw sw-fwd" }), `${modeLabel("adapt_fwd")} (solid)`]),
      el("span", { class: "item" }, [el("span", { class: "sw sw-orc" }), `${modeLabel("adapt_oracle")} (hatched)`]),
      el("span", { class: "item muted" }, "labels: succ / fail / total"),
    ])
  );
  return wrap;
}

function buildMemoryPanelB(data) {
  const wrap = el("div", { class: "mem-panel card" });
  wrap.appendChild(
    el("h3", { class: "mem-panel-title" }, "B · Tool-era mix in memory — at which time step were the referenced tools first introduced?")
  );
  wrap.appendChild(
    el(
      "div",
      { class: "muted small" },
      "Each tool-call inside a memory entry references some tool; we attribute it to the time step T where that tool was first introduced. Lots of T₁-tool references = memory mostly grounds in early-time-step capabilities."
    )
  );

  const domains = data.domains;
  const systems = data.systems;
  const nEras = data.n_eras;
  // Era palette (matplotlib viridis-like)
  const eraColors = [
    "#3b0f70", "#641a80", "#a32a89", "#cd4071",
    "#f37651", "#fca636", "#f0f921",
  ];
  const getEraColor = (i) => eraColors[Math.min(i, eraColors.length - 1)];

  const W = Math.max(560, domains.length * 130 + 60);
  const H = 240;
  const padL = 30, padR = 18, padT = 24, padB = 60;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "mem-svg");
  svg.style.width = "100%";
  svg.style.height = `${H}px`;

  // Y axis 0..1 ticks
  const yScale = (v) => padT + (H - padT - padB) * (1 - v);
  for (let k = 0; k <= 4; k++) {
    const v = k / 4;
    const y = yScale(v);
    svg.appendChild(svgText(padL - 6, y + 3, v.toFixed(2), "#64748b", "end", 10));
    svg.appendChild(svgLine(padL, y, W - padR, y, "rgba(15,23,42,0.07)"));
  }
  svg.appendChild(svgText(8, padT - 6, "share", "#64748b", "start", 10, 600));

  const groupW = (W - padL - padR) / domains.length;
  const barW = Math.min(28, groupW / (systems.length + 1) - 2);
  domains.forEach((dom, di) => {
    const gx = padL + di * groupW + (groupW - barW * systems.length - 4) / 2;
    systems.forEach((sys_, si) => {
      const row = data.panel_b.find((r) => r.domain === dom && r.system === sys_);
      if (!row) return;
      const bx = gx + si * (barW + 4);
      // Stacked from era 0 up
      let yBottom = H - padB;
      row.era_shares.forEach((sh, idx) => {
        if (!sh || sh <= 0) return;
        const hpx = (H - padT - padB) * sh;
        const yTop = yBottom - hpx;
        const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        r.setAttribute("x", bx); r.setAttribute("y", yTop);
        r.setAttribute("width", barW); r.setAttribute("height", hpx);
        r.setAttribute("fill", getEraColor(idx));
        r.setAttribute("opacity", sys_ === "adapt_oracle" ? 0.7 : 1.0);
        if (sys_ === "adapt_oracle") {
          r.setAttribute("stroke", "rgba(255,255,255,0.25)");
          r.setAttribute("stroke-width", 0.5);
        }
        r.appendChild(_svgTitle(`${dom} · ${modeLabel(sys_, "short")} · T${idx + 1} tools: ${(sh * 100).toFixed(1)}% (${row.era_counts[idx]} refs)`));
        svg.appendChild(r);
        yBottom = yTop;
      });
      // 2×2-axis tag under each bar (e.g. "C/+" for cumulative + memory).
      svg.appendChild(
        svgText(bx + barW / 2, H - padB + 12, modeTag(sys_), "#64748b", "middle", 8, 600)
      );
    });
    svg.appendChild(svgText(gx + (barW * systems.length + 4) / 2, H - padB + 26, dom, "#64748b", "middle", 10));
  });
  svg.appendChild(svgLine(padL, H - padB, W - padR, H - padB, "#cbd5e1"));

  wrap.appendChild(svg);

  // Era legend
  const legend = el("div", { class: "mem-legend" });
  for (let i = 0; i < nEras; i++) {
    legend.appendChild(
      el("span", { class: "item" }, [
        el("span", { class: "sw", style: `background:${getEraColor(i)}` }),
        `T${i + 1} tools`,
      ])
    );
  }
  wrap.appendChild(legend);
  return wrap;
}

function buildMemoryPanelC(data) {
  const wrap = el("div", { class: "mem-panel card" });
  wrap.appendChild(
    el("h3", { class: "mem-panel-title" }, "C · Breadth of exposure per memory entry — avg # tool references per entry")
  );
  wrap.appendChild(
    el(
      "div",
      { class: "muted small" },
      "Higher = entries reference more tools per task. Useful as a context-budget signal."
    )
  );

  const domains = [...data.domains, "OVERALL"];
  const systems = data.systems;
  const W = Math.max(560, domains.length * 110 + 60);
  const H = 200;
  const padL = 40, padR = 18, padT = 24, padB = 50;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "mem-svg");
  svg.style.width = "100%";
  svg.style.height = `${H}px`;

  const all = data.panel_c.map((r) => r.avg_refs_per_entry || 0)
    .concat(systems.map((s) => data.overall[s]?.avg_refs_per_entry || 0));
  const maxV = Math.max(1, ...all);
  const yScale = (v) => padT + (H - padT - padB) * (1 - v / maxV);
  for (let k = 0; k <= 4; k++) {
    const v = (maxV * k) / 4;
    const y = yScale(v);
    svg.appendChild(svgText(padL - 6, y + 3, v.toFixed(1), "#64748b", "end", 10));
    svg.appendChild(svgLine(padL, y, W - padR, y, "rgba(15,23,42,0.07)"));
  }
  svg.appendChild(svgText(8, padT - 6, "refs/entry", "#64748b", "start", 10, 600));

  const colorFor = { adapt_fwd: "#60a5fa", adapt_oracle: "#a78bfa" };
  const groupW = (W - padL - padR) / domains.length;
  const barW = Math.min(28, groupW / (systems.length + 1) - 2);
  domains.forEach((dom, di) => {
    const gx = padL + di * groupW + (groupW - barW * systems.length - 4) / 2;
    systems.forEach((sys_, si) => {
      const v = dom === "OVERALL"
        ? (data.overall[sys_]?.avg_refs_per_entry || 0)
        : (data.panel_c.find((r) => r.domain === dom && r.system === sys_)?.avg_refs_per_entry || 0);
      const bx = gx + si * (barW + 4);
      const y = yScale(v);
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", bx); r.setAttribute("y", y);
      r.setAttribute("width", barW); r.setAttribute("height", (H - padB) - y);
      r.setAttribute("fill", colorFor[sys_] || "#60a5fa");
      r.appendChild(_svgTitle(`${dom} · ${modeLabel(sys_, "short")}: ${v.toFixed(2)} refs/entry`));
      svg.appendChild(r);
      svg.appendChild(svgText(bx + barW / 2, y - 4, v.toFixed(1), "#334155", "middle", 8.5, 600));
    });
    svg.appendChild(
      svgText(gx + (barW * systems.length + 4) / 2, H - padB + 14,
        dom, dom === "OVERALL" ? "#0f172a" : "#64748b", "middle", 10, dom === "OVERALL" ? 700 : 400)
    );
  });
  svg.appendChild(svgLine(padL, H - padB, W - padR, H - padB, "#cbd5e1"));

  wrap.appendChild(svg);
  wrap.appendChild(
    el("div", { class: "mem-legend" }, [
      el("span", { class: "item" }, [el("span", { class: "sw", style: "background:#60a5fa" }), modeLabel("adapt_fwd")]),
      el("span", { class: "item" }, [el("span", { class: "sw", style: "background:#a78bfa" }), modeLabel("adapt_oracle")]),
    ])
  );
  return wrap;
}

function svgLine(x1, y1, x2, y2, color, w = 1) {
  const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
  l.setAttribute("x1", x1); l.setAttribute("y1", y1);
  l.setAttribute("x2", x2); l.setAttribute("y2", y2);
  l.setAttribute("stroke", color); l.setAttribute("stroke-width", w);
  return l;
}

// ---------- Helpers ----------
function num(x, digits = 2) {
  if (x == null || isNaN(x)) return "—";
  return Number(x).toFixed(digits);
}
function signed(x, digits = 2) {
  if (x == null || isNaN(x)) return "—";
  return (x >= 0 ? "+" : "") + Number(x).toFixed(digits);
}
function fmtCell(col, v) {
  if (v == null) return "—";
  if (typeof v !== "number") return String(v);
  if (/__success$|^success/.test(col) || col.includes("verifier_pr") || col.includes("rate") || col.includes("give_up") || col.includes("hallucinated")) return fmtPct(v);
  if (col.includes("token") || col === "wall_ms") return Math.round(v).toLocaleString();
  return Number(v).toFixed(3);
}

// Wire the toolbar
$("#ins-run").addEventListener("change", onInsightsRunChange);
$("#ins-view").addEventListener("change", () => renderInsightsView());
$("#ins-refresh").addEventListener("click", () => renderInsightsView());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Honour the URL on first paint so /, /tools, /tools/insights, … all land
// directly on the right view without pushing a duplicate history entry.
// loadHome() (and the other lazy initialisers) fire from inside showTab()
// the first time a /tools/* view is actually opened, so visiting the root
// landing doesn't kick off the four Insights fetches.
showTab(tabFromLocation(), { skipPushState: true });
// Make sure history.state reflects the tab we just rendered, so the user's
// first Back navigation isn't a no-op.
if (!window.history.state || !window.history.state.tab) {
  window.history.replaceState({ tab: tabFromLocation() }, "");
}

// Run the landing diagram alignment a couple of times after first paint
// so it survives webfont swap and any late-layout settling.
setTimeout(alignFeedbackLoop, 0);
setTimeout(alignFeedbackLoop, 300);
setTimeout(alignFeedbackLoop, 1200);
