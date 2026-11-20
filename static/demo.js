/* CascadeIQ Lab 01 — The Retry Storm
   Scenario-first guided flow over existing /api/* endpoints. */

const DEFAULT_INCIDENT = `API Gateway routes checkout traffic to Orders, which calls Payments.
During a peak window Payments capacity drops hard and checkouts start failing.
Arrivals are about 80 requests per second. Payments normally handles 100/s
but falls to roughly 30/s from second 20 through 50. Clients retry immediately
up to two times.`;

const DEFAULT_ALLOWLIST = [
  "bounded_exponential_backoff_seeded_jitter",
  "retry_cap_reduction",
];

const state = {
  scenario: null,
  audit: null,
  recommend: null,
  verify: null,
  prediction: null,
  step: 1,
  maxReached: 1,
  labOpen: false,
};

const $ = (id) => document.getElementById(id);

function setStatus(el, msg, kind = "") {
  if (!el) return;
  el.textContent = msg || "";
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function fixtureMode() {
  return Boolean($("useFixture")?.checked || $("useFixtureAdv")?.checked);
}

function setStep(n, { unlock = true } = {}) {
  state.step = n;
  if (unlock) state.maxReached = Math.max(state.maxReached, n);
  document.querySelectorAll(".steps .step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle("active", s === n);
    el.classList.toggle("done", s < n && s <= state.maxReached);
    el.disabled = s > state.maxReached;
  });
  document.querySelectorAll(".step-panel").forEach((panel) => {
    const p = Number(panel.dataset.panel);
    panel.classList.toggle("hidden", p !== n);
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
  if (!state.scenario) throw new Error("Start the lab (or interpret) first.");
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
}

function renderMetrics(metrics) {
  const items = [
    ["Failed checkouts", metrics.unique_failed_checkouts],
    ["Successful", metrics.unique_successful_checkouts],
    ["Retry amp.", metrics.retry_amplification, 3],
    ["Peak backlog", metrics.peak_backlog],
    ["Total retries", metrics.total_retries],
    ["Rev at risk $", metrics.revenue_at_risk_usd, 0],
  ];
  $("metrics").innerHTML = items
    .map(
      ([k, v, d = 0]) =>
        `<div class="metric"><div class="k">${k}</div><div class="v">${fmt(v, d)}</div></div>`
    )
    .join("");
}

function drawChart(series) {
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = 220;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { l: 36, r: 12, t: 12, b: 24 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  const keys = [
    { key: "backlog", color: "#6ea8fe" },
    { key: "customer_failures", color: "#f07178" },
    { key: "payments_capacity", color: "#f0b429" },
    { key: "attempts", color: "#3dd6c6" },
  ];

  let maxY = 1;
  for (const row of series) {
    for (const { key } of keys) maxY = Math.max(maxY, Number(row[key]) || 0);
  }

  ctx.strokeStyle = "#243041";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#8b9bb0";
  ctx.font = "11px IBM Plex Mono, monospace";
  ctx.fillText(String(Math.round(maxY)), 4, pad.t + 8);
  ctx.fillText("0", 4, pad.t + h);

  const n = Math.max(series.length - 1, 1);
  const xAt = (i) => pad.l + (w * i) / n;
  const yAt = (v) => pad.t + h - (h * (Number(v) || 0)) / maxY;

  for (const { key, color } of keys) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    series.forEach((row, i) => {
      const x = xAt(i);
      const y = yAt(row[key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  if (state.scenario?.fault) {
    const a = state.scenario.fault.start_tick ?? 0;
    const b = state.scenario.fault.end_tick ?? 0;
    const x0 = xAt(Math.min(a, n));
    const x1 = xAt(Math.min(b, n));
    ctx.fillStyle = "rgba(240, 180, 41, 0.08)";
    ctx.fillRect(x0, pad.t, Math.max(x1 - x0, 1), h);
  }
}

function fillAllowlist(ids, selected) {
  const allow = ids?.length ? ids : DEFAULT_ALLOWLIST;
  const sel = $("mitigationPick");
  const current = selected || sel.value;
  sel.innerHTML =
    `<option value="">— pick or recommend —</option>` +
    allow
      .map(
        (id) =>
          `<option value="${id}" ${id === current ? "selected" : ""}>${id}</option>`
      )
      .join("");
  $("btnToVerify").disabled = !sel.value;
}

function renderRecommend(rec) {
  $("recBox").classList.remove("hidden");
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
  fillAllowlist(rec.allowlist, rec.mitigation_id);
  updateExplainPanel();
}

function renderVerify(v) {
  $("overall").classList.remove("hidden");
  $("compareWrap").classList.remove("hidden");
  $("verifyNext").classList.remove("hidden");

  const overall = $("overall");
  overall.textContent = v.overall_improved
    ? "Overall improved"
    : "Overall not improved";
  overall.className = "flag " + (v.overall_improved ? "true" : "false");

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
  $("notes").innerHTML = (v.notes || []).map((n) => `<li>${n}</li>`).join("");

  if (state.prediction) {
    const recall = $("predictRecall");
    recall.classList.remove("hidden");
    recall.innerHTML =
      `<strong>Your prediction</strong> · failed checkouts: ${state.prediction.failed} · ` +
      `retry amp: ${state.prediction.retry}` +
      (state.prediction.note
        ? `<br/>Note: ${escapeHtml(state.prediction.note)}`
        : "");
  }
  updateExplainPanel();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateExplainPanel() {
  if (state.recommend) {
    $("explainId").textContent = state.recommend.mitigation_id;
    $("explainRationale").textContent =
      state.recommend.rationale || "(no rationale returned)";
    const flag = $("explainFlag");
    flag.textContent = `inference_used=${state.recommend.inference_used}`;
    flag.className =
      "flag " + (state.recommend.inference_used ? "true" : "false");
  } else {
    $("explainId").textContent = $("mitigationPick").value || "—";
    $("explainRationale").textContent =
      "No recommend call yet. Use Refresh to ground a Qwen rationale in the audit metrics.";
    $("explainFlag").textContent = "inference_used=—";
    $("explainFlag").className = "flag";
  }

  if (state.verify?.deltas?.length) {
    const lines = state.verify.deltas.map((d) => {
      const arrow =
        d.improved === true ? "↓ improved" : d.improved === false ? "↑ worse" : "—";
      return `${d.metric}: baseline ${fmt(d.baseline, 2)} → mitigated ${fmt(
        d.mitigated,
        2
      )} (Δ ${fmt(d.delta, 2)}) ${arrow}`;
    });
    if (state.verify.overall_improved != null) {
      lines.unshift(
        `overall_improved=${state.verify.overall_improved}`
      );
    }
    $("explainDeltaSummary").textContent = lines.join("\n");
    $("explainDeltaSummary").style.whiteSpace = "pre-wrap";
    $("explainDeltaSummary").style.fontFamily = "var(--mono)";
    $("explainDeltaSummary").style.fontSize = "0.78rem";
  } else {
    $("explainDeltaSummary").textContent = "Run verify first.";
    $("explainDeltaSummary").style.whiteSpace = "";
    $("explainDeltaSummary").style.fontFamily = "";
  }
}

async function loadDemoScenario({ forStart = false } = {}) {
  // Same path as prior "Load demo + interpret" — fixture interpret → demo scenario
  $("useFixture").checked = true;
  $("useFixtureAdv").checked = true;
  $("incident").value = DEFAULT_INCIDENT;
  const data = await api("/api/interpret", {
    text: DEFAULT_INCIDENT,
    use_fixture: true,
  });
  fillScenarioUI(data.scenario);
  inferenceBadge(data.inference_used, data.inference_error);
  return data;
}

async function startLab() {
  const btn = $("btnStartLab");
  btn.disabled = true;
  setStatus($("startStatus"), "Loading Lab 01 demo scenario…");
  try {
    const data = await loadDemoScenario({ forStart: true });
    state.labOpen = true;
    state.audit = null;
    state.recommend = null;
    state.verify = null;
    state.prediction = null;
    state.maxReached = 1;
    $("landing").classList.add("hidden");
    $("labWorkspace").classList.remove("hidden");
    $("chartWrap").classList.add("hidden");
    $("observeNext").classList.add("hidden");
    $("metrics").innerHTML = "";
    $("recBox").classList.add("hidden");
    fillAllowlist(DEFAULT_ALLOWLIST, "");
    setStep(1);
    setStatus(
      $("startStatus"),
      "",
      ""
    );
    setStatus(
      $("auditStatus"),
      `Demo scenario ready · validation=${data.validation_status} · inference_used=${data.inference_used}`,
      data.inference_used ? "ok" : "warn"
    );
  } catch (e) {
    setStatus($("startStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function backHome() {
  $("labWorkspace").classList.add("hidden");
  $("landing").classList.remove("hidden");
  state.labOpen = false;
}

async function onInterpret() {
  const btn = $("btnInterpret");
  btn.disabled = true;
  setStatus($("interpretStatus"), "Interpreting…");
  try {
    const useFix = $("useFixtureAdv").checked;
    $("useFixture").checked = useFix;
    const data = await api("/api/interpret", {
      text: $("incident").value.trim(),
      use_fixture: useFix,
    });
    fillScenarioUI(data.scenario);
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
  } catch (e) {
    setStatus($("interpretStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onAudit() {
  const btn = $("btnAudit");
  btn.disabled = true;
  setStatus($("auditStatus"), "Running baseline audit…");
  try {
    const scenario = scenarioFromFields();
    fillScenarioUI(scenario);
    const data = await api("/api/audit", { scenario });
    state.audit = data.result;
    renderMetrics(data.result.metrics);
    $("chartWrap").classList.remove("hidden");
    drawChart(data.result.series || []);
    $("observeNext").classList.remove("hidden");
    setStatus(
      $("auditStatus"),
      `seed=${data.result.seed} · series=${(data.result.series || []).length} ticks · failed=${data.result.metrics?.unique_failed_checkouts}`,
      "ok"
    );
    state.maxReached = Math.max(state.maxReached, 2);
    document.querySelectorAll(".steps .step").forEach((el) => {
      const s = Number(el.dataset.step);
      el.disabled = s > state.maxReached;
    });
  } catch (e) {
    setStatus($("auditStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function onSavePredict() {
  const failed = document.querySelector('input[name="predFail"]:checked')?.value;
  const retry = document.querySelector('input[name="predRetry"]:checked')?.value;
  if (!failed || !retry) {
    setStatus($("predictStatus"), "Pick a direction for both predictions.", "err");
    return;
  }
  state.prediction = {
    failed,
    retry,
    note: $("predNote").value.trim(),
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(
      "cascadeiq_lab01_prediction",
      JSON.stringify(state.prediction)
    );
  } catch {
    /* local-only; ignore quota */
  }
  $("btnToMitigate").disabled = false;
  setStatus(
    $("predictStatus"),
    `Prediction saved locally · failures ${failed} · retry amp ${retry}`,
    "ok"
  );
  state.maxReached = Math.max(state.maxReached, 3);
  document.querySelectorAll(".steps .step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.disabled = s > state.maxReached;
  });
}

async function onRecommend() {
  const btn = $("btnRecommend");
  btn.disabled = true;
  setStatus($("recStatus"), "Recommending…");
  try {
    if (!state.audit) throw new Error("Run baseline audit first.");
    const scenario = scenarioFromFields();
    fillScenarioUI(scenario);
    const data = await api("/api/recommend", {
      scenario,
      audit: state.audit,
      use_fixture: fixtureMode(),
    });
    state.recommend = data;
    renderRecommend(data);
    inferenceBadge(data.inference_used, data.inference_error);
    setStatus(
      $("recStatus"),
      `mitigation=${data.mitigation_id} · inference_used=${data.inference_used}`,
      data.inference_used ? "ok" : "warn"
    );
    state.maxReached = Math.max(state.maxReached, 4);
    document.querySelectorAll(".steps .step").forEach((el) => {
      const s = Number(el.dataset.step);
      el.disabled = s > state.maxReached;
    });
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
    renderVerify(data);
    setStatus(
      $("verifyStatus"),
      data.overall_improved
        ? "Mitigation improved primary metrics."
        : "No overall improvement.",
      data.overall_improved ? "ok" : "err"
    );
    state.maxReached = Math.max(state.maxReached, 5);
    document.querySelectorAll(".steps .step").forEach((el) => {
      const s = Number(el.dataset.step);
      el.disabled = s > state.maxReached;
    });
  } catch (e) {
    setStatus($("verifyStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onRefreshExplain() {
  const btn = $("btnRefreshExplain");
  btn.disabled = true;
  setStatus($("explainStatus"), "Refreshing recommend rationale…");
  try {
    if (!state.audit) throw new Error("Run baseline audit first.");
    const scenario = scenarioFromFields();
    const data = await api("/api/recommend", {
      scenario,
      audit: state.audit,
      use_fixture: fixtureMode(),
    });
    state.recommend = data;
    updateExplainPanel();
    inferenceBadge(data.inference_used, data.inference_error);
    setStatus(
      $("explainStatus"),
      `rationale refreshed · inference_used=${data.inference_used}`,
      data.inference_used ? "ok" : "warn"
    );
  } catch (e) {
    setStatus($("explainStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function onSaveRun() {
  const btn = $("btnSaveRun");
  btn.disabled = true;
  setStatus($("shareStatus"), "Calling POST /api/runs…");
  $("shareOut").classList.add("hidden");
  try {
    const payload = {
      lab: "lab01_retry_storm",
      scenario: state.scenario,
      audit: state.audit,
      recommend: state.recommend,
      verify: state.verify,
      prediction: state.prediction,
      mitigation_id: $("mitigationPick").value || null,
    };
    const data = await api("/api/runs", payload);
    $("shareOut").textContent = JSON.stringify(data, null, 2);
    $("shareOut").classList.remove("hidden");
    const stub =
      data.status === "not_implemented" ||
      /not.?implemented|danny|postgres|stretch/i.test(data.message || "");
    if (stub) {
      setStatus(
        $("shareStatus"),
        "Coming soon — Danny’s Postgres /api/runs persistence. Stub responded; nothing was saved.",
        "warn"
      );
    } else {
      setStatus(
        $("shareStatus"),
        `Saved · status=${data.status || "ok"}`,
        "ok"
      );
    }
  } catch (e) {
    setStatus($("shareStatus"), e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function syncJsonFromFields() {
  try {
    const s = scenarioFromFields();
    $("scenarioJson").value = JSON.stringify(s, null, 2);
    state.scenario = s;
  } catch (e) {
    setStatus($("interpretStatus"), e.message, "err");
  }
}

function wire() {
  $("incident").value = DEFAULT_INCIDENT;
  fillAllowlist(DEFAULT_ALLOWLIST, "");

  $("btnStartLab").addEventListener("click", startLab);
  $("btnBackHome").addEventListener("click", backHome);

  document.querySelectorAll(".steps .step").forEach((el) => {
    el.addEventListener("click", () => {
      const s = Number(el.dataset.step);
      if (s <= state.maxReached) setStep(s, { unlock: false });
    });
  });

  $("btnAudit").addEventListener("click", onAudit);
  $("btnToPredict").addEventListener("click", () => setStep(2));
  $("btnSavePredict").addEventListener("click", onSavePredict);
  $("btnToMitigate").addEventListener("click", () => setStep(3));
  $("btnRecommend").addEventListener("click", onRecommend);
  $("mitigationPick").addEventListener("change", () => {
    $("btnToVerify").disabled = !$("mitigationPick").value;
    if ($("mitigationPick").value) {
      state.maxReached = Math.max(state.maxReached, 4);
      document.querySelectorAll(".steps .step").forEach((el) => {
        const step = Number(el.dataset.step);
        el.disabled = step > state.maxReached;
      });
    }
  });
  $("btnToVerify").addEventListener("click", () => setStep(4));
  $("btnVerify").addEventListener("click", onVerify);
  $("btnToExplain").addEventListener("click", () => {
    updateExplainPanel();
    setStep(5);
  });
  $("btnRefreshExplain").addEventListener("click", onRefreshExplain);
  $("btnToShare").addEventListener("click", () => {
    state.maxReached = Math.max(state.maxReached, 6);
    setStep(6);
  });
  $("btnSaveRun").addEventListener("click", onSaveRun);

  $("btnInterpret").addEventListener("click", onInterpret);
  $("btnLoadDemo").addEventListener("click", async () => {
    try {
      setStatus($("interpretStatus"), "Reloading demo…");
      const data = await loadDemoScenario();
      setStatus(
        $("interpretStatus"),
        `Demo reloaded · inference_used=${data.inference_used}`,
        "warn"
      );
    } catch (e) {
      setStatus($("interpretStatus"), e.message, "err");
    }
  });
  $("btnSyncJson").addEventListener("click", syncJsonFromFields);
  $("btnApplyJson").addEventListener("click", () => {
    try {
      const s = JSON.parse($("scenarioJson").value);
      fillScenarioUI(s);
      setStatus($("interpretStatus"), "Applied JSON → fields.", "ok");
    } catch (e) {
      setStatus($("interpretStatus"), "Invalid JSON: " + e.message, "err");
    }
  });

  // Keep fixture toggles in sync
  $("useFixture").addEventListener("change", () => {
    $("useFixtureAdv").checked = $("useFixture").checked;
  });
  $("useFixtureAdv").addEventListener("change", () => {
    $("useFixture").checked = $("useFixtureAdv").checked;
  });

  fetch("/api/health")
    .then((r) => r.json())
    .then((h) => {
      $("healthBadge").textContent = h.ok ? "api ok" : "api down";
      $("healthBadge").className = "badge " + (h.ok ? "on" : "warn");
    })
    .catch(() => {
      $("healthBadge").textContent = "api down";
      $("healthBadge").className = "badge warn";
    });

  // Prefetch allowlist labels if available
  fetch("/api/mitigations")
    .then((r) => r.json())
    .then((list) => {
      if (Array.isArray(list) && list.length) {
        const ids = list.map((m) => m.id || m).filter(Boolean);
        if (ids.length) fillAllowlist(ids, $("mitigationPick").value);
      }
    })
    .catch(() => {});

  window.addEventListener("resize", () => {
    if (state.audit?.series) drawChart(state.audit.series);
  });
}

document.addEventListener("DOMContentLoaded", wire);
