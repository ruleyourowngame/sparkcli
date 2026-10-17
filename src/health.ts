import { loadProto, extractSystemStats, type PlatformInfo, type SystemStats } from "./parse.js";

// ─── Health report (application/x-spark-health, `/spark health --upload`) ───
//
// A health report carries no thread samples: it is a snapshot of the platform
// and host statistics (TPS/MSPT/ping rolling averages, heap pools, allocation
// rate, GC totals, network, per-world entity census) plus a ~1h metrics
// history. Spark's viewer spreads this over several tabs; here it is one
// screen, with the derived numbers that matter when tuning a server (GC duty
// cycle, per-player allocation and bandwidth, entity hot spots).

export interface Rolling {
  mean: number;
  max: number;
  min: number;
  median: number;
  p95: number;
}

export interface MemUsage {
  used: number;
  committed: number;
  init: number;
  max: number;
}

export interface HealthGc {
  name: string;
  total: number;
  /** ms per collection */
  avgTime: number;
  /** ms between collections */
  avgFrequency: number;
}

export interface HealthWindow {
  id: number;
  durationMs: number;
  cpuProcess: number;
  cpuSystem: number;
  tps: number;
  msptMedian: number;
  msptMax: number;
  players: number;
  entities: number;
  tileEntities: number;
  chunks: number;
}

export interface HealthChunk {
  world: string;
  x: number;
  z: number;
  total: number;
  counts: Record<string, number>;
}

export interface HealthWorld {
  name: string;
  total: number;
  counts: Record<string, number>;
}

export interface HealthSeries {
  name: string;
  unit: "" | "%" | "ms" | "B" | "B/s";
  values: number[];
}

export interface HealthNet {
  iface: string;
  rxBytes: Rolling;
  txBytes: Rolling;
  rxPackets: Rolling;
  txPackets: Rolling;
}

export interface HealthReport {
  origin: string;
  platform: PlatformInfo;
  system: SystemStats;
  generatedTime: number;
  players: number;
  onlineMode: string;
  tps?: { last1m: number; last5m: number; last15m: number; target: number };
  mspt?: { last1m: Rolling; last5m: Rolling; idealMax: number };
  ping?: Rolling;
  heap: MemUsage;
  nonHeap: MemUsage;
  pools: Array<{ name: string; usage: MemUsage; afterGc: MemUsage }>;
  alloc: { last1m?: Rolling; last5m?: Rolling; last15m?: Rolling };
  gc: HealthGc[];
  disk: { used: number; total: number };
  swap: { used: number; total: number };
  os: string;
  java: string;
  vmArgs: string;
  net: HealthNet[];
  entities: { total: number; counts: Record<string, number>; worlds: HealthWorld[]; chunks: HealthChunk[] };
  windows: HealthWindow[];
  series: HealthSeries[];
  sources: Array<{ name: string; version: string; builtin: boolean }>;
  configs: string[];
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof v === "object" && "toNumber" in (v as any)) return (v as any).toNumber();
  return 0;
}

// proto3 defaults absent numbers to 0, so `?? fallback` never fires for them
function positiveOr(v: unknown, fallback: number): number {
  const n = num(v);
  return n > 0 ? n : fallback;
}

function rolling(r: any): Rolling | undefined {
  if (!r) return undefined;
  return {
    mean: r.mean ?? 0,
    max: r.max ?? 0,
    min: r.min ?? 0,
    median: r.median ?? 0,
    p95: r.percentile95 ?? 0,
  };
}

function mem(m: any): MemUsage {
  return { used: num(m?.used), committed: num(m?.committed), init: num(m?.init), max: num(m?.max) };
}

