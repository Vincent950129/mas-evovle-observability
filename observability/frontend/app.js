// EvoHarnessBench — single-page frontend.
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
  "skill-datasets": "/skills/benchmark",
  "skill-results": "/skills/results",
  "agent-datasets": "/agents/benchmark",
  "agents-results": "/agents/results",
};
const PATH_TO_TAB = (() => {
  const m = {};
  Object.entries(TAB_TO_PATH).forEach(([k, v]) => { m[v] = k; });
  m["/tools"] = "home";
  m["/skills"] = "skill-results";
  m["/agents"] = "agents-results";
  return m;
})();

// Which tabs belong to which URL space, used to show/hide the per-space
// nav in the header.
const TOOLS_TABS = new Set(["home", "datasets", "results", "insights"]);
const SKILLS_TABS = new Set(["skill-datasets", "skill-results"]);
const AGENTS_TABS = new Set(["agent-datasets", "agents-results"]);

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

  // Hide the whole nav on the root landing; otherwise show only the nav
  // group for the URL space the active tab belongs to (Tools vs Skills).
  const tabs = document.getElementById("tabs");
  if (tabs) tabs.classList.toggle("tabs-hidden", name === "landing");
  const inSkills = SKILLS_TABS.has(name);
  const inAgents = AGENTS_TABS.has(name);
  // The Benchmark detail views live under Dataset building, not the evaluation
  // section: there we hide that axis's eval group and surface only the
  // "← Back to dataset building" link (which axis is encoded per detail view).
  const detailTrack = name === "datasets" ? "tools"
    : name === "skill-datasets" ? "skills"
    : name === "agent-datasets" ? "agents"
    : null;
  $$(".tab-group-tools").forEach((g) => g.classList.toggle("group-hidden", inSkills || inAgents || detailTrack !== null));
  $$(".tab-group-skills").forEach((g) => g.classList.toggle("group-hidden", !inSkills || name === "skill-datasets"));
  $$(".tab-group-agents").forEach((g) => g.classList.toggle("group-hidden", !inAgents || name === "agent-datasets"));
  const backDb = document.getElementById("back-to-db");
  if (backDb) {
    backDb.classList.toggle("tab-back-hidden", detailTrack === null);
    if (detailTrack) backDb.dataset.dbBack = detailTrack;
  }
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
  if (name === "skill-results" && !state.skrs.loaded) {
    state.skrs.loaded = true;
    if (state.skrs.mode === "summary") initSkillSummary();
    else loadSkillResults("");
  }
  if (name === "skill-datasets") {
    SKDS.onShow();
  }
  if (name === "agent-datasets") {
    AGDS.onShow();
  }
  if (name === "agents-results" && !state.ar.loaded) {
    state.ar.loaded = true;
    if (state.ar.mode === "summary") initAgentSummary();
    else loadAgentResults("");
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
  // "← Back to dataset building": return to the landing stepper's Dataset-
  // building page (P2) and re-select the track the detail page belongs to.
  const dbBack = e.target.closest("[data-db-back]");
  if (dbBack) {
    showTab("landing");
    LP.go(2);
    DB.select(dbBack.dataset.dbBack || "tools");
    return;
  }
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
  skrs: { path: "", loaded: false, mode: "summary", figs: null, _browserLoaded: false },
  ar: { path: "", loaded: false, mode: "summary", figs: null, _browserLoaded: false },
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

// Shared "Dataset statistics" table for the Evolution tab of every axis
// (tools / skills / agents). Reports the sample size with a per-version
// breakdown — train (adapt) / test / total tasks and the version's share of
// the whole sample — plus how the evolving resource pool grows. `opts`:
//   resourceLabel: "skills" | "tools" | "agents"  (column wording)
//   cumKey/newKey: per-stage field names for cumulative / newly-added counts
// Stage fields tolerate both the evolution (num_adapt/num_test/num_new_tasks)
// and summary (n_train/n_test/n_tasks) shapes.
function datasetStatsTable(stages, opts) {
  opts = opts || {};
  const resLabel = opts.resourceLabel || "items";
  const cumKey = opts.cumKey || null;
  const newKey = opts.newKey || null;
  const rows = (stages || []).map((s) => {
    const train = s.num_adapt ?? s.n_train ?? 0;
    const test = s.num_test ?? s.n_test ?? 0;
    return {
      name: s.name || `V${s.version ?? ""}`,
      train,
      test,
      tasks: s.num_new_tasks ?? s.n_tasks ?? train + test,
      nnew: newKey ? s[newKey] ?? null : null,
      cum: cumKey ? s[cumKey] ?? null : null,
    };
  });
  const tTrain = rows.reduce((a, r) => a + r.train, 0);
  const tTest = rows.reduce((a, r) => a + r.test, 0);
  const tTasks = rows.reduce((a, r) => a + r.tasks, 0);
  const finalCum = rows.length ? rows[rows.length - 1].cum : null;
  const n = (x) => (x == null ? "—" : Number(x).toLocaleString());
  const share = (x) => (tTasks ? `${((x / tTasks) * 100).toFixed(1)}%` : "—");

  const wrap = el("div", { class: "evo-chart card stats-card" });
  wrap.appendChild(el("h3", { class: "evo-section-title" }, "Dataset statistics — sample size per version"));
  wrap.appendChild(
    el("p", { class: "muted stats-sub" },
      `Sample size = ${n(tTasks)} tasks across ${rows.length} version${rows.length === 1 ? "" : "s"} ` +
      `(${n(tTrain)} train · ${n(tTest)} test). Each version is a disjoint train (adapt) + test split.`)
  );

  const head = ["Version", "Train (adapt)", "Test", "Total tasks", "% of sample"];
  if (cumKey) head.push(`+ new ${resLabel}`, `cumulative ${resLabel}`);
  const table = el("table", { class: "stats-table" }, [
    el("thead", {}, [
      el("tr", {}, head.map((h, i) => el("th", { class: i ? "num" : "" }, h))),
    ]),
    el("tbody", {}, rows.map((r) => {
      const cells = [
        el("td", {}, r.name),
        el("td", { class: "num" }, n(r.train)),
        el("td", { class: "num" }, n(r.test)),
        el("td", { class: "num num-strong" }, n(r.tasks)),
        el("td", { class: "num muted" }, share(r.tasks)),
      ];
      if (cumKey) {
        cells.push(el("td", { class: "num" }, r.nnew == null ? "—" : `+${r.nnew}`));
        cells.push(el("td", { class: "num" }, n(r.cum)));
      }
      return el("tr", {}, cells);
    })),
    el("tfoot", {}, [
      el("tr", { class: "stats-total" }, (() => {
        const cells = [
          el("td", {}, "Total"),
          el("td", { class: "num" }, n(tTrain)),
          el("td", { class: "num" }, n(tTest)),
          el("td", { class: "num num-strong" }, n(tTasks)),
          el("td", { class: "num muted" }, "100%"),
        ];
        if (cumKey) {
          cells.push(el("td", { class: "num" }, "—"));
          cells.push(el("td", { class: "num" }, n(finalCum)));
        }
        return cells;
      })()),
    ]),
  ]);
  wrap.appendChild(table);
  return wrap;
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

  // -- Dataset-size statistics table (sample size + per-version splits)
  root.appendChild(datasetStatsTable(data.stages, {
    resourceLabel: "tools", cumKey: "num_cumulative_tools", newKey: "num_new_tools",
  }));

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

// ---------------------------------------------------------------------------
// Skill-evolution results (evovle_skills/jobs): Summary (aggregate figures)
// + Browser (lazy file tree over runs → domain → version → run_N → trials).
// ---------------------------------------------------------------------------
const SKILL_BROWSE_CFG = {
  filesSel: "#skrs-files",
  detailSel: "#skrs-detail",
  apiBase: "/api/skill_results",
};

$("#skrs-modes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-skrs-mode]");
  if (!b) return;
  setSkillResultsMode(b.dataset.skrsMode);
});
$("#skrs-up").addEventListener("click", () => {
  if (!state.skrs.path) return;
  const parts = state.skrs.path.split("/").filter(Boolean);
  parts.pop();
  loadSkillResults(parts.join("/"));
});

function setSkillResultsMode(mode) {
  state.skrs.mode = mode;
  $$("#skrs-modes [data-skrs-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.skrsMode === mode)
  );
  $(".skrs-browser-tools").style.display = mode === "browser" ? "" : "none";
  $("#skrs-browser").style.display = mode === "browser" ? "" : "none";
  $("#skrs-summary").style.display = mode === "summary" ? "" : "none";
  if (mode === "summary") initSkillSummary();
  if (mode === "browser" && !state.skrs._browserLoaded) {
    state.skrs._browserLoaded = true;
    loadSkillResults("");
  }
}

async function initSkillSummary() {
  if (state.skrs.figs) return;
  const root = $("#skrs-summary");
  root.innerHTML = `<div class="empty">Loading skill-evolution summary…</div>`;
  let data;
  try {
    data = await fetchJson("/api/skill_results/summary_figures");
  } catch (e) {
    root.innerHTML = `<div class="empty error">Failed to load summary: ${escapeHtml(e.message)}</div>`;
    return;
  }
  state.skrs.figs = data;
  renderSkillSummary(root, data);
}

function renderSkillSummary(root, data) {
  root.innerHTML = "";
  root.appendChild(
    el("p", { class: "muted" }, [
      "Aggregate results for self-evolving skills across modes ",
      el("strong", {}, "(no-skill / oracle-skill / evolved-skill)"),
      " and domains. Figures are produced by the analysis pipeline under ",
      el("code", {}, "evovle_skills/jobs/_analysis"),
      ". Use the ",
      el("strong", {}, "Browser"),
      " tab to drill into individual runs → domain → version → trial.",
    ])
  );

  const groups = (data && data.groups) || [];
  if (!groups.length) {
    root.appendChild(
      el("div", { class: "empty" }, "No summary figures found yet under _analysis/.")
    );
    return;
  }
  for (const g of groups) {
    root.appendChild(el("h3", { class: "skrs-fig-group" }, g.label));
    const grid = el("div", { class: "skrs-figs" });
    for (const f of g.figures) {
      const rawUrl = `/api/skill_results/raw?path=${encodeURIComponent(f.path)}`;
      const img = el("img", { src: rawUrl, alt: f.name, loading: "lazy" });
      img.addEventListener("error", () => {
        img.replaceWith(el("div", { class: "empty error" }, "Could not load image."));
      });
      grid.appendChild(
        el("figure", { class: "skrs-fig" }, [
          el("figcaption", {}, [
            el("span", { style: "flex:1" }, f.name),
            downloadLink(`${rawUrl}&download=1`, "Download figure", ""),
          ]),
          el("a", { href: rawUrl, target: "_blank", rel: "noopener" }, [img]),
        ])
      );
    }
    root.appendChild(grid);
  }
}

async function loadSkillResults(path) {
  state.skrs.path = path;
  const url = new URL("/api/skill_results/tree", location.origin);
  if (path) url.searchParams.set("path", path);
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    toast(String(e), true);
    return;
  }
  renderSkillBreadcrumb(path);
  const dl = $("#skrs-dl-folder");
  if (dl) {
    dl.href = `/api/skill_results/download_zip?path=${encodeURIComponent(path || "")}`;
    dl.title = path
      ? `Download "${path}" as .zip`
      : "Download the entire evovle_skills/jobs folder as .zip";
  }
  renderSkillTree(data);
  const detail = $("#skrs-detail");
  detail.innerHTML = "";
  detail.appendChild(
    el(
      "div",
      { class: "empty" },
      path === ""
        ? "Top of evovle_skills/jobs. Pick a run (mode) → domain → version → run → trial."
        : "Open a file on the left."
    )
  );
}

function renderSkillBreadcrumb(path) {
  const root = $("#skrs-breadcrumb");
  root.innerHTML = "";
  root.appendChild(
    el("span", { class: "crumb", onclick: () => loadSkillResults("") }, "jobs")
  );
  if (!path) return;
  const parts = path.split("/").filter(Boolean);
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    const partAcc = acc;
    root.appendChild(document.createTextNode(" / "));
    root.appendChild(el("span", { class: "crumb", onclick: () => loadSkillResults(partAcc) }, p));
  }
}

function renderSkillTree(data) {
  const dirs = $("#skrs-dirs");
  const files = $("#skrs-files");
  dirs.innerHTML = "";
  files.innerHTML = "";

  for (const d of data.dirs) {
    const dirPath = state.skrs.path ? `${state.skrs.path}/${d}` : d;
    dirs.appendChild(
      el("li", { onclick: () => loadSkillResults(dirPath) }, [
        el("span", { style: "flex:1" }, d),
        downloadLink(
          `/api/skill_results/download_zip?path=${encodeURIComponent(dirPath)}`,
          "Download folder as .zip",
          "zip"
        ),
      ])
    );
  }
  for (const f of data.files) {
    const path = state.skrs.path ? `${state.skrs.path}/${f.name}` : f.name;
    const li = el(
      "li",
      {
        class: "file",
        onclick: () => openResultFile(path, f.name, SKILL_BROWSE_CFG),
      },
      [
        el("span", { style: "flex:1" }, f.name),
        el("span", { class: "muted", style: "font-size:11px;font-family:inherit;" }, fmtBytes(f.size)),
        downloadLink(`/api/skill_results/raw?path=${encodeURIComponent(path)}&download=1`, "Download file", ""),
      ]
    );
    li.dataset.path = path;
    files.appendChild(li);
  }
  if (!data.dirs.length && !data.files.length) {
    dirs.appendChild(el("li", { class: "muted" }, "(empty)"));
  }
}

// ---------------------------------------------------------------------------
// Agent-evolution results (evovle_agents/jobs): the AGENTS-axis evaluation
// view — Summary (aggregate figures) + Browser (lazy file tree over settings
// → domain → version → run_N → trials). Mirrors the skill-results view, reuses
// the shared openResultFile() detail renderer.
// ---------------------------------------------------------------------------
const AGENT_BROWSE_CFG = {
  filesSel: "#ar-files",
  detailSel: "#ar-detail",
  apiBase: "/api/agent_results",
};

$("#ar-modes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-ar-mode]");
  if (!b) return;
  setAgentResultsMode(b.dataset.arMode);
});
$("#ar-up").addEventListener("click", () => {
  if (!state.ar.path) return;
  const parts = state.ar.path.split("/").filter(Boolean);
  parts.pop();
  loadAgentResults(parts.join("/"));
});

function setAgentResultsMode(mode) {
  state.ar.mode = mode;
  $$("#ar-modes [data-ar-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.arMode === mode)
  );
  $(".ar-browser-tools").style.display = mode === "browser" ? "" : "none";
  $("#ar-browser").style.display = mode === "browser" ? "" : "none";
  $("#ar-summary").style.display = mode === "summary" ? "" : "none";
  if (mode === "summary") initAgentSummary();
  if (mode === "browser" && !state.ar._browserLoaded) {
    state.ar._browserLoaded = true;
    loadAgentResults("");
  }
}

async function initAgentSummary() {
  if (state.ar.figs) return;
  const root = $("#ar-summary");
  root.innerHTML = `<div class="empty">Loading agent-evolution summary…</div>`;
  let data;
  try {
    data = await fetchJson("/api/agent_results/summary_figures");
  } catch (e) {
    root.innerHTML = `<div class="empty error">Failed to load summary: ${escapeHtml(e.message)}</div>`;
    return;
  }
  state.ar.figs = data;
  renderAgentSummary(root, data);
}

function renderAgentSummary(root, data) {
  root.innerHTML = "";
  root.appendChild(
    el("p", { class: "muted" }, [
      "Aggregate evaluation results for the agent settings ",
      el("strong", {}, "(oracle-agents / cumulative-agents)"),
      " across domains. Figures are produced by the analysis pipeline under ",
      el("code", {}, "evovle_agents/jobs/_analysis"),
      ". Use the ",
      el("strong", {}, "Browser"),
      " tab to drill into individual runs → domain → version → trial. ",
      "For how these agents are built, see ",
      el("strong", {}, "Agents / Benchmark"),
      ".",
    ])
  );

  const groups = (data && data.groups) || [];
  if (!groups.length) {
    root.appendChild(
      el("div", { class: "empty" }, "No summary figures found yet under _analysis/.")
    );
    return;
  }
  for (const g of groups) {
    root.appendChild(el("h3", { class: "skrs-fig-group" }, g.label));
    const grid = el("div", { class: "skrs-figs" });
    for (const f of g.figures) {
      const rawUrl = `/api/agent_results/raw?path=${encodeURIComponent(f.path)}`;
      const img = el("img", { src: rawUrl, alt: f.name, loading: "lazy" });
      img.addEventListener("error", () => {
        img.replaceWith(el("div", { class: "empty error" }, "Could not load image."));
      });
      grid.appendChild(
        el("figure", { class: "skrs-fig" }, [
          el("figcaption", {}, [
            el("span", { style: "flex:1" }, f.name),
            downloadLink(`${rawUrl}&download=1`, "Download figure", ""),
          ]),
          el("a", { href: rawUrl, target: "_blank", rel: "noopener" }, [img]),
        ])
      );
    }
    root.appendChild(grid);
  }
}

async function loadAgentResults(path) {
  state.ar.path = path;
  const url = new URL("/api/agent_results/tree", location.origin);
  if (path) url.searchParams.set("path", path);
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    toast(String(e), true);
    return;
  }
  renderAgentBreadcrumb(path);
  const dl = $("#ar-dl-folder");
  if (dl) {
    dl.href = `/api/agent_results/download_zip?path=${encodeURIComponent(path || "")}`;
    dl.title = path
      ? `Download "${path}" as .zip`
      : "Download the entire evovle_agents/jobs folder as .zip";
  }
  renderAgentTree(data);
  const detail = $("#ar-detail");
  detail.innerHTML = "";
  detail.appendChild(
    el(
      "div",
      { class: "empty" },
      path === ""
        ? "Top of evovle_agents/jobs. Pick a setting (mode) → domain → version → run → trial."
        : "Open a file on the left."
    )
  );
}

function renderAgentBreadcrumb(path) {
  const root = $("#ar-breadcrumb");
  root.innerHTML = "";
  root.appendChild(
    el("span", { class: "crumb", onclick: () => loadAgentResults("") }, "jobs")
  );
  if (!path) return;
  const parts = path.split("/").filter(Boolean);
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    const partAcc = acc;
    root.appendChild(document.createTextNode(" / "));
    root.appendChild(el("span", { class: "crumb", onclick: () => loadAgentResults(partAcc) }, p));
  }
}

