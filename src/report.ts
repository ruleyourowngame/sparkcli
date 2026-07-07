import type { Report, Thread } from "./parse.js";
import { hotSpots, formatPct, shortClass, type Frame } from "./analyze.js";
import { renderAllThreads, allThreadsJson, nativeRootedBusy } from "./busy.js";

export interface ReportOptions {
  top: number;
  thread?: string;
  color: boolean;
  json: boolean;
  /** Busy-ranked per-thread + cross-thread view instead of one thread's hot spots. */
  allThreads?: boolean;
  minPct?: number;
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function paint(s: string, code: string, color: boolean): string {
  if (!color) return s;
  return `${code}${s}${C.reset}`;
}

// fraction (0..1) -> "87.8%"
function pct(frac: number): string {
  return `${(frac * 100).toFixed(1)}%`;
}

// Colour a CPU usage fraction. High isn't necessarily bad (it can be a small
// core cap), but it's the thing worth eyeballing, so flag it.
function cpuColor(frac: number): string {
  return frac >= 0.9 ? C.red : frac >= 0.7 ? C.yellow : C.green;
}

function fmtBytes(n: number): string {
  if (n <= 0) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(ms: number): string {
  if (ms <= 0) return "?";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function pickThread(report: Report, query?: string): Thread {
  if (!query) {
    // Prefer the busiest "Server thread*" — on executor-ticked forks the tick
    // runs on "Server Thread - ES" while the original "Server thread" is a
    // parked launcher thread that exact-matches first.
    const serverThreads = report.threads
      .filter((t) => /^server thread/i.test(t.name))
      .sort((a, b) => b.busy - a.busy || b.total - a.total);
    return serverThreads[0] ?? report.threads[0]!;
  }
  const exact = report.threads.find((t) => t.name === query);
  if (exact) return exact;
  const ci = report.threads.find((t) =>
    t.name.toLowerCase().includes(query.toLowerCase()),
  );
  if (ci) return ci;
  throw new Error(`No thread matched ${JSON.stringify(query)}`);
}

export function renderText(report: Report, opts: ReportOptions): string {
  if (opts.json) return renderJson(report, opts);

  const out: string[] = [];
  const c = opts.color;

  const platform = `${report.platform.brand || report.platform.name} ${report.platform.version}`;
  const duration = (report.endTime - report.startTime) / 1000;
  const isAlloc = report.samplerMode === "ALLOCATION";
  // Background profilers run for the whole uptime but only retain recent
  // windows — the samples cover the window span, not `duration`.
  const coverage = report.windows.reduce((s, w) => s + w.durationMs, 0) / 1000;

  out.push(paint("─── spark report ───────────────────────────────────────", C.cyan, c));
  out.push(`${paint("platform :", C.dim, c)} ${paint(platform, C.bold, c)}  ${paint("MC", C.dim, c)} ${report.platform.minecraftVersion}`);
  // In ALLOCATION mode `interval` is the async-profiler sampling threshold in
  // bytes (e.g. 512 KiB), not a time interval — labelling it μs is just wrong.
  const intervalStr = isAlloc ? fmtBytes(report.interval) : `${report.interval}μs`;
  out.push(`${paint("sampler  :", C.dim, c)} ${report.samplerEngine}/${report.samplerMode}  interval=${intervalStr}`);
  out.push(`${paint("source   :", C.dim, c)} ${report.origin}`);
  const coverageNote =
    coverage > 0 && duration > 0 && coverage < duration * 0.9
      ? paint(`  (samples cover last ${(coverage / 60).toFixed(0)}m of ${(duration / 3600).toFixed(1)}h run)`, C.yellow, c)
      : "";
  out.push(`${paint("ticks    :", C.dim, c)} ${report.numberOfTicks}  ${paint("dur", C.dim, c)} ${duration.toFixed(1)}s  ${paint("players", C.dim, c)} ${report.stats.players}${coverageNote}`);

  const tps = report.stats;
  const tpsCol = tps.tps1m >= 19.5 ? C.green : tps.tps1m >= 15 ? C.yellow : C.red;
  out.push(
    `${paint("TPS      :", C.dim, c)} ${paint(tps.tps1m.toFixed(2), tpsCol, c)} / ${tps.tps5m.toFixed(2)} / ${tps.tps15m.toFixed(2)}` +
      `   ${paint("MSPT", C.dim, c)} med ${paint(tps.msptMedian.toFixed(1), tps.msptMedian <= 50 ? C.green : C.red, c)} ` +
      `p95 ${tps.msptP95.toFixed(1)} max ${tps.msptMax.toFixed(1)}`,
  );

  const totalAll = report.threads.reduce((s, t) => s + t.total, 0) || 1;

  // For an allocation profile the single most useful number is the rate: how
  // fast the server is producing garbage (and therefore how hard the GC works).
  if (isAlloc) {
    const rate = duration > 0 ? totalAll / duration : 0;
    out.push(
      `${paint("alloc    :", C.dim, c)} ${paint(fmtBytes(totalAll), C.bold, c)} sampled over ${duration.toFixed(1)}s` +
        `   ${paint("rate", C.dim, c)} ${paint(fmtBytes(rate) + "/s", rate >= 100 * 1024 * 1024 ? C.red : rate >= 25 * 1024 * 1024 ? C.yellow : C.green, c)}`,
    );
  }

  out.push(...renderSystem(report, c));

  out.push("");
  const busyAll = report.threads.reduce((s, t) => s + t.busy, 0) || 1;
  out.push(
    paint(
      `Threads (${report.threads.length})${isAlloc ? " — share of allocations" : " — busy%all · busy/thr (idle park/wait excluded)"}:`,
      C.bold,
      c,
    ),
  );
  for (const t of report.threads.slice(0, Math.min(10, report.threads.length))) {
    if (isAlloc) {
      const pct = (t.total / totalAll) * 100;
      out.push(`  ${pct.toFixed(1).padStart(5)}%  ${t.name}`);
    } else {
      const pctAll = (t.busy / busyAll) * 100;
      const pctThr = t.total > 0 ? (t.busy / t.total) * 100 : 0;
      const nativeBusy = t.busy > 0 ? nativeRootedBusy(t) / t.busy : 0;
      const warn =
        nativeBusy > 0.5
          ? paint(
              `  ⚠ ${(nativeBusy * 100).toFixed(0)}% native-rooted syscall time — may be blocked, not busy (verify per-thread CPU)`,
              C.yellow,
              c,
            )
          : "";
      out.push(
        `  ${pctAll.toFixed(1).padStart(5)}%  ${paint(pctThr.toFixed(0).padStart(3) + "%", C.dim, c)}  ${t.name}${warn}`,
      );
    }
  }
  if (report.threads.length > 10) out.push(paint(`  ... +${report.threads.length - 10} more`, C.dim, c));

  if (report.threads.length === 0) {
    out.push("");
    out.push(
      paint(
        "No thread samples in this report — statistics-only snapshot (see CPU/system above).",
        C.yellow,
        c,
      ),
    );
    return out.join("\n");
  }

  if (opts.allThreads) {
    out.push("");
    out.push(
      renderAllThreads(report, {
        top: opts.top,
        color: c,
        minPct: opts.minPct ?? 0.1,
      }),
    );
    return out.join("\n");
  }

  const thread = pickThread(report, opts.thread);
  const all = hotSpots(thread);
  const total = thread.total || 1;

  // In allocation mode the metric is bytes allocated, not CPU time — say so,
  // and print the absolute amount next to each frame's share.
  const noun = isAlloc ? "allocating frames" : "self-time hot spots";
  const colHead = isAlloc ? "  self%    incl%    self-bytes  frame" : "  self%    incl%    frame";
  const inclColHead = isAlloc ? "  incl%    self%    incl-bytes  frame" : "  incl%    self%    frame";

  const srcOf = (className: string): string | null => {
    // deferred import avoided: classSources lookup is trivial
    const direct = report.classSources[className];
    if (direct) return direct;
    const dollar = className.indexOf("$");
    if (dollar > 0) return report.classSources[className.slice(0, dollar)] ?? null;
    return null;
  };

  out.push("");
  out.push(paint(`Top ${opts.top} ${noun} in "${thread.name}":`, C.bold, c));
  out.push(paint(colHead, C.dim, c));
  const bySelf = [...all].sort((a, b) => b.self - a.self).slice(0, opts.top);
  for (const f of bySelf) out.push(renderRow(f, total, c, "self", isAlloc, srcOf(f.className)));

  out.push("");
  out.push(paint(`Top ${opts.top} ${isAlloc ? "allocation call paths (inclusive)" : "inclusive hot spots"} in "${thread.name}":`, C.bold, c));
  out.push(paint(inclColHead, C.dim, c));
  const byIncl = [...all].sort((a, b) => b.inclusive - a.inclusive).slice(0, opts.top);
  for (const f of byIncl) out.push(renderRow(f, total, c, "incl", isAlloc, srcOf(f.className)));

  return out.join("\n");
}

// CPU / memory header block + the per-window CPU·TPS time series.
function renderSystem(report: Report, c: boolean): string[] {
  const out: string[] = [];
  const s = report.system;
  const hasCpu = s.cpuThreads > 0 || s.cpuProcess1m > 0 || s.cpuSystem1m > 0;
  if (!hasCpu && report.windows.length === 0) return out;

  if (hasCpu) {
    const cores = s.cpuThreads > 0 ? `  ${paint("cores", C.dim, c)} ${s.cpuThreads}` : "";
    out.push(
      `${paint("CPU      :", C.dim, c)} ${paint("process", C.dim, c)} ` +
        `${paint(pct(s.cpuProcess1m), cpuColor(s.cpuProcess1m), c)} / ${pct(s.cpuProcess15m)}` +
        `   ${paint("system", C.dim, c)} ${paint(pct(s.cpuSystem1m), cpuColor(s.cpuSystem1m), c)} / ${pct(s.cpuSystem15m)}` +
        `   ${paint("(1m/15m)", C.dim, c)}${cores}`,
    );
    const memLine =
      s.memTotal > 0
        ? `${paint("memory   :", C.dim, c)} ${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}` +
          ` ${paint(`(${pct(s.memUsed / s.memTotal)})`, C.dim, c)}` +
          (s.uptime > 0 ? `   ${paint("uptime", C.dim, c)} ${fmtUptime(s.uptime)}` : "")
        : "";
    if (memLine) out.push(memLine);
    if (s.cpuModel) out.push(`           ${paint(s.cpuModel, C.dim, c)}`);
  }

  if (report.windows.length > 0) {
    out.push("");
    out.push(paint(`Windows (${report.windows.length} × ~1m — CPU process/system · TPS · MSPT med · players):`, C.bold, c));
    report.windows.forEach((w, i) => {
      out.push(
        `  ${paint(`#${i + 1}`.padEnd(3), C.dim, c)} ${(w.durationMs / 1000).toFixed(1).padStart(5)}s` +
          `   ${paint("cpu", C.dim, c)} ${paint(pct(w.cpuProcess), cpuColor(w.cpuProcess), c)} / ${pct(w.cpuSystem)}` +
          `   ${paint("tps", C.dim, c)} ${w.tps.toFixed(2)}` +
          `   ${paint("mspt", C.dim, c)} ${w.msptMedian.toFixed(2)}` +
          `   ${paint("players", C.dim, c)} ${w.players}`,
      );
    });
  }

  return out;
}

function renderRow(
  f: Frame,
  total: number,
  color: boolean,
  leading: "self" | "incl",
  showBytes = false,
  source: string | null = null,
): string {
  const selfPct = (f.self / total) * 100;
  const inclPct = (f.inclusive / total) * 100;
  const a = leading === "self" ? selfPct : inclPct;
  const b = leading === "self" ? inclPct : selfPct;
  const aStr = formatPct(a).padStart(7);
  const bStr = formatPct(b).padStart(7);
  const aCol = a >= 5 ? C.red : a >= 1 ? C.yellow : C.dim;
  // In alloc mode self/inclusive are already byte counts — surface the absolute
  // amount so a 5% frame on a 4 GiB profile reads as the 200 MiB it really is.
  const bytesStr = showBytes
    ? "  " + paint(fmtBytes(leading === "self" ? f.self : f.inclusive).padStart(9), C.gray, color)
    : "";
  const label = `${shortClass(f.className)}.${f.methodName}${f.lineNumber > 0 ? ":" + f.lineNumber : ""}`;
  const srcTag = source ? paint(`  [${source}]`, C.cyan, color) : "";
  return `  ${paint(aStr, aCol, color)}  ${paint(bStr, C.dim, color)}${bytesStr}  ${label}${srcTag}`;
}

function renderJson(report: Report, opts: ReportOptions): string {
  const hasThreads = report.threads.length > 0;
  const thread = hasThreads ? pickThread(report, opts.thread) : null;
  const total = (thread?.total ?? 0) || 1;
  const frames = thread
    ? hotSpots(thread).sort((a, b) => b.self - a.self).slice(0, opts.top)
    : [];
  const duration = (report.endTime - report.startTime) / 1000;
  const isAlloc = report.samplerMode === "ALLOCATION";
  const totalAll = report.threads.reduce((s, t) => s + t.total, 0);
  return JSON.stringify(
    {
      platform: report.platform,
      samplerMode: report.samplerMode,
      samplerEngine: report.samplerEngine,
      // unit of `self`/`inclusive`/`total`/`threadTotal` below
      metricUnit: isAlloc ? "bytes" : "samples",
      interval: report.interval,
      intervalUnit: isAlloc ? "bytes" : "microseconds",
      ...(isAlloc
        ? { totalAllocated: totalAll, allocBytesPerSec: duration > 0 ? totalAll / duration : 0 }
        : {}),
      stats: report.stats,
      system: report.system,
      windows: report.windows,
      ticks: report.numberOfTicks,
      duration,
      // background profilers retain only recent windows; samples cover this span
      windowCoverageSec: report.windows.reduce((s, w) => s + w.durationMs, 0) / 1000,
      sources: report.sources,
      threads: report.threads.map((t) => ({ name: t.name, total: t.total, busy: t.busy, idle: t.idle })),
      ...(opts.allThreads ? { allThreads: allThreadsJson(report, opts.top) } : {}),
      thread: thread?.name ?? null,
      threadTotal: thread?.total ?? 0,
      frames: frames.map((f) => ({
        class: f.className,
        method: f.methodName,
        line: f.lineNumber,
        selfPct: (f.self / total) * 100,
        inclPct: (f.inclusive / total) * 100,
        self: f.self,
        inclusive: f.inclusive,
        source: report.classSources[f.className] ?? null,
      })),
    },
    null,
    2,
  );
}