function addCounts(into: Record<string, number>, from: Record<string, number> | undefined): void {
  for (const [k, v] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + num(v);
}

// Spark names each world entry "<World> region at <x>, <z>" on regionised servers (one entry per
// tick region); fold those back into one row per world.
function worldName(name: string): string {
  return name.replace(/ region at -?\d+, -?\d+$/, "");
}

export async function parseHealth(origin: string, bytes: Uint8Array): Promise<HealthReport> {
  const root = await loadProto();
  const HealthData = root.lookupType("spark.HealthData");
  const data = HealthData.toObject(HealthData.decode(bytes), {
    longs: Number,
    enums: String,
    defaults: true,
    arrays: true,
    objects: true,
  }) as any;

  const meta = data.metadata ?? {};
  const pm = meta.platformMetadata ?? {};
  const ps = meta.platformStatistics ?? {};
  const sys = meta.systemStatistics ?? {};

  const world = ps.world ?? {};
  const worlds = new Map<string, HealthWorld>();
  const chunks: HealthChunk[] = [];
  for (const w of world.worlds ?? []) {
    const name = worldName(w.name ?? "?");
    const agg = worlds.get(name) ?? { name, total: 0, counts: {} };
    agg.total += num(w.totalEntities);
    for (const r of w.regions ?? []) {
      for (const ch of r.chunks ?? []) {
        addCounts(agg.counts, ch.entityCounts);
        chunks.push({ world: name, x: ch.x ?? 0, z: ch.z ?? 0, total: num(ch.totalEntities), counts: ch.entityCounts ?? {} });
      }
    }
    worlds.set(name, agg);
  }

  const tw = data.timeWindowStatistics ?? {};
  const windows: HealthWindow[] = Object.keys(tw)
    .map((k) => {
      const w = tw[k] ?? {};
      return {
        id: Number(k),
        durationMs: w.duration ?? 0,
        cpuProcess: w.cpuProcess ?? 0,
        cpuSystem: w.cpuSystem ?? 0,
        tps: w.tps ?? 0,
        msptMedian: w.msptMedian ?? 0,
        msptMax: w.msptMax ?? 0,
        players: w.players ?? 0,
        entities: w.entities ?? 0,
        tileEntities: w.tileEntities ?? 0,
        chunks: w.chunks ?? 0,
      };
    })
    .sort((a, b) => a.id - b.id);

  const metrics = meta.metrics ?? {};
  const series: HealthSeries[] = [];
  const pushSeries = (name: string, unit: HealthSeries["unit"], values: number[] | undefined) => {
    if (values && values.length > 1) series.push({ name, unit, values });
  };
  pushSeries("tps", "", metrics.tps?.values);
  pushSeries("mspt p95", "ms", metrics.tickDuration?.values?.map((v: any) => v.percentile95 ?? 0));
  pushSeries("mspt max", "ms", metrics.tickDuration?.values?.map((v: any) => v.max ?? 0));
  pushSeries("cpu process", "%", metrics.cpuUsageProcess?.values?.map((v: number) => v * 100));
  pushSeries("cpu system", "%", metrics.cpuUsageSystem?.values?.map((v: number) => v * 100));
  pushSeries("heap used", "B", metrics.memoryUsageHeap?.values?.map((v: any) => num(v.used)));
  pushSeries("alloc rate", "B/s", metrics.memoryAllocation?.values);
  pushSeries("players", "", metrics.worldInfo?.values?.map((v: any) => v.players ?? 0));
  pushSeries("entities", "", metrics.worldInfo?.values?.map((v: any) => v.entities ?? 0));
  pushSeries("chunks", "", metrics.worldInfo?.values?.map((v: any) => v.chunks ?? 0));
  pushSeries("ping p95", "ms", metrics.playerPing?.values?.map((v: any) => v.percentile95 ?? 0));

  const java = sys.java ?? {};
  const os = sys.os ?? {};

  return {
    origin,
    platform: {
      name: pm.name ?? "",
      version: pm.version ?? "",
      minecraftVersion: pm.minecraftVersion ?? "",
      brand: pm.brand ?? "",
    },
    system: extractSystemStats(sys),
    generatedTime: num(meta.generatedTime),
    players: num(ps.playerCount),
    onlineMode: ps.onlineMode && ps.onlineMode !== "UNKNOWN" ? String(ps.onlineMode).toLowerCase() : "",
    tps: ps.tps
      ? { last1m: ps.tps.last1m, last5m: ps.tps.last5m, last15m: ps.tps.last15m, target: positiveOr(ps.tps.gameTargetTps, 20) }
      : undefined,
    mspt:
      ps.mspt?.last1m
        ? { last1m: rolling(ps.mspt.last1m)!, last5m: rolling(ps.mspt.last5m)!, idealMax: positiveOr(ps.mspt.gameMaxIdealMspt, 50) }
        : undefined,
    ping: rolling(ps.ping?.last15m),
    heap: mem(ps.memory?.heap),
    nonHeap: mem(ps.memory?.nonHeap),
    pools: (ps.memory?.pools ?? []).map((p: any) => ({
      name: p.name ?? "?",
      usage: mem(p.usage),
      afterGc: mem(p.collectionUsage),
    })),
    alloc: {
      last1m: rolling(ps.memory?.allocBpsLast1m),
      last5m: rolling(ps.memory?.allocBpsLast5m),
      last15m: rolling(ps.memory?.allocBpsLast15m),
    },
    gc: Object.entries(ps.gc ?? {}).map(([name, g]: [string, any]) => ({
      name,
      total: num(g.total),
      avgTime: g.avgTime ?? 0,
      avgFrequency: g.avgFrequency ?? 0,
    })),
    disk: { used: num(sys.disk?.used), total: num(sys.disk?.total) },
    swap: { used: num(sys.memory?.swap?.used), total: num(sys.memory?.swap?.total) },
    os: [os.name, os.version, os.arch].filter(Boolean).join(" "),
    java: [java.vendorVersion || java.vendor, java.version].filter(Boolean).join(" "),
    vmArgs: java.vmArgs ?? "",
    net: Object.entries(sys.net ?? {}).map(([iface, n]: [string, any]) => ({
      iface,
      rxBytes: rolling(n.rxBytesPerSecond)!,
      txBytes: rolling(n.txBytesPerSecond)!,
      rxPackets: rolling(n.rxPacketsPerSecond)!,
      txPackets: rolling(n.txPacketsPerSecond)!,
    })),
    entities: {
      total: num(world.totalEntities),
      counts: world.entityCounts ?? {},
      worlds: [...worlds.values()].sort((a, b) => b.total - a.total),
      chunks: chunks.sort((a, b) => b.total - a.total),
    },
    windows,
    series,
    sources: Object.values(meta.sources ?? {})
      .map((s: any) => ({ name: s.name ?? "?", version: s.version ?? "", builtin: !!s.builtin }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    configs: Object.keys(meta.serverConfigurations ?? {}).sort(),
  };
}

// ─── rendering ──────────────────────────────────────────────────────────────

export interface HealthOptions {
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
  if (!Number.isFinite(n) || n <= 0) return "0 B";
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

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(3)}ms`;
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

function fmtTime(ms: number): string {
  if (ms <= 0) return "?";
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function fmtUnit(v: number, unit: HealthSeries["unit"]): string {
  switch (unit) {
    case "%":
      return `${v.toFixed(0)}%`;
    case "ms":
      return fmtMs(v);
    case "B":
      return fmtBytes(v);
    case "B/s":
      return `${fmtBytes(v)}/s`;
    default:
      return Number.isInteger(v) ? fmtInt(v) : v.toFixed(2);
  }
}

const SPARK = "▁▂▃▄▅▆▇█";

// Resample to `width` buckets (max per bucket, so short spikes survive) and draw a sparkline.
function sparkline(values: number[], width: number): string {
  if (values.length === 0) return "";
  const buckets: number[] = [];
  const step = values.length / Math.min(width, values.length);
  for (let i = 0; i < values.length; i += step) {
    const slice = values.slice(Math.floor(i), Math.max(Math.floor(i) + 1, Math.floor(i + step)));
    buckets.push(Math.max(...slice));
  }
  const lo = Math.min(...buckets);
  const hi = Math.max(...buckets);
  const span = hi - lo || 1;
  return buckets.map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor(((v - lo) / span) * SPARK.length))]).join("");
}

function tpsColor(tps: number, target: number): string {
  return tps >= target * 0.97 ? C.green : tps >= target * 0.85 ? C.yellow : C.red;
}

function topCounts(counts: Record<string, number>, n: number): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k.replace(/^minecraft:/, "")} ${v}`)
    .join(", ");
}

/**
 * GC duty cycle: share of wall time a collector is running. For concurrent collectors (ZGC,
 * Shenandoah "Cycles") this is background GC thread time, not pause time — a cycle that is busy
 * most of the time means allocation is outpacing the collector and allocation stalls are close.
 */
function gcDuty(g: HealthGc): number {
  return g.avgFrequency > 0 ? g.avgTime / g.avgFrequency : 0;
}

export function renderHealth(r: HealthReport, opts: HealthOptions): string {
  if (opts.json) return renderHealthJson(r, opts);
  const c = opts.color;
  const out: string[] = [];
  const label = (s: string) => paint(s.padEnd(9) + ":", C.dim, c);
  const section = (s: string) => {
    out.push("");
    out.push(paint(s, C.bold, c));
  };

  out.push(paint("─── spark health report ────────────────────────────────", C.cyan, c));
  const p = r.platform;
  out.push(
    `${label("platform")} ${paint((p.brand || p.name || "?") + (p.version ? ` ${p.version.trim()}` : ""), C.bold, c)}` +
      (p.minecraftVersion ? `  ${paint("MC", C.dim, c)} ${p.minecraftVersion}` : ""),
  );
  out.push(`${label("source")} ${r.origin}`);
  out.push(
    `${label("taken")} ${fmtTime(r.generatedTime)}   ${paint("players", C.dim, c)} ${r.players}` +
      (r.onlineMode ? `   ${paint("mode", C.dim, c)} ${r.onlineMode}` : "") +
      `   ${paint("uptime", C.dim, c)} ${fmtUptime(r.system.uptime)}`,
  );

  // ── tick health
  if (r.tps) {
    const t = r.tps;
    out.push(
      `${label("TPS")} ` +
        [t.last1m, t.last5m, t.last15m].map((v) => paint(v.toFixed(2), tpsColor(v, t.target), c)).join(" / ") +
        paint("  (1m/5m/15m)", C.dim, c),
    );
  }
  if (r.mspt) {
    for (const [k, m] of [
      ["1m", r.mspt.last1m],
      ["5m", r.mspt.last5m],
    ] as const) {
      const maxCol = m.max >= r.mspt.idealMax ? C.red : m.max >= r.mspt.idealMax / 2 ? C.yellow : C.reset;
      out.push(
        `${label(`MSPT ${k}`)} mean ${fmtMs(m.mean)}  med ${fmtMs(m.median)}  p95 ${fmtMs(m.p95)}  ` +
          `max ${paint(fmtMs(m.max), maxCol, c)}`,
      );
    }
  }
  if (r.ping) {
    out.push(`${label("ping 15m")} med ${r.ping.median.toFixed(0)}ms  p95 ${r.ping.p95.toFixed(0)}ms  max ${r.ping.max.toFixed(0)}ms`);
  }

  // ── CPU
  const s = r.system;
  out.push(
    `${label("CPU")} process ${(s.cpuProcess1m * 100).toFixed(1)}% / ${(s.cpuProcess15m * 100).toFixed(1)}%` +
      `   system ${(s.cpuSystem1m * 100).toFixed(1)}% / ${(s.cpuSystem15m * 100).toFixed(1)}%` +
      paint("  (1m/15m)", C.dim, c) +
      `  cores ${s.cpuThreads}` +
      (s.cpuThreads > 0 ? paint(`  ≈ ${(s.cpuProcess1m * s.cpuThreads).toFixed(1)} cores busy`, C.dim, c) : ""),
  );
  if (s.cpuModel) out.push(`${" ".repeat(11)}${paint(s.cpuModel, C.dim, c)}`);

  // ── memory
  section("Memory");
  const heapFill = r.heap.max > 0 ? r.heap.used / r.heap.max : 0;
  out.push(
    `  ${label("heap")} ${fmtBytes(r.heap.used)} used / ${fmtBytes(r.heap.committed)} committed / ${fmtBytes(r.heap.max)} max` +
      paint(` (${(heapFill * 100).toFixed(1)}%)`, heapFill >= 0.9 ? C.red : heapFill >= 0.75 ? C.yellow : C.green, c),
  );
  out.push(`  ${label("non-heap")} ${fmtBytes(r.nonHeap.used)} used / ${fmtBytes(r.nonHeap.committed)} committed`);
  for (const pool of r.pools) {
    const after = pool.afterGc.used > 0 ? paint(`   after last GC ${fmtBytes(pool.afterGc.used)}`, C.dim, c) : "";
    out.push(`    ${pool.name.padEnd(28)} ${fmtBytes(pool.usage.used).padStart(9)} / ${fmtBytes(pool.usage.committed).padStart(9)}${after}`);
  }
  const allocs = (
    [
      ["1m", r.alloc.last1m],
      ["5m", r.alloc.last5m],
      ["15m", r.alloc.last15m],
    ] as const
  ).filter(([, a]) => a && a.mean > 0);
  if (allocs.length > 0) {
    out.push(`  ${label("alloc")} ` + allocs.map(([k, a]) => `${k} ${fmtBytes(a!.mean)}/s (p95 ${fmtBytes(a!.p95)}/s)`).join("   "));
    const a = allocs[allocs.length - 1][1]!;
    if (r.players > 0) {
      out.push(`  ${" ".repeat(10)} ${paint(`≈ ${fmtBytes(a.mean / r.players)}/s per player`, C.dim, c)}`);
    }
  }
  if (s.memTotal > 0) {
    out.push(
      `  ${label("host")} ${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}` +
        (r.swap.total > 0 ? `   swap ${fmtBytes(r.swap.used)} / ${fmtBytes(r.swap.total)}` : "") +
        (r.disk.total > 0 ? `   disk ${fmtBytes(r.disk.used)} / ${fmtBytes(r.disk.total)}` : ""),
    );
  }

  // ── GC
  if (r.gc.length > 0) {
    section("GC (since start)");
    out.push(paint(`  ${"collector".padEnd(28)} ${"count".padStart(8)} ${"avg time".padStart(9)} ${"every".padStart(8)} ${"duty".padStart(6)}`, C.dim, c));
    for (const g of r.gc) {
      const duty = gcDuty(g);
      const dutyCol = duty >= 0.5 ? C.red : duty >= 0.2 ? C.yellow : C.reset;
      out.push(
        `  ${g.name.padEnd(28)} ${fmtInt(g.total).padStart(8)} ${fmtMs(g.avgTime).padStart(9)} ${fmtMs(g.avgFrequency).padStart(8)} ` +
          paint(`${(duty * 100).toFixed(1)}%`.padStart(6), dutyCol, c),
      );
    }
    out.push(paint("  duty = avg time / interval: wall-time share the collector runs (concurrent cycles: GC threads, not pauses)", C.dim, c));
  }

  // ── network
  const nets = r.net.filter((n) => n.iface !== "lo" && (n.rxBytes?.mean ?? 0) + (n.txBytes?.mean ?? 0) > 0);
  if (nets.length > 0) {
    section("Network");
    for (const n of nets) {
      out.push(
        `  ${n.iface.padEnd(8)} rx ${fmtBytes(n.rxBytes.mean)}/s (p95 ${fmtBytes(n.rxBytes.p95)}/s, ${fmtInt(n.rxPackets.mean)} pkt/s)` +
          `   tx ${fmtBytes(n.txBytes.mean)}/s (p95 ${fmtBytes(n.txBytes.p95)}/s, ${fmtInt(n.txPackets.mean)} pkt/s)`,
      );
      if (r.players > 0) {
        out.push(
          paint(
            `  ${" ".repeat(8)} ≈ ${fmtBytes(n.txBytes.mean / r.players)}/s tx and ${fmtInt(n.txPackets.mean / r.players)} pkt/s per player`,
            C.dim,
            c,
          ),
        );
      }
    }
  }

  // ── windows
  if (r.windows.length > 0) {
    section(`Windows (${r.windows.length} — cpu process/system · tps · mspt med/max · players · entities · chunks):`);
    for (const w of r.windows) {
      out.push(
        `  #${String(w.id).padEnd(3)} ${(w.durationMs / 1000).toFixed(0).padStart(4)}s` +
          `  cpu ${(w.cpuProcess * 100).toFixed(1).padStart(5)}% / ${(w.cpuSystem * 100).toFixed(1).padStart(5)}%` +
          `  tps ${paint(w.tps.toFixed(2), tpsColor(w.tps, r.tps?.target ?? 20), c)}` +
          `  mspt ${w.msptMedian.toFixed(2)} / ${fmtMs(w.msptMax).padStart(6)}` +
          `  players ${String(w.players).padStart(4)}  entities ${fmtInt(w.entities).padStart(6)}  chunks ${fmtInt(w.chunks).padStart(6)}`,
      );
    }
  }

  // ── history sparklines
  if (r.series.length > 0) {
    section("History (metrics series, max per bucket):");
    for (const sr of r.series) {
      const lo = Math.min(...sr.values);
      const hi = Math.max(...sr.values);
      out.push(`  ${sr.name.padEnd(12)} ${sparkline(sr.values, 60)}  ${paint(`${fmtUnit(lo, sr.unit)} → ${fmtUnit(hi, sr.unit)}`, C.dim, c)}`);
    }
  }

  // ── entities
  if (r.entities.total > 0) {
    section(`Entities (${fmtInt(r.entities.total)} across ${r.entities.worlds.length} worlds):`);
    out.push(`  ${paint("by type :", C.dim, c)} ${topCounts(r.entities.counts, 12)}`);
    out.push(paint(`  top worlds:`, C.dim, c));
    for (const w of r.entities.worlds.slice(0, Math.min(opts.top, 15))) {
      out.push(`    ${String(w.total).padStart(6)}  ${w.name}  ${paint(topCounts(w.counts, 4), C.dim, c)}`);
    }
    out.push(paint(`  top chunks:`, C.dim, c));
    for (const ch of r.entities.chunks.slice(0, Math.min(opts.top, 10))) {
      out.push(`    ${String(ch.total).padStart(6)}  ${ch.world} [${ch.x}, ${ch.z}]  ${paint(topCounts(ch.counts, 4), C.dim, c)}`);
    }
  }

  // ── JVM
  section("JVM");
  if (r.java) out.push(`  ${label("java")} ${r.java}`);
  if (r.os) out.push(`  ${label("os")} ${r.os}`);
  if (r.vmArgs) {
    out.push(`  ${label("vm args")}`);
    let line = "    ";
    for (const a of r.vmArgs.split(/\s+/).filter(Boolean)) {
      if (line.length + a.length > 100) {
        out.push(line);
        line = "    ";
      }
      line += a + " ";
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  if (r.sources.length > 0) {
    out.push(`  ${label("sources")} ${r.sources.map((x) => `${x.name}${x.version ? ` ${x.version}` : ""}`).join(", ")}`);
  }
  if (r.configs.length > 0) out.push(`  ${label("configs")} ${r.configs.join(", ")}`);

  return out.join("\n");
}

function renderHealthJson(r: HealthReport, opts: HealthOptions): string {
  return JSON.stringify(
    {
      kind: "health",
      ...r,
      gc: r.gc.map((g) => ({ ...g, duty: gcDuty(g) })),
      entities: {
        ...r.entities,
        worlds: r.entities.worlds.slice(0, opts.top),
        chunks: r.entities.chunks.slice(0, opts.top),
      },
    },
    null,
    2,
  );
}
