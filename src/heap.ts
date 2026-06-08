import type { HeapReport, HeapEntry } from "./parse.js";

export interface HeapOptions {
  top: number;
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
};

function paint(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${C.reset}` : s;
}

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtUptime(ms: number): string {
  if (ms <= 0) return "?";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmtTime(ms: number): string {
  if (ms <= 0) return "?";
  // Stable UTC stamp — avoids depending on the runner's timezone.
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// Colour the heap fill ratio: this is the "are we pinned at -Xmx" signal.
function fillColor(frac: number): string {
  return frac >= 0.9 ? C.red : frac >= 0.75 ? C.yellow : C.green;
}

export function renderHeap(report: HeapReport, opts: HeapOptions): string {
  if (opts.json) return renderHeapJson(report, opts);

  const c = opts.color;
  const out: string[] = [];
  const p = report.platform;

  out.push(paint("─── spark heap summary ─────────────────────────────────", C.cyan, c));

  const brand = p.brand || p.name || "?";
  const ver = p.version ? ` ${p.version.trim()}` : "";
  out.push(
    `${paint("platform :", C.dim, c)} ${paint(brand + ver, C.bold, c)}` +
      (p.minecraftVersion ? `  ${paint("MC", C.dim, c)} ${p.minecraftVersion}` : ""),
  );
  out.push(`${paint("source   :", C.dim, c)} ${report.origin}`);
  out.push(
    `${paint("taken    :", C.dim, c)} ${fmtTime(report.generatedTime)}` +
      `   ${paint("players", C.dim, c)} ${report.players}`,
  );

  // The headline line: used / committed / max with the fill ratio against -Xmx.
  const max = report.heapMax;
  const fill = max > 0 ? report.heapUsed / max : 0;
  const fillStr = max > 0 ? ` ${paint(`(${(fill * 100).toFixed(1)}% of max)`, fillColor(fill), c)}` : "";
  out.push(
    `${paint("heap     :", C.dim, c)} ${paint(fmtBytes(report.heapUsed), fillColor(fill), c)} used` +
      ` / ${fmtBytes(report.heapCommitted)} committed` +
      (max > 0 ? ` / ${fmtBytes(max)} max` : "") +
      fillStr,
  );
  if (report.nonHeapUsed > 0) {
    out.push(`${paint("non-heap :", C.dim, c)} ${fmtBytes(report.nonHeapUsed)} used`);
  }

  const s = report.system;
  if (s.memTotal > 0) {
    out.push(
      `${paint("host mem :", C.dim, c)} ${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}` +
        ` ${paint(`(${((s.memUsed / s.memTotal) * 100).toFixed(0)}%)`, C.dim, c)}` +
        (s.uptime > 0 ? `   ${paint("uptime", C.dim, c)} ${fmtUptime(s.uptime)}` : ""),
    );
  }
  if (s.cpuModel) out.push(`           ${paint(s.cpuModel, C.dim, c)}`);

  if (report.gc.length > 0) {
    const gcStr = report.gc
      .map(
        (g) =>
          `${g.name} ×${fmtInt(g.total)}` +
          (g.avgTime > 0 ? ` (avg ${g.avgTime.toFixed(1)}ms)` : ""),
      )
      .join("  ·  ");
    out.push(`${paint("GC       :", C.dim, c)} ${gcStr}`);
  }

  out.push(
    `${paint("live     :", C.dim, c)} ${fmtInt(report.totalInstances)} objects` +
      ` · ${fmtBytes(report.totalSize)} across ${fmtInt(report.entries.length)} classes`,
  );

  // Class histogram — the part that tells you WHAT is on the heap.
  out.push("");
  out.push(paint(`Top ${opts.top} classes by retained size:`, C.bold, c));
  out.push(
    paint(
      `  ${"size".padStart(9)}  ${"%live".padStart(6)}  ${"instances".padStart(13)}  ${"avg/obj".padStart(9)}  class`,
      C.dim,
      c,
    ),
  );
  const denom = report.totalSize || 1;
  for (const e of report.entries.slice(0, opts.top)) {
    const sharePct = (e.size / denom) * 100;
    const avg = e.instances > 0 ? e.size / e.instances : 0;
    const shareCol = sharePct >= 10 ? C.red : sharePct >= 3 ? C.yellow : C.dim;
    out.push(
      `  ${paint(fmtBytes(e.size).padStart(9), shareCol, c)}` +
        `  ${paint((sharePct.toFixed(1) + "%").padStart(6), C.dim, c)}` +
        `  ${fmtInt(e.instances).padStart(13)}` +
        `  ${fmtBytes(avg).padStart(9)}` +
        `  ${e.type}`,
    );
  }
  if (report.entries.length > opts.top) {
    out.push(paint(`  ... +${fmtInt(report.entries.length - opts.top)} more classes`, C.dim, c));
  }

  return out.join("\n");
}

function renderHeapJson(report: HeapReport, opts: HeapOptions): string {
  const top: HeapEntry[] = report.entries.slice(0, opts.top);
  return JSON.stringify(
    {
      kind: "heap",
      origin: report.origin,
      platform: report.platform,
      system: report.system,
      players: report.players,
      generatedTime: report.generatedTime,
      heap: {
        used: report.heapUsed,
        committed: report.heapCommitted,
        init: report.heapInit,
        max: report.heapMax,
        fillOfMax: report.heapMax > 0 ? report.heapUsed / report.heapMax : null,
      },
      nonHeapUsed: report.nonHeapUsed,
      gc: report.gc,
      totals: {
        instances: report.totalInstances,
        size: report.totalSize,
        classes: report.entries.length,
      },
      topClasses: top.map((e) => ({
        type: e.type,
        size: e.size,
        instances: e.instances,
        avgSize: e.instances > 0 ? e.size / e.instances : 0,
        sharePct: report.totalSize > 0 ? (e.size / report.totalSize) * 100 : 0,
      })),
    },
    null,
    2,
  );
}
