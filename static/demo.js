/* CascadeIQ demo shell — interpret → audit → recommend → verify */

const DEFAULT_INCIDENT = `API Gateway routes checkout traffic to Orders, which calls Payments.
During a peak window Payments capacity drops hard and checkouts start failing.
Arrivals are about 80 requests per second. Payments normally handles 100/s
but falls to roughly 30/s from second 20 through 50. Clients retry immediately
up to two times.`;

const state = {
  scenario: null,
  audit: null,
  recommend: null,
  verify: null,
  interpret: null,
  step: 1,
  readonly: false,
  catalog: null,
  labOpen: false,
};

const $ = (id) => document.getElementById(id);

function setStatus(el, msg, kind = "") {
  el.textContent = msg || "";
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function setStep(n) {
  state.step = n;
  document.querySelectorAll(".step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) <= n);
  });
}

function fmt(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function inferenceBadge(used, err) {
  const badge = $("inferenceBadge");
  if (used === true) {
    badge.textContent = "inference_used=true";
    badge.className = "badge on";
  } else if (used === false) {
    badge.textContent = err ? "inference_used=false" : "fixture / fallback";
    badge.className = "badge warn";
  } else {
    badge.textContent = "ready";
    badge.className = "badge";
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data.detail || data.message || text || res.statusText;
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

function scenarioFromFields() {
  if (!state.scenario) throw new Error("Interpret first (or load demo scenario).");
  const s = structuredClone(state.scenario);
  s.ticks = Number($("fTicks").value);
  s.arrivals_rps = Number($("fArrivals").value);
  s.seed = Number($("fSeed").value);
  s.capacities = s.capacities || {};
  s.capacities.payments_rps = Number($("fPayCap").value);
  s.fault = s.fault || {};
  s.fault.start_tick = Number($("fFaultStart").value);
  s.fault.end_tick = Number($("fFaultEnd").value);
  s.fault.capacity_rps = Number($("fFaultCap").value);
  s.retry = s.retry || {};
  s.retry.max_retries = Number($("fMaxRetries").value);
  if ($("scenarioJson").value.trim()) {
    try {
      const edited = JSON.parse($("scenarioJson").value);
      return { ...edited, ...pickOverrides(s, edited) };
    } catch (e) {
      throw new Error("Scenario JSON is invalid: " + e.message);
    }
  }
  return s;
}

function pickOverrides(fields, edited) {
  // Key fields from the form win over JSON when form is the source of truth.
  return {
    ticks: fields.ticks,
    arrivals_rps: fields.arrivals_rps,
    seed: fields.seed,
    capacities: {
      ...(edited.capacities || {}),
      payments_rps: fields.capacities.payments_rps,
    },
    fault: {
      ...(edited.fault || {}),
      start_tick: fields.fault.start_tick,
      end_tick: fields.fault.end_tick,
      capacity_rps: fields.fault.capacity_rps,
    },
    retry: {
      ...(edited.retry || {}),
      max_retries: fields.retry.max_retries,
    },
  };
}

function fillScenarioUI(scenario) {
  state.scenario = scenario;
  $("fTicks").value = scenario.ticks ?? 90;
  $("fArrivals").value = scenario.arrivals_rps ?? 80;
  $("fSeed").value = scenario.seed ?? 42;
  $("fPayCap").value = scenario.capacities?.payments_rps ?? 100;
  $("fFaultStart").value = scenario.fault?.start_tick ?? 20;
  $("fFaultEnd").value = scenario.fault?.end_tick ?? 50;
  $("fFaultCap").value = scenario.fault?.capacity_rps ?? 30;
  $("fMaxRetries").value = scenario.retry?.max_retries ?? 2;
  $("scenarioJson").value = JSON.stringify(scenario, null, 2);
  $("scenarioPanel").classList.remove("hidden");
}

function renderMetrics(metrics) {
  const items = [
    ["Failed checkouts", metrics.unique_failed_checkouts],
    ["Successful", metrics.unique_successful_checkouts],
    ["Retry amp.", metrics.retry_amplification, 3],
    ["Peak backlog", metrics.peak_backlog],
    ["Total retries", metrics.total_retries],
    ["Simulated outage loss $", metrics.revenue_at_risk_usd, 0],
  ];
  $("metrics").innerHTML = items
    .map(
      ([k, v, d = 0]) =>
        `<div class="metric"><div class="k">${k}</div><div class="v">${fmt(v, d)}</div></div>`
    )
    .join("");
}

function money(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${Number(n).toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
  })}`;
}

function selectedPlan() {
  const id = $("costPlan")?.value;
  if (!id || !state.catalog?.types) return null;
  return state.catalog.types.find((t) => t.id === id) || null;
}

// Outage loss from the simulator, shown beside the infra estimate. Different units on purpose:
// infra is per month, outage loss is for this one simulated incident. No ratio is computed.
function updateOutageLoss() {
  const box = $("costOutageLoss");
  if (!box) return;
  const before = state.audit?.metrics?.revenue_at_risk_usd;
  const after = state.verify?.mitigated?.metrics?.revenue_at_risk_usd;
  const secs = state.audit?.series?.length;
  const span = secs ? `this ${secs} s incident` : "this incident";
  if (before == null) {
    box.textContent = "—";
    $("costOutageLabel").textContent = `Simulated outage loss, ${span} (run the audit)`;
  } else if (after == null) {
    box.textContent = money(before);
    $("costOutageLabel").textContent = `Simulated outage loss, ${span}`;
  } else {
    box.textContent = `${money(before)} → ${money(after)}`;
    $("costOutageLabel").textContent = `Simulated outage loss, ${span}, before → after mitigation`;
  }
}

function updateCostEstimate() {
  updateOutageLoss();
  const plan = selectedPlan();
  const count = Math.max(1, Number($("costCount")?.value) || 1);
  const note = $("costNote");
  if (!plan || plan.monthly == null) {
    if ($("costPlanMonthly")) $("costPlanMonthly").textContent = "—";
    if ($("costArchMonthly")) $("costArchMonthly").textContent = "—";
    if (note) {
      note.textContent = state.catalog?.source === "unavailable"
        ? "Catalog unavailable — demo still works; prices not invented."
        : "Pick a plan with a published monthly price.";
    }
    return;
  }
  $("costPlanMonthly").textContent = money(plan.monthly);
  $("costArchMonthly").textContent = money(plan.monthly * count);
  const regionTag = plan.price_region === "global"
    ? "global published price (no us-sea region_prices)"
    : `region ${plan.price_region}`;
  if (note) note.textContent = `${plan.label} · ${regionTag} · × ${count} instances`;
}

async function loadComputeCatalog() {
  const src = $("costSource");
  const planSel = $("costPlan");
  const countEl = $("costCount");
  if (!planSel) return;
  try {
    const res = await fetch("/api/catalog/compute?region=us-sea");
    const data = await res.json();
    state.catalog = data;
    const live = data.source === "live" && (data.types || []).length > 0;
    if (src) {
      src.textContent = data.source || "unavailable";
      src.className = `cost-src ${live ? "live" : "unavailable"}`;
    }
    planSel.innerHTML = "";
    if (!live) {
      planSel.innerHTML = `<option value="">Catalog unavailable</option>`;
      planSel.disabled = true;
      if (countEl) countEl.disabled = true;
      updateCostEstimate();
      return;
    }
    const preferred = ["g6-standard-2", "g6-standard-4", "g6-standard-6", "g6-nanode-1"];
    const types = [...data.types].sort((a, b) => {
      const ai = preferred.indexOf(a.id);
      const bi = preferred.indexOf(b.id);
      if (ai === -1 && bi === -1) return (a.monthly ?? 0) - (b.monthly ?? 0);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    for (const t of types) {
      if (t.monthly == null) continue;
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.label} — $${t.monthly}/mo`;
      planSel.appendChild(opt);
    }
    const defaultId = types.find((t) => t.id === "g6-standard-2")?.id || types[0]?.id;
    if (defaultId) planSel.value = defaultId;
    planSel.disabled = false;
    if (countEl) countEl.disabled = false;
    updateCostEstimate();
  } catch (e) {
    state.catalog = { source: "unavailable", types: [], message: String(e) };
    if (src) {
      src.textContent = "unavailable";
      src.className = "cost-src unavailable";
    }
    planSel.innerHTML = `<option value="">Catalog unavailable</option>`;
    planSel.disabled = true;
    if (countEl) countEl.disabled = true;
    updateCostEstimate();
  }
}