function renderAgentTree(data) {
  const dirs = $("#ar-dirs");
  const files = $("#ar-files");
  dirs.innerHTML = "";
  files.innerHTML = "";

  for (const d of data.dirs) {
    const dirPath = state.ar.path ? `${state.ar.path}/${d}` : d;
    dirs.appendChild(
      el("li", { onclick: () => loadAgentResults(dirPath) }, [
        el("span", { style: "flex:1" }, d),
        downloadLink(
          `/api/agent_results/download_zip?path=${encodeURIComponent(dirPath)}`,
          "Download folder as .zip",
          "zip"
        ),
      ])
    );
  }
  for (const f of data.files) {
    const path = state.ar.path ? `${state.ar.path}/${f.name}` : f.name;
    const li = el(
      "li",
      {
        class: "file",
        onclick: () => openResultFile(path, f.name, AGENT_BROWSE_CFG),
      },
      [
        el("span", { style: "flex:1" }, f.name),
        el("span", { class: "muted", style: "font-size:11px;font-family:inherit;" }, fmtBytes(f.size)),
        downloadLink(`/api/agent_results/raw?path=${encodeURIComponent(path)}&download=1`, "Download file", ""),
      ]
    );
    li.dataset.path = path;
    files.appendChild(li);
  }
  if (!data.dirs.length && !data.files.length) {
    dirs.appendChild(el("li", { class: "muted" }, "(empty)"));
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

async function openResultFile(path, name, cfg) {
  // cfg lets the skills browser reuse this exact viewer with a different API
  // base + DOM targets. Defaults to the tools (evolve_results) browser.
  cfg = cfg || {};
  const filesSel = cfg.filesSel || "#rs-files";
  const detailSel = cfg.detailSel || "#rs-detail";
  const apiBase = cfg.apiBase || "/api/results";
  $$(`${filesSel} li`).forEach((li) => li.classList.toggle("active", li.dataset.path === path));
  const detail = $(detailSel);

  // Image files: render inline instead of as raw bytes.
  if (IMAGE_EXTS.includes(fileExt(name))) {
    detail.innerHTML = "";
    detail.appendChild(el("h2", {}, name));
    detail.appendChild(el("div", { class: "muted" }, path));
    const rawUrl = `${apiBase}/raw?path=${encodeURIComponent(path)}`;
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
    const data = await fetchJson(`${apiBase}/file?path=${encodeURIComponent(path)}`);
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

// ===========================================================================
// Build Inspector (Agents axis) — how the skill track becomes the agent track,
// and what that guarantees. Backed by /api/build/*. Self-contained module;
// reuses shared helpers ($, $$, el, escapeHtml, fetchJson, fmtPct).
// ===========================================================================
const BI = (() => {
  const S = {
    domain: null,
    domains: [], booted: false, tab: null,
    cov: null, covFilter: "all",
  };
  const TAB_BODY = {
    "agents-overview": "#bi-overview",
    "agents-skills": "#bi-skills",
    "agents-agents": "#bi-agents",
    "agents-scoping": "#bi-scoping",
    "agents-coverage": "#bi-coverage",
  };
  const esc = escapeHtml;
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;

  const pill = (t, cls = "bi-dim") => `<span class="bi-pill ${cls}">${esc(t)}</span>`;
  const chips = (items, cls) => (!items || !items.length)
    ? `<span class="bi-faint">—</span>`
    : `<div class="bi-chips">${items.map((t) => pill(t, cls)).join("")}</div>`;
  function bar(label, value, max, cls, suffix = "") {
    const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
    return `<div class="bi-bar-row"><div class="bi-bl">${esc(label)}</div>` +
      `<div class="bi-bar-track"><div class="bi-bar-fill ${cls}" style="width:${w}%">${value}${suffix}</div></div></div>`;
  }
  const stat = (num, lbl, cls = "") =>
    `<div class="bi-card bi-stat ${cls}"><span class="bi-num">${num}</span><span class="bi-lbl">${esc(lbl)}</span></div>`;

  function hlToml(src) {
    return esc(src).split("\n").map((line) => {
      if (/^\s*#/.test(line)) return `<span class="bi-c">${line}</span>`;
      const m = line.match(/^(\[\[?[^\]]+\]?\])(.*)$/);
      if (m) return `<span class="bi-h">${m[1]}</span>${m[2]}`;
      return line
        .replace(/^([A-Za-z0-9_]+)(\s*=\s*)/, '<span class="bi-k">$1</span>$2')
        .replace(/(&quot;(?:[^&]|&(?!quot;))*&quot;)/g, '<span class="bi-s">$1</span>');
    }).join("\n");
  }

  function controls() {
    const dopts = S.domains.map((d) =>
      `<option value="${d}" ${d === S.domain ? "selected" : ""}>${d}</option>`).join("");
    return `<div class="bi-controls">
      <label>Domain <select id="bi-domain">${dopts}</select></label>
      <span class="bi-controls-note">capability partition · live from the real build code</span>
    </div>`;
  }

  function body() { return $(TAB_BODY[S.tab]); }

  async function onShow(tab) {
    S.tab = tab;
    if (!S.booted) {
      const node = body();
      if (node) node.innerHTML = `<div class="empty">Loading build inspector…</div>`;
      try {
        const cfg = await fetchJson("/api/build/domains");
        S.domains = cfg.domains || [];
        S.domain = S.domains[0];
        S.booted = true;
      } catch (e) {
        if (node) node.innerHTML = `<div class="bi-error">Could not load build APIs: ${esc(e.message)}</div>`;
        return;
      }
    }
    render();
  }

  async function render() {
    const node = body();
    if (!node) return;
    node.innerHTML = controls() + `<div class="empty">Loading…</div>`;
    try {
      let html;
      if (S.tab === "agents-overview") html = await renderOverview();
      else if (S.tab === "agents-skills") html = await renderSkills();
      else if (S.tab === "agents-agents") html = await renderAgents();
      else if (S.tab === "agents-scoping") html = await renderScoping();
      else if (S.tab === "agents-coverage") html = await renderCoverage();
      node.innerHTML = controls() + html;
    } catch (e) {
      node.innerHTML = controls() + `<div class="bi-error">Error: ${esc(e.message)}</div>`;
    }
  }

  // ---- views -------------------------------------------------------------
  async function renderOverview() {
    const d = await fetchJson(`/api/build/${S.domain}/overview`);
    const flow = `<div class="bi-flow">
      <div class="bi-step bi-skillc"><h4>1 · Dataset rows</h4><p>Each task lists its
        ${pill("oracle_skills", "bi-skill")} and gold ${pill("selected_tools", "bi-tool")}.</p></div>
      <div class="bi-arrow">→</div>
      <div class="bi-step bi-skillc"><h4>2 · Skill library</h4><p>One <code>SKILL.md</code> per oracle
        skill, pooled <b>per-version</b> &amp; <b>cumulatively</b>.</p></div>
      <div class="bi-arrow">→</div>
      <div class="bi-step bi-agentc"><h4>3 · Capability partition</h4><p>The tool universe is split into
        disjoint, COMPLETE capability bundles (deterministic, no LLM).</p></div>
      <div class="bi-arrow">→</div>
      <div class="bi-step bi-toolc"><h4>4 · Capability agents</h4><p>Each capability becomes one Codex
        subagent owning its whole tool bundle.</p></div>
    </div>`;
    const maxPool = Math.max(...d.versions.map((v) => v.n_cumulative_pool), 1);
    const rows = d.versions.map((v) => `<tr>
      <td><b>v${v.version}</b></td>
      <td class="bi-num">${v.n_train}</td><td class="bi-num">${v.n_test}</td>
      <td class="bi-num">${v.n_tasks}</td>
      <td>${bar(`v${v.version}`, v.n_version_pool, maxPool, "bi-accent")}</td>
      <td>${bar(`v${v.version}`, v.n_cumulative_pool, maxPool, "bi-accent")}</td>
      <td class="bi-num">${v.n_distractors ? pill(v.n_distractors, "bi-forced") : "0"}</td>
    </tr>`).join("");
    return `<div class="bi-note">The <b>skill track</b> (<code>evovle_skills</code>) and
      <b>agent track</b> (<code>evovle_agents</code>) share the same dataset &amp; oracle library;
      the agent track materializes each skill 1:1 as a subagent. Everything here is computed live
      from the build code — exactly what a trial would mount.</div>
      ${flow}
      <div class="bi-cards">
        ${stat(d.n_versions, "versions")}
        ${stat(d.n_skills_total, "oracle skills = agents", "bi-agentnum")}
        ${stat(d.versions.reduce((a, v) => a + v.n_tasks, 0), "total tasks")}
        ${stat(d.versions.at(-1)?.n_cumulative_pool ?? 0, "final pool size", "bi-accentnum")}
      </div>
      <h3 class="bi-h3">Evolving resource — per-version vs cumulative pool</h3>
      <p class="bi-tip">A skill/agent enters the pool at the version its tasks first need it; the
        cumulative pool only grows. Agents beyond a version's own set are ${pill("distractors", "bi-forced")}.</p>
      <table class="bi-grid"><thead><tr><th>Version</th><th class="bi-num">Train</th>
        <th class="bi-num">Test</th><th class="bi-num">Tasks</th><th>Per-version pool</th>
        <th>Cumulative pool</th><th class="bi-num">Distractors</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
  }

  async function renderSkills() {
    const d = await fetchJson(`/api/build/${S.domain}/skills`);
    const rows = d.skills.map((s, i) => `<tr class="bi-click" data-bi-skill="${esc(s.slug)}">
      <td class="bi-faint bi-num">${i + 1}</td>
      <td><code>${esc(s.slug)}</code></td>
      <td>${pill(s.agent_name, "bi-agent")}</td>
      <td class="bi-muted">${esc((s.description || "").slice(0, 90))}${(s.description || "").length > 90 ? "…" : ""}</td>
      <td class="bi-num">${s.references.length}</td><td class="bi-num">${s.n_tasks}</td>
    </tr>`).join("");
    return `<div class="bi-note"><b>Can an agent hold more than one skill?</b> No — strictly 1:1.
      All ${d.n_skills} oracle skills below; each maps to exactly one agent. Click a row for the
      <code>SKILL.md</code> body + references.</div>
      <table class="bi-grid"><thead><tr><th class="bi-num">#</th><th>Skill slug</th><th>→ Agent</th>
        <th>Description (routing-hint source)</th><th class="bi-num">refs</th>
        <th class="bi-num">tasks</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function renderAgents() {
    const d = await fetchJson(`/api/build/${S.domain}/agents`);
    const maxTools = Math.max(...d.agents.map((a) => a.n_tools), 1);
    const rows = d.agents.map((a) => `<tr class="bi-click" data-bi-agent="${esc(a.source_slug)}">
      <td>${pill(a.agent_name, "bi-agent")}</td>
      <td><code>${esc(a.source_slug)}</code></td>
      <td style="min-width:220px">${bar(a.agent_name, a.n_tools, maxTools, "bi-accent")}</td>
    </tr>`).join("");
    return `<div class="bi-note"><b>${d.n_agents} capability agents</b>
      (${d.one_to_one ? pill("disjoint", "bi-solo") : pill("OVERLAP", "bi-hole")}). Each agent owns a
      COMPLETE, disjoint tool bundle (deterministic, no LLM). Click an agent for its generated Codex
      TOML.</div>
      <table class="bi-grid"><thead><tr><th>Agent</th><th>Capability</th>
        <th>Tool bundle</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function renderScoping() {
    const d = await fetchJson(`/api/build/${S.domain}/scoping`);
    const maxTools = Math.max(...d.per_agent.map((a) => a.n_tools), 1);
    const agentBars = d.per_agent.map((a) => bar(a.agent_name, a.n_tools, maxTools, "bi-accent")).join("");
    const sharedEntries = Object.entries(d.shared_tools).sort((a, b) => b[1].length - a[1].length);
    const sharedRows = sharedEntries.slice(0, 250).map(([t, agents]) =>
      `<tr><td><code>${esc(t)}</code></td><td class="bi-num">${agents.length}</td>
        <td>${chips(agents, "bi-agent")}</td></tr>`).join("");
    return `<div class="bi-note"><b>Capability partition:</b> every tool is owned by exactly one
      capability agent, so the per-agent bundles are <b>complete</b> (each agent can finish its
      capability) and <b>disjoint</b> (no tool shared across agents).</div>
      <div class="bi-cards">
        ${stat(d.n_agents, "agents")}
        ${stat(d.n_distinct_tools, "distinct tools")}
        ${stat(d.n_shared_tools, "shared across ≥2 agents", d.n_shared_tools ? "bi-warnnum" : "bi-solonum")}
        ${stat(pct(d.shared_fraction), "tool overlap", d.n_shared_tools ? "bi-warnnum" : "bi-solonum")}
      </div>
      <p class="bi-tip">Disjoint scopes (0% overlap) are <b>why</b> a task whose gold tools span several
        capabilities cannot be solved by a single agent → forced multi-agent.</p>
      <div class="bi-split2">
        <div><h3 class="bi-h3">Tools per agent</h3>${agentBars}</div>
        <div><h3 class="bi-h3">Shared tools (in ≥2 agent scopes)</h3>
          <div class="bi-tablewrap"><table class="bi-grid"><thead><tr><th>Tool</th>
            <th class="bi-num"># agents</th><th>Agents</th></tr></thead>
            <tbody>${sharedRows || `<tr><td colspan="3" class="bi-faint">none</td></tr>`}</tbody>
          </table></div></div>
      </div>`;
  }

  async function renderCoverage() {
    const d = await fetchJson(`/api/build/${S.domain}/coverage`);
    S.cov = d;
    const dist = d.distribution;
    const maxc = Math.max(...Object.values(dist), 1);
    const distBars = Object.keys(dist).sort((a, b) => +a - +b).map((k) =>
      bar(`${k} agent${k === "1" ? "" : "s"}`, dist[k], maxc, k === "1" ? "bi-solo" : "bi-forced",
        ` task${dist[k] === 1 ? "" : "s"}`)).join("");
    return `<div class="bi-note"><b>Does a task need &gt;1 agent?</b> A task is
      ${pill("forced-multi", "bi-forced")} only if <b>no single</b> oracle agent's scope covers all its
      gold tools (min set-cover ≥ 2). A ${pill("hole", "bi-hole")} means the oracle agents can't jointly
      cover it.</div>
      <div class="bi-cards">
        ${stat(d.n_tasks, "tasks")}
        ${stat(d.solvable_by_one, "solvable by ONE agent", "bi-solonum")}
        ${stat(d.forced_multi_agent, "forced multi-agent", "bi-warnnum")}
        ${stat(pct(d.forced_fraction), "forced fraction", "bi-warnnum")}
        ${stat(d.coverage_holes, "coverage holes", d.coverage_holes ? "bi-holenum" : "bi-solonum")}
      </div>
      <div class="bi-split2">
        <div><h3 class="bi-h3">Min agents required (distribution)</h3>${distBars}
          <p class="bi-tip">${d.n_single_oracle_skill_tasks} tasks need a single capability agent
            (solo-solvable); the rest span ≥2 capabilities → forced multi-agent.</p></div>
        <div><h3 class="bi-h3">What the capability partition guarantees</h3>
          <ul class="bi-muted bi-ul">
          <li><b>0 coverage holes</b> — the partition is complete, so every task's gold tools are owned
            by some agent.</li>
          <li><b>Complete agents</b> — each agent owns its capability's WHOLE tool bundle, so it can
            always finish its part.</li>
          <li>Gold tools are <b>split across disjoint specialists</b>, so a task spanning ≥2 capabilities
            is forced multi-agent — no single agent can cover it.</li>
          </ul></div>
      </div>
      <h3 class="bi-h3">Per-task verdicts</h3>
      <div class="bi-search"><select id="bi-cov-filter">
        <option value="all">All tasks</option>
        <option value="forced">Forced multi-agent</option>
        <option value="solo">Solo-solvable</option>
        <option value="holes">Coverage holes</option>
      </select></div>
      <div class="bi-tablewrap"><table class="bi-grid" id="bi-cov-table">${covTableInner()}</table></div>`;
  }

  function covTableInner() {
    const d = S.cov;
    if (!d) return "";
    let tasks = d.per_task;
    if (S.covFilter === "forced") tasks = tasks.filter((t) => t.min_agents && t.min_agents >= 2);
    else if (S.covFilter === "solo") tasks = tasks.filter((t) => t.min_agents === 1);
    else if (S.covFilter === "holes") tasks = tasks.filter((t) => !t.coverable);
    const rows = tasks.slice(0, 600).map((t) => {
      const verdict = !t.coverable ? pill("hole", "bi-hole")
        : t.min_agents === 1 ? pill("solo", "bi-solo") : pill(`needs ${t.min_agents}`, "bi-forced");
      return `<tr class="bi-click" data-bi-task="${esc(t.task_id)}">
        <td><code>${esc(t.task_id.slice(0, 30))}…</code></td>
        <td class="bi-num">v${t.version}</td><td class="bi-num">${t.n_oracle_skills}</td>
        <td class="bi-num">${t.n_gold_tools}</td><td>${verdict}</td>
        <td>${chips(t.oracle_agents, "bi-agent")}</td></tr>`;
    }).join("");
    return `<thead><tr><th>Task</th><th class="bi-num">ver</th><th class="bi-num">caps</th>
      <th class="bi-num">gold</th><th>verdict</th><th>Capability agents</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="bi-faint">none</td></tr>`}</tbody>`;
  }

  // ---- drawers -----------------------------------------------------------
  function openDrawer(html) {
    $("#bi-drawer-body").innerHTML = html;
    $("#bi-drawer").classList.remove("hidden");
  }
  function closeDrawer() { $("#bi-drawer").classList.add("hidden"); }

  async function openSkill(slug) {
    const d = await fetchJson(`/api/build/${S.domain}/skills/${encodeURIComponent(slug)}`);
    openDrawer(`<h2 class="bi-dh"><code>${esc(d.slug)}</code></h2>
      <div class="bi-kv">
        <div class="bi-key">Becomes agent</div><div>${pill(d.agent_name, "bi-agent")}</div>
        <div class="bi-key">frontmatter name</div><div><code>${esc(d.frontmatter.name || "—")}</code></div>
        <div class="bi-key">In versions</div><div>${d.in_versions.map((v) => pill("v" + v)).join(" ") || "—"}</div>
        <div class="bi-key">references/</div><div>${chips(d.references, "bi-dim")}</div>
      </div>
      <h3 class="bi-h3">Description (→ agent routing hint)</h3>
      <div class="bi-note">${esc(d.frontmatter.description || "—")}</div>
      <h3 class="bi-h3">SKILL.md body <span class="bi-faint">(referenced, never inlined)</span></h3>
      <pre class="bi-code">${esc(d.body || "(empty)")}</pre>`);
  }

  async function openAgent(slug) {
    const d = await fetchJson(`/api/build/${S.domain}/agents/${encodeURIComponent(slug)}`);
    openDrawer(`<h2 class="bi-dh">${pill(d.agent_name, "bi-agent")}</h2>
      <div class="bi-kv">
        <div class="bi-key">Capability</div><div><code>${esc(d.source_slug)}</code></div>
        <div class="bi-key">Tool bundle</div><div>${d.n_tools} tools (complete &amp; disjoint)</div>
        <div class="bi-key">In versions</div><div>${d.in_versions.map((v) => pill("v" + v)).join(" ") || "—"}</div>
        <div class="bi-key">Used by</div><div>${d.n_tasks} tasks</div>
      </div>
      <h3 class="bi-h3">Oracle tool bundle</h3>${chips(d.tools, "bi-tool")}
      <h3 class="bi-h3">Generated Codex agent (TOML)</h3>
      <pre class="bi-code">${hlToml(d.toml)}</pre>`);
  }

  async function openTask(taskId) {
    const d = await fetchJson(`/api/build/${S.domain}/task/${encodeURIComponent(taskId)}`);
    const verdict = d.verdict === "forced_multi" ? pill(`forced — needs ${d.min_agents}`, "bi-forced")
      : d.verdict === "solo" ? pill("solo-solvable", "bi-solo") : pill("uncoverable", "bi-hole");
    const agentRows = d.agents.map((a) => `<tr>
      <td>${pill(a.agent_name, "bi-agent")}</td><td class="bi-num">${a.scope_size}</td>
      <td class="bi-num">${a.n_covers}/${d.gold_tools.length}${a.covers_all ? " " + pill("all", "bi-solo") : ""}</td>
      <td>${(a.attributed.length ? chips(a.attributed, "bi-tool") : `<span class="bi-faint">—</span>`)}</td>
    </tr>`).join("");
    openDrawer(`<h2 class="bi-dh">Task ${verdict}</h2>
      <div class="bi-kv">
        <div class="bi-key">task_id</div><div><code>${esc(d.task_id)}</code></div>
        <div class="bi-key">version / split</div><div>v${d.version} · ${esc(d.split)}</div>
        <div class="bi-key">Oracle agents</div><div>${chips(d.oracle_agents, "bi-agent")}</div>
        <div class="bi-key">Gold tools (${d.gold_tools.length})</div><div>${chips(d.gold_tools, "bi-tool")}</div>
        <div class="bi-key">Min set-cover</div><div>${d.min_agents == null ? pill("uncoverable", "bi-hole")
          : `${d.min_agents} agent(s): ${chips(d.cover_set, "bi-agent")}`}</div>
      </div>
      <h3 class="bi-h3">Per-agent coverage of this task's gold tools</h3>
      <p class="bi-tip"><b>covers</b> = gold tools in the agent's capability bundle.
        <b>attributed</b> = the gold tools this capability owns (disjoint, so covers == attributed).</p>
      <table class="bi-grid"><thead><tr><th>Agent</th><th class="bi-num">scope</th>
        <th class="bi-num">covers</th><th>attributed (this task)</th></tr></thead>
        <tbody>${agentRows}</tbody></table>
      <h3 class="bi-h3">User prompt</h3>
      <pre class="bi-code">${esc((d.user_prompt || "").slice(0, 1500))}</pre>`);
  }

  // ---- delegated events --------------------------------------------------
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-bi-close]")) { closeDrawer(); return; }
    const sk = e.target.closest("[data-bi-skill]");
    if (sk) { openSkill(sk.dataset.biSkill); return; }
    const ag = e.target.closest("[data-bi-agent]");
    if (ag) { openAgent(ag.dataset.biAgent); return; }
    const tk = e.target.closest("[data-bi-task]");
    if (tk) { openTask(tk.dataset.biTask); return; }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "bi-domain") { S.domain = e.target.value; render(); }
    else if (e.target.id === "bi-cov-filter") {
      S.covFilter = e.target.value;
      const t = $("#bi-cov-table");
      if (t) t.innerHTML = covTableInner();
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  // Render a single inspector view (scoping/coverage) into an arbitrary
  // container, driven by an EXTERNAL domain selector (the Agents / Benchmark
  // mode bar). Self-boots so it works before onShow ever runs; the delegated
  // click/drawer/cov-filter listeners above keep working since they read S.
  async function renderInto(tab, container, domain) {
    if (!container) return;
    if (!S.booted) {
      container.innerHTML = `<div class="empty">Loading…</div>`;
      try {
        const cfg = await fetchJson("/api/build/domains");
        S.domains = cfg.domains || [];
        S.booted = true;
      } catch (e) {
        container.innerHTML = `<div class="bi-error">Could not load build APIs: ${esc(e.message)}</div>`;
        return;
      }
    }
    S.domain = domain;
    S.tab = tab;
    container.innerHTML = `<div class="empty">Loading…</div>`;
    try {
      const html = tab === "agents-scoping" ? await renderScoping() : await renderCoverage();
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = `<div class="bi-error">Error: ${esc(e.message)}</div>`;
    }
  }

  return { onShow, renderInto };
})();

// ---------------------------------------------------------------------------
// SKDS — Skills / Benchmark (dataset-building) explorer
// ---------------------------------------------------------------------------
// The SKILLS-axis analogue of the Tools "Benchmark" (#datasets) view: the same
// four sub-tabs — How it's built / Evolution / Real-world fit / Task Browser —
// but the evolving resource is the LATENT oracle SKILL library (S₁ ⊂ S₂ ⊂ …),
// not a tool catalog. Data comes from /api/skill-datasets/* (build_engine over
// the real evovle_skills rows + _oracle manifest). Reuses the ds-/evo-/rw-
// styles and the shared el()/chart helpers so it matches the Tools view 1:1.
const SKDS = (() => {
  const st = {
    mounted: false,
    domain: null,
    mode: "construct",
    sum: { data: null },
    evo: { data: null, loading: false },
    rw: { data: null, loading: false },
    tasks: [],
  };
  // Color a skill by the version that first introduces it (0-based).
  const VCOLORS = ["#2563eb", "#0ea5e9", "#6366f1", "#d97706", "#dc2626", "#059669"];
  const vcolor = (i) => VCOLORS[i % VCOLORS.length];

  // ===== lifecycle =========================================================
  async function onShow() {
    if (st.mounted) return;
    st.mounted = true;
    wire();
    try {
      const d = await fetchJson("/api/skill-datasets");
      const sel = $("#skds-domain");
      sel.innerHTML = (d.domains || [])
        .map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`)
        .join("");
      st.domain = (d.domains || [])[0] || null;
      if (st.domain) sel.value = st.domain;
    } catch (e) {
      $("#skds-construct").innerHTML =
        `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
      return;
    }
    applyModeVisibility(st.mode);
    await onDomainChange();
  }

  function wire() {
    $("#skds-modes").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-skds-mode]");
      if (b) setMode(b.dataset.skdsMode);
    });
    $("#skds-domain").addEventListener("change", onDomainChange);
    $("#skds-version").addEventListener("change", reloadTaskList);
    $("#skds-split").addEventListener("change", reloadTaskList);
    $("#skds-filter").addEventListener("input", renderTaskList);
  }

  function applyModeVisibility(mode) {
    $$("#skds-modes [data-skds-mode]").forEach((b) =>
      b.classList.toggle("active", b.dataset.skdsMode === mode));
    $(".skds-browser-tools").style.display = mode === "browser" ? "" : "none";
    $("#skds-browser").style.display = mode === "browser" ? "" : "none";
    $("#skds-evolution").style.display = mode === "evolution" ? "" : "none";
    $("#skds-construct").style.display = mode === "construct" ? "" : "none";
    const rw = $("#skds-realworld");
    if (rw) rw.style.display = mode === "realworld" ? "" : "none";
  }

  // Called on user tab clicks (data for the initial domain is already loaded
  // by onDomainChange, so the evo cache is warm by the time tabs are used).
  function setMode(mode) {
    st.mode = mode;
    applyModeVisibility(mode);
    if (mode === "construct" || mode === "evolution") {
      if (!st.evo.data) loadEvolution();
      else if (mode === "construct") renderConstruction($("#skds-construct"), st.evo.data, st.sum.data);
      else renderEvolution($("#skds-evolution"), st.evo.data);
    } else if (mode === "realworld") {
      loadRealworld();
    }
  }

  // ===== data loads ========================================================
  async function onDomainChange() {
    st.domain = $("#skds-domain").value;
    st.evo.data = null;
    try {
      st.sum.data = await fetchJson(`/api/skill-datasets/${st.domain}/summary`);
    } catch (e) {
      st.sum.data = null;
    }
    populateVersions();
    renderStages();
    await reloadTaskList();
    if (st.mode === "construct" || st.mode === "evolution") await loadEvolution();
    else if (st.mode === "realworld") await loadRealworld();
  }

  function populateVersions() {
    const sel = $("#skds-version");
    const stages = st.sum.data?.stages || [];
    sel.innerHTML = `<option value="">all</option>` +
      stages.map((s) => `<option value="${s.version}">V${s.version}</option>`).join("");
  }

  async function loadEvolution() {
    if (!st.domain || st.evo.loading) return;
    if (st.evo.data) {
      renderConstruction($("#skds-construct"), st.evo.data, st.sum.data);
      renderEvolution($("#skds-evolution"), st.evo.data);
      return;
    }
    st.evo.loading = true;
    try {
      const data = await fetchJson(`/api/skill-datasets/${st.domain}/evolution`);
      st.evo.data = data;
      renderConstruction($("#skds-construct"), data, st.sum.data);
      renderEvolution($("#skds-evolution"), data);
    } catch (e) {
      const msg = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
      $("#skds-evolution").innerHTML = msg;
      $("#skds-construct").innerHTML = msg;
    } finally {
      st.evo.loading = false;
    }
  }

  async function loadRealworld() {
    const root = $("#skds-realworld");
    if (st.rw.data) { renderRealworld(root, st.rw.data); return; }
    if (st.rw.loading) return;
    st.rw.loading = true;
    root.innerHTML = `<div class="empty">Loading real-world comparison…</div>`;
    try {
      const data = await fetchJson("/api/skill-datasets/realworld_comparison");
      st.rw.data = data;
      renderRealworld(root, data);
    } catch (e) {
      root.innerHTML = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
    } finally {
      st.rw.loading = false;
    }
  }

  async function reloadTaskList() {
    if (!st.domain) return;
    const version = $("#skds-version").value;
    const split = $("#skds-split").value;
    const url = new URL(`/api/skill-datasets/${st.domain}/tasks`, location.origin);
    if (version !== "") url.searchParams.set("version", version);
    url.searchParams.set("split", split || "all");
    try {
      const data = await fetchJson(url);
      st.tasks = data.tasks || [];
    } catch (e) {
      st.tasks = [];
    }
    renderTaskList();
  }

  // ===== CONSTRUCTION ("How it's built") ===================================
  function renderConstruction(root, evo, sum) {
    root.innerHTML = "";
    const stages = evo.stages || [];

    root.appendChild(el("div", { class: "evo-header" }, [
      el("h2", { class: "evo-title" }, `How the skill benchmark is built · ${evo.domain}`),
      el("p", { class: "muted" },
        `The policy of a domain is split into a hidden library of oracle SKILLS, ordered by task ` +
        `coverage and grown into nested versions S₁ ⊂ S₂ ⊂ … . The skills are never shown — the agent ` +
        `must author its own — while oracle tools are handed over so we isolate the skill itself. Below, the ` +
        `five construction steps on the current domain (${evo.n_skills_total} skills, ${stages.length} versions, ${evo.total_tasks ?? "?"} tasks).`),
    ]));

    root.appendChild(skdsStep1());
    root.appendChild(skdsStep2(evo, sum));
    root.appendChild(skdsStep3(stages));
    root.appendChild(skdsStep4(stages));
    root.appendChild(skdsStep5(sum));
  }

  // Step 1 — anatomy of a skill sample: X → hidden skills → oracle tools → Y
  function skdsStep1() {
    const W = 720, H = 210;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "construct-svg");
    svg.style.width = "100%"; svg.style.maxWidth = `${W}px`; svg.style.height = "auto";
    const blue = "#2563eb", purple = "#7c3aed", gold = "#ca8a04", green = "#16a34a", sub = "#64748b", txt = "#0f172a";
    const boxes = [
      { t: "Xᵢ", s: "user task", d: '"Register an HR case for the on-site mandate"', c: blue },
      { t: "Sᵢ", s: "latent oracle skills", d: "{ registering-an-hr-case }  ·  hidden", c: purple },
      { t: "Tᵢ", s: "oracle tools (given)", d: "{ get_user, create_new_hr_case, … }", c: gold },
      { t: "Yᵢ", s: "expected outcome", d: "verifier passes (case row created)", c: green },
    ];
    const boxW = 158, boxH = 116, gapX = (W - boxW * 4) / 5;
    boxes.forEach((b, i) => {
      const x = gapX + i * (boxW + gapX), y = 26;
      svg.appendChild(svgRect(x, y, boxW, boxH, "#f8fafc", b.c, 8));
      svg.appendChild(svgText(x + boxW / 2, y + 26, b.t, b.c, "middle", 20, 800));
      svg.appendChild(svgText(x + boxW / 2, y + 46, b.s, sub, "middle", 10, 600));
      const d = b.d;
      svg.appendChild(svgText(x + boxW / 2, y + 72, d.slice(0, 24), txt, "middle", 9));
      if (d.length > 24) svg.appendChild(svgText(x + boxW / 2, y + 86, d.slice(24, 48), txt, "middle", 9));
      if (d.length > 48) svg.appendChild(svgText(x + boxW / 2, y + 100, d.slice(48, 72), txt, "middle", 9));
      if (i < boxes.length - 1) {
        const ax = x + boxW + 3, ex = x + boxW + gapX - 3, ay = y + boxH / 2;
        const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
        ln.setAttribute("x1", ax); ln.setAttribute("y1", ay); ln.setAttribute("x2", ex); ln.setAttribute("y2", ay);
        ln.setAttribute("stroke", sub); ln.setAttribute("stroke-width", 1.5);
        ln.setAttribute("marker-end", "url(#skds-arrow)");
        svg.appendChild(ln);
        svg.appendChild(svgText((ax + ex) / 2, ay - 7, ["needs", "uses", "yields"][i], sub, "middle", 9, 600));
      }
    });
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `<marker id="skds-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b"/></marker>`;
    svg.insertBefore(defs, svg.firstChild);
    svg.appendChild(svgText(W / 2, H - 10,
      "Each task carries its prompt Xᵢ, the oracle skills Sᵢ needed (latent), the oracle tools Tᵢ (provided), and a verifier outcome Yᵢ.",
      sub, "middle", 11, 500));
    return constructStepCard(1, "Each sample = (Xᵢ, Sᵢ, Tᵢ, Yᵢ)",
      "The atomic unit is a tuple of the user prompt, the ground-truth oracle SKILLS it requires (held out of the system prompt), the oracle TOOLS (handed over so tool-discovery is not the bottleneck), and a verifier-checkable outcome.",
      svg);
  }

  // Step 2 — collect & rank skills by task coverage, colored by intro version.
  function skdsStep2(evo, sum) {
    const counts = (sum && sum.task_count_per_skill) || {};
    const skills = (evo.skill_timeline || []).map((r) => ({
      slug: r.skill, name: r.name || r.skill, intro: r.intro_stage,
      count: counts[r.skill] || 0,
    })).sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
    const maxC = Math.max(1, ...skills.map((s) => s.count));
    const rowH = 22, padL = 250, padR = 48, W = 720, H = Math.max(60, skills.length * rowH + 16);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "construct-svg");
    svg.style.width = "100%"; svg.style.maxWidth = `${W}px`; svg.style.height = "auto";
    skills.forEach((s, i) => {
      const y = 8 + i * rowH;
      const bw = ((W - padL - padR) * s.count) / maxC;
      const c = vcolor(s.intro);
      svg.appendChild(svgText(padL - 8, y + rowH / 2 + 3,
        (s.name.length > 38 ? s.name.slice(0, 37) + "…" : s.name), "#334155", "end", 10, 600));
      svg.appendChild(svgRect(padL, y + 3, Math.max(2, bw), rowH - 8, c, c, 3));
      svg.appendChild(svgText(padL + Math.max(2, bw) + 5, y + rowH / 2 + 3, `${s.count}`, "#475569", "start", 10, 700));
    });
    const wrap = el("div", {});
    wrap.appendChild(svg);
    const legend = el("div", { class: "evo-legend" });
    (evo.stages || []).forEach((stg, i) =>
      legend.appendChild(el("span", { class: "legend-item" }, [
        el("span", { class: "legend-dot", style: `background:${vcolor(i)}` }, ""),
        `introduced at V${i + 1}`,
      ])));
    wrap.appendChild(legend);
    return constructStepCard(2, "Pool every oracle skill, rank by task coverage",
      "Across the whole domain we count how many tasks each oracle skill covers, then rank skills most-covering → long tail. Bars are colored by the version that first introduces the skill — the most foundational skills anchor the earliest versions.",
      wrap);
  }

  // Step 3 — grow nested cumulative libraries S₁ ⊂ S₂ ⊂ S₃.
  function skdsStep3(stages) {
    const maxCum = Math.max(1, ...stages.map((s) => s.num_cumulative_skills || 0));
    const wrap = el("div", { class: "skds-rings" });
    stages.forEach((s, i) => {
      const col = el("div", { class: "skds-ring-col" });
      const bar = el("div", { class: "skds-ring-bar" });
      // stacked: carried (cumulative - new) + new
      const carried = (s.num_cumulative_skills || 0) - (s.num_new_skills || 0);
      const pCarried = (carried / maxCum) * 100;
      const pNew = ((s.num_new_skills || 0) / maxCum) * 100;
      bar.appendChild(el("div", { class: "skds-ring-seg carried", style: `height:${pCarried}%`, title: `${carried} carried` }, ""));
      bar.appendChild(el("div", { class: "skds-ring-seg new", style: `height:${pNew}%; background:${vcolor(i)}`, title: `${s.num_new_skills} new` }, ""));
      col.appendChild(bar);
      col.appendChild(el("div", { class: "skds-ring-cap" }, [
        el("b", {}, `V${s.version}`),
        el("span", { class: "muted" }, `|S|=${s.num_cumulative_skills}`),
        el("span", { class: "chip chip-new" }, `+${s.num_new_skills}`),
      ]));
      wrap.appendChild(col);
    });
    return constructStepCard(3, "Grow nested libraries S₁ ⊂ S₂ ⊂ S₃",
      "Each version keeps every earlier skill and adds the next cohort, so the oracle library only ever accumulates. The colored cap is the skills new at that version; the grey base is carried forward.",
      wrap);
  }

  // Step 4 — assign every task to the earliest version a *new* skill appears.
  function skdsStep4(stages) {
    const maxN = Math.max(1, ...stages.map((s) => s.num_new_tasks || 0));
    const wrap = el("div", { class: "skds-assign" });
    stages.forEach((s, i) => {
      const col = el("div", { class: "skds-assign-col" });
      col.appendChild(el("div", { class: "skds-assign-bar" }, [
        el("div", { class: "skds-assign-fill", style: `height:${((s.num_new_tasks || 0) / maxN) * 100}%; background:${vcolor(i)}` },
          el("span", { class: "skds-assign-n" }, String(s.num_new_tasks || 0))),
      ]));
      col.appendChild(el("div", { class: "skds-assign-cap" }, [
        el("b", {}, `V${s.version}`),
        el("span", { class: "muted" }, `adapt ${s.num_adapt ?? "?"} · test ${s.num_test ?? "?"}`),
        el("span", { class: "muted small" }, (s.new_skill_names || []).slice(0, 2).join(", ") + ((s.new_skill_names || []).length > 2 ? " …" : "")),
      ]));
      wrap.appendChild(col);
    });
    return constructStepCard(4, "Place each task at the earliest version its skill is new",
      "A task lands at the version that first introduces a skill it needs — so every task exercises at least one skill that is new at its version (older skills are optional context). Bars show how many tasks each version ships.",
      wrap);
  }

  // Step 5 — the guarantees this construction gives.
  function skdsStep5(sum) {
    const active = (sum && sum.active_skills) || [];
    const inactive = (sum && sum.inactive_skills) || [];
    const body = el("div", {});
    body.appendChild(el("ul", { class: "skds-feats" }, [
      el("li", { html: "<b>Skills are latent</b>: required to solve a task but never shown in the system prompt — the agent must <b>author</b> covering skills." }),
      el("li", { html: "<b>Oracle tools are provided</b>, so a failure isolates the missing <b>skill</b>, not tool discovery." }),
      el("li", { html: "<b>Each task needs a skill new at its version</b>; carried skills become optional distractors as the library grows." }),
      el("li", { html: "<b>The library only accumulates</b> (S₁ ⊂ S₂ ⊂ …) — nothing is removed." }),
    ]));
    body.appendChild(el("div", { class: "skds-active-split" }, [
      el("div", {}, [
        el("div", { class: "evo-card-sublabel" }, `${active.length} active oracle skills`),
        el("div", { class: "chip-row" }, active.length
          ? active.slice(0, 30).map((s) => el("span", { class: "chip", title: s }, s))
          : [el("span", { class: "muted" }, "—")]),
      ]),
      inactive.length ? el("div", {}, [
        el("div", { class: "evo-card-sublabel" }, `${inactive.length} inactive (held out, not shipped)`),
        el("div", { class: "chip-row" }, inactive.map((s) => el("span", { class: "chip chip-retired", title: s }, s))),
      ]) : null,
    ]));
    return constructStepCard(5, "What this construction guarantees", "", body);
  }

  // ===== EVOLUTION =========================================================
  function renderEvolution(root, evo) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "evo-header" }, [
      el("h2", { class: "evo-title" }, `${evo.domain} · skill library evolution`),
      el("p", { class: "muted" },
        `${evo.total_tasks ?? "?"} tasks · ${evo.num_stages ?? "?"} versions · ${evo.n_skills_total} oracle skills total`),
    ]));

    root.appendChild(datasetStatsTable(evo.stages, {
      resourceLabel: "skills", cumKey: "num_cumulative_skills", newKey: "num_new_skills",
    }));

    const cards = el("div", { class: "evo-cards" });
    (evo.stages || []).forEach((s, i) => {
      const newChips = (s.new_skill_names || s.new_skills || []).slice(0, 10).map((t) =>
        el("span", { class: "chip chip-new", title: t }, t));
      const moreNew = (s.new_skills || []).length - newChips.length;
      if (moreNew > 0) newChips.push(el("span", { class: "chip chip-more" }, `+${moreNew} more`));
      cards.appendChild(el("div", { class: "evo-card" }, [
        el("div", { class: "evo-card-head" }, [
          el("div", { class: "evo-card-name" }, s.name || `V${i + 1}`),
          el("div", { class: "evo-card-meta" }, `|S|=${s.num_cumulative_skills} · +${s.num_new_skills}`),
        ]),
        el("div", { class: "evo-card-stats" }, [
          evoStat("tasks", s.num_new_tasks),
          evoStat("adapt", s.num_adapt),
          evoStat("test", s.num_test),
          evoStat("skills/task", fmtStat(s.skills_per_task)),
          evoStat("tools/task", fmtStat(s.tools_per_task)),
          evoStat("verifiers/task", fmtStat(s.verifiers_per_task)),
        ]),
        el("div", { class: "evo-card-section" }, [
          el("div", { class: "evo-card-sublabel" }, `+${s.num_new_skills} new skills`),
          el("div", { class: "chip-row" }, newChips.length ? newChips : [el("span", { class: "muted" }, "—")]),
        ]),
        el("div", { class: "evo-card-section" }, [
          el("div", { class: "evo-card-sublabel" }, "most-used skills in oracle solutions"),
          el("div", { class: "chip-row" }, (s.top_skill_usage || []).slice(0, 8).map((u) =>
            el("span", { class: "chip chip-usage", title: `${u.name} · used in ${u.count} tasks` }, [
              el("span", {}, u.name || u.skill),
              el("span", { class: "chip-count" }, String(u.count)),
            ]))),
        ]),
      ]));
    });
    root.appendChild(cards);
    root.appendChild(skdsComplexityChart(evo));
    root.appendChild(skdsSkillTimeline(evo));
  }

  function skdsComplexityChart(evo) {
    const wrap = el("div", { class: "evo-chart card" });
    wrap.appendChild(el("h3", { class: "evo-section-title" }, "Library growth & task complexity over versions"));
    const stages = evo.stages || [];
    if (!stages.length) { wrap.appendChild(el("div", { class: "muted" }, "No versions.")); return wrap; }
    const W = Math.max(420, stages.length * 110), H = 220, padL = 50, padR = 80, padT = 18, padB = 36;
    const xs = stages.map((_, i) => padL + (i * (W - padL - padR)) / Math.max(1, stages.length - 1));
    const series = [
      { name: "|S| (cumulative skills)", color: "#2563eb", values: stages.map((s) => s.num_cumulative_skills), axis: "left" },
      { name: "+N new skills", color: "#16a34a", values: stages.map((s) => s.num_new_skills), axis: "left" },
      { name: "avg skills/task", color: "#7c3aed", values: stages.map((s) => s.skills_per_task?.mean ?? null), axis: "right" },
      { name: "avg tools/task", color: "#f59e0b", values: stages.map((s) => s.tools_per_task?.mean ?? null), axis: "right" },
    ];
    const lMax = Math.max(1, ...series.filter((s) => s.axis === "left").flatMap((s) => s.values).filter((v) => v != null));
    const rMax = Math.max(1, ...series.filter((s) => s.axis === "right").flatMap((s) => s.values).filter((v) => v != null));
    const yL = (v) => padT + (H - padT - padB) * (1 - v / lMax);
    const yR = (v) => padT + (H - padT - padB) * (1 - v / rMax);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "evo-svg");
    svg.style.width = "100%"; svg.style.maxWidth = "100%"; svg.style.height = `${H}px`;
    svg.appendChild(mkSvgLine(padL, padT, padL, H - padB, "#cbd5e1"));
    svg.appendChild(mkSvgLine(W - padR, padT, W - padR, H - padB, "#cbd5e1"));
    svg.appendChild(mkSvgLine(padL, H - padB, W - padR, H - padB, "#cbd5e1"));
    stages.forEach((s, i) => svg.appendChild(mkSvgText(xs[i], H - padB + 18, s.name || `V${i + 1}`, "#64748b", "middle")));
    for (let k = 0; k <= 4; k++) {
      const v = Math.round((lMax * k) / 4), y = yL(v);
      svg.appendChild(mkSvgText(padL - 6, y + 3, String(v), "#64748b", "end", 10));
      svg.appendChild(mkSvgLine(padL, y, W - padR, y, "rgba(15,23,42,0.07)"));
    }
    for (let k = 0; k <= 4; k++) {
      const v = ((rMax * k) / 4).toFixed(1);
      svg.appendChild(mkSvgText(W - padR + 6, yR(parseFloat(v)) + 3, v, "#64748b", "start", 10));
    }
    series.forEach((ser) => {
      const yFn = ser.axis === "left" ? yL : yR; let prev = null;
      ser.values.forEach((v, i) => {
        if (v == null) { prev = null; return; }
        const cx = xs[i], cy = yFn(v);
        if (prev) svg.appendChild(mkSvgLine(prev.x, prev.y, cx, cy, ser.color, 2));
        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", 3.5); c.setAttribute("fill", ser.color);
        svg.appendChild(c);
        svg.appendChild(mkSvgText(cx, cy - 8, Number.isInteger(v) ? String(v) : v.toFixed(1), ser.color, "middle", 10));
        prev = { x: cx, y: cy };
      });
    });
    const legend = el("div", { class: "evo-legend" });
    series.forEach((ser) => legend.appendChild(el("span", { class: "legend-item" }, [
      el("span", { class: "legend-dot", style: `background:${ser.color}` }, ""),
      `${ser.name} (${ser.axis === "left" ? "left" : "right"} axis)`,
    ])));
    wrap.appendChild(svg); wrap.appendChild(legend);
    return wrap;
  }

  function skdsSkillTimeline(evo) {
    const wrap = el("div", { class: "evo-timeline card" });
    const rows = evo.skill_timeline || [];
    wrap.appendChild(el("h3", { class: "evo-section-title" },
      `Skill library timeline — when each oracle skill joined (${rows.length} skills, ${evo.num_stages} versions)`));
    if (!rows.length) { wrap.appendChild(el("div", { class: "muted" }, "No skills.")); return wrap; }
    const stages = evo.stages || [];
    const table = el("table", { class: "evo-timeline-table" });
    const hr = el("tr");
    hr.appendChild(el("th", { class: "tool-col" }, "Skill"));
    stages.forEach((s) => hr.appendChild(el("th", {}, s.name || "")));
    hr.appendChild(el("th", {}, "Intro"));
    table.appendChild(el("thead", {}, [hr]));
    const tbody = el("tbody");
    rows.forEach((row) => {
      const tr = el("tr");
      tr.appendChild(el("td", { class: "tool-name", title: row.skill }, row.name || row.skill));
      row.presence.forEach((p) => {
        const td = el("td", { class: `cell cell-${p}` });
        td.title = `${row.name || row.skill} · ${p}`;
        td.textContent = p === "new" ? "●" : p === "present" ? "▪" : "";
        tr.appendChild(td);
      });
      tr.appendChild(el("td", { class: "intro-cell" }, stages[row.intro_stage]?.name || `V${row.intro_stage + 1}`));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.appendChild(el("div", { class: "evo-legend" }, [
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-new" }, ""), "newly introduced"]),
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-present" }, ""), "present"]),
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-absent" }, ""), "absent"]),
    ]));
    return wrap;
  }

  // ===== REAL-WORLD FIT ====================================================
  function renderRealworld(root, data) {
    root.innerHTML = "";
    const ms = data.match_summary || {};
    const real = ms.real || null;
    const sims = ms.simulated || [];
    root.appendChild(el("div", { class: "rw-header" }, [
      el("h2", { class: "rw-title" }, "Does our evolving skill benchmark look like the real world?"),
      el("p", { class: "muted rw-subtitle" },
        "We compare each simulated domain's oracle skill structure against the Org62 production trace " +
        "(640K skills across 4.1K intents). Procedural depth (steps per skill), how many skills a task needs, " +
        "and the reuse heavy-tail (Zipf α / Gini) line up on the same regime — evidence our synthetic skill " +
        "library is a faithful microcosm of a real one."),
    ]));

    if (real && sims.length) root.appendChild(skdsRealStatsTable(real, sims));

    const figs = data.figures || [];
    if (figs.length) {
      const grid = el("div", { class: "rw-fig-grid" });
      const CAPS = {
        "rank_frequency.png": ["Skill-reuse rank-frequency (log–log)", "How often each skill is reused vs its rank — the heavy-tail / Zipf law shared by real and simulated libraries."],
        "skills_per_task.png": ["Skills per task", "Distribution of how many oracle skills a single task requires."],
        "steps_per_skill.png": ["Steps per skill", "Procedural depth — number of steps a skill encodes."],
        "skill_emergence.png": ["Skill emergence", "How the cumulative skill universe grows as more intents/tasks are seen."],
        "match_table.png": ["Summary match table", "Side-by-side of the key structural statistics."],
      };
      const order = ["rank_frequency.png", "skills_per_task.png", "steps_per_skill.png", "skill_emergence.png", "match_table.png"];
      order.filter((f) => figs.includes(f)).concat(figs.filter((f) => !order.includes(f))).forEach((fig) => {
        const cap = CAPS[fig] || [fig, ""];
        grid.appendChild(el("figure", { class: "rw-fig card" }, [
          el("figcaption", { class: "rw-fig-cap" }, [
            el("strong", {}, cap[0]),
            cap[1] ? el("p", { class: "muted small" }, cap[1]) : null,
          ]),
          el("img", {
            class: "skds-rw-img",
            src: `/api/skill-datasets/realworld_comparison/image?name=${encodeURIComponent(fig)}`,
            alt: cap[0], loading: "lazy",
          }),
        ]));
      });
      root.appendChild(grid);
    }
  }

  function skdsRealStatsTable(real, sims) {
    const metrics = [
      ["n_skills", "library size", 0],
      ["steps_per_skill_mean", "steps / skill (mean)", 2],
      ["skills_per_task_mean", "skills / task (mean)", 2],
      ["reuse_zipf_alpha", "reuse Zipf α", 2],
      ["reuse_gini", "reuse Gini", 2],
    ];
    const card = el("div", { class: "card skds-rw-stats" });
    card.appendChild(el("h3", { class: "evo-section-title" }, "Structural fingerprints — Org62 (real) vs simulated domains"));
    const table = el("table", { class: "rw-stats-table" });
    const hr = el("tr");
    hr.appendChild(el("th", {}, "metric"));
    hr.appendChild(el("th", { class: "rw-real-col" }, real.name || "Org62 (real)"));
    sims.forEach((s) => hr.appendChild(el("th", {}, s.name)));
    table.appendChild(el("thead", {}, [hr]));
    const tbody = el("tbody");
    metrics.forEach(([key, label, dp]) => {
      const tr = el("tr");
      tr.appendChild(el("td", { class: "rw-metric-name" }, label));
      const rv = real[key];
      tr.appendChild(el("td", { class: "rw-real-col" }, rv == null ? "—" : num(rv, dp)));
      sims.forEach((s) => tr.appendChild(el("td", {}, s[key] == null ? "—" : num(s[key], dp))));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(table);
    return card;
  }

  // ===== TASK BROWSER ======================================================
  function renderStages() {
    const root = $("#skds-stages");
    root.innerHTML = "";
    const sum = st.sum.data;
    if (!sum) { root.appendChild(el("div", { class: "muted" }, "No summary.")); return; }
    root.appendChild(el("div", { class: "section-header" }, [
      el("div", { class: "title" }, sum.domain),
      el("div", { class: "sub" }, `${sum.n_tasks_total ?? "?"} tasks · ${sum.n_versions ?? "?"} versions · ${sum.active_skills?.length ?? "?"} active skills`),
    ]));
    (sum.stages || []).forEach((s) => {
      root.appendChild(el("div", { class: "stage-pill" }, [
        el("span", { class: "lbl" }, `V${s.version}`),
        el("span", { class: "meta" }, `skills=${s.num_cumulative_skills} (+${s.num_new_skills}) · adapt=${s.n_train} · test=${s.n_test}`),
      ]));
    });
  }

  function renderTaskList() {
    const filter = ($("#skds-filter").value || "").toLowerCase();
    const list = $("#skds-task-list");
    list.innerHTML = "";
    const filtered = st.tasks.filter((t) => !filter || (t.task_id && t.task_id.toLowerCase().includes(filter)));
    $("#skds-task-count").textContent = `${filtered.length} / ${st.tasks.length} tasks`;
    for (const t of filtered) {
      const li = el("li", { onclick: () => openTask(t) }, [
        el("span", { class: `badge stage-${t.stage}` }, `V${t.version}`),
        el("span", { class: "skds-li-split" }, t.split),
        el("span", {}, t.task_id),
        el("span", { class: "skds-li-n", title: `${t.n_oracle_skills} oracle skills` }, `${t.n_oracle_skills} sk`),
      ]);
      li.dataset.tid = `${t.version}/${t.split}/${t.task_id}`;
      list.appendChild(li);
    }
  }

  async function openTask(t) {
    $$("#skds-task-list li").forEach((li) =>
      li.classList.toggle("active", li.dataset.tid === `${t.version}/${t.split}/${t.task_id}`));
    const detail = $("#skds-detail");
    detail.innerHTML = `<div class="empty">Loading…</div>`;
    const url = new URL(`/api/skill-datasets/${st.domain}/task`, location.origin);
    url.searchParams.set("version", String(t.version));
    url.searchParams.set("split", t.split);
    url.searchParams.set("task_id", t.task_id);
    try {
      const cfg = await fetchJson(url);
      if (cfg.error) { detail.innerHTML = `<div class="empty error">${escapeHtml(cfg.error)}</div>`; return; }
      renderTaskDetail(detail, cfg);
    } catch (e) {
      detail.innerHTML = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  // An oracle-skill card whose body lazily loads the FULL skill (SKILL.md +
  // every references/ file) the first time it is expanded.
  function skdsSkillCard(s) {
    const det = el("details", { class: "skds-skill-full" }, [
      el("summary", {}, "Full SKILL.md & references/"),
      el("div", { class: "skds-skill-full-body" }, [el("div", { class: "muted small" }, "Loading…")]),
    ]);
    let loaded = false;
    det.addEventListener("toggle", async () => {
      if (!det.open || loaded) return;
      loaded = true;
      const body = det.querySelector(".skds-skill-full-body");
      try {
        const url = new URL(`/api/skill-datasets/${st.domain}/skill`, location.origin);
        url.searchParams.set("slug", s.slug);
        renderSkillFull(body, await fetchJson(url));
      } catch (e) {
        loaded = false;
        body.innerHTML = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
      }
    });
    return el("div", { class: "skds-skill-item" }, [
      el("div", { class: "skds-skill-name" }, s.name || s.slug),
      el("code", { class: "skds-skill-slug" }, s.slug),
      s.description ? el("div", { class: "muted small" }, s.description) : null,
      det,
    ]);
  }

  function renderSkillFull(root, full) {
    root.innerHTML = "";
    if (full.error) { root.appendChild(el("div", { class: "empty error" }, full.error)); return; }
    root.appendChild(el("div", { class: "skds-file-h" }, "SKILL.md"));
    root.appendChild(el("pre", { class: "skds-file-pre" }, full.body || "(empty)"));
    const refs = full.references || [];
    if (refs.length) {
      root.appendChild(el("div", { class: "skds-file-h" }, `references/ (${refs.length})`));
      refs.forEach((r, i) => {
        const tag = r.truncated ? "  (truncated)" : r.binary ? `  (binary · ${r.size} B)` : "";
        root.appendChild(el("details", { class: "skds-ref", open: i === 0 ? "" : null }, [
          el("summary", {}, `${r.name}${tag}`),
          r.content != null
            ? el("pre", { class: "skds-file-pre" }, r.content)
            : el("div", { class: "muted small" }, "binary or unreadable file"),
        ]));
      });
    }
    if ((full.other_files || []).length) {
      root.appendChild(el("div", { class: "skds-file-h" }, "other files in skill dir"));
      root.appendChild(el("div", { class: "chip-row" },
        full.other_files.map((f) => el("span", { class: "chip" }, f))));
    }
  }

  function renderTaskDetail(root, cfg) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "detail-section" }, [
      el("h2", {}, cfg.task_id),
      el("div", { class: "muted" }, `${cfg.domain} · V${cfg.version} · ${cfg.split}`),
    ]));

    if (cfg.user_prompt) {
      root.appendChild(el("div", { class: "detail-section" }, [
        el("h3", {}, "User prompt"),
        el("div", { class: "skds-prompt" }, cfg.user_prompt),
      ]));
    }

    // Oracle skills (latent) — name + description + expandable full SKILL.md/refs
    const osk = cfg.oracle_skills || [];
    root.appendChild(el("div", { class: "detail-section" }, [
      el("h3", {}, `Oracle skills · latent (${osk.length})`),
      el("div", { class: "skds-skill-list" }, osk.length
        ? osk.map((s) => skdsSkillCard(s))
        : [el("span", { class: "muted" }, "—")]),
    ]));

    // Cumulative library at this version (context)
    const cum = cfg.cumulative_oracle_skills || [];
    if (cum.length) {
      root.appendChild(el("div", { class: "detail-section" }, [
        el("h3", {}, `Cumulative oracle library at V${cfg.version} (${cum.length})`),
        el("div", { class: "chip-row" }, cum.map((s) =>
          el("span", { class: "chip" + (osk.some((o) => o.slug === s.slug) ? " chip-new" : ""), title: s.slug }, s.name || s.slug))),
      ]));
    }

    // Oracle tools (provided)
    const tools = cfg.selected_tools || [];
    if (tools.length) {
      const sec = el("div", { class: "detail-section" }, [el("h3", {}, `Oracle tools · provided (${tools.length})`)]);
      const wrap = el("div", {});
      tools.forEach((tn) => wrap.appendChild(el("span", { class: "tag tool" }, tn)));
      sec.appendChild(wrap);
      root.appendChild(sec);
    }

    // Verifiers
    const verifiers = cfg.verifiers || [];
    if (verifiers.length) {
      const sec = el("div", { class: "detail-section" }, [el("h3", {}, `Verifiers (${verifiers.length})`)]);
      const tbl = el("table", { class: "verif" });
      tbl.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", {}, "#"), el("th", {}, "Name"), el("th", {}, "Type"),
        el("th", {}, "Expected"), el("th", {}, "Compare"), el("th", {}, "Query / Config"),
      ])]));
      const tbody = el("tbody", {});
      verifiers.forEach((v, i) => {
        const vc = v.validation_config || {};
        tbody.appendChild(el("tr", {}, [
          el("td", {}, String(i + 1)),
          el("td", {}, v.name || ""),
          el("td", {}, v.verifier_type || ""),
          el("td", {}, vc.expected_value != null ? JSON.stringify(vc.expected_value) : ""),
          el("td", {}, vc.comparison_type || ""),
          el("td", { class: "query" }, vc.query || JSON.stringify(vc, null, 2)),
        ]));
      });
      tbl.appendChild(tbody);
      sec.appendChild(tbl);
      root.appendChild(sec);
    }

    if (cfg.gym_servers_config && cfg.gym_servers_config.length) {
      root.appendChild(el("details", { class: "collapse" }, [
        el("summary", {}, "Gym servers config"),
        el("pre", { class: "collapse-body" }, JSON.stringify(cfg.gym_servers_config, null, 2)),
      ]));
    }
    if (cfg.system_prompt) {
      root.appendChild(el("details", { class: "collapse" }, [
        el("summary", {}, "System prompt (skills stripped out)"),
        el("pre", { class: "collapse-body" }, cfg.system_prompt),
      ]));
    }
  }

  return { onShow };
})();

