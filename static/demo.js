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
  step: 1,
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

  // grid
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

  // fault band annotation from scenario if present
  if (state.scenario?.fault) {
    const a = state.scenario.fault.start_tick ?? 0;
    const b = state.scenario.fault.end_tick ?? 0;
    const x0 = xAt(Math.min(a, n));
    const x1 = xAt(Math.min(b, n));
    ctx.fillStyle = "rgba(240, 180, 41, 0.08)";
    ctx.fillRect(x0, pad.t, Math.max(x1 - x0, 1), h);
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

  const allow = rec.allowlist || [
    "bounded_exponential_backoff_seeded_jitter",
    "retry_cap_reduction",
  ];
  const sel = $("mitigationPick");
  sel.innerHTML = allow
    .map(
      (id) =>
        `<option value="${id}" ${id === rec.mitigation_id ? "selected" : ""}>${id}</option>`
    )
    .join("");
}

function renderVerify(v) {
  $("verifyPanel").classList.remove("hidden");
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

async function onRecommend() {
  const btn = $("btnRecommend");
  btn.disabled = true;
  setStatus($("recStatus"), "Recommending…");
  try {
    if (!state.audit) throw new Error("Run audit first.");
    const scenario = scenarioFromFields();
    fillScenarioUI(scenario);
    const data = await api("/api/recommend", {
      scenario,
      audit: state.audit,
      use_fixture: $("useFixture").checked,
    });
    state.recommend = data;
    renderRecommend(data);
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
    renderVerify(data);
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

async function loadDemoScenario() {
  // Fixture interpret path — offline-safe rehearsal defaults
  $("useFixture").checked = true;
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

function wire() {
  $("incident").value = DEFAULT_INCIDENT;
  $("btnInterpret").addEventListener("click", onInterpret);
  $("btnAudit").addEventListener("click", onAudit);
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