async function startLab() {
  const btn = $("btnStartLab");
  if (btn) btn.disabled = true;
  setStatus($("startStatus"), "Loading Lab 01 demo scenario…");
  try {
    await loadDemoScenario();
    $("landing")?.classList.add("hidden");
    $("labBench")?.classList.remove("hidden");
    state.labOpen = true;
    setStatus($("startStatus"), "", "ok");
    if (window.Instrument?.resize) Instrument.resize();
  } catch (e) {
    setStatus($("startStatus"), e.message, "err");
    if (btn) btn.disabled = false;
  }
}

function drawChart(series) {
  // Shows the trace selected in the instrument (before / after mitigation), with a playhead at the current second.
  if (window.Instrument && Instrument.chartSeries()) series = Instrument.chartSeries();
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = 220;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { l: 40, r: 12, t: 14, b: 24 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;
  const C = { grid: "#cfd1d6", dim: "#4f545d", paper: "#aeb2b9", lime: "#3fa66b", amber: "#dc972a", red: "#e0574a", ink: "#3b3f46" };
  const keys = [
    { key: "payments_capacity", color: C.paper, dash: [4, 4], width: 1.5 },
    { key: "attempts", color: C.lime, width: 2 },
    { key: "backlog", color: C.amber, width: 2 },
    { key: "customer_failures", color: C.red, width: 2.5 },
  ];

  let maxY = 1;
  for (const row of series) {
    for (const { key } of keys) maxY = Math.max(maxY, Number(row[key]) || 0);
  }
  const n = Math.max(series.length - 1, 1);
  const xAt = (i) => pad.l + (w * i) / n;
  const yAt = (v) => pad.t + h - (h * (Number(v) || 0)) / maxY;

  // fault window first, hatched, so the lines sit on top of it
  if (state.scenario?.fault) {
    const x0 = xAt(Math.min(state.scenario.fault.start_tick ?? 0, n));
    const x1 = xAt(Math.min(state.scenario.fault.end_tick ?? 0, n));
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, pad.t, Math.max(x1 - x0, 1), h);
    ctx.clip();
    ctx.strokeStyle = "rgba(224, 87, 74, 0.16)";
    ctx.lineWidth = 2;
    for (let x = x0 - h; x < x1 + h; x += 8) {
      ctx.beginPath();
      ctx.moveTo(x, pad.t + h);
      ctx.lineTo(x + h, pad.t);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
  }
  ctx.fillStyle = C.dim;
  ctx.font = "600 13px Manrope, sans-serif";
  ctx.fillText(String(Math.round(maxY)), 4, pad.t + 8);
  ctx.fillText("0", 4, pad.t + h);

  for (const { key, color, dash, width } of keys) {
    ctx.beginPath();
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    series.forEach((row, i) => {
      const x = xAt(i);
      const y = yAt(row[key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);

  if (window.Instrument) {
    const x = xAt(Math.min(Instrument.t(), n));
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + h);
    ctx.stroke();
  }
}

function renderRecommend(rec) {
  $("recPanel").classList.remove("hidden");
  $("recId").textContent = rec.mitigation_id;
  $("recRationale").textContent = rec.rationale || "";
  const flag = $("recFlag");
  flag.textContent = `inference_used=${rec.inference_used}`;
  flag.className = "flag " + (rec.inference_used ? "true" : "false");
  if (rec.inference_error) {
    $("recError").textContent = rec.inference_error;
    $("recError").classList.remove("hidden");
  } else {
    $("recError").classList.add("hidden");
  }

  // The API returns allowlist entries as {id, label, description}; older fixtures may send plain strings.
  const allow = (rec.allowlist || [
    "bounded_exponential_backoff_seeded_jitter",
    "retry_cap_reduction",
  ]).map((a) => (typeof a === "string" ? { id: a, label: a } : a));
  const sel = $("mitigationPick");
  sel.replaceChildren(
    ...allow.map((a) => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.label && a.label !== a.id ? `${a.label} (${a.id})` : a.id;
      if (a.description) opt.title = a.description;
      opt.selected = a.id === rec.mitigation_id;
      return opt;
    })
  );
}

function renderVerify(v) {
  $("verifyPanel").classList.remove("hidden");
  const overall = $("overall");
  overall.textContent = v.overall_improved
    ? "Verified: the fix improved the outcome"
    : "Verified: the fix did not improve the outcome";
  overall.className = "flag stamp " + (v.overall_improved ? "true" : "false");

  const rows = (v.deltas || [])
    .map((d) => {
      const cls =
        d.improved === true ? "improved" : d.improved === false ? "worse" : "";
      return `<tr>
        <td>${d.metric}</td>
        <td class="num">${fmt(d.baseline, 2)}</td>
        <td class="num">${fmt(d.mitigated, 2)}</td>
        <td class="num ${cls}">${fmt(d.delta, 2)}</td>
        <td class="${cls}">${d.improved == null ? "—" : d.improved ? "yes" : "no"}</td>
      </tr>`;
    })
    .join("");
  $("deltaBody").innerHTML = rows;
  $("notes").replaceChildren(
    ...(v.notes || []).map((n) => {
      const li = document.createElement("li");
      li.textContent = n;
      return li;
    })
  );
}

async function onInterpret() {
  const btn = $("btnInterpret");
  btn.disabled = true;
  setStatus($("interpretStatus"), "Interpreting…");
  try {
    const data = await api("/api/interpret", {
      text: $("incident").value.trim(),
      use_fixture: $("useFixture").checked,
    });
    state.interpret = data;
    resetCrossCheck();
    fillScenarioUI(data.scenario);
    window.Instrument && Instrument.onInterpret(data);
    inferenceBadge(data.inference_used, data.inference_error);
    const bits = [
      `validation=${data.validation_status}`,
      `inference_used=${data.inference_used}`,
    ];
    if (data.missing_fields?.length) {
      bits.push(`missing: ${data.missing_fields.join(", ")}`);
    }
    if (data.inference_error) bits.push(data.inference_error);
    setStatus(
      $("interpretStatus"),
      bits.join(" · "),
      data.inference_used ? "ok" : "err"
    );
    setStep(2);
  } catch (e) {
    setStatus($("interpretStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onAudit() {
  const btn = $("btnAudit");
  btn.disabled = true;
  setStatus($("auditStatus"), "Running audit…");
  try {
    const scenario = scenarioFromFields();
    // keep JSON + state in sync with form
    fillScenarioUI(scenario);
    const data = await api("/api/audit", { scenario });
    state.audit = data.result;
    $("auditPanel").classList.remove("hidden");
    renderMetrics(data.result.metrics);
    drawChart(data.result.series || []);
    window.Instrument && Instrument.onAudit(data.result, scenario);
    updateOutageLoss();
    resetChartRead();
    setStatus(
      $("auditStatus"),
      `seed=${data.result.seed} · series=${(data.result.series || []).length} ticks`,
      "ok"
    );
    setStep(3);
  } catch (e) {
    setStatus($("auditStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function visualNote(read) {
  return read?.used ? [read.text, read.suggestion && `Suggestion: ${read.suggestion}`].filter(Boolean).join("\n") : null;
}

function renderVisualInput(rec, read) {
  const dd = $("recVisual");
  if (!dd) return;
  if (rec?.visual_note_used) {
    dd.textContent = `Gemma read the chart and Qwen got that reading as a hint (metrics still win): "${(rec.visual_note || "").slice(0, 220)}${(rec.visual_note || "").length > 220 ? "…" : ""}"`;
  } else if ($("useFixture").checked && !state.readonly) {
    dd.textContent = "Not used: fixture mode skips both models.";
  } else if (read && !read.used) {
    dd.textContent = `Gemma was not available (${read.error}), so Qwen used the metrics only.`;
  } else {
    dd.textContent = "Not used: Qwen chose from the metrics only.";
  }
}

async function onRecommend() {
  const btn = $("btnRecommend");
  btn.disabled = true;
  setStatus($("recStatus"), "Recommending…");
  try {
    if (!state.audit) throw new Error("Run audit first.");
    const scenario = scenarioFromFields();
    fillScenarioUI(scenario);
    const useFixture = $("useFixture").checked;
    // Pipeline: (1) Gemma reads the before-mitigation chart, (2) Qwen chooses with that reading as a hint.
    let read = null;
    if (!useFixture) {
      setStatus($("recStatus"), "Step 1 of 2: Gemma is reading the chart…");
      try {
        read = state.chartRead?.trace === "before" ? state.chartRead : await readChart();
      } catch (e) {
        read = { used: false, error: e.message };
      }
      setStatus($("recStatus"), "Step 2 of 2: Qwen is choosing a mitigation…");
    }
    const body = { scenario, audit: state.audit, use_fixture: useFixture, visual_note: visualNote(read) };
    let data;
    try {
      data = await api("/api/recommend/informed", body);
    } catch (e) {
      if (!/^404/.test(e.message)) throw e;
      data = await api("/api/recommend", { scenario, audit: state.audit, use_fixture: useFixture }); // server without serve.py
    }
    state.recommend = data;
    renderRecommend(data);
    renderVisualInput(data, read);
    window.Instrument && Instrument.onRecommend(data, state.audit);
    inferenceBadge(data.inference_used, data.inference_error);
    setStatus(
      $("recStatus"),
      `mitigation=${data.mitigation_id} · inference_used=${data.inference_used}`,
      data.inference_used ? "ok" : "err"
    );
    setStep(4);
  } catch (e) {
    setStatus($("recStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onVerify() {
  const btn = $("btnVerify");
  btn.disabled = true;
  setStatus($("verifyStatus"), "Verifying…");
  try {
    const scenario = scenarioFromFields();
    fillScenarioUI(scenario);
    const mitigation_id = $("mitigationPick").value;
    if (!mitigation_id) throw new Error("Pick a mitigation first.");
    const body = { scenario, mitigation_id };
    if (state.audit) body.baseline = state.audit;
    const data = await api("/api/verify", body);
    state.verify = data;
    resetShare();
    renderVerify(data);
    window.Instrument && Instrument.onVerify(data);
    updateOutageLoss();
    setStatus(
      $("verifyStatus"),
      data.overall_improved ? "Mitigation improved primary metrics." : "No overall improvement.",
      data.overall_improved ? "ok" : "err"
    );
    setStep(5);
  } catch (e) {
    setStatus($("verifyStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// "Run resilience audit" works from a cold start: interpret the incident first if there is no scenario yet.
async function runResilienceAudit() {
  if (!state.scenario) {
    await onInterpret();
    if (!state.scenario) return;
  }
  await onAudit();
}

/* ---------- Advisory cross-check: Qwen's numbers vs the text vs Gemma (never changes the scenario) ---------- */

function resetCrossCheck() {
  $("btnCrossCheck").disabled = !state.interpret;
  setStatus($("xcheckStatus"), "");
  $("xcheckTable").classList.add("hidden");
  $("xcheckRaw").classList.add("hidden");
}

async function onCrossCheck() {
  const btn = $("btnCrossCheck");
  btn.disabled = true;
  setStatus($("xcheckStatus"), "Checking…");
  try {
    if (!state.interpret || !state.scenario) throw new Error("Interpret an incident first.");
    const r = await api("/api/interpret/check", {
      text: state.interpret.source_text || $("incident").value,
      scenario: scenarioFromFields(), // what the audit will actually use, including manual edits
      missing_fields: state.interpret.missing_fields || [],
    });
    const cell = (text, cls) => { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; return td; };
    const GROUND = { found: ["in text", "ok"], not_found: ["not in text", "bad"], default: ["default", "warn"], "n/a": ["—", ""] };
    $("xcheckBody").replaceChildren(...r.fields.map((f) => {
      const tr = document.createElement("tr");
      const [gt, gc] = GROUND[f.grounding] || ["—", ""];
      const gemma = !r.gemma.used ? "—" : f.gemma == null ? "not stated" : String(f.gemma);
      tr.append(cell(f.label), cell(f.qwen == null ? "—" : String(f.qwen)), cell(gt, gc),
                cell(gemma + (f.agree === false ? "  (differs)" : ""), f.agree === false ? "bad" : f.agree ? "ok" : ""));
      return tr;
    }));
    $("xcheckTable").classList.remove("hidden");
    const g = r.grounding, a = r.agreement;
    const textPart = `${g.found}/${g.checked} extracted numbers appear in the text`;
    if (r.gemma.used) {
      setStatus($("xcheckStatus"), `Gemma (${r.gemma.model}) agrees on ${a.agree}/${a.compared} fields · ${textPart}. Advisory only.`,
        a.agree === a.compared && g.found === g.checked ? "ok" : "warn");
      $("xcheckRawPre").textContent = r.gemma.raw_response || "";
      $("xcheckRaw").classList.remove("hidden");
    } else {
      setStatus($("xcheckStatus"), `Gemma was not called: ${r.gemma.error} · ${textPart}.`, "warn");
    }
  } catch (e) {
    setStatus($("xcheckStatus"), e.message, "err");
  } finally {
    btn.disabled = !state.interpret;
  }
}

/* ---------- Gemma (vision) reads the simulation chart: advisory reading + one suggestion ---------- */

function chartPng() {
  // The chart canvas is transparent; paint the page background under it so the model sees what people see.
  const src = $("chart");
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#e4e5e9";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  return out.toDataURL("image/png");
}

function resetChartRead() {
  state.chartRead = null;
  $("chartReadOut").classList.add("hidden");
  setStatus($("chartReadStatus"), "");
}

// Gemma reads the chart currently on screen. Stores the result (with which trace it saw) for the Qwen step.
async function readChart() {
  const sc = state.audit?.scenario || state.scenario;
  if (!state.audit || !sc) throw new Error("Run the audit first.");
  const trace = window.Instrument && Instrument.trace() === "mitigated" ? "after" : "before";
  $("chartReadOut").classList.add("hidden");
  setStatus($("chartReadStatus"), "Gemma is reading the chart…");
  const r = await api("/api/chart/review", {
    image: chartPng(), fault_start: sc.fault.start_tick, fault_end: sc.fault.end_tick, trace,
  });
  state.chartRead = { ...r, trace };
  if (!r.used) {
    setStatus($("chartReadStatus"), `Gemma was not called: ${r.error}`, "warn");
    return state.chartRead;
  }
  $("chartReadText").textContent = r.text || "";
  $("chartReadSuggest").textContent = r.suggestion ? `Suggestion: ${r.suggestion}` : "";
  $("chartReadSuggest").classList.toggle("hidden", !r.suggestion);
  $("chartReadOut").classList.remove("hidden");
  setStatus($("chartReadStatus"),
    `Read by ${r.model} (vision)${r.latency_ms ? ` in ${(r.latency_ms / 1000).toFixed(1)} s` : ""}, ${trace} mitigation. Advisory only.`, "ok");
  return state.chartRead;
}

async function onChartRead() {
  const btn = $("btnChartRead");
  btn.disabled = true;
  try {
    await readChart();
  } catch (e) {
    setStatus($("chartReadStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function loadDemoScenario() {
  // Leave fixtures OFF so Ask Qwen / Gemma stay live after Start Lab (tick the box for offline rehearsal)
  $("useFixture").checked = false;
  $("incident").value = DEFAULT_INCIDENT;
  await onInterpret();
}

function syncJsonFromFields() {
  try {
    const s = scenarioFromFields();
    $("scenarioJson").value = JSON.stringify(s, null, 2);
    state.scenario = s;
  } catch (e) {
    setStatus($("auditStatus"), e.message, "err");
  }
}

/* ---------- Saved audits (PostgreSQL via /api/runs) + read-only share links ---------- */

function resetShare() {
  $("shareLink").classList.add("hidden");
  $("shareLink").textContent = "";
  setStatus($("saveStatus"), "");
}

async function onSave() {
  const btn = $("btnSave");
  btn.disabled = true;
  setStatus($("saveStatus"), "Saving…");
  try {
    if (!state.verify) throw new Error("Verify a mitigation first.");
    const v = state.verify;
    const record = {
      schema_version: "1",
      scenario: v.baseline.scenario,
      interpretation: state.interpret,
      baseline: v.baseline,
      recommendation: state.recommend,
      mitigated: v.mitigated,
      verification: { deltas: v.deltas, overall_improved: v.overall_improved, notes: v.notes, mitigation_id: $("mitigationPick").value },
    };
    const data = await api("/api/runs", record);
    if (!data.id || !data.url) {
      throw new Error(data.message || "Saving is not enabled on this server. Start it with: uv run serve.py");
    }
    const url = location.origin + data.url;
    const link = $("shareLink");
    link.href = data.url;
    link.textContent = url;
    link.classList.remove("hidden");
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch { /* clipboard blocked */ }
    setStatus($("saveStatus"), `Saved audit ${data.id.slice(0, 8)}…` + (copied ? " · link copied" : ""), "ok");
  } catch (e) {
    setStatus($("saveStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function loadSavedAudit(id) {
  state.readonly = true;
  document.body.classList.add("readonly");
  const banner = $("savedBanner");
  banner.classList.remove("hidden");
  banner.textContent = "Loading saved audit…";
  let rec;
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    rec = await res.json();
    if (!res.ok || !rec.baseline) throw new Error(rec.detail || rec.message || `HTTP ${res.status}`);
  } catch (e) {
    banner.textContent = "Could not load this saved audit: " + e.message;
    return;
  }
  const when = rec.created_at ? new Date(rec.created_at).toLocaleString() : "";
  banner.textContent = `Saved audit · read-only · ${when} · seed ${rec.baseline.seed}. Same scenario + seed reproduces these numbers. `;
  const fresh = document.createElement("a");
  fresh.href = "/";
  fresh.textContent = "Start a new audit →";
  banner.append(fresh);

  if (rec.interpretation) {
    $("incident").value = rec.interpretation.source_text || "";
    state.interpret = rec.interpretation;
    inferenceBadge(rec.interpretation.inference_used, rec.interpretation.inference_error);
    setStatus($("interpretStatus"),
      `validation=${rec.interpretation.validation_status} · inference_used=${rec.interpretation.inference_used}`,
      rec.interpretation.inference_used ? "ok" : "err");
  }
  fillScenarioUI(rec.scenario);
  state.audit = rec.baseline;
  $("auditPanel").classList.remove("hidden");
  renderMetrics(rec.baseline.metrics);
  drawChart(rec.baseline.series || []);
  if (rec.recommendation) {
    state.recommend = rec.recommendation;
    renderRecommend({ ...rec.recommendation, mitigation_id: rec.verification.mitigation_id || rec.recommendation.mitigation_id });
  }
  state.verify = { baseline: rec.baseline, mitigated: rec.mitigated, ...rec.verification };
  renderVerify(state.verify);
  if (window.Instrument) {
    if (rec.interpretation) Instrument.onInterpret(rec.interpretation);
    Instrument.onAudit(rec.baseline, rec.scenario);
    if (state.recommend) Instrument.onRecommend(state.recommend, rec.baseline);
    if (state.recommend) renderVisualInput(state.recommend, null);
    Instrument.onVerify(state.verify);
    updateOutageLoss();
  }
  setStep(5);

  // Read-only: lock every input and hide the actions that would change the audit.
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    if (!el.hasAttribute("data-keep-enabled")) el.disabled = true; // timeline controls stay usable
  });
  ["btnInterpret", "btnLoadDemo", "btnSyncJson", "btnApplyJson", "btnAudit", "btnRecommend", "btnVerify", "shareBox", "xcheckBox"]
    .forEach((id) => $(id).classList.add("edit-only"));
  document.querySelector(".toggle").classList.add("edit-only");
}

function wire() {
  const saved = location.pathname.match(/^\/runs\/([0-9a-fA-F-]{36})\/?$/);
  if (saved) {
    $("landing")?.classList.add("hidden");
    $("labBench")?.classList.remove("hidden");
    state.labOpen = true;
    loadSavedAudit(saved[1]);
  } else {
    $("incident").value = DEFAULT_INCIDENT;
  }
  $("btnStartLab")?.addEventListener("click", startLab);
  $("costPlan")?.addEventListener("change", updateCostEstimate);
  $("costCount")?.addEventListener("input", updateCostEstimate);
  loadComputeCatalog();
  $("btnSave").addEventListener("click", onSave);
  $("btnCrossCheck").addEventListener("click", onCrossCheck);
  $("btnChartRead").addEventListener("click", onChartRead);
  $("btnInterpret").addEventListener("click", onInterpret);
  $("btnAudit").addEventListener("click", runResilienceAudit);
  $("btnRecommend").addEventListener("click", onRecommend);
  $("btnVerify").addEventListener("click", onVerify);
  $("btnLoadDemo").addEventListener("click", loadDemoScenario);
  $("btnSyncJson").addEventListener("click", syncJsonFromFields);
  $("btnApplyJson").addEventListener("click", () => {
    try {
      const s = JSON.parse($("scenarioJson").value);
      fillScenarioUI(s);
      setStatus($("auditStatus"), "Applied JSON → fields.", "ok");
    } catch (e) {
      setStatus($("auditStatus"), "Invalid JSON: " + e.message, "err");
    }
  });

  // health ping
  fetch("/api/health")
    .then((r) => r.json())
    .then((h) => {
      $("healthBadge").textContent = h.ok ? "api ok" : "api down";
      $("healthBadge").className = "badge " + (h.ok ? "on" : "warn");
      if (h.database === false) {
        $("btnSave").disabled = true;
        $("saveHint").textContent = "Saving unavailable: database not configured on this server";
      } else if (h.database === undefined) {
        $("saveHint").textContent = "Saving needs the server started with: uv run serve.py";
      }
    })
    .catch(() => {
      $("healthBadge").textContent = "api down";
      $("healthBadge").className = "badge warn";
    });

  window.addEventListener("resize", () => {
    if (state.audit?.series) drawChart(state.audit.series);
  });
}

document.addEventListener("DOMContentLoaded", wire);