// ---------------------------------------------------------------------------
// AGDS — Agents / Benchmark (dataset-building) explorer
// ---------------------------------------------------------------------------
// The AGENTS-axis analogue of the Tools/Skills "Benchmark" views: the same four
// sub-tabs — How it's built / Evolution / Real-world fit / Task Browser — but
// the evolving resource is the GIVEN, accumulating pool of tool-scoped SUBAGENTS
// (A₁ ⊂ A₂ ⊂ …, #agents = #skills). Data comes from /api/agent-datasets/*
// (build_engine over the materialized data/evovling_agents tree). Reuses the
// ds-/evo-/rw-/skds- styles + shared el()/chart helpers so it matches 1:1.
const AGDS = (() => {
  const st = {
    mounted: false,
    domain: null,
    mode: "construct",
    sum: { data: null },
    evo: { data: null, loading: false },
    rw: { data: null, loading: false },
    insp: { scopingDomain: null, coverageDomain: null },
    tasks: [],
    detailVersion: null,
  };
  const VCOLORS = ["#2563eb", "#0ea5e9", "#6366f1", "#d97706", "#dc2626", "#059669", "#db2777", "#0891b2"];
  const vcolor = (i) => VCOLORS[i % VCOLORS.length];

  // ===== lifecycle =========================================================
  async function onShow() {
    if (st.mounted) return;
    st.mounted = true;
    wire();
    try {
      const d = await fetchJson("/api/agent-datasets");
      const sel = $("#agds-domain");
      sel.innerHTML = (d.domains || [])
        .map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`)
        .join("");
      st.domain = (d.domains || [])[0] || null;
      if (st.domain) sel.value = st.domain;
    } catch (e) {
      $("#agds-construct").innerHTML =
        `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
      return;
    }
    applyModeVisibility(st.mode);
    await onDomainChange();
  }

  function wire() {
    $("#agds-modes").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-agds-mode]");
      if (b) setMode(b.dataset.agdsMode);
    });
    $("#agds-domain").addEventListener("change", onDomainChange);
    $("#agds-version").addEventListener("change", reloadTaskList);
    $("#agds-split").addEventListener("change", reloadTaskList);
    $("#agds-filter").addEventListener("input", renderTaskList);
  }

  function applyModeVisibility(mode) {
    $$("#agds-modes [data-agds-mode]").forEach((b) =>
      b.classList.toggle("active", b.dataset.agdsMode === mode));
    $(".agds-browser-tools").style.display = mode === "browser" ? "" : "none";
    $("#agds-browser").style.display = mode === "browser" ? "" : "none";
    $("#agds-evolution").style.display = mode === "evolution" ? "" : "none";
    $("#agds-construct").style.display = mode === "construct" ? "" : "none";
    const rw = $("#agds-realworld");
    if (rw) rw.style.display = mode === "realworld" ? "" : "none";
    const sc = $("#agds-scoping");
    if (sc) sc.style.display = mode === "scoping" ? "" : "none";
    const cv = $("#agds-coverage");
    if (cv) cv.style.display = mode === "coverage" ? "" : "none";
  }

  function setMode(mode) {
    st.mode = mode;
    applyModeVisibility(mode);
    if (mode === "construct" || mode === "evolution") {
      if (!st.evo.data) loadEvolution();
      else if (mode === "construct") renderConstruction($("#agds-construct"), st.evo.data, st.sum.data);
      else renderEvolution($("#agds-evolution"), st.evo.data);
    } else if (mode === "realworld") {
      loadRealworld();
    } else if (mode === "scoping" || mode === "coverage") {
      loadInspector(mode);
    }
  }

  // Tool scoping + Coverage are the build-inspector views, relocated here from
  // the old Agents nav. They are rendered by the BI module straight into our
  // containers, driven by the AGDS domain selector (one render per domain).
  async function loadInspector(mode) {
    const cont = mode === "scoping" ? $("#agds-scoping") : $("#agds-coverage");
    if (!cont) return;
    const tab = mode === "scoping" ? "agents-scoping" : "agents-coverage";
    const seenKey = mode === "scoping" ? "scopingDomain" : "coverageDomain";
    if (st.insp[seenKey] === st.domain) return;
    await BI.renderInto(tab, cont, st.domain);
    st.insp[seenKey] = st.domain;
  }

  // ===== data loads ========================================================
  async function onDomainChange() {
    st.domain = $("#agds-domain").value;
    st.evo.data = null;
    st.insp.scopingDomain = null;
    st.insp.coverageDomain = null;
    try {
      st.sum.data = await fetchJson(`/api/agent-datasets/${st.domain}/summary`);
    } catch (e) {
      st.sum.data = null;
    }
    populateVersions();
    renderStages();
    await reloadTaskList();
    if (st.mode === "construct" || st.mode === "evolution") await loadEvolution();
    else if (st.mode === "realworld") await loadRealworld();
    else if (st.mode === "scoping" || st.mode === "coverage") await loadInspector(st.mode);
  }

  function populateVersions() {
    const sel = $("#agds-version");
    const stages = st.sum.data?.stages || [];
    sel.innerHTML = `<option value="">all</option>` +
      stages.map((s) => `<option value="${s.version}">V${s.version}</option>`).join("");
  }

  async function loadEvolution() {
    if (!st.domain || st.evo.loading) return;
    if (st.evo.data) {
      renderConstruction($("#agds-construct"), st.evo.data, st.sum.data);
      renderEvolution($("#agds-evolution"), st.evo.data);
      return;
    }
    st.evo.loading = true;
    try {
      const data = await fetchJson(`/api/agent-datasets/${st.domain}/evolution`);
      st.evo.data = data;
      renderConstruction($("#agds-construct"), data, st.sum.data);
      renderEvolution($("#agds-evolution"), data);
    } catch (e) {
      const msg = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
      $("#agds-evolution").innerHTML = msg;
      $("#agds-construct").innerHTML = msg;
    } finally {
      st.evo.loading = false;
    }
  }

  async function loadRealworld() {
    const root = $("#agds-realworld");
    if (st.rw.data) { renderRealworld(root, st.rw.data); return; }
    if (st.rw.loading) return;
    st.rw.loading = true;
    root.innerHTML = `<div class="empty">Loading real-world comparison…</div>`;
    try {
      const data = await fetchJson("/api/agent-datasets/realworld_comparison");
      st.rw.data = data;
      renderRealworld(root, data);
    } catch (e) {
      root.innerHTML = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
    } finally {
      st.rw.loading = false;
    }
  }

  async function reloadTaskList() {
    if (!st.domain) return;
    const version = $("#agds-version").value;
    const split = $("#agds-split").value;
    const url = new URL(`/api/agent-datasets/${st.domain}/tasks`, location.origin);
    if (version !== "") url.searchParams.set("version", version);
    url.searchParams.set("split", split || "all");
    try {
      const data = await fetchJson(url);
      st.tasks = data.tasks || [];
    } catch (e) {
      st.tasks = [];
    }
    renderTaskList();
  }

  // ===== CONSTRUCTION ("How it's built") ===================================
  function renderConstruction(root, evo, sum) {
    root.innerHTML = "";
    const stages = evo.stages || [];
    const fracPct = sum && sum.multi_agent_frac != null ? Math.round(sum.multi_agent_frac * 100) : null;
    root.appendChild(el("div", { class: "evo-header" }, [
      el("h2", { class: "evo-title" }, `How the agent benchmark is built · ${evo.domain}`),
      el("p", { class: "muted" },
        `Each oracle skill becomes one tool-scoped subagent (#agents = #skills), built deterministically — no LLM. ` +
        `A task's gold tools are split across its specialists so it needs ≥2 agents${fracPct != null ? ` (${fracPct}% of tasks here are multi-agent)` : ""}, ` +
        `and the given agent pool only accumulates A₁ ⊂ A₂ ⊂ … . The lead is a tool-less router; we test how well it delegates. ` +
        `Below, the five construction steps on the current domain (${evo.n_agents_total} agents, ${stages.length} versions, ${evo.total_tasks ?? "?"} tasks).`),
    ]));
    root.appendChild(agdsStep1());
    root.appendChild(agdsStep2(evo, sum));
    root.appendChild(agdsStep3(stages));
    root.appendChild(agdsStep4(stages));
    root.appendChild(agdsStep5(sum));
  }

  // Step 1 — anatomy of an agent sample: X → oracle agents (given) → split tools → Y
  function agdsStep1() {
    const W = 720, H = 210;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "construct-svg");
    svg.style.width = "100%"; svg.style.maxWidth = `${W}px`; svg.style.height = "auto";
    const blue = "#2563eb", purple = "#7c3aed", gold = "#ca8a04", green = "#16a34a", sub = "#64748b", txt = "#0f172a";
    const boxes = [
      { t: "Xᵢ", s: "user task", d: '"Onboard the hire and enroll benefits"', c: blue },
      { t: "Aᵢ", s: "oracle agents (given)", d: "{ employee-records, benefits }", c: purple },
      { t: "Tᵢ", s: "tools split across agents", d: "{ create_employee | enroll_benefit }", c: gold },
      { t: "Yᵢ", s: "expected outcome", d: "verifier passes (rows written)", c: green },
    ];
    const boxW = 158, boxH = 116, gapX = (W - boxW * 4) / 5;
    boxes.forEach((b, i) => {
      const x = gapX + i * (boxW + gapX), y = 26;
      svg.appendChild(svgRect(x, y, boxW, boxH, "#f8fafc", b.c, 8));
      svg.appendChild(svgText(x + boxW / 2, y + 26, b.t, b.c, "middle", 20, 800));
      svg.appendChild(svgText(x + boxW / 2, y + 46, b.s, sub, "middle", 10, 600));
      const d = b.d;
      svg.appendChild(svgText(x + boxW / 2, y + 72, d.slice(0, 26), txt, "middle", 9));
      if (d.length > 26) svg.appendChild(svgText(x + boxW / 2, y + 86, d.slice(26, 52), txt, "middle", 9));
      if (d.length > 52) svg.appendChild(svgText(x + boxW / 2, y + 100, d.slice(52, 78), txt, "middle", 9));
      if (i < boxes.length - 1) {
        const ax = x + boxW + 3, ex = x + boxW + gapX - 3, ay = y + boxH / 2;
        const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
        ln.setAttribute("x1", ax); ln.setAttribute("y1", ay); ln.setAttribute("x2", ex); ln.setAttribute("y2", ay);
        ln.setAttribute("stroke", sub); ln.setAttribute("stroke-width", 1.5);
        ln.setAttribute("marker-end", "url(#agds-arrow)");
        svg.appendChild(ln);
        svg.appendChild(svgText((ax + ex) / 2, ay - 7, ["delegate", "split", "yields"][i], sub, "middle", 9, 600));
      }
    });
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `<marker id="agds-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b"/></marker>`;
    svg.insertBefore(defs, svg.firstChild);
    svg.appendChild(svgText(W / 2, H - 10,
      "A tool-less lead routes Xᵢ to the gold oracle agents Aᵢ (⊆ the given pool); their tools Tᵢ split across agents, forcing coordination.",
      sub, "middle", 11, 500));
    return constructStepCard(1, "Each sample = (Xᵢ, Aᵢ, Tᵢ, Yᵢ) · #agents = #skills",
      "The atomic unit pairs the user prompt with the ground-truth oracle AGENTS it needs — each built 1:1 from an oracle skill out of five deterministic parts (instruction · context · model · tools · skill). The oracle TOOLS are split across those agents (so a task needs ≥2) and the outcome is verifier-checkable. The lead agent holds no tools — it can only delegate.",
      svg);
  }

  // Step 2 — collect & rank agents by task coverage, colored by intro version.
  function agdsStep2(evo, sum) {
    const counts = (sum && sum.task_count_per_agent) || {};
    const toolCounts = (sum && sum.agent_tool_counts) || {};
    const agents = (evo.agent_timeline || []).map((r) => ({
      name: r.agent, label: r.name || r.agent, intro: r.intro_stage,
      count: counts[r.agent] || 0, nTools: toolCounts[r.agent] ?? r.n_tools ?? 0,
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const maxC = Math.max(1, ...agents.map((s) => s.count));
    const rowH = 22, padL = 250, padR = 70, W = 720, H = Math.max(60, agents.length * rowH + 16);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "construct-svg");
    svg.style.width = "100%"; svg.style.maxWidth = `${W}px`; svg.style.height = "auto";
    agents.forEach((s, i) => {
      const y = 8 + i * rowH;
      const bw = ((W - padL - padR) * s.count) / maxC;
      const c = vcolor(s.intro);
      svg.appendChild(svgText(padL - 8, y + rowH / 2 + 3,
        (s.label.length > 38 ? s.label.slice(0, 37) + "…" : s.label), "#334155", "end", 10, 600));
      svg.appendChild(svgRect(padL, y + 3, Math.max(2, bw), rowH - 8, c, c, 3));
      svg.appendChild(svgText(padL + Math.max(2, bw) + 5, y + rowH / 2 + 3,
        `${s.count} · ${s.nTools}t`, "#475569", "start", 9.5, 700));
    });
    const wrap = el("div", {});
    wrap.appendChild(svg);
    const legend = el("div", { class: "evo-legend" });
    (evo.stages || []).forEach((stg, i) =>
      legend.appendChild(el("span", { class: "legend-item" }, [
        el("span", { class: "legend-dot", style: `background:${vcolor(i)}` }, ""),
        `introduced at V${i + 1}`,
      ])));
    wrap.appendChild(legend);
    return constructStepCard(2, "One agent per oracle skill, ranked by task coverage",
      "Each oracle skill is materialized into exactly one subagent, then we count how many tasks each agent is gold for and rank them most-covering → long tail. Bars are colored by the version that first introduces the agent; the number after each bar is its task count · derived tool-scope size.",
      wrap);
  }

  // Step 3 — grow the GIVEN cumulative pool A₁ ⊂ A₂ ⊂ A₃.
  function agdsStep3(stages) {
    const maxCum = Math.max(1, ...stages.map((s) => s.num_cumulative_agents || 0));
    const wrap = el("div", { class: "skds-rings" });
    stages.forEach((s, i) => {
      const col = el("div", { class: "skds-ring-col" });
      const bar = el("div", { class: "skds-ring-bar" });
      const carried = (s.num_cumulative_agents || 0) - (s.num_new_agents || 0);
      const pCarried = (carried / maxCum) * 100;
      const pNew = ((s.num_new_agents || 0) / maxCum) * 100;
      bar.appendChild(el("div", { class: "skds-ring-seg carried", style: `height:${pCarried}%`, title: `${carried} carried` }, ""));
      bar.appendChild(el("div", { class: "skds-ring-seg new", style: `height:${pNew}%; background:${vcolor(i)}`, title: `${s.num_new_agents} new` }, ""));
      col.appendChild(bar);
      col.appendChild(el("div", { class: "skds-ring-cap" }, [
        el("b", {}, `V${s.version}`),
        el("span", { class: "muted" }, `|A|=${s.num_cumulative_agents}`),
        el("span", { class: "chip chip-new" }, `+${s.num_new_agents}`),
      ]));
      wrap.appendChild(col);
    });
    return constructStepCard(3, "Grow the given pool A₁ ⊂ A₂ ⊂ A₃",
      "Agents are a given, per-version resource (not hidden like skills): each version keeps every earlier agent and mounts the next cohort, so the pool only accumulates. The colored cap is the agents new at that version; the grey base is carried forward as tool-scoped distractors.",
      wrap);
  }

  // Step 4 — assign each task to the earliest version a *new* agent appears,
  // and surface how many tasks need ≥2 agents (coordination).
  function agdsStep4(stages) {
    const maxN = Math.max(1, ...stages.map((s) => s.num_new_tasks || 0));
    const wrap = el("div", { class: "skds-assign" });
    stages.forEach((s, i) => {
      const total = s.num_new_tasks || 0;
      const multi = s.n_multi_agent || 0;
      const col = el("div", { class: "skds-assign-col" });
      const bar = el("div", { class: "skds-assign-bar" });
      const fill = el("div", { class: "skds-assign-fill", style: `height:${(total / maxN) * 100}%; background:${vcolor(i)}` },
        el("span", { class: "skds-assign-n" }, String(total)));
      // overlay: the multi-agent (coordination) portion of this version's tasks
      if (total > 0 && multi > 0) {
        fill.appendChild(el("div", {
          class: "agds-assign-multi",
          style: `height:${(multi / total) * 100}%`,
          title: `${multi} of ${total} tasks need ≥2 agents`,
        }, ""));
      }
      bar.appendChild(fill);
      col.appendChild(bar);
      col.appendChild(el("div", { class: "skds-assign-cap" }, [
        el("b", {}, `V${s.version}`),
        el("span", { class: "muted" }, `adapt ${s.num_adapt ?? "?"} · test ${s.num_test ?? "?"}`),
        el("span", { class: "muted small" }, `${multi} multi-agent`),
      ]));
      wrap.appendChild(col);
    });
    return constructStepCard(4, "Place each task at the earliest version its agent is new",
      "A task lands at the version that first introduces an agent it needs — so every task delegates to at least one agent new at its version (carried agents are optional distractors). The hatched band marks tasks whose tools span ≥2 agents, forcing the lead to coordinate.",
      wrap);
  }

  // Step 5 — the guarantees this construction gives.
  function agdsStep5(sum) {
    const active = (sum && sum.active_agents) || [];
    const distractor = (sum && sum.distractor_agents) || [];
    const names = (sum && sum.agent_names) || {};
    const fracPct = sum && sum.multi_agent_frac != null ? Math.round(sum.multi_agent_frac * 100) : null;
    const body = el("div", {});
    body.appendChild(el("ul", { class: "skds-feats" }, [
      el("li", { html: "<b>Capability specialists</b>: the tool universe is partitioned into disjoint, COMPLETE bundles, each built into one specialist (instruction · context · model · tools · skill) deterministically — <b>no LLM</b>." }),
      el("li", { html: `<b>Tools split across agents</b> (disjoint partition): each task stays fully solvable yet its tools fan out, so <b>${fracPct != null ? fracPct + "% of tasks need ≥2 agents" : "many tasks need ≥2 agents"}</b> — forcing the lead to delegate.` }),
      el("li", { html: "<b>Agents are given and accumulate</b> (A₁ ⊂ A₂ ⊂ …); carried-forward extras are tool-scoped <b>distractors</b> a misroute physically can't use." }),
      el("li", { html: "<b>The lead is a tool-less router</b> — the metric is purely how well it routes to the gold specialists." }),
    ]));
    body.appendChild(el("div", { class: "skds-active-split" }, [
      el("div", {}, [
        el("div", { class: "evo-card-sublabel" }, `${active.length} agents used as oracle`),
        el("div", { class: "chip-row" }, active.length
          ? active.slice(0, 30).map((s) => el("span", { class: "chip", title: s }, names[s] || s))
          : [el("span", { class: "muted" }, "—")]),
      ]),
      distractor.length ? el("div", {}, [
        el("div", { class: "evo-card-sublabel" }, `${distractor.length} distractor-only (never gold)`),
        el("div", { class: "chip-row" }, distractor.map((s) => el("span", { class: "chip chip-retired", title: s }, names[s] || s))),
      ]) : null,
    ]));
    return constructStepCard(5, "What this construction guarantees", "", body);
  }

  // ===== EVOLUTION =========================================================
  function renderEvolution(root, evo) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "evo-header" }, [
      el("h2", { class: "evo-title" }, `${evo.domain} · agent pool evolution`),
      el("p", { class: "muted" },
        `${evo.total_tasks ?? "?"} tasks · ${evo.num_stages ?? "?"} versions · ${evo.n_agents_total} agents total`),
    ]));

    root.appendChild(datasetStatsTable(evo.stages, {
      resourceLabel: "agents", cumKey: "num_cumulative_agents", newKey: "num_new_agents",
    }));

    const cards = el("div", { class: "evo-cards" });
    (evo.stages || []).forEach((s, i) => {
      const newChips = (s.new_agent_names || s.new_agents || []).slice(0, 10).map((t) =>
        el("span", { class: "chip chip-new", title: t }, t));
      const moreNew = (s.new_agents || []).length - newChips.length;
      if (moreNew > 0) newChips.push(el("span", { class: "chip chip-more" }, `+${moreNew} more`));
      cards.appendChild(el("div", { class: "evo-card" }, [
        el("div", { class: "evo-card-head" }, [
          el("div", { class: "evo-card-name" }, s.name || `V${i + 1}`),
          el("div", { class: "evo-card-meta" }, `|A|=${s.num_cumulative_agents} · +${s.num_new_agents}`),
        ]),
        el("div", { class: "evo-card-stats" }, [
          evoStat("tasks", s.num_new_tasks),
          evoStat("adapt", s.num_adapt),
          evoStat("test", s.num_test),
          evoStat("multi-agent", s.n_multi_agent),
          evoStat("agents/task", fmtStat(s.agents_per_task)),
          evoStat("tools/task", fmtStat(s.tools_per_task)),
        ]),
        el("div", { class: "evo-card-section" }, [
          el("div", { class: "evo-card-sublabel" }, `+${s.num_new_agents} new agents`),
          el("div", { class: "chip-row" }, newChips.length ? newChips : [el("span", { class: "muted" }, "—")]),
        ]),
        el("div", { class: "evo-card-section" }, [
          el("div", { class: "evo-card-sublabel" }, "most-delegated agents in oracle solutions"),
          el("div", { class: "chip-row" }, (s.top_agent_usage || []).slice(0, 8).map((u) =>
            el("span", { class: "chip chip-usage", title: `${u.name} · gold in ${u.count} tasks` }, [
              el("span", {}, u.name || u.agent),
              el("span", { class: "chip-count" }, String(u.count)),
            ]))),
        ]),
      ]));
    });
    root.appendChild(cards);
    root.appendChild(agdsComplexityChart(evo));
    root.appendChild(agdsAgentTimeline(evo));
  }

  function agdsComplexityChart(evo) {
    const wrap = el("div", { class: "evo-chart card" });
    wrap.appendChild(el("h3", { class: "evo-section-title" }, "Pool growth & task complexity over versions"));
    const stages = evo.stages || [];
    if (!stages.length) { wrap.appendChild(el("div", { class: "muted" }, "No versions.")); return wrap; }
    const W = Math.max(420, stages.length * 110), H = 220, padL = 50, padR = 80, padT = 18, padB = 36;
    const xs = stages.map((_, i) => padL + (i * (W - padL - padR)) / Math.max(1, stages.length - 1));
    const series = [
      { name: "|A| (cumulative agents)", color: "#2563eb", values: stages.map((s) => s.num_cumulative_agents), axis: "left" },
      { name: "+N new agents", color: "#16a34a", values: stages.map((s) => s.num_new_agents), axis: "left" },
      { name: "avg agents/task", color: "#7c3aed", values: stages.map((s) => s.agents_per_task?.mean ?? null), axis: "right" },
      { name: "avg tools/task", color: "#f59e0b", values: stages.map((s) => s.tools_per_task?.mean ?? null), axis: "right" },
    ];
    const lMax = Math.max(1, ...series.filter((s) => s.axis === "left").flatMap((s) => s.values).filter((v) => v != null));
    const rMax = Math.max(1, ...series.filter((s) => s.axis === "right").flatMap((s) => s.values).filter((v) => v != null));
    const yL = (v) => padT + (H - padT - padB) * (1 - v / lMax);
    const yR = (v) => padT + (H - padT - padB) * (1 - v / rMax);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "evo-svg");
    svg.style.width = "100%"; svg.style.maxWidth = "100%"; svg.style.height = `${H}px`;
    svg.appendChild(mkSvgLine(padL, padT, padL, H - padB, "#cbd5e1"));
    svg.appendChild(mkSvgLine(W - padR, padT, W - padR, H - padB, "#cbd5e1"));
    svg.appendChild(mkSvgLine(padL, H - padB, W - padR, H - padB, "#cbd5e1"));
    stages.forEach((s, i) => svg.appendChild(mkSvgText(xs[i], H - padB + 18, s.name || `V${i + 1}`, "#64748b", "middle")));
    for (let k = 0; k <= 4; k++) {
      const v = Math.round((lMax * k) / 4), y = yL(v);
      svg.appendChild(mkSvgText(padL - 6, y + 3, String(v), "#64748b", "end", 10));
      svg.appendChild(mkSvgLine(padL, y, W - padR, y, "rgba(15,23,42,0.07)"));
    }
    for (let k = 0; k <= 4; k++) {
      const v = ((rMax * k) / 4).toFixed(1);
      svg.appendChild(mkSvgText(W - padR + 6, yR(parseFloat(v)) + 3, v, "#64748b", "start", 10));
    }
    series.forEach((ser) => {
      const yFn = ser.axis === "left" ? yL : yR; let prev = null;
      ser.values.forEach((v, i) => {
        if (v == null) { prev = null; return; }
        const cx = xs[i], cy = yFn(v);
        if (prev) svg.appendChild(mkSvgLine(prev.x, prev.y, cx, cy, ser.color, 2));
        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", 3.5); c.setAttribute("fill", ser.color);
        svg.appendChild(c);
        svg.appendChild(mkSvgText(cx, cy - 8, Number.isInteger(v) ? String(v) : v.toFixed(1), ser.color, "middle", 10));
        prev = { x: cx, y: cy };
      });
    });
    const legend = el("div", { class: "evo-legend" });
    series.forEach((ser) => legend.appendChild(el("span", { class: "legend-item" }, [
      el("span", { class: "legend-dot", style: `background:${ser.color}` }, ""),
      `${ser.name} (${ser.axis === "left" ? "left" : "right"} axis)`,
    ])));
    wrap.appendChild(svg); wrap.appendChild(legend);
    return wrap;
  }

  function agdsAgentTimeline(evo) {
    const wrap = el("div", { class: "evo-timeline card" });
    const rows = evo.agent_timeline || [];
    wrap.appendChild(el("h3", { class: "evo-section-title" },
      `Agent pool timeline — when each agent joined (${rows.length} agents, ${evo.num_stages} versions)`));
    if (!rows.length) { wrap.appendChild(el("div", { class: "muted" }, "No agents.")); return wrap; }
    const stages = evo.stages || [];
    const table = el("table", { class: "evo-timeline-table" });
    const hr = el("tr");
    hr.appendChild(el("th", { class: "tool-col" }, "Agent"));
    stages.forEach((s) => hr.appendChild(el("th", {}, s.name || "")));
    hr.appendChild(el("th", {}, "Intro"));
    table.appendChild(el("thead", {}, [hr]));
    const tbody = el("tbody");
    rows.forEach((row) => {
      const tr = el("tr");
      tr.appendChild(el("td", { class: "tool-name", title: row.agent }, row.name || row.agent));
      row.presence.forEach((p) => {
        const td = el("td", { class: `cell cell-${p}` });
        td.title = `${row.name || row.agent} · ${p}`;
        td.textContent = p === "new" ? "●" : p === "present" ? "▪" : "";
        tr.appendChild(td);
      });
      tr.appendChild(el("td", { class: "intro-cell" }, stages[row.intro_stage]?.name || `V${row.intro_stage + 1}`));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.appendChild(el("div", { class: "evo-legend" }, [
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-new" }, ""), "newly introduced"]),
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-present" }, ""), "present"]),
      el("span", { class: "legend-item" }, [el("span", { class: "swatch swatch-absent" }, ""), "absent"]),
    ]));
    return wrap;
  }

  // ===== REAL-WORLD FIT ====================================================
  function renderRealworld(root, data) {
    root.innerHTML = "";
    const ms = data.match_summary || {};
    const real = ms.real || null;
    const sims = ms.simulated || [];
    root.appendChild(el("div", { class: "rw-header" }, [
      el("h2", { class: "rw-title" }, "Does our evolving agent population look like the real world?"),
      el("p", { class: "muted rw-subtitle" },
        "We compare each simulated domain's agent population against the Org62 production trace " +
        "(3.7K agents over a 7.3K-tool universe). Tools per agent, how much agents' tool scopes overlap " +
        "(Jaccard), and the tool-use heavy-tail (Zipf α / Gini) sit in the same regime — evidence our " +
        "synthetic agent set is a faithful microcosm of a real one."),
    ]));

    if (real && sims.length) root.appendChild(agdsRealStatsTable(real, sims));

    const figs = data.figures || [];
    if (figs.length) {
      const grid = el("div", { class: "rw-fig-grid" });
      const CAPS = {
        "rank_frequency.png": ["Tool-use rank-frequency (log–log)", "How often each tool is used across agents vs its rank — the heavy-tail / Zipf law shared by real and simulated populations."],
        "tools_per_agent.png": ["Tools per agent", "Distribution of how many tools each agent's derived scope contains."],
        "agent_overlap.png": ["Agent scope overlap", "Pairwise tool-scope similarity (Jaccard) between agents."],
        "agent_emergence.png": ["Agent emergence", "How the cumulative agent population grows as more intents/tasks are seen."],
        "match_table.png": ["Summary match table", "Side-by-side of the key structural statistics."],
      };
      const order = ["rank_frequency.png", "tools_per_agent.png", "agent_overlap.png", "agent_emergence.png", "match_table.png"];
      order.filter((f) => figs.includes(f)).concat(figs.filter((f) => !order.includes(f))).forEach((fig) => {
        const cap = CAPS[fig] || [fig, ""];
        grid.appendChild(el("figure", { class: "rw-fig card" }, [
          el("figcaption", { class: "rw-fig-cap" }, [
            el("strong", {}, cap[0]),
            cap[1] ? el("p", { class: "muted small" }, cap[1]) : null,
          ]),
          el("img", {
            class: "skds-rw-img",
            src: `/api/agent-datasets/realworld_comparison/image?name=${encodeURIComponent(fig)}`,
            alt: cap[0], loading: "lazy",
          }),
        ]));
      });
      root.appendChild(grid);
    }
  }

  function agdsRealStatsTable(real, sims) {
    const metrics = [
      ["n_agents", "agents", 0],
      ["n_tool_universe", "tool universe", 0],
      ["tools_per_agent_mean", "tools / agent (mean)", 2],
      ["tools_per_agent_median", "tools / agent (median)", 1],
      ["single_tool_agent_frac", "single-tool agents", 2],
      ["agents_per_tool_mean", "agents / tool (mean)", 2],
      ["mean_jaccard", "scope overlap (Jaccard)", 3],
      ["zipf_alpha", "tool-use Zipf α", 2],
      ["gini_tool_freq", "tool-use Gini", 2],
    ];
    const card = el("div", { class: "card skds-rw-stats" });
    card.appendChild(el("h3", { class: "evo-section-title" }, "Structural fingerprints — Org62 (real) vs simulated domains"));
    const table = el("table", { class: "rw-stats-table" });
    const hr = el("tr");
    hr.appendChild(el("th", {}, "metric"));
    hr.appendChild(el("th", { class: "rw-real-col" }, real.name || "Org62 (real)"));
    sims.forEach((s) => hr.appendChild(el("th", {}, s.name)));
    table.appendChild(el("thead", {}, [hr]));
    const tbody = el("tbody");
    metrics.forEach(([key, label, dp]) => {
      const tr = el("tr");
      tr.appendChild(el("td", { class: "rw-metric-name" }, label));
      const rv = real[key];
      tr.appendChild(el("td", { class: "rw-real-col" }, rv == null ? "—" : num(rv, dp)));
      sims.forEach((s) => tr.appendChild(el("td", {}, s[key] == null ? "—" : num(s[key], dp))));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(table);
    return card;
  }

  // ===== TASK BROWSER ======================================================
  function renderStages() {
    const root = $("#agds-stages");
    root.innerHTML = "";
    const sum = st.sum.data;
    if (!sum) { root.appendChild(el("div", { class: "muted" }, "No summary.")); return; }
    root.appendChild(el("div", { class: "section-header" }, [
      el("div", { class: "title" }, sum.domain),
      el("div", { class: "sub" }, `${sum.n_tasks_total ?? "?"} tasks · ${sum.n_versions ?? "?"} versions · ${sum.n_agents_total ?? "?"} agents`),
    ]));
    (sum.stages || []).forEach((s) => {
      root.appendChild(el("div", { class: "stage-pill" }, [
        el("span", { class: "lbl" }, `V${s.version}`),
        el("span", { class: "meta" }, `agents=${s.num_cumulative_agents} (+${s.num_new_agents}) · adapt=${s.n_train} · test=${s.n_test} · multi=${s.n_multi_agent}`),
      ]));
    });
  }

  function renderTaskList() {
    const filter = ($("#agds-filter").value || "").toLowerCase();
    const list = $("#agds-task-list");
    list.innerHTML = "";
    const filtered = st.tasks.filter((t) => !filter || (t.task_id && t.task_id.toLowerCase().includes(filter)));
    $("#agds-task-count").textContent = `${filtered.length} / ${st.tasks.length} tasks`;
    for (const t of filtered) {
      const li = el("li", { onclick: () => openTask(t) }, [
        el("span", { class: `badge stage-${t.stage}` }, `V${t.version}`),
        el("span", { class: "skds-li-split" }, t.split),
        el("span", {}, t.task_id),
        t.multi_agent ? el("span", { class: "agds-li-multi", title: `${t.n_oracle_agents} agents · coordination` }, `${t.n_oracle_agents}×`) : null,
        el("span", { class: "skds-li-n", title: `${t.n_oracle_agents} oracle agents` }, `${t.n_oracle_agents} ag`),
      ]);
      li.dataset.tid = `${t.version}/${t.split}/${t.task_id}`;
      list.appendChild(li);
    }
  }

  async function openTask(t) {
    $$("#agds-task-list li").forEach((li) =>
      li.classList.toggle("active", li.dataset.tid === `${t.version}/${t.split}/${t.task_id}`));
    const detail = $("#agds-detail");
    detail.innerHTML = `<div class="empty">Loading…</div>`;
    st.detailVersion = t.version;
    const url = new URL(`/api/agent-datasets/${st.domain}/task`, location.origin);
    url.searchParams.set("version", String(t.version));
    url.searchParams.set("split", t.split);
    url.searchParams.set("task_id", t.task_id);
    try {
      const cfg = await fetchJson(url);
      if (cfg.error) { detail.innerHTML = `<div class="empty error">${escapeHtml(cfg.error)}</div>`; return; }
      renderTaskDetail(detail, cfg);
    } catch (e) {
      detail.innerHTML = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  // An oracle-agent card whose body lazily loads the FULL agent (generated TOML
  // spec + the SKILL.md/references it wraps) the first time it is expanded.
  function agdsAgentCard(a) {
    const det = el("details", { class: "skds-skill-full" }, [
      el("summary", {}, "Full agent spec (TOML) & wrapped skill"),
      el("div", { class: "skds-skill-full-body" }, [el("div", { class: "muted small" }, "Loading…")]),
    ]);
    let loaded = false;
    det.addEventListener("toggle", async () => {
      if (!det.open || loaded) return;
      loaded = true;
      const body = det.querySelector(".skds-skill-full-body");
      try {
        const url = new URL(`/api/agent-datasets/${st.domain}/agent`, location.origin);
        url.searchParams.set("name", a.name);
        if (st.detailVersion != null) url.searchParams.set("version", String(st.detailVersion));
        renderAgentFull(body, await fetchJson(url));
      } catch (e) {
        loaded = false;
        body.innerHTML = `<div class="empty error">${escapeHtml(e.message || String(e))}</div>`;
      }
    });
    return el("div", { class: "skds-skill-item" }, [
      el("div", { class: "skds-skill-name" }, [
        el("span", {}, a.title || a.name),
        a.n_tools != null ? el("span", { class: "agds-tool-badge", title: "derived tool-scope size" }, `${a.n_tools} tools`) : null,
      ]),
      el("code", { class: "skds-skill-slug" }, a.name),
      a.description ? el("div", { class: "muted small" }, a.description) : null,
      det,
    ]);
  }

  function renderAgentFull(root, full) {
    root.innerHTML = "";
    if (full.error) { root.appendChild(el("div", { class: "empty error" }, full.error)); return; }
    root.appendChild(el("div", { class: "agds-agent-meta" }, [
      el("span", { class: "chip" }, `skill: ${full.source_slug || "—"}`),
      el("span", { class: "chip" }, `model: ${full.model || "(inherit)"}`),
      el("span", { class: "chip" }, `versions: ${(full.in_versions || []).map((v) => "V" + v).join(", ") || "—"}`),
    ]));
    // derived tool scope
    const tools = full.oracle_tools || [];
    root.appendChild(el("div", { class: "skds-file-h" }, `derived tool scope (${tools.length})`));
    root.appendChild(el("div", { class: "chip-row" }, tools.length
      ? tools.map((tn) => el("span", { class: "tag tool" }, tn))
      : [el("span", { class: "muted" }, "—")]));
    // the generated agent spec
    root.appendChild(el("div", { class: "skds-file-h" }, `${full.name}.toml`));
    root.appendChild(el("pre", { class: "skds-file-pre" }, full.toml || "(empty)"));
    // the wrapped skill (SKILL.md + references)
    const sk = full.skill || {};
    root.appendChild(el("div", { class: "skds-file-h" }, `wrapped skill — ${sk.slug || ""}/SKILL.md`));
    root.appendChild(el("pre", { class: "skds-file-pre" }, sk.body || "(empty)"));
    const refs = sk.references || [];
    if (refs.length) {
      root.appendChild(el("div", { class: "skds-file-h" }, `references/ (${refs.length})`));
      refs.forEach((r, i) => {
        const tag = r.truncated ? "  (truncated)" : r.binary ? `  (binary · ${r.size} B)` : "";
        root.appendChild(el("details", { class: "skds-ref", open: i === 0 ? "" : null }, [
          el("summary", {}, `${r.name}${tag}`),
          r.content != null
            ? el("pre", { class: "skds-file-pre" }, r.content)
            : el("div", { class: "muted small" }, "binary or unreadable file"),
        ]));
      });
    }
    if ((sk.other_files || []).length) {
      root.appendChild(el("div", { class: "skds-file-h" }, "other files in skill dir"));
      root.appendChild(el("div", { class: "chip-row" }, sk.other_files.map((f) => el("span", { class: "chip" }, f))));
    }
  }

  function renderTaskDetail(root, cfg) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "detail-section" }, [
      el("h2", {}, cfg.task_id),
      el("div", { class: "muted" }, `${cfg.domain} · V${cfg.version} · ${cfg.split}`),
    ]));

    if (cfg.user_prompt) {
      root.appendChild(el("div", { class: "detail-section" }, [
        el("h3", {}, "User prompt"),
        el("div", { class: "skds-prompt" }, cfg.user_prompt),
      ]));
    }

    // Oracle agents (the lead must delegate to these) — expandable to full spec
    const oa = cfg.oracle_agents || [];
    root.appendChild(el("div", { class: "detail-section" }, [
      el("h3", {}, `Oracle agents · delegate to (${oa.length})${oa.length > 1 ? " · multi-agent" : ""}`),
      el("div", { class: "skds-skill-list" }, oa.length
        ? oa.map((a) => agdsAgentCard(a))
        : [el("span", { class: "muted" }, "—")]),
    ]));

    // Cumulative agent pool mounted at this version (context + distractors)
    const cum = cfg.cumulative_agents || [];
    if (cum.length) {
      root.appendChild(el("div", { class: "detail-section" }, [
        el("h3", {}, `Agent pool mounted at V${cfg.version} (${cum.length})`),
        el("div", { class: "chip-row" }, cum.map((a) =>
          el("span", { class: "chip" + (oa.some((o) => o.name === a.name) ? " chip-new" : ""), title: a.name }, a.title || a.name))),
      ]));
    }

    // Oracle skills behind the agents
    const osk = cfg.oracle_skills || [];
    if (osk.length) {
      root.appendChild(el("div", { class: "detail-section" }, [
        el("h3", {}, `Oracle skills (${osk.length})`),
        el("div", { class: "chip-row" }, osk.map((s) => el("span", { class: "chip", title: s }, s))),
      ]));
    }

    // Oracle tools (split across the agents above)
    const tools = cfg.selected_tools || [];
    if (tools.length) {
      const sec = el("div", { class: "detail-section" }, [el("h3", {}, `Oracle tools · split across agents (${tools.length})`)]);
      const wrap = el("div", {});
      tools.forEach((tn) => wrap.appendChild(el("span", { class: "tag tool" }, tn)));
      sec.appendChild(wrap);
      root.appendChild(sec);
    }

    // Verifiers
    const verifiers = cfg.verifiers || [];
    if (verifiers.length) {
      const sec = el("div", { class: "detail-section" }, [el("h3", {}, `Verifiers (${verifiers.length})`)]);
      const tbl = el("table", { class: "verif" });
      tbl.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", {}, "#"), el("th", {}, "Name"), el("th", {}, "Type"),
        el("th", {}, "Expected"), el("th", {}, "Compare"), el("th", {}, "Query / Config"),
      ])]));
      const tbody = el("tbody", {});
      verifiers.forEach((v, i) => {
        const vc = v.validation_config || {};
        tbody.appendChild(el("tr", {}, [
          el("td", {}, String(i + 1)),
          el("td", {}, v.name || ""),
          el("td", {}, v.verifier_type || ""),
          el("td", {}, vc.expected_value != null ? JSON.stringify(vc.expected_value) : ""),
          el("td", {}, vc.comparison_type || ""),
          el("td", { class: "query" }, vc.query || JSON.stringify(vc, null, 2)),
        ]));
      });
      tbl.appendChild(tbody);
      sec.appendChild(tbl);
      root.appendChild(sec);
    }

    if (cfg.gym_servers_config && cfg.gym_servers_config.length) {
      root.appendChild(el("details", { class: "collapse" }, [
        el("summary", {}, "Gym servers config"),
        el("pre", { class: "collapse-body" }, JSON.stringify(cfg.gym_servers_config, null, 2)),
      ]));
    }
    if (cfg.system_prompt) {
      root.appendChild(el("details", { class: "collapse" }, [
        el("summary", {}, "Shared policy (system prompt)"),
        el("pre", { class: "collapse-body" }, cfg.system_prompt),
      ]));
    }
  }

  return { onShow };
})();

