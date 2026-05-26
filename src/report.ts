import type { Report, Thread } from "./parse.js";
import { hotSpots, formatPct, shortClass, type Frame } from "./analyze.js";

export interface ReportOptions {
  top: number;
  thread?: string;
  color: boolean;
  json: boolean;
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

function pickThread(report: Report, query?: string): Thread {
  if (!query) {
    return (
      report.threads.find((t) => /^Server thread$/i.test(t.name)) ??
      report.threads[0]!
    );
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

  out.push(paint("─── spark report ───────────────────────────────────────", C.cyan, c));
  out.push(`${paint("platform :", C.dim, c)} ${paint(platform, C.bold, c)}  ${paint("MC", C.dim, c)} ${report.platform.minecraftVersion}`);
  out.push(`${paint("sampler  :", C.dim, c)} ${report.samplerEngine}/${report.samplerMode}  interval=${report.interval}μs`);
  out.push(`${paint("source   :", C.dim, c)} ${report.origin}`);
  out.push(`${paint("ticks    :", C.dim, c)} ${report.numberOfTicks}  ${paint("dur", C.dim, c)} ${duration.toFixed(1)}s  ${paint("players", C.dim, c)} ${report.stats.players}`);

  const tps = report.stats;
  const tpsCol = tps.tps1m >= 19.5 ? C.green : tps.tps1m >= 15 ? C.yellow : C.red;
  out.push(
    `${paint("TPS      :", C.dim, c)} ${paint(tps.tps1m.toFixed(2), tpsCol, c)} / ${tps.tps5m.toFixed(2)} / ${tps.tps15m.toFixed(2)}` +
      `   ${paint("MSPT", C.dim, c)} med ${paint(tps.msptMedian.toFixed(1), tps.msptMedian <= 50 ? C.green : C.red, c)} ` +
      `p95 ${tps.msptP95.toFixed(1)} max ${tps.msptMax.toFixed(1)}`,
  );

  const totalAll = report.threads.reduce((s, t) => s + t.total, 0) || 1;
  out.push("");
  out.push(paint(`Threads (${report.threads.length}):`, C.bold, c));
  for (const t of report.threads.slice(0, Math.min(10, report.threads.length))) {
    const pct = (t.total / totalAll) * 100;
    out.push(`  ${pct.toFixed(1).padStart(5)}%  ${t.name}`);
  }
  if (report.threads.length > 10) out.push(paint(`  ... +${report.threads.length - 10} more`, C.dim, c));

  const thread = pickThread(report, opts.thread);
  const all = hotSpots(thread);
  const total = thread.total || 1;

  out.push("");
  out.push(paint(`Top ${opts.top} self-time hot spots in "${thread.name}":`, C.bold, c));
  out.push(paint("  self%    incl%    frame", C.dim, c));
  const bySelf = [...all].sort((a, b) => b.self - a.self).slice(0, opts.top);
  for (const f of bySelf) out.push(renderRow(f, total, c, "self"));

  out.push("");
  out.push(paint(`Top ${opts.top} inclusive hot spots in "${thread.name}":`, C.bold, c));
  out.push(paint("  incl%    self%    frame", C.dim, c));
  const byIncl = [...all].sort((a, b) => b.inclusive - a.inclusive).slice(0, opts.top);
  for (const f of byIncl) out.push(renderRow(f, total, c, "incl"));

  return out.join("\n");
}

function renderRow(f: Frame, total: number, color: boolean, leading: "self" | "incl"): string {
  const selfPct = (f.self / total) * 100;
  const inclPct = (f.inclusive / total) * 100;
  const a = leading === "self" ? selfPct : inclPct;
  const b = leading === "self" ? inclPct : selfPct;
  const aStr = formatPct(a).padStart(7);
  const bStr = formatPct(b).padStart(7);
  const aCol = a >= 5 ? C.red : a >= 1 ? C.yellow : C.dim;
  const label = `${shortClass(f.className)}.${f.methodName}${f.lineNumber > 0 ? ":" + f.lineNumber : ""}`;
  return `  ${paint(aStr, aCol, color)}  ${paint(bStr, C.dim, color)}  ${label}`;
}

function renderJson(report: Report, opts: ReportOptions): string {
  const thread = pickThread(report, opts.thread);
  const total = thread.total || 1;
  const frames = hotSpots(thread).sort((a, b) => b.self - a.self).slice(0, opts.top);
  return JSON.stringify(
    {
      platform: report.platform,
      stats: report.stats,
      ticks: report.numberOfTicks,
      duration: (report.endTime - report.startTime) / 1000,
      threads: report.threads.map((t) => ({ name: t.name, total: t.total })),
      thread: thread.name,
      threadTotal: thread.total,
      frames: frames.map((f) => ({
        class: f.className,
        method: f.methodName,
        line: f.lineNumber,
        selfPct: (f.self / total) * 100,
        inclPct: (f.inclusive / total) * 100,
        self: f.self,
        inclusive: f.inclusive,
      })),
    },
    null,
    2,
  );
}
