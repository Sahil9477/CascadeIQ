/* CascadeIQ instrument layer (Danny).
   Draws the dependency-path hero, the propagation timeline, the outcome strip and the report extras
   from the same API responses demo.js already receives. No API calls change; demo.js calls the hooks below. */
"use strict";

const Instrument = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const S = { baseline: null, mitigated: null, deltas: null, scenario: null, trace: "baseline", t: 0, timer: null };
  const el = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmt = (n, d = 0) => (n == null || Number.isNaN(Number(n)) ? "—"
    : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const usd = (n) => (n == null ? "—" : "$" + fmt(n, 0));

  function sv(tag, attrs = {}, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function h(tag, attrs = {}, text) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  const ROLES = { gateway: "Edge ingress", orders: "Checkout service", payments: "Dependency" };

  function current() { return S.trace === "mitigated" && S.mitigated ? S.mitigated : S.baseline; }
  function ticks() { return (current() && current().series.length) || (S.scenario && S.scenario.ticks) || 90; }

  // Node status derived from the simulator's per-second series (UI-side; the engine reports the series only).
  function statusAt(run, id, t) {
    const p = run && run.series[t];
    if (!p) return "idle";
    const timeout = (run.scenario && run.scenario.timeout_ticks) || 5;
    if (id === "payments") {
      if (p.backlog > p.payments_capacity * timeout) return "failing";
      return p.backlog > 0 || p.attempts >= p.payments_capacity ? "degraded" : "ok";
    }
    if (id === "orders") return p.customer_failures > 0 ? "failing" : p.retries_scheduled > 0 || p.backlog > 0 ? "degraded" : "ok";
    return p.customer_failures >= p.arrivals * 0.5 ? "failing" : p.customer_failures > 0 ? "degraded" : "ok";
  }
  function failedSoFar(run, t) {
    let c = 0;
    for (let i = 0; i <= t && i < run.series.length; i++) c += run.series[i].customer_failures;
    return c;
  }

  function readouts(id, run, t) {
    const p = run && run.series[t];
    const v = (x, unit = "") => (p ? fmt(x) + unit : "—");
    if (id === "gateway") return [["arriving", v(p && p.arrivals, "/s")], ["failing now", v(p && p.customer_failures, "/s")], ["failed so far", p ? fmt(failedSoFar(run, t)) : "—"]];
    if (id === "orders") return [["attempts", v(p && p.attempts, "/s")], ["completed", v(p && p.completions, "/s")], ["retries queued", v(p && p.retries_scheduled, "/s")]];
    const limit = run && run.scenario ? run.scenario.queue_limit : null;
    return [["capacity", v(p && p.payments_capacity, "/s")], ["backlog", p ? fmt(p.backlog) + (limit ? ` / ${fmt(limit)}` : "") : "—"], ["served", v(p && p.completions, "/s")]];
  }

  function drawTopology() {
    const box = el("topo");
    if (!box) return;
    const run = current();
    const sc = (run && run.scenario) || S.scenario;
    const t = S.t;
    const topo = (sc && sc.topology) || [{ id: "gateway", label: "API Gateway" }, { id: "orders", label: "Orders" }, { id: "payments", label: "Payments" }];
    // Wide screens: left-to-right path. Phones: the same path stacked top-to-bottom so readouts stay legible.
    const vertical = box.clientWidth > 0 && box.clientWidth < 620;
    const nw = vertical ? 340 : 250, nh = 180, top = 58;
    const gap = vertical ? 64 : (1000 - nw * topo.length) / (topo.length - 1);
    const W = vertical ? 380 : 1000;
    const H = vertical ? top + topo.length * nh + (topo.length - 1) * gap + 8 : 300;
    const pos = topo.map((_, i) => (vertical ? { x: 20, y: top + i * (nh + gap) } : { x: i * (nw + gap), y: top }));
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet" });
    const defs = sv("defs");
    // Neumorphic raise: a dark shadow down-right and a light shadow up-left, merged under the shape.
    const soft = sv("filter", { id: "soft", x: "-20%", y: "-20%", width: "140%", height: "140%" });
    soft.append(
      sv("feGaussianBlur", { in: "SourceAlpha", stdDeviation: 7, result: "b" }),
      sv("feOffset", { in: "b", dx: 7, dy: 7, result: "d" }),
      sv("feFlood", { "flood-color": "#bec1c8" }),
      sv("feComposite", { in2: "d", operator: "in", result: "ds" }),
      sv("feOffset", { in: "b", dx: -7, dy: -7, result: "l" }),
      sv("feFlood", { "flood-color": "#ffffff" }),
      sv("feComposite", { in2: "l", operator: "in", result: "ls" }),
    );
    const merge = sv("feMerge");
    merge.append(sv("feMergeNode", { in: "ds" }), sv("feMergeNode", { in: "ls" }), sv("feMergeNode", { in: "SourceGraphic" }));
    soft.append(merge);
    const arrow = sv("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse" });
    arrow.append(sv("path", { d: "M0,1 L9,5 L0,9 z", fill: "#aeb2b9" }));
    defs.append(soft, arrow);
    svg.append(defs);

    const states = topo.map((n) => (run ? statusAt(run, n.id, t) : "idle"));

    // request wires (toward the dependency) and the back-pressure wire running the other way
    for (let i = 0; i < topo.length - 1; i++) {
      const a = pos[i], b = pos[i + 1];
      const down = states[i + 1];
      const cls = down === "failing" ? "back hot" : down === "degraded" ? "back warm" : "back";
      if (vertical) {
        svg.append(sv("line", { x1: a.x + 70, y1: a.y + nh, x2: a.x + 70, y2: b.y - 2, class: "wire", "marker-end": "url(#arrow)" }));
        svg.append(sv("line", { x1: a.x + nw - 70, y1: b.y, x2: a.x + nw - 70, y2: a.y + nh, class: cls }));
      } else {
        svg.append(sv("line", { x1: a.x + nw, y1: top + 52, x2: b.x - 2, y2: top + 52, class: "wire", "marker-end": "url(#arrow)" }));
        svg.append(sv("line", { x1: b.x, y1: top + 150, x2: a.x + nw, y2: top + 150, class: cls }));
      }
    }
    if (vertical) {
      svg.append(sv("text", { x: pos[0].x + 80, y: pos[0].y + nh + 26, class: "wire-label" }, "requests"));
      svg.append(sv("text", { x: pos[0].x + nw - 80, y: pos[0].y + nh + 26, "text-anchor": "end", class: "wire-label" }, "back-pressure"));
    } else {
      svg.append(sv("text", { x: pos[0].x + nw + 10, y: top + 44, class: "wire-label" }, "requests"));
      svg.append(sv("text", { x: pos[0].x + nw + 10, y: top + 170, class: "wire-label" }, "back-pressure"));
    }

    topo.forEach((n, i) => {
      const st = states[i];
      const g = sv("g", { class: `node ${st}`, transform: `translate(${pos[i].x},${pos[i].y})` });
      g.append(sv("rect", { class: "node-frame", width: nw, height: nh, rx: 24 }));
      g.append(sv("rect", { class: "ring", x: 1, y: 1, width: nw - 2, height: nh - 2, rx: 23 }));
      g.append(sv("text", { x: 18, y: 42, class: "node-name" }, n.label));
      g.append(sv("text", { x: 18, y: 64, class: "node-role" }, ROLES[n.id] || ""));
      g.append(sv("circle", { class: "lamp", cx: nw - 26, cy: 34, r: 9 }));
      g.append(sv("text", { x: nw - 18, y: 64, "text-anchor": "end", class: "node-state" }, st === "idle" ? "standby" : st));
      g.append(sv("line", { x1: 14, y1: 80, x2: nw - 14, y2: 80, class: "divider" }));
      readouts(n.id, run, t).forEach(([k, v], r) => {
        g.append(sv("text", { x: 18, y: 108 + r * 28, class: "rd-k" }, k));
        g.append(sv("text", { x: nw - 18, y: 108 + r * 28, "text-anchor": "end", class: "rd-v" }, v));
      });
      svg.append(g);
    });

    // fault marker over the dependency that is being degraded
    if (sc && sc.fault) {
      const fi = topo.findIndex((n) => n.id === sc.fault.service);
      if (fi >= 0) {
        const active = run && t >= sc.fault.start_tick && t < sc.fault.end_tick;
        const fx = pos[fi].x, fy = pos[fi].y;
        if (active) {
          const label = `Fault: capacity ${fmt(sc.capacities && sc.capacities.payments_rps)} → ${fmt(sc.fault.capacity_rps)}/s`;
          const tag = sv("g", { class: "fault-tag" });
          tag.append(sv("rect", { x: fx, y: fy - 48, width: nw, height: 32, rx: 16 }));
          tag.append(sv("text", { x: fx + nw / 2, y: fy - 27, "text-anchor": "middle" }, label));
          svg.append(tag);
        } else {
          svg.append(sv("text", { x: fx, y: fy - 24, class: "fault-sched" }, `Fault window t=${sc.fault.start_tick}–${sc.fault.end_tick}s`));
        }
      }
    }
    box.replaceChildren(svg);
  }

  function drawClock() {
    const run = current();
    const sc = (run && run.scenario) || S.scenario;
    el("clock").textContent = "T+" + String(S.t).padStart(3, "0");
    const ph = el("phase");
    if (!run || !sc) {
      ph.textContent = "Idle. Run a resilience audit to stream the simulation through this path.";
      ph.className = "phase";
      return;
    }
    const p = run.series[S.t] || {};
    const who = S.trace === "mitigated" ? "With mitigation. " : "";
    if (S.t < sc.fault.start_tick) { ph.textContent = who + "Before the fault. Traffic fits within capacity."; ph.className = "phase"; }
    else if (S.t < sc.fault.end_tick) { ph.textContent = who + `Fault active. Payments limited to ${fmt(p.payments_capacity)}/s while ${fmt(p.arrivals)}/s keep arriving.`; ph.className = "phase fault"; }
    else if (p.backlog > 0 || p.customer_failures > 0) { ph.textContent = who + "Fault cleared, but the backlog is still draining."; ph.className = "phase recovery"; }
    else { ph.textContent = who + "Recovered. Backlog drained."; ph.className = "phase steady"; }
  }

  function drawTimeline() {
    const sc = (current() && current().scenario) || S.scenario;
    const n = ticks();
    const scrub = el("scrub");
    scrub.max = n - 1;
    if (S.t > n - 1) S.t = n - 1;
    scrub.value = S.t;
    const pct = (x) => `${(x / Math.max(1, n - 1)) * 100}%`;
    const band = el("faultBand"), tk = el("ticks");
    tk.replaceChildren();
    if (!sc || !sc.fault) { band.style.width = "0"; return; }
    band.style.left = pct(sc.fault.start_tick);
    band.style.width = `calc(${pct(sc.fault.end_tick - sc.fault.start_tick)})`;
    for (const [v, f] of [[0, false], [sc.fault.start_tick, true], [sc.fault.end_tick, true], [n - 1, false]]) {
      const s = h("span", f ? { class: "f" } : {}, `${v}s`);
      s.style.left = pct(v);
      tk.append(s);
    }
  }

  function setT(t) {
    S.t = Math.max(0, Math.min(ticks() - 1, t));
    el("scrub").value = S.t;
    drawTopology();
    drawClock();
    if (typeof drawChart === "function" && S.baseline) drawChart(S.baseline.series);
  }

  function stop() {
    clearInterval(S.timer);
    S.timer = null;
    el("play").textContent = "Play";
    el("play").setAttribute("aria-label", "Play simulation");
  }
  function setPlayEnabled(on) {
    const btn = el("play");
    btn.disabled = !on;
    btn.title = on ? "" : "Run a resilience audit first";
  }
  function play() {
    if (!current()) {
      const ph = el("phase");
      if (ph) { ph.textContent = "Run a resilience audit first — then Play streams the simulation."; ph.className = "phase"; }
      setPlayEnabled(false);
      return;
    }
    stop();
    if (S.t >= ticks() - 1) setT(0);
    el("play").textContent = "Pause";
    el("play").setAttribute("aria-label", "Pause simulation");
    S.timer = setInterval(() => {
      if (S.t >= ticks() - 1) { stop(); return; }
      setT(S.t + 1);
    }, 100);
  }
  function replay() {
    if (reduceMotion) {
      const s = current().series;
      let peak = 0;
      s.forEach((p, i) => { if (p.backlog > s[peak].backlog) peak = i; });
      setT(peak);
      return;
    }
    setT(0);
    play();
  }

  function setTrace(which) {
    S.trace = which === "mitigated" && S.mitigated ? "mitigated" : "baseline";
    el("traceBase").classList.toggle("on", S.trace === "baseline");
    el("traceMit").classList.toggle("on", S.trace === "mitigated");
    drawTimeline();
    setT(S.t);
  }

  // ---------- outcome strip ----------
  const OUTCOME = [
    ["unique_failed_checkouts", "Customers who could not check out", (v) => fmt(v), true],
    ["revenue_at_risk_usd", "Revenue at risk", usd, false, true],
    ["retry_amplification", "Retry amplification", (v) => fmt(v, 3)],
    ["total_retries", "Retries sent", (v) => fmt(v)],
    ["peak_backlog", "Peak payments backlog", (v) => fmt(v)],
  ];
  function drawOutcome() {
    const box = el("outcome");
    if (!S.baseline) return;
    const deltas = Object.fromEntries((S.deltas || []).map((d) => [d.metric, d]));
    const grid = h("div", { class: "outcome-grid" });
    for (const [key, label, f, primary, estimate] of OUTCOME) {
      const cell = h("div", { class: "oc" + (primary ? " primary" : "") });
      const title = h("h3", {}, label);
      if (estimate) title.append(h("span", { class: "est" }, " (estimate)"));
      cell.append(title);
      const b = S.baseline.metrics[key];
      const pair = h("div", { class: "pair" });
      if (S.mitigated) {
        const m = S.mitigated.metrics[key];
        pair.append(h("span", { class: "before" }, f(b)), h("span", { class: "arrow" }, "→"), h("span", { class: "after" }, f(m)));
        cell.append(pair);
        const d = deltas[key];
        const diff = m - b;
        const cls = d ? (d.improved === true ? "good" : d.improved === false ? "bad" : "flat") : "flat";
        let txt = diff === 0 ? "no change" : (diff > 0 ? "+" : "−") + f(Math.abs(diff)).replace(/^\$/, "$");
        if (primary && b) txt += ` (${diff > 0 ? "+" : "−"}${fmt(Math.abs(diff / b) * 100, 1)}%)`;
        cell.append(h("span", { class: "delta " + cls }, txt));
      } else {
        pair.append(h("span", {}, f(b)));
        cell.append(pair, h("div", { class: "pending" }, "Before mitigation. Verify a fix to compare."));
      }
      grid.append(cell);
    }
    box.replaceChildren(grid);
  }

  // ---------- hooks called by demo.js ----------
  function onInterpret(data) {
    if (!data) return;
    S.scenario = data.scenario || S.scenario;
    const pre = el("interpretRawPre");
    pre.textContent = data.raw_model_output
      ? JSON.stringify(data.raw_model_output, null, 2)
      : "No model output." + (data.inference_error ? " " + data.inference_error : "");
    drawTimeline();
    drawTopology();
  }
  function onAudit(result, scenario) {
    S.baseline = result;
    S.scenario = scenario || result.scenario;
    S.mitigated = null;
    S.deltas = null;
    el("traceMit").disabled = true;
    el("btnRecommend").disabled = false;
    setPlayEnabled(true);
    el("reportId").textContent = `Seed ${result.seed}`;
    el("ledgerEmpty").classList.remove("hidden");
    setTrace("baseline");
    drawOutcome();
    replay();
  }
  function onRecommend(rec, audit) {
    if (!rec) return;
    el("recAnalyst").textContent = rec.inference_used ? "Akamai Inference, Qwen (live call)" : "Fixture response, not live inference";
    const m = (audit || S.baseline || {}).metrics;
    el("recFinding").textContent = m
      ? `${m.highest_impact_dependency} is the highest-impact dependency. Backlog peaked at ${fmt(m.peak_backlog)} and ${fmt(m.unique_failed_checkouts)} customers failed to check out.`
      : "—";
    const entry = (rec.allowlist || []).find((a) => a && a.id === rec.mitigation_id);
    const idBox = el("recId");
    idBox.replaceChildren(h("span", { class: "rec-label" }, entry ? entry.label : rec.mitigation_id), document.createTextNode(rec.mitigation_id));
    el("recRawPre").textContent = rec.raw_model_output
      ? JSON.stringify(rec.raw_model_output, null, 2)
      : "No model output." + (rec.inference_error ? " " + rec.inference_error : "");
  }
  function onVerify(v) {
    if (!v || !v.mitigated) return;
    S.baseline = v.baseline || S.baseline;
    S.mitigated = v.mitigated;
    S.deltas = v.deltas || [];
    el("traceMit").disabled = false;
    el("ledgerEmpty").classList.add("hidden");
    drawOutcome();
    setTrace("mitigated");
    replay();
  }

  function init() {
    setPlayEnabled(false);
    el("scrub").addEventListener("input", (e) => { stop(); setT(Number(e.target.value)); });
    el("play").addEventListener("click", () => (S.timer ? stop() : play()));
    el("traceBase").addEventListener("click", () => setTrace("baseline"));
    el("traceMit").addEventListener("click", () => setTrace("mitigated"));
    drawTimeline();
    drawTopology();
    drawClock();
    let rz;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(drawTopology, 120); });
    fetch("/api/health").then((r) => r.json()).then((hh) => {
      const b = el("dbBadge");
      if (hh.database === true) { b.textContent = "db online"; b.className = "badge on"; }
      else if (hh.database === false) { b.textContent = "db not configured"; b.className = "badge warn"; }
      else { b.textContent = "db n/a (start with serve.py)"; b.className = "badge"; }
    }).catch(() => { el("dbBadge").textContent = "db unknown"; });
  }
  document.addEventListener("DOMContentLoaded", init);

  return {
    onInterpret, onAudit, onRecommend, onVerify,
    t: () => S.t,
    chartSeries: () => (current() ? current().series : null),
    trace: () => S.trace,
  };
})();

window.Instrument = Instrument; // top-level const is not a window property; demo.js checks window.Instrument