// ---------------------------------------------------------------------------
// Landing — dataset-building animation  (P2 of the 3-page landing)
// ---------------------------------------------------------------------------
// One seed dataset (EnterpriseOps-Gym) is sliced by usage *frequency* into
// evolving versions T1->T2->T3. The same seed feeds three evolving axes; each
// track shows the *fixed set at Ti* (carried-forward chips) plus the *new*
// resource (red, pulsing) that expands it at Ti+1. Pure-CSS keyframes drive
// the build animation; this module only renders the three track panels and
// swaps which one is visible (a hidden panel's animation restarts when shown).
const DB = (() => {
  const ORDER = ["tools", "skills", "agents"];
  const TRACKS = {
    tools: {
      label: "Tools",
      blurb: "Deterministic build, no LLM: rank tools by <b>how many tasks use them</b>, grow nested versions T<sub>1</sub> &sub; T<sub>2</sub> &sub; T<sub>3</sub>, then place each task at the <b>earliest version that covers all its tools</b>.",
      seedNote: "one domain &rarr; many tasks &middot; each task wires several tools",
      benchNote: 'fixed tool set at T<sub>i</sub> &middot; a <b class="db-ink">new tool</b> expands it at T<sub>i+1</sub>',
      chipKind: "tool",
      feats: [
        "Every task uses <b>&ge;1 new tool</b> plus at least one carried-forward tool.",
        "Versions T<sub>i</sub> are cut from the seed by tool-usage <b>frequency</b>.",
      ],
    },
    skills: {
      label: "Skills",
      blurb: "Deterministic build, no LLM: the system-prompt <b>policy is split into hidden oracle skills</b>, ordered by <b>task coverage</b> (not frequency), and grown into versions S<sub>1</sub> &sub; S<sub>2</sub> &sub; S<sub>3</sub> &mdash; the agent must <b>author</b> the right skills as new policy areas appear.",
      seedNote: "skills are hidden from the system prompt &middot; oracle tools are given to isolate the effect",
      benchNote: 'tasks at T<sub>i</sub> need a <b class="db-ink">skill new at that version</b> &middot; older skills optional',
      chipKind: "skill",
      feats: [
        "Skills are <b>latent</b>: needed to solve the task but never shown.",
        "Oracle tools are provided, so we measure the <b>skill</b>, not tool discovery.",
        "Each task requires a skill <b>new at its time step</b>.",
      ],
    },
    agents: {
      label: "Agents",
      blurb: "Deterministic build (no LLM): each oracle <b>skill becomes one tool-scoped agent</b> (#agents = #skills). Tools are <b>split</b> across agents so a task needs <b>&ge;2</b>, and the given pool <b>accumulates</b> across versions — we test how well a lead agent <b>delegates</b>.",
      seedNote: "each skill becomes one agent &middot; an agent bundles tools &middot; skills &middot; instructions &middot; model &middot; context",
      benchNote: 'fixed agent set at T<sub>i</sub> &middot; a <b class="db-ink">new agent</b> expands it at T<sub>i+1</sub>',
      chipKind: "agent",
      feats: [
        "Each agent is built from a skill &rarr; <b>#skills = #agents</b>.",
        "Agents are given; we test the lead agent's <b>delegation</b>.",
        "Every task uses <b>&ge;1 agent new at its version</b>.",
      ],
    },
  };

  let mounted = false;
  let active = "tools";

  // ----- Tools track: a precise, animated walk-through of the frequency split.
  // A tiny worked example (a calendar-like domain) instantiates the real
  // algorithm from evolve_tools/src/frequency_config.py so a first-time reader
  // can see EXACTLY how tasks are sliced into versions by tool-usage frequency:
  //   (1) every task carries the set of tools it needs;
  //   (2) pool all tools, rank by how many tasks use each (core -> long tail);
  //   (3) grow nested catalogs T1 c T2 c T3 (add the next-most-frequent tools);
  //   (4) assign every task to the EARLIEST version that covers all its tools.
  const TC = {
    create_event: "#2563eb",
    list_events:  "#0ea5e9",
    find_slot:    "#6366f1",
    send_invite:  "#d97706",
    delete_event: "#dc2626",
  };
  // Tools sorted by descending task-frequency (ties alphabetical) == rank order.
  // `ver` = the version (0-based) that first introduces the tool.
  const T_TOOLS = [
    { id: "create_event", freq: 5, ver: 0 },
    { id: "list_events",  freq: 3, ver: 0 },
    { id: "find_slot",    freq: 2, ver: 1 },
    { id: "send_invite",  freq: 2, ver: 1 },
    { id: "delete_event", freq: 1, ver: 2 },
  ];
  // Each task's oracle tool set. `ver` = earliest version that covers all of
  // its tools (so >=1 of them is new at `ver`; the rest are carried-forward).
  const T_TASKS = [
    { id: "A", tools: ["create_event", "list_events"], ver: 0 },
    { id: "B", tools: ["create_event", "list_events", "send_invite"], ver: 1 },
    { id: "C", tools: ["create_event", "find_slot"], ver: 1 },
    { id: "D", tools: ["create_event", "list_events", "find_slot"], ver: 1 },
    { id: "E", tools: ["create_event", "send_invite", "delete_event"], ver: 2 },
  ];
  const T_VERS = [
    { tag: "T₁", delta: ["create_event", "list_events"] },
    { tag: "T₂", delta: ["find_slot", "send_invite"] },
    { tag: "T₃", delta: ["delete_event"] },
  ];
  // version each tool is introduced at — used to label a task's tools new/old.
  const T_TOOLVER = Object.fromEntries(T_TOOLS.map((t) => [t.id, t.ver]));
  const T_STEPS = [
    "tasks need tools",
    "rank by frequency",
    "cut cumulative versions",
    "assign to earliest version",
  ];
  const T_CAPS = [
    "Start from the seed: every task carries the <b>set of tools</b> it needs to be solved.",
    "Pool all tools and count <b>how many tasks use each</b>, then rank them most-used &rarr; long tail (ties broken alphabetically).",
    "Grow a nested chain <b>T₁ &sub; T₂ &sub; T₃</b> by adding the next-most-frequent tools — but <b>where to cut</b> is set by the <b>min_new_tasks</b> floor: <b>T₁ is the smallest prefix that makes ≥ N tasks solvable</b> (here N=1 — the top-2 tools first make a whole task, Task A, solvable), then each later version grows until <b>≥ N new</b> tasks clear.",
    "Place each task at the <b>earliest version</b> that covers <b>all</b> its tools — now read off the guarantee: each task has <b>≥1 new</b> tool (new at its version) and, from T₂ on, also <b>≥1 old</b> carried-forward tool.",
  ];
  // What the construction guarantees (from the dataset card + environment.py).
  const T_FEATS = [
    "<b>Every task uses ≥1 new tool</b> (the one new at its version) — and from <b>T₂ onward</b> also <b>≥1 old tool</b> carried forward, so each version tests mixing new APIs with known ones.",
    "<b>Tools only accumulate</b>: T₁ &sub; T₂ &sub; T₃ — nothing is ever removed, and the tools added each version are the most-frequent of what remains.",
    "<b>Every new tool is exercised</b> at the version it appears, and per-task difficulty (|tools|) is balanced across versions so a version's effect isolates tool novelty.",
    "<b>Cuts are principled, not arbitrary</b>: each version is the <b>smallest frequency-prefix</b> that clears the <b>min_new_tasks</b> floor (≥ N newly-solvable tasks). In the real benchmark N=7, first met at the <b>top-40</b> tools ⟹ <b>C₁ = 40</b> — the smallest first version that can host 7 whole composite tasks.",
  ];

  function tchip(id, opts) {
    opts = opts || {};
    const c = TC[id] || "var(--accent)";
    const cls = "dbt-tool" + (opts.muted ? " is-muted" : "");
    const n = opts.count != null
      ? `<b class="dbt-tool-n">&times;${opts.count}</b>` : "";
    return `<span class="${cls}" style="--tc:${c}">${id}${n}</span>`;
  }
  // Tool chip tagged new/old relative to a task's assigned version. `old`
  // (carried-forward) chips are muted just like in step 3; `new` chips keep
  // the tool colour — so the new+old guarantee is readable at a glance.
  function tchipNO(id, isOld) {
    const c = TC[id] || "var(--accent)";
    return `<span class="dbt-tool${isOld ? " is-muted" : ""}" style="--tc:${c}">${id}` +
      `<b class="dbt-flag dbt-flag--${isOld ? "old" : "new"}">${isOld ? "old" : "new"}</b></span>`;
  }

  function toolsPanelHTML() {
    const maxF = Math.max.apply(null, T_TOOLS.map((t) => t.freq));

    const p1 = `<div class="dbt-phase dbt-p1"><div class="dbt-tasklist">${
      T_TASKS.map((t) =>
        `<div class="dbt-task"><span class="dbt-task-tag">Task ${t.id}</span>` +
        `<span class="dbt-task-tools">${t.tools.map((id) => tchip(id)).join("")}</span></div>`
      ).join("")
    }</div></div>`;

    const p2 = `<div class="dbt-phase dbt-p2"><div class="dbt-rank">${
      T_TOOLS.map((t) =>
        `<div class="dbt-rankrow">` +
        `<span class="dbt-rank-name" style="--tc:${TC[t.id]}">${t.id}</span>` +
        `<span class="dbt-rank-track"><span class="dbt-rank-bar" style="--tc:${TC[t.id]};--w:${Math.round(t.freq / maxF * 100)}%"></span></span>` +
        `<span class="dbt-rank-cnt">${t.freq} task${t.freq > 1 ? "s" : ""}</span>` +
        `</div>`
      ).join("")
    }</div><div class="dbt-rank-axis"><span>core &middot; most-used</span><span>long tail</span></div></div>`;

    // phase 3 — cut cumulative versions. WHERE each version stops is set by the
    // min_new_tasks FLOOR: V1 = the smallest frequency-prefix that makes >= N
    // tasks SOLVABLE (all of a task's tools present); each later version then
    // grows the prefix until >= N NEW tasks become solvable. Toy floor N=1; the
    // real benchmark uses min_new_tasks_per_stage = 7 (-> C1 = 40 tools).
    const p3seen = new Set();
    const p3rows = T_VERS.map((v, k) => {
      const cum = T_TOOLS.filter((t) => t.ver <= k);
      const have = new Set(cum.map((t) => t.id));
      const solv = T_TASKS.filter((t) => t.tools.every((x) => have.has(x)));
      const fresh = solv.filter((t) => !p3seen.has(t.id));
      solv.forEach((t) => p3seen.add(t.id));
      const freshChips = fresh.length
        ? fresh.map((t) => `<i class="dbt-solv-chip">Task ${t.id}</i>`).join("")
        : `<i class="dbt-solv-chip is-none">none</i>`;
      const badge = k === 0
        ? `<span class="dbt-cut-badge dbt-cut-badge--floor">${solv.length} &ge; floor (N=1) &rarr; smallest first version</span>`
        : `<span class="dbt-cut-badge">+${fresh.length} new &middot; ${solv.length}/${T_TASKS.length} solvable</span>`;
      const main = `<div class="dbt-cat"><span class="dbt-cat-tag">${v.tag}</span>` +
        `<span class="dbt-cat-tools">${cum.map((t) => tchip(t.id, { muted: t.ver < k })).join("")}</span>` +
        `<span class="dbt-cat-delta">${k === 0 ? "core catalog" : "+ " + v.delta.join(", ")}</span></div>`;
      const sub = `<div class="dbt-cut-sub"><span class="dbt-cut-arrow">&#8627;</span> newly solvable: ${freshChips} ${badge}</div>`;
      return `<div class="dbt-cutrow">${main}${sub}</div>`;
    }).join("");
    const p3 = `<div class="dbt-phase dbt-p3">` +
      `<div class="dbt-rulebar">Where to <b>cut</b> each version is set by the <b>min_new_tasks</b> floor: <b>V₁ is the smallest frequency-prefix that makes ≥ N tasks solvable</b>, and every later version grows the prefix until <b>≥ N new</b> tasks become solvable. <i>(toy floor N=1)</i></div>` +
      `<div class="dbt-cats dbt-cats--cut">${p3rows}</div>` +
      `<div class="dbt-foot">Can't cut smaller — the <b>top-1</b> prefix <code>{create_event}</code> leaves <b>0</b> solvable tasks, below the floor. In the real benchmark the floor is <b>min_new_tasks = 7</b>, first reached only once the <b>top-40</b> tools are on &rArr; <b>C₁ = 40</b>: the smallest possible first version that can host 7 whole composite tasks.</div>` +
      `</div>`;

    const p4 = `<div class="dbt-phase dbt-p4"><div class="dbt-assign">${
      T_VERS.map((v, k) => {
        const inV = T_TASKS.filter((t) => t.ver === k);
        return `<div class="dbt-asg-ver"><span class="dbt-asg-tag">${v.tag}</span><div class="dbt-asg-tasks">${
          inV.map((t) => {
            const chips = t.tools.map((id) => tchipNO(id, T_TOOLVER[id] < t.ver)).join("");
            const nNew = t.tools.filter((id) => T_TOOLVER[id] === t.ver).length;
            const nOld = t.tools.length - nNew;
            const sum = nOld > 0 ? `${nNew} new + ${nOld} old` : `${nNew} new &middot; core`;
            return `<div class="dbt-asg-task"><span class="dbt-asg-name">Task ${t.id}</span>` +
              `<span class="dbt-asg-tools">${chips}</span>` +
              `<span class="dbt-asg-sum">${sum}</span></div>`;
          }).join("")
        }</div></div>`;
      }).join("")
    }</div></div>`;

    return `
      <div class="db-panel${active === "tools" ? " is-active" : ""}" data-panel="tools">
        <div class="dbt" data-phase="1">
          <div class="dbt-bar">
            <ol class="dbt-steps">${
              T_STEPS.map((s, i) =>
                `<li data-step="${i + 1}" role="button" tabindex="0" title="Click to study this step"><b>${i + 1}</b>${s}</li>`
              ).join("")
            }</ol>
            <button class="dbt-play" type="button" data-playing="true" title="Pause" aria-label="Pause or play the walk-through"></button>
          </div>
          <div class="dbt-stage">${p1}${p2}${p3}${p4}</div>
          <div class="dbt-caps">${
            T_CAPS.map((c, i) => `<p data-cap="${i + 1}">${c}</p>`).join("")
          }</div>
          <div class="dbt-feats">
            <span class="dbt-feats-k">Guarantee</span>
            <ul>${T_FEATS.map((f) => `<li>${f}</li>`).join("")}</ul>
          </div>
          <!-- Entry point into the full built-dataset detail page (the former
               top-nav "Benchmark" view): statistics, example tasks, and the
               real-world-fit assessment. Routes to the #datasets view. -->
          <button class="dbt-cta" type="button" data-tab="datasets">
            <span class="dbt-cta-k">Deep dive</span>
            <span class="dbt-cta-tx">
              <b>Statistics, examples &amp; realistic assessment</b>
              <i>How it's built · Evolution · Real-world fit · Task browser</i>
            </span>
            <span class="dbt-cta-arrow" aria-hidden="true">&rarr;</span>
          </button>
        </div>
      </div>`;
  }

  // =====================================================================
  // Skills track walk-through. DIFFERENT from tools — mirrors
  // evovle_skills/builder (splitter + tagger + sequencer):
  //   * skills are LATENT: the system-prompt policy is split into an oracle
  //     skill library and HELD OUT; the agent starts empty and must author
  //     its own skills (oracle TOOLS are given, to isolate the skill).
  //   * a task is tagged to a skill from its VERIFIER signature, not tools.
  //   * versions grow by SKILL COVERAGE (most-covered first), adding skills
  //     until >= min-step-size NEW tasks become solvable (default 15) — NOT
  //     a frequency size-schedule like tools.
  //   * each task needs >=1 skill NEW at its version; OLD skills optional.
  // The worked example below is internally consistent with that algorithm
  // (coverage order == intro order; earliest-covering placement).
  const SC = {
    "employee-records": "#6366f1",
    "leave-management": "#8b5cf6",
    "payroll": "#0ea5e9",
    "benefits": "#14b8a6",
    "offboarding": "#d97706",
    "compliance": "#dc2626",
  };
  const S_SKILLS = [ // sorted by descending task coverage == version intro order
    { id: "employee-records", cov: 5, ver: 0 },
    { id: "leave-management", cov: 4, ver: 0 },
    { id: "benefits", cov: 3, ver: 1 },
    { id: "payroll", cov: 3, ver: 1 },
    { id: "offboarding", cov: 2, ver: 2 },
    { id: "compliance", cov: 2, ver: 2 },
  ];
  const S_SKILLVER = Object.fromEntries(S_SKILLS.map((s) => [s.id, s.ver]));
  const S_TASKS = [
    { id: "A", skills: ["employee-records"], ver: 0 },
    { id: "B", skills: ["employee-records", "leave-management"], ver: 0 },
    { id: "C", skills: ["leave-management"], ver: 0 },
    { id: "D", skills: ["employee-records", "payroll"], ver: 1 },
    { id: "E", skills: ["leave-management", "benefits"], ver: 1 },
    { id: "F", skills: ["employee-records", "payroll", "benefits"], ver: 1 },
    { id: "G", skills: ["employee-records", "payroll", "offboarding"], ver: 2 },
    { id: "H", skills: ["leave-management", "benefits", "compliance"], ver: 2 },
    { id: "I", skills: ["offboarding", "compliance"], ver: 2 },
  ];
  const S_VERS = [
    { tag: "T₁", delta: ["employee-records", "leave-management"] },
    { tag: "T₂", delta: ["benefits", "payroll"] },
    { tag: "T₃", delta: ["offboarding", "compliance"] },
  ];
  const S_STEPS = [
    "hide policy &rarr; oracle skills",
    "tag tasks &rarr; skills",
    "order by coverage, grow versions",
    "assign &middot; &ge;1 new skill",
  ];
  const S_CAPS = [
    "A deterministic <b>title-keyword</b> rule (no LLM) routes each <b>§</b> three ways: the <b>behavioural contract</b> stays in the stripped prompt; <b>procedure</b> + <b>reference/authority</b> become <b>hidden oracle skills</b>; <b>glossaries</b> are dropped from the prompt and used only to build the tagging universe. Anything unrecognized <b>defaults to a skill</b> — so the keep/hide line is a heuristic, not a semantic judgement. (Oracle <b>tools are given</b>, to isolate the skill.)",
    "Tagging is deterministic: parse a task's <b>verifier SQL</b> into a signature of <b>table.column</b> and <b>table.column = value</b> tokens, then match it against each skill's <b>index</b>. A table-qualified <b>value pair</b> is strong evidence (&times;3); a bare column is weak (&times;1) — tag when the score clears the bar, or on any pair hit. (Note `leave_request.status` vs `employee.status` — the table disambiguates.)",
    "Sort skills by <b>task coverage</b>, then sweep them in that order; after each skill, count the tasks that <b>just became fully solvable</b>. The moment that count reaches <b>min-step-size</b>, <b>cut a version</b> — so <b>how many skills land in a T is derived</b> from when enough new tasks unlock, not chosen. Coverage-greedy, <b>not</b> a frequency schedule like tools.",
    "Place each task at the <b>earliest version</b> covering all its skills — so every task needs <b>&ge;1 skill new at its version</b>, while <b>old skills are optional</b> (e.g. Task I lands at T₃ needing only new skills).",
  ];
  const S_FEATS = [
    "<b>Skills are latent</b>: the policy is stripped from the prompt and held out as an answer key — the agent must <b>author</b> its own skills (skill.write) to solve tasks.",
    "<b>Versions grow by coverage, not frequency</b>: skills are added most-covered-first until <b>&ge; min-step-size</b> new tasks become solvable (15 in the real build); cumulative S₁ &sub; S₂ &sub; S₃.",
    "<b>Every task needs ≥1 new skill</b> (new at its version); <b>older skills are optional</b>. <b>Oracle tools are provided</b>, so the metric isolates skill generation — not tool discovery.",
  ];

  // Step 1 — how the splitter classifies each system-prompt section (by title
  // keyword): Contract + Glossary are KEPT in the stripped prompt; Procedure +
  // Reference are EXTRACTED as hidden skills.
  const S_SECTIONS = [
    { t: "General instructions", cls: "Contract", bin: "keep",
      ex: "“Confirm before any destructive action; never expose another user’s PII.”" },
    { t: "Operational constraints", cls: "Contract", bin: "keep",
      ex: "“Act only within the caller’s region; return ≤ 50 rows per query.”" },
    { t: "Employee records", cls: "Procedure", bin: "skill", skill: "employee-records",
      ex: "“To onboard: insert employee, set status = active, assign a manager_id.”" },
    { t: "Leave management", cls: "Procedure", bin: "skill", skill: "leave-management",
      ex: "“Approve only if balance ≥ days requested, then set status = approved.”" },
    { t: "Benefits enrollment", cls: "Procedure", bin: "skill", skill: "benefits",
      ex: "“During the window, create an enrollment; set plan_tier from salary band.”" },
    { t: "Payroll run", cls: "Procedure", bin: "skill", skill: "payroll",
      ex: "“Lock timesheets, compute gross − deductions, then mark the run = posted.”" },
    { t: "Offboarding", cls: "Procedure", bin: "skill", skill: "offboarding",
      ex: "“Revoke access, set status = terminated, and schedule final pay.”" },
    { t: "Compliance & access", cls: "Reference", bin: "skill", skill: "compliance",
      ex: "“Only HR-Admin may edit compensation; managers have read-only access.”" },
    { t: "Predefined lists / enums", cls: "Glossary", bin: "tag",
      ex: "leave_request.status ∈ { pending, approved, rejected }" },
  ];
  // Step 2 — one worked verifier→signature→match example (the tagger weights a
  // table-qualified (col=val) pair ×3 and a bare (table.col) ×1; tag if score≥3
  // or any pair hit). Task C's verifier disambiguates `status` via its table.
  const S_TAG_EX = {
    task: "C",
    sql: "SELECT COUNT(*) FROM leave_request\nWHERE status = 'approved';",
    sig: [
      { tok: "leave_request.status", kind: "col" },
      { tok: "leave_request.status = approved", kind: "pair" },
    ],
    cand: [
      { skill: "leave-management", idx: ["leave_request.status", "leave_request.status=approved"], score: "3", tag: true },
      { skill: "employee-records", idx: ["employee.status", "employee.dept"], score: "0", tag: false },
    ],
  };
  // Step 3 — illustrative min-step-size for the worked example (15 in the real build).
  const S_THRESH = 3;

  function schip(id, opts) {
    opts = opts || {};
    const c = SC[id] || "var(--accent-2)";
    const n = opts.count != null ? `<b class="dbt-tool-n">&times;${opts.count}</b>` : "";
    return `<span class="dbt-skill${opts.muted ? " is-muted" : ""}" style="--tc:${c}">${id}${n}</span>`;
  }
  function schipNO(id, isOld) {
    const c = SC[id] || "var(--accent-2)";
    return `<span class="dbt-skill${isOld ? " is-muted" : ""}" style="--tc:${c}">${id}` +
      `<b class="dbt-flag dbt-flag--${isOld ? "old" : "new"}">${isOld ? "old" : "new"}</b></span>`;
  }

  // Replay the sequencer's greedy version-cut so the trace is faithful: walk
  // skills in coverage order, add one at a time, count newly-solvable unplaced
  // tasks, and cut a version once that count reaches `thresh`.
  function computeGreedy(thresh) {
    const order = S_SKILLS.map((s) => s.id);
    const placed = new Set();
    const cum = new Set();
    const steps = [];
    let verIdx = 0, skillsThisVer = 0;
    order.forEach((sk, i) => {
      cum.add(sk);
      skillsThisVer += 1;
      const elig = S_TASKS.filter((t) => !placed.has(t.id) && t.skills.every((x) => cum.has(x)));
      const last = i === order.length - 1;
      const step = { skill: sk, count: elig.length, cut: null };
      if (elig.length >= thresh || last) {
        elig.forEach((t) => placed.add(t.id));
        verIdx += 1;
        step.cut = { tag: (S_VERS[verIdx - 1] || {}).tag || ("T" + verIdx), nSkills: skillsThisVer, nTasks: elig.length };
        skillsThisVer = 0;
      }
      steps.push(step);
    });
    return steps;
  }

  function skillsPanelHTML() {
    // phase 1 — classify each § (by title) into KEEP (stripped prompt) vs HIDE
    // (oracle skill), and say why.
    const secRow = (s) => {
      let right;
      if (s.bin === "keep") right = `<span class="dbt-badge dbt-badge--keep">${s.cls}</span>`;
      else if (s.bin === "skill") right = `<span class="dbt-badge dbt-badge--skill">${s.cls}</span><span class="dbt-sec-arrow">&rarr;</span>${schip(s.skill)}`;
      else right = `<span class="dbt-badge dbt-badge--tag">${s.cls}</span>`;
      return `<div class="dbt-sec"><div class="dbt-sec-top"><span class="dbt-sec-t">&sect; ${s.t}</span>${right}</div>` +
        `<div class="dbt-sec-ex">${s.ex}</div></div>`;
    };
    const keptRows = S_SECTIONS.filter((s) => s.bin === "keep").map(secRow).join("");
    const skillRows = S_SECTIONS.filter((s) => s.bin === "skill").map(secRow).join("");
    const tagRows = S_SECTIONS.filter((s) => s.bin === "tag").map(secRow).join("");
    // the bins are carved out of ONE document — the EOG system prompt — so show
    // that source first, then split it.
    const srcSecs = S_SECTIONS.map((s, i) =>
      `<li><span class="dbt-src-num">&sect;${i + 1}</span> ${s.t}</li>`).join("");
    const p1 = `<div class="dbt-phase dbt-p1">` +
      `<figure class="dbt-src"><figcaption class="dbt-src-cap"><span class="db-cap-k">Source</span> EnterpriseOps-Gym — one <b>system prompt</b> (numbered policy sections)</figcaption>` +
        `<div class="dbt-src-doc"><div class="dbt-src-title"># Operating policy</div><ol class="dbt-src-secs">${srcSecs}</ol></div></figure>` +
      `<div class="dbt-splitar"><span class="dbt-splitar-line"></span>` +
        `<span class="dbt-splitar-lab">A deterministic rule splits this prompt: <b>match each &sect;'s title</b> by keyword (no LLM, no content analysis) and route it <b>three ways</b> &darr;</span></div>` +
      `<div class="dbt-route">` +
        `<div class="dbt-route-l">` +
          `<div class="dbt-bin dbt-bin--keep"><div class="dbt-bin-h"><span class="dbt-bin-k dbt-bin-k--keep">KEEP</span> Contract &rarr; stripped prompt (agent sees this)</div>${keptRows}</div>` +
          `<div class="dbt-bin dbt-bin--tag dbt-drop"><div class="dbt-bin-h"><span class="dbt-bin-k dbt-bin-k--tag">DROP</span> Glossary &rarr; not shown to the agent; parsed only to build the verifier-tagging universe (step 2)</div>${tagRows}</div>` +
        `</div>` +
        `<div class="dbt-bin dbt-bin--skill"><div class="dbt-bin-h"><span class="dbt-bin-k dbt-bin-k--skill">HIDE</span> Procedure + Reference &rarr; oracle skills (held out)</div>${skillRows}</div>` +
      `</div>` +
      `<div class="dbt-foot">Because it's title-based, the line is <b>fuzzy</b>: an <i>Operational constraints</i> block is kept, yet <b>access-scope authority</b> becomes a skill — any constraint written <i>inside</i> a procedure rides along into that skill, and a title matching <b>no</b> rule <b>defaults to a skill</b>.</div>` +
      `</div>`;

    // phase 2 — HOW tagging works: parse a verifier's SQL into a signature and
    // match it against each skill's index (pair = strong evidence).
    const ex = S_TAG_EX;
    const sigChips = ex.sig.map((s) =>
      `<span class="dbt-sig dbt-sig--${s.kind}">${s.tok}<b>${s.kind === "pair" ? "pair &times;3" : "col &times;1"}</b></span>`
    ).join("");
    const candRows = ex.cand.map((c) =>
      `<div class="dbt-cand${c.tag ? " is-tag" : ""}">${schip(c.skill)}` +
      `<span class="dbt-cand-idx">${c.idx.map((x) => `<code>${x}</code>`).join("")}</span>` +
      `<span class="dbt-cand-score">score ${c.score}</span>` +
      `<span class="dbt-cand-mark">${c.tag ? "tag &check;" : "&times;"}</span></div>`
    ).join("");
    const how = `<div class="dbt-tag-how">` +
      `<div class="dbt-tag-step"><div class="dbt-tag-h"><span class="dbt-tag-n">1</span> Task ${ex.task} &mdash; the EOG <b>verifier SQL</b></div>` +
        `<pre class="dbt-sql">${ex.sql.replace(/</g, "&lt;")}</pre></div>` +
      `<div class="dbt-tag-step"><div class="dbt-tag-h"><span class="dbt-tag-n">2</span> parse &rarr; <b>signature</b> (tables / cols / values)</div><div class="dbt-sigs">${sigChips}</div></div>` +
      `<div class="dbt-tag-step"><div class="dbt-tag-h"><span class="dbt-tag-n">3</span> match each skill's <b>index</b> <i>(table-qualified pair = strong)</i></div><div class="dbt-cands">${candRows}</div></div>` +
      `<div class="dbt-tag-step dbt-tag-out"><div class="dbt-tag-h"><span class="dbt-tag-n">&rArr;</span> tag Task ${ex.task} &rarr; ${schip(ex.cand.find((c) => c.tag).skill)}</div></div>` +
      `</div>`;
    const res = `<div class="dbt-tag-res"><div class="dbt-tag-res-h">same parse + match for every task &rarr;</div>` +
      `<div class="dbt-tasklist">${
        S_TASKS.map((t) =>
          `<div class="dbt-task"><span class="dbt-task-tag">Task ${t.id}</span>` +
          `<span class="dbt-task-tools">${t.skills.map((id) => schip(id)).join("")}</span></div>`
        ).join("")
      }</div></div>`;
    const p2 = `<div class="dbt-phase dbt-p2"><div class="dbt-tag">${how}${res}</div></div>`;

    // phase 3 — order by coverage, then DERIVE versions: add skills until ≥ N
    // new tasks become solvable, then cut.
    const strip = S_SKILLS.map((s) => schip(s.id, { count: s.cov }))
      .join('<span class="dbt-rank-sep">&rsaquo;</span>');
    const trace = computeGreedy(S_THRESH).map((st) => {
      const w = Math.min(100, Math.round((st.count / S_THRESH) * 100));
      const cut = st.cut
        ? `<span class="dbt-gcut">&#9986; cut &rarr; <b>${st.cut.tag}</b> = ${st.cut.nSkills} new skills, ${st.cut.nTasks} tasks</span>`
        : "";
      return `<div class="dbt-gstep${st.cut ? " is-cut" : ""}">` +
        `<span class="dbt-gadd">+ ${schip(st.skill)}</span>` +
        `<span class="dbt-gtrack"><i style="--w:${w}%"></i></span>` +
        `<span class="dbt-gcount">${st.count}/${S_THRESH}</span>${cut}</div>`;
    }).join("");
    const p3 = `<div class="dbt-phase dbt-p3">` +
      `<div class="dbt-rankstrip"><span class="dbt-rankstrip-lab">by coverage</span>${strip}</div>` +
      `<div class="dbt-greedy"><div class="dbt-greedy-rule">Walk skills in coverage order; <b>cut a version</b> once <b>&ge; ${S_THRESH}</b> new tasks become solvable <i>(= min-step-size; <b>15</b> in the real build, ${S_THRESH} here)</i>. So a version's skill-count is <b>derived</b>, not chosen.</div>${trace}</div>` +
      `</div>`;

    // phase 4 — assign tasks to earliest version, labelling new vs old skills
    const p4 = `<div class="dbt-phase dbt-p4"><div class="dbt-assign">${
      S_VERS.map((v, k) => {
        const inV = S_TASKS.filter((t) => t.ver === k);
        return `<div class="dbt-asg-ver"><span class="dbt-asg-tag">${v.tag}</span><div class="dbt-asg-tasks">${
          inV.map((t) => {
            const chips = t.skills.map((id) => schipNO(id, S_SKILLVER[id] < t.ver)).join("");
            const nNew = t.skills.filter((id) => S_SKILLVER[id] === t.ver).length;
            const nOld = t.skills.length - nNew;
            const sum = nOld > 0 ? `${nNew} new + ${nOld} old` : `${nNew} new &middot; no old`;
            return `<div class="dbt-asg-task"><span class="dbt-asg-name">Task ${t.id}</span>` +
              `<span class="dbt-asg-tools">${chips}</span>` +
              `<span class="dbt-asg-sum">${sum}</span></div>`;
          }).join("")
        }</div></div>`;
      }).join("")
    }</div></div>`;

    return `
      <div class="db-panel${active === "skills" ? " is-active" : ""}" data-panel="skills">
        <div class="dbt" data-phase="1">
          <div class="dbt-bar">
            <ol class="dbt-steps">${
              S_STEPS.map((s, i) =>
                `<li data-step="${i + 1}" role="button" tabindex="0" title="Click to study this step"><b>${i + 1}</b>${s}</li>`
              ).join("")
            }</ol>
            <button class="dbt-play" type="button" data-playing="true" title="Pause" aria-label="Pause or play the walk-through"></button>
          </div>
          <div class="dbt-stage">${p1}${p2}${p3}${p4}</div>
          <div class="dbt-caps">${
            S_CAPS.map((c, i) => `<p data-cap="${i + 1}">${c}</p>`).join("")
          }</div>
          <div class="dbt-feats">
            <span class="dbt-feats-k">Guarantee</span>
            <ul>${S_FEATS.map((f) => `<li>${f}</li>`).join("")}</ul>
          </div>
          <!-- Entry point into the full skill-benchmark detail page. Routes to
               the #skill-datasets view (/skills/benchmark): the 4-tab dataset
               explorer (How it's built / Evolution / Real-world fit / Browser). -->
          <button class="dbt-cta" type="button" data-tab="skill-datasets">
            <span class="dbt-cta-k">Deep dive</span>
            <span class="dbt-cta-tx">
              <b>Statistics, examples &amp; realistic assessment</b>
              <i>How it's built · Evolution · Real-world fit · Task browser</i>
            </span>
            <span class="dbt-cta-arrow" aria-hidden="true">&rarr;</span>
          </button>
        </div>
      </div>`;
  }

  // =====================================================================
  // Agents track walk-through. Mirrors evovle_agents (capabilities.py +
  // build_capabilities.py + agent_library.py + build_agents.py):
  //   * an AGENT is now a CAPABILITY — a tool-coherent, DISJOINT bundle of the
  //     domain's tools, derived by PARTITIONING the tool universe by ENTITY
  //     (tool_capability: the table each tool acts on). Every tool belongs to
  //     exactly ONE capability, so the partition is total + disjoint +
  //     non-empty: each agent owns its COMPLETE bundle (never empty).
  //   * each capability -> one Codex SUBAGENT, built DETERMINISTICALLY (no LLM).
  //     build_capabilities re-homes ALL workflow content BY TABLE (field rules
  //     by their table; each workflow's Source policy + Notes by its primary
  //     write target; references unioned), and verify_no_content_dropped ABORTS
  //     the build if any policy/field/reference would be lost. Every agent also
  //     carries the FULL domain policy as operating context -> COMPLETE.
  //   * a task needs >1 agent when its selected_tools SPAN several capabilities
  //     (task_capabilities). ~98-100% do (49/50 csm, 75/75 hr, 82/83 itsm), yet
  //     stay solvable (the spanned bundles jointly cover all its gold tools).
  //   * rosters grow per version (a capability enters when a version's tools
  //     first touch its entity); the lead is a tool-less ROUTER that delegates
  //     + coordinates; carried-forward agents are distractors.
  // Toy: a small HR tool universe partitioned by entity (real csm=7 caps/57
  // tools, hr=6, itsm=7).
  const CC = {  // capability colours
    directory: "#2563eb", leave: "#16a34a", payroll: "#d97706",
    benefits: "#7c3aed", access: "#dc2626",
  };
  const CAP = {  // capability slug -> { title, entity, DISJOINT tool bundle }
    directory: { title: "Directory", entity: "employee",     tools: ["get_employee", "update_employee"] },
    leave:     { title: "Leave",     entity: "leave_request", tools: ["get_leave_balance", "approve_leave"] },
    payroll:   { title: "Payroll",   entity: "payroll_run",   tools: ["run_payroll"] },
    benefits:  { title: "Benefits",  entity: "benefit",       tools: ["enroll_benefit"] },
    access:    { title: "Access",    entity: "access_grant",   tools: ["grant_access", "revoke_access", "check_access"] },
  };
  const CAP_ORDER = ["directory", "leave", "payroll", "benefits", "access"];
  const CAP_OF_TOOL = {};                          // tool -> owning capability
  CAP_ORDER.forEach((c) => CAP[c].tools.forEach((t) => { CAP_OF_TOOL[t] = c; }));
  const CAP_UNIVERSE = CAP_ORDER.flatMap((c) => CAP[c].tools);  // the tool universe
  // The version a capability first enters the roster, staged by CAPABILITY
  // FREQUENCY (core caps first) — the agents track's OWN version axis (see
  // capabilities._capability_staging). The pool only grows T1={directory,leave}
  // ⊂ T2=+{payroll,benefits} ⊂ T3=+{access}.
  const CAP_VER = { directory: 0, leave: 0, payroll: 1, benefits: 1, access: 2 };
  // old workflow skills (dropped as UNITS) -> their facts re-home by table.
  const WF = [
    { id: "employee-records", table: "employee", cap: "directory" },
    { id: "leave-management", table: "leave_request", cap: "leave" },
    { id: "payroll-run", table: "payroll_run", cap: "payroll" },
  ];
  // one worked task: its gold tools span 3 capabilities -> needs 3 agents.
  const CAP_TASK = { id: "onboard + first pay-run", tools: ["get_employee", "run_payroll", "grant_access"] };
  // per-version routing examples (gold capability set; >=1 new at that version).
  const CAP_ROUTE = [
    { id: "P", ver: 0, caps: ["directory", "leave"] },
    { id: "Q", ver: 1, caps: ["directory", "payroll"] },
    { id: "R", ver: 1, caps: ["leave", "benefits"] },
    { id: "S", ver: 2, caps: ["payroll", "access", "directory"] },
  ];
  const A_STEPS = [
    "partition tools by entity",
    "build complete agents",
    "task spans &rarr; &ge;2 agents",
    "versions &middot; route &amp; delegate",
  ];
  const A_CAPS = [
    "An <b>agent is a capability</b> — a <b>disjoint</b> bundle of the domain's tools, found by <b>partitioning the tool universe by entity</b> (the table each tool acts on), with <b>no LLM</b>. Every tool lands in <b>exactly one</b> capability, so the partition is <b>total, disjoint &amp; non-empty</b> — each agent owns its <b>complete</b> tool bundle (never empty).",
    "Each capability is built into one subagent <b>deterministically</b>. <b>All</b> workflow content is <b>re-homed by table</b> — field rules by their table, each workflow's policy + notes by its primary write target, references unioned — and a hard verifier <b>aborts the build</b> if any fact is lost. Plus every agent carries the <b>full domain policy</b> as context &rArr; each subagent is <b>complete</b>.",
    "A task needs <b>one agent per capability its tools touch</b>. Because the bundles are <b>disjoint</b> and a task's tools usually span several entities, it needs <b>&ge;2 agents</b> — yet stays <b>solvable</b> (the spanned bundles jointly cover all its gold tools). <b>~98–100%</b> of tasks are multi-agent.",
    "Agents are a <b>given</b>, accumulating resource. The agents track stages its <b>own</b> versions by <b>capability frequency</b> (core caps first), <b>not</b> by skill emergence (coarse caps saturate at T₁), and <b>cuts</b> each version with a <b>min_new_tasks</b> + <b>capability-growth</b> floor — so the roster <b>grows every version</b> (T₁ &sub; T₂ &sub; T₃). The lead is a tool-less <b>router</b>: it must <b>delegate</b> to the task's gold agents (&ge;1 <b>new</b>) and <b>coordinate</b> several; carried-forward extras are <b>distractors</b>.",
  ];
  const A_FEATS = [
    "<b>Agent = capability = a disjoint, complete tool bundle</b> (partition by entity, no LLM): total, disjoint, non-empty. Real domains carve <b>csm 7</b>, <b>hr 6</b>, <b>itsm 7</b> capabilities over their tool universes.",
    "<b>Every subagent is complete &amp; nothing is dropped</b>: all workflow facts (field rules, policy, references) are re-homed by table and <b>verify_no_content_dropped</b> aborts the build on any loss; every agent also gets the full domain policy. Workflow skills are dropped only <b>as units</b> (name/grouping).",
    "<b>Coordination is forced</b>: a task needs one agent per capability its tools span, so <b>49/50 csm · 75/75 hr · 82/83 itsm</b> tasks need <b>&ge;2</b> agents — yet every task stays solvable. The roster <b>accumulates</b> per version and extras are <b>distractors</b>; the metric is the lead's <b>delegation</b>.",
  ];
  const A_TAG = ["T₁", "T₂", "T₃"];   // version tags (NOT agent names) — matches tools/skills

  const cap_chip = (c, opts) => {
    opts = opts || {};
    return `<span class="dbt-agent${opts.muted ? " is-muted" : ""}" style="--tc:${CC[c]}">${CAP[c].title}</span>`;
  };
  const cap_chipNO = (c, isOld) =>
    `<span class="dbt-agent${isOld ? " is-muted" : ""}" style="--tc:${CC[c]}">${CAP[c].title}` +
    `<b class="dbt-flag dbt-flag--${isOld ? "old" : "new"}">${isOld ? "old" : "new"}</b></span>`;
  // tool chip coloured by its OWNING capability (so the partition reads at a glance)
  const cap_tool = (t, opts) => {
    opts = opts || {};
    return `<span class="dbt-ctool${opts.muted ? " is-muted" : ""}" style="--tc:${CC[CAP_OF_TOOL[t]]}">${t}</span>`;
  };
  const mtool = (t) => `<span class="dbt-mini">${t}</span>`;

  function agentsPanelHTML() {
    // phase 1 — partition the tool universe BY ENTITY into disjoint capability
    // bundles (the agent roster). Mirrors capabilities.capability_tool_map.
    const uni = CAP_UNIVERSE.map((t) =>
      `<span class="dbt-ctool" style="--tc:var(--border-strong)">${t}</span>`).join("");
    const bins = CAP_ORDER.map((c) =>
      `<div class="dbt-capbin" style="--tc:${CC[c]}">` +
        `<div class="dbt-capbin-h"><span class="dbt-capbin-dot"></span><b>${CAP[c].title}</b>` +
          `<span class="dbt-capbin-ent">entity <code>${CAP[c].entity}</code></span></div>` +
        `<div class="dbt-capbin-tools">${CAP[c].tools.map(mtool).join("")}</div></div>`).join("");
    const p1 = `<div class="dbt-phase dbt-p1">` +
      `<figure class="dbt-uni-fig"><figcaption class="dbt-uni-cap"><span class="db-cap-k">Tool universe</span> every tool the domain's tasks ever call (union of all selected_tools)</figcaption>` +
        `<div class="dbt-uni">${uni}</div></figure>` +
      `<div class="dbt-splitar"><span class="dbt-splitar-line"></span>` +
        `<span class="dbt-splitar-lab">Partition by <b>entity</b>: parse each tool's name &rarr; the <b>table it acts on</b> &rarr; route it to <b>exactly one</b> capability (deterministic, no LLM).</span></div>` +
      `<div class="dbt-capgrid">${bins}</div>` +
      `<div class="dbt-foot"><b>The roster.</b> The partition is <b>disjoint</b> (every tool in exactly one bundle), <b>total</b> (no tool dropped) and <b>non-empty</b> (each capability owns &ge;1 tool) — so each <b>capability = one agent</b> that owns its <b>complete</b> tool bundle.</div>` +
      `</div>`;

    // phase 2 — build each capability into a COMPLETE subagent: re-home ALL
    // workflow content by table + full domain policy; verifier aborts on loss.
    const wfRows = WF.map((w) =>
      `<div class="dbt-attr-row"><span class="dbt-mini">${w.id}</span><span class="dbt-attr-ar">&rarr;</span>` +
      `<code class="dbt-tbl">${w.table}</code><span class="dbt-attr-ar">&rarr;</span>${cap_chip(w.cap)}</div>`).join("");
    const acard = `<div class="dbt-acard" style="--tc:${CC.directory}">` +
      `<div class="dbt-acard-h">${cap_chip("directory")}<span class="dbt-acard-tag">one complete subagent</span></div>` +
      `<div class="dbt-acard-row"><span class="dbt-acard-k">tools</span><span class="dbt-acard-v">${CAP.directory.tools.map(mtool).join("")}<i>complete bundle</i></span></div>` +
      `<div class="dbt-acard-row"><span class="dbt-acard-k">SKILL.md</span><span class="dbt-acard-v">Scope · Required fields · Operating rules · references <i>re-homed by table</i></span></div>` +
      `<div class="dbt-acard-row"><span class="dbt-acard-k">context</span><span class="dbt-acard-v">full domain policy <i>shared by every agent</i></span></div>` +
      `<div class="dbt-acard-row"><span class="dbt-acard-k">model</span><span class="dbt-acard-v">inherits the orchestrator</span></div>` +
      `<div class="dbt-acard-complete">&#10003; complete — owns every tool + every rule it can act on</div></div>`;
    const p2 = `<div class="dbt-phase dbt-p2">` +
      `<div class="dbt-rulebar">Each capability becomes <b>one subagent</b>, assembled <b>deterministically</b> (no LLM): it owns its <b>complete tool bundle</b>, and <b>all</b> workflow content is <b>re-homed onto it by table</b> — then a hard verifier checks <b>nothing was lost</b>.</div>` +
      `<div class="dbt-tag">` +
        `<div class="dbt-tag-how">` +
          `<div class="dbt-tag-step"><div class="dbt-tag-h"><span class="dbt-tag-n">1</span> old <b>workflow skills</b> — dropped as <b>units</b>, facts kept</div>` +
            `<div class="dbt-attr-line">${WF.map((w) => `<span class="dbt-mini">${w.id}</span>`).join("")}</div></div>` +
          `<div class="dbt-tag-step"><div class="dbt-tag-h"><span class="dbt-tag-n">2</span> re-home each fact <b>by table</b> &rarr; the capability that owns it</div>` +
            `<div class="dbt-attr">${wfRows}</div></div>` +
          `<div class="dbt-tag-step dbt-tag-out"><div class="dbt-tag-h"><span class="dbt-tag-n">&#10003;</span> <b>verify_no_content_dropped</b> — build <b>aborts</b> if any field-cell, policy line or reference fails to re-home</div></div>` +
        `</div>` +
        `<div class="dbt-tag-res"><div class="dbt-tag-res-h">the assembled agent (capability directory) &rarr;</div>${acard}</div>` +
      `</div>` +
      `<div class="dbt-foot"><b>Trade-off.</b> Workflow skills lose their <b>grouping/name</b> as units — but <b>every fact</b> (field rules, policy, references) is preserved and re-homed by table, and each agent also carries the <b>full domain policy</b>, so no rule is invisible to the agent that can act on it.</div>` +
      `</div>`;

    // phase 3 — a task whose tools SPAN several capabilities needs one agent per
    // capability. Mirrors capabilities.task_capabilities.
    const tk = CAP_TASK;
    const tcaps = CAP_ORDER.filter((c) => tk.tools.some((x) => CAP_OF_TOOL[x] === c));
    const mapRows = tk.tools.map((x) =>
      `<div class="dbt-attr-row">${cap_tool(x)}<span class="dbt-attr-ar">&rarr;</span>${cap_chip(CAP_OF_TOOL[x])}</div>`).join("");
    const rates = [["csm", "49 / 50"], ["hr", "75 / 75"], ["itsm", "82 / 83"]];
    const rateRows = rates.map(([d, n]) =>
      `<div class="dbt-stat"><span class="dbt-stat-d">${d}</span><span class="dbt-stat-n">${n}</span><span class="dbt-stat-l">need &ge;2 agents</span></div>`).join("");
    const p3 = `<div class="dbt-phase dbt-p3"><div class="dbt-tag">` +
      `<div class="dbt-tag-how">` +
        `<div class="dbt-tag-step"><div class="dbt-tag-h"><span class="dbt-tag-n">1</span> Task &ldquo;${tk.id}&rdquo; — its gold <b>tools</b></div>` +
          `<div class="dbt-attr-line">${tk.tools.map((x) => cap_tool(x)).join("")}</div></div>` +
        `<div class="dbt-tag-step"><div class="dbt-tag-h"><span class="dbt-tag-n">2</span> map each tool &rarr; the <b>one</b> capability that owns it</div>` +
          `<div class="dbt-attr">${mapRows}</div></div>` +
        `<div class="dbt-tag-step dbt-tag-out"><div class="dbt-tag-h"><span class="dbt-tag-n">&rArr;</span> tools <b>span</b> ${tcaps.map((c) => cap_chip(c)).join(" ")} &rarr; needs <b>${tcaps.length} agents</b> · coordinate — yet <b>solvable</b></div></div>` +
      `</div>` +
      `<div class="dbt-tag-res"><div class="dbt-tag-res-h">why &ge;2 agents is the norm &rarr;</div><div class="dbt-stats">${rateRows}</div>` +
        `<div class="dbt-stat-note">Disjoint bundles + tasks touching several entities &rArr; coordination is <b>forced</b>; the rare solo task touches a single entity.</div></div>` +
      `</div></div>`;

    // phase 4 — the roster GROWS per version. The agents track stages its OWN
    // versions by CAPABILITY FREQUENCY (core caps first) and decides WHERE to
    // cut with TWO floors (capabilities._capability_staging ->
    // evolve_tools.build_frequency_anchors_adaptive):
    //   - min_new_tasks_per_stage : >= N tasks become newly solvable, AND
    //   - min_growth_frac         : the roster grows by >= a fraction of caps.
    // Each task lands at the earliest version whose roster covers its caps.
    const capVers = A_TAG.map((tag, k) => ({
      tag, k,
      cum: CAP_ORDER.filter((c) => CAP_VER[c] <= k),
      delta: CAP_ORDER.filter((c) => CAP_VER[c] === k),
    }));
    const p4seen = new Set();
    const chain = capVers.map((v) => {
      const have = new Set(v.cum);
      const solv = CAP_ROUTE.filter((r) => r.caps.every((c) => have.has(c)));
      const fresh = solv.filter((r) => !p4seen.has(r.id));
      solv.forEach((r) => p4seen.add(r.id));
      const freshChips = fresh.length
        ? fresh.map((r) => `<i class="dbt-solv-chip">Task ${r.id}</i>`).join(" ")
        : `<i class="dbt-solv-chip is-none">none</i>`;
      const dcap = `+${v.delta.length} cap${v.delta.length === 1 ? "" : "s"}`;
      const fcount = `+${fresh.length} new task${fresh.length === 1 ? "" : "s"}`;
      const badge = v.k === 0
        ? `<span class="dbt-cut-badge dbt-cut-badge--floor">${dcap} &middot; ${fresh.length} task${fresh.length === 1 ? "" : "s"} &ge; floor (N=1)</span>`
        : `<span class="dbt-cut-badge">${dcap} &middot; ${fcount} &ge; floor</span>`;
      const main = `<div class="dbt-cat"><span class="dbt-cat-tag">${v.tag}</span>` +
        `<span class="dbt-cat-tools">${v.cum.map((c) => cap_chip(c, { muted: CAP_VER[c] < v.k })).join(" ")}</span>` +
        `<span class="dbt-cat-delta">${v.k === 0 ? "initial roster" : "+ " + v.delta.map((c) => CAP[c].title).join(", ")}</span></div>`;
      const sub = `<div class="dbt-cut-sub"><span class="dbt-cut-arrow">&#8627;</span> newly solvable: ${freshChips} ${badge}</div>`;
      return `<div class="dbt-cutrow">${main}${sub}</div>`;
    }).join("");
    const routes = capVers.map((v) => {
      const inV = CAP_ROUTE.filter((r) => r.ver === v.k);
      return `<div class="dbt-asg-ver"><span class="dbt-asg-tag">${v.tag}</span><div class="dbt-asg-tasks">${
        inV.map((r) => {
          const chips = r.caps.map((c) => cap_chipNO(c, CAP_VER[c] < r.ver)).join(" ");
          const n = r.caps.length;
          const sum = n > 1 ? `route to ${n} agents &middot; <b>coordinate</b>` : "route to 1 agent";
          return `<div class="dbt-asg-task${n > 1 ? " is-coord" : ""}"><span class="dbt-asg-name">Task ${r.id}</span>` +
            `<span class="dbt-asg-tools">${chips}</span><span class="dbt-asg-sum">${sum}</span></div>`;
        }).join("")
      }</div></div>`;
    }).join("");
    const p4 = `<div class="dbt-phase dbt-p4">` +
      `<div class="dbt-rulebar">The agents track stages its <b>own</b> versions by <b>capability frequency</b> (core caps first), <b>not</b> by skill emergence (coarse caps would saturate at T₁ — 0 new agents after). Where to <b>cut</b> each version is set by <b>two floors</b>: <b>&ge; min_new_tasks</b> newly-solvable tasks <b>and</b> a <b>capability-growth</b> floor; each task lands at the <b>earliest version whose roster covers its caps</b>, so the pool only grows T₁ &sub; T₂ &sub; T₃.</div>` +
      `<div class="dbt-asg-h">the <b>roster</b> after each cut — grows every version &rarr;</div>` +
      `<div class="dbt-cats dbt-cats--cut">${chain}</div>` +
      `<div class="dbt-asg-h">the lead <b>routes</b> each task to its gold agents (&ge;1 <b>new</b>) &amp; <b>coordinates</b> &rarr;</div>` +
      `<div class="dbt-assign">${routes}</div>` +
      `<div class="dbt-foot"><b>Real floors</b> (<code>capabilities._capability_staging</code>). <code>min_new_tasks</code> = <b>7</b>/version (enterprise <b>100</b>); the growth floor <code>min_growth_frac</code> = <b>0.15</b> (enterprise <b>0.02</b> &asymp; floor-only, so the task floor sets the step size). Staged by frequency the roster grows <b>every</b> version (never saturating) — for the dense enterprise domain this spreads into up to <b>~15</b> balanced versions (110–254 tasks each). Carried-forward extras become <b>distractors</b>.</div>` +
      `</div>`;

    return `
      <div class="db-panel${active === "agents" ? " is-active" : ""}" data-panel="agents">
        <div class="dbt" data-phase="1">
          <div class="dbt-bar">
            <ol class="dbt-steps">${
              A_STEPS.map((s, i) =>
                `<li data-step="${i + 1}" role="button" tabindex="0" title="Click to study this step"><b>${i + 1}</b>${s}</li>`
              ).join("")
            }</ol>
            <button class="dbt-play" type="button" data-playing="true" title="Pause" aria-label="Pause or play the walk-through"></button>
          </div>
          <div class="dbt-stage">${p1}${p2}${p3}${p4}</div>
          <div class="dbt-caps">${
            A_CAPS.map((c, i) => `<p data-cap="${i + 1}">${c}</p>`).join("")
          }</div>
          <div class="dbt-feats">
            <span class="dbt-feats-k">Guarantee</span>
            <ul>${A_FEATS.map((f) => `<li>${f}</li>`).join("")}</ul>
          </div>
          <!-- Entry point into the full agent-benchmark detail page. Routes to
               the #agent-datasets view (/agents/benchmark): the 4-tab dataset
               explorer (How it's built / Evolution / Real-world fit / Browser). -->
          <button class="dbt-cta" type="button" data-tab="agent-datasets">
            <span class="dbt-cta-k">Deep dive</span>
            <span class="dbt-cta-tx">
              <b>Statistics, examples &amp; realistic assessment</b>
              <i>How it's built · Evolution · Real-world fit · Task browser</i>
            </span>
            <span class="dbt-cta-arrow" aria-hidden="true">&rarr;</span>
          </button>
        </div>
      </div>`;
  }

  // Drive every 4-phase walk-through (.dbt) on the page. The reader can CLICK
  // any step to jump to it (which pauses auto-advance so they can study it) and
  // use the play/pause button to resume. Auto-advance only runs while playing
  // AND on screen (IntersectionObserver reports a display:none subtree as not
  // intersecting, so switching tab / landing page pauses it automatically).
  function startWalkthroughs(root) {
    root.querySelectorAll(".dbt").forEach((dbt) => {
      if (dbt._wired) return;
      dbt._wired = true;
      const N = dbt.querySelectorAll(".dbt-steps li").length || 4;
      let phase = 1, playing = true, visible = false, timer = null;

      const render = () => {
        dbt.setAttribute("data-phase", String(phase));
        const b = dbt.querySelector(".dbt-play");
        if (b) {
          b.dataset.playing = String(playing);
          b.title = playing ? "Pause" : "Play";
        }
      };
      const sync = () => {
        if (playing && visible) {
          if (!timer) timer = setInterval(() => { phase = (phase % N) + 1; render(); }, 3200);
        } else if (timer) {
          clearInterval(timer);
          timer = null;
        }
      };
      const goTo = (p) => { phase = ((p - 1 + N) % N) + 1; render(); };
      render();

      const steps = dbt.querySelector(".dbt-steps");
      const onStep = (li) => {
        if (!li) return;
        playing = false;          // studying a step -> stop auto-advance
        goTo(Number(li.dataset.step));
        sync();
      };
      if (steps) {
        steps.addEventListener("click", (e) => onStep(e.target.closest("li[data-step]")));
        steps.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onStep(e.target.closest("li[data-step]")); }
        });
      }
      const btn = dbt.querySelector(".dbt-play");
      if (btn) btn.addEventListener("click", () => { playing = !playing; render(); sync(); });

      if ("IntersectionObserver" in window) {
        new IntersectionObserver((es) => {
          es.forEach((e) => { visible = e.isIntersecting; });
          sync();
        }, { threshold: 0.3 }).observe(dbt);
      } else {
        visible = true;
        sync();
      }
    });
  }

  function select(k) {
    if (!TRACKS[k]) return;
    active = k;
    const root = document.getElementById("db-root");
    if (!root) return;
    $$(".db-tab", root).forEach((b) => b.classList.toggle("is-active", b.dataset.dbtrack === k));
    $$(".db-panel", root).forEach((p) => p.classList.toggle("is-active", p.dataset.panel === k));
    const blurb = $(".db-blurb", root);
    if (blurb) blurb.innerHTML = TRACKS[k].blurb;
  }

  function mount() {
    if (mounted) return;
    const root = document.getElementById("db-root");
    if (!root) return;
    const tabs = ORDER.map((k) =>
      `<button class="db-tab${k === active ? " is-active" : ""}" type="button" data-dbtrack="${k}">` +
      `<span class="db-tab-dot db-dot--${k}"></span>${TRACKS[k].label}</button>`
    ).join("");
    root.innerHTML =
      `<div class="db-tabs" role="tablist">${tabs}</div>` +
      `<p class="db-blurb">${TRACKS[active].blurb}</p>` +
      `<div class="db-panels">${
        ORDER.map((k) => (k === "tools" ? toolsPanelHTML() : k === "skills" ? skillsPanelHTML() : agentsPanelHTML())).join("")
      }</div>`;
    root.addEventListener("click", (e) => {
      const b = e.target.closest(".db-tab");
      if (b && b.dataset.dbtrack) select(b.dataset.dbtrack);
    });
    startWalkthroughs(root);
    mounted = true;
  }

  return { mount, select };
})();

// ---------------------------------------------------------------------------
// Landing — 3-page stepper  (Framework · Dataset building · Evaluation & observability)
// ---------------------------------------------------------------------------
const LP = (() => {
  let page = 1;

  function go(n) {
    n = Math.max(1, Math.min(3, n | 0));
    page = n;
    const root = document.getElementById("landing");
    if (!root) return;
    $$(".lp-page", root).forEach((p) => p.classList.toggle("is-active", Number(p.dataset.lpPage) === n));
    $$(".lp-step", root).forEach((s) => s.classList.toggle("is-active", Number(s.dataset.lp) === n));
    $$(".lp-dots i", root).forEach((d) => d.classList.toggle("is-active", Number(d.dataset.lp) === n));
    const prev = $(".lp-prev", root);
    const next = $(".lp-next", root);
    if (prev) prev.disabled = n === 1;
    if (next) next.disabled = n === 3;

    // P1 holds the framework diagram whose feedback loop is measured from
    // live layout — re-align now that it is visible again.
    if (n === 1) {
      requestAnimationFrame(alignFeedbackLoop);
      setTimeout(alignFeedbackLoop, 120);
    }
    // P2 builds its panels lazily the first time it is opened.
    if (n === 2) DB.mount();
  }

  function init() {
    const root = document.getElementById("landing");
    if (!root) return;
    root.addEventListener("click", (e) => {
      const dot = e.target.closest(".lp-dots i");
      if (dot && dot.dataset.lp) { go(Number(dot.dataset.lp)); return; }
      const step = e.target.closest(".lp-step");
      if (step && step.dataset.lp) { go(Number(step.dataset.lp)); return; }
      if (e.target.closest(".lp-next")) { go(page + 1); return; }
      if (e.target.closest(".lp-prev")) { go(page - 1); return; }
    });
    go(1);
  }

  return { init, go };
})();

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

// Wire up the 3-page landing stepper (Framework · Dataset building ·
// Evaluation & observability) and start on page 1.
LP.init();

// Run the landing diagram alignment a couple of times after first paint
// so it survives webfont swap and any late-layout settling.
setTimeout(alignFeedbackLoop, 0);
setTimeout(alignFeedbackLoop, 300);
setTimeout(alignFeedbackLoop, 1200);
