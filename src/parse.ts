import { fileURLToPath } from "node:url";
import path from "node:path";
import protobuf from "protobufjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.resolve(here, "proto");

export interface StackNode {
  className: string;
  methodName: string;
  lineNumber: number;
  parentLineNumber: number;
  methodDesc: string;
  times: number[];
  childrenRefs: number[];
}

export interface Thread {
  name: string;
  times: number[];
  childrenRefs: number[];
  nodes: StackNode[];
  total: number;
}

export interface PlatformInfo {
  name: string;
  version: string;
  minecraftVersion: string;
  brand: string;
}

export interface Stats {
  tps1m: number;
  tps5m: number;
  tps15m: number;
  msptMedian: number;
  msptP95: number;
  msptMax: number;
  players: number;
}

// CPU / memory of the whole JVM process & host, from SamplerMetadata.system_statistics.
// Usage values are fractions (0..1) — e.g. 0.88 == 88% of the available cores.
export interface SystemStats {
  cpuProcess1m: number;
  cpuProcess15m: number;
  cpuSystem1m: number;
  cpuSystem15m: number;
  cpuThreads: number; // cores/threads visible to the process (cgroup-capped)
  cpuModel: string;
  memUsed: number;
  memTotal: number;
  uptime: number;
}

// One profiling window (~1 min) from time_window_statistics — a CPU/TPS time series.
export interface WindowStat {
  id: number;
  cpuProcess: number;
  cpuSystem: number;
  tps: number;
  msptMedian: number;
  msptMax: number;
  players: number;
  durationMs: number;
}

export interface Report {
  origin: string;
  platform: PlatformInfo;
  stats: Stats;
  system: SystemStats;
  windows: WindowStat[];
  startTime: number;
  endTime: number;
  numberOfTicks: number;
  interval: number;
  samplerMode: string;
  samplerEngine: string;
  threads: Thread[];
}

let cachedRoot: protobuf.Root | null = null;

async function loadProto(): Promise<protobuf.Root> {
  if (cachedRoot) return cachedRoot;
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => {
    const base = path.basename(target);
    return path.resolve(PROTO_DIR, base);
  };
  await root.load(
    [
      path.join(PROTO_DIR, "spark.proto"),
      path.join(PROTO_DIR, "spark_sampler.proto"),
      path.join(PROTO_DIR, "spark_heap.proto"),
    ],
    { keepCase: false },
  );
  cachedRoot = root;
  return root;
}

const SAMPLER_MODE = ["EXECUTION", "ALLOCATION"];
const SAMPLER_ENGINE = ["JAVA", "ASYNC"];

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof v === "object" && "toNumber" in (v as any)) return (v as any).toNumber();
  return 0;
}

function sumArr(a: number[] | undefined): number {
  if (!a) return 0;
  let s = 0;
  for (const v of a) s += v;
  return s;
}

// Pull the host CPU/memory block out of a decoded SystemStatistics object.
// Shared by sampler and heap reports — both embed the same message.
export function extractSystemStats(sys: any): SystemStats {
  const cpu = sys.cpu ?? {};
  const physical = sys.memory?.physical ?? {};
  return {
    cpuProcess1m: cpu.processUsage?.last1m ?? 0,
    cpuProcess15m: cpu.processUsage?.last15m ?? 0,
    cpuSystem1m: cpu.systemUsage?.last1m ?? 0,
    cpuSystem15m: cpu.systemUsage?.last15m ?? 0,
    cpuThreads: cpu.threads ?? 0,
    cpuModel: cpu.modelName ?? "",
    memUsed: num(physical.used),
    memTotal: num(physical.total),
    uptime: num(sys.uptime),
  };
}

export async function parse(origin: string, bytes: Uint8Array): Promise<Report> {
  const root = await loadProto();
  const SamplerData = root.lookupType("spark.SamplerData");
  const msg = SamplerData.decode(bytes);
  const data = SamplerData.toObject(msg, {
    longs: Number,
    enums: Number,
    defaults: true,
    arrays: true,
    objects: true,
  }) as any;

  const meta = data.metadata ?? {};
  const platformMeta = meta.platformMetadata ?? {};
  const platformStats = meta.platformStatistics ?? {};
  const tps = platformStats.tps ?? {};
  const mspt = platformStats.mspt ?? {};
  const msptLast1m = mspt.last1m ?? {};

  const system = extractSystemStats(meta.systemStatistics ?? {});

  const tw = data.timeWindowStatistics ?? {};
  const windows: WindowStat[] = Object.keys(tw)
    .map((k) => {
      const w = tw[k] ?? {};
      return {
        id: Number(k),
        cpuProcess: w.cpuProcess ?? 0,
        cpuSystem: w.cpuSystem ?? 0,
        tps: w.tps ?? 0,
        msptMedian: w.msptMedian ?? 0,
        msptMax: w.msptMax ?? 0,
        players: w.players ?? 0,
        durationMs: w.duration ?? 0,
      };
    })
    .sort((a, b) => a.id - b.id);

  const threads: Thread[] = (data.threads ?? []).map((t: any) => {
    const nodes: StackNode[] = (t.children ?? []).map((n: any) => ({
      className: n.className ?? "",
      methodName: n.methodName ?? "",
      lineNumber: n.lineNumber ?? 0,
      parentLineNumber: n.parentLineNumber ?? 0,
      methodDesc: n.methodDesc ?? "",
      times: (n.times ?? []) as number[],
      childrenRefs: (n.childrenRefs ?? []) as number[],
    }));
    const times = (t.times ?? []) as number[];
    return {
      name: t.name ?? "",
      times,
      childrenRefs: (t.childrenRefs ?? []) as number[],
      nodes,
      total: sumArr(times),
    };
  });

  threads.sort((a, b) => b.total - a.total);

  return {
    origin,
    platform: {
      name: platformMeta.name ?? "",
      version: platformMeta.version ?? "",
      minecraftVersion: platformMeta.minecraftVersion ?? "",
      brand: platformMeta.brand ?? "",
    },
    stats: {
      tps1m: tps.last1m ?? 0,
      tps5m: tps.last5m ?? 0,
      tps15m: tps.last15m ?? 0,
      msptMedian: msptLast1m.median ?? 0,
      msptP95: msptLast1m.percentile95 ?? 0,
      msptMax: msptLast1m.max ?? 0,
      players: num(platformStats.playerCount),
    },
    system,
    windows,
    startTime: num(meta.startTime),
    endTime: num(meta.endTime),
    numberOfTicks: meta.numberOfTicks ?? 0,
    interval: meta.interval ?? 0,
    samplerMode: SAMPLER_MODE[meta.samplerMode ?? 0] ?? "?",
    samplerEngine: SAMPLER_ENGINE[meta.samplerEngine ?? 0] ?? "?",
    threads,
  };
}

// ── Heap summary (application/x-spark-heap) ─────────────────────────────────
// A heap *summary* is the JVM's class histogram (à la `jmap -histo`/
// `GC.class_histogram`): one row per class with live instance count and the
// shallow byte size they occupy. It is NOT a full heap dump — there are no
// reference graphs — but it's exactly what you want to answer "what is eating
// the heap and why are we pinned near -Xmx".

export interface HeapEntry {
  /** 1-based rank as spark emitted it (already sorted by size desc). */
  order: number;
  /** Live instance count for this class. */
  instances: number;
  /** Shallow bytes occupied by all those instances. */
  size: number;
  /** Class name, e.g. "byte[]" or "net.minecraft.server.v1_8_R3.Chunk". */
  type: string;
}

export interface GcStat {
  name: string;
  /** Total collections since start. */
  total: number;
  /** Average pause time in ms. */
  avgTime: number;
  /** Average ms between collections. */
  avgFrequency: number;
}

export interface HeapReport {
  origin: string;
  platform: PlatformInfo;
  system: SystemStats;
  players: number;
  /** Epoch ms when the summary was taken. */
  generatedTime: number;
  // JVM managed-heap pool (the pool governed by -Xmx). `max` is the cap that
  // "hitting 4gb" refers to; `used` is live + garbage not yet collected.
  heapUsed: number;
  heapCommitted: number;
  heapInit: number;
  heapMax: number;
  nonHeapUsed: number;
  gc: GcStat[];
  /** Class histogram, sorted by size desc. */
  entries: HeapEntry[];
  totalInstances: number;
  totalSize: number;
}

export async function parseHeap(origin: string, bytes: Uint8Array): Promise<HeapReport> {
  const root = await loadProto();
  const HeapData = root.lookupType("spark.HeapData");
  const msg = HeapData.decode(bytes);
  const data = HeapData.toObject(msg, {
    longs: Number,
    enums: Number,
    defaults: true,
    arrays: true,
    objects: true,
  }) as any;

  const meta = data.metadata ?? {};
  const platformMeta = meta.platformMetadata ?? {};
  const platformStats = meta.platformStatistics ?? {};
  const heap = platformStats.memory?.heap ?? {};
  const nonHeap = platformStats.memory?.nonHeap ?? {};

  const gc: GcStat[] = Object.entries(platformStats.gc ?? {}).map(
    ([name, g]: [string, any]) => ({
      name,
      total: num(g.total),
      avgTime: g.avgTime ?? 0,
      avgFrequency: g.avgFrequency ?? 0,
    }),
  );

  const entries: HeapEntry[] = (data.entries ?? [])
    .map((e: any) => ({
      order: e.order ?? 0,
      instances: num(e.instances),
      size: num(e.size),
      type: e.type ?? "",
    }))
    .sort((a: HeapEntry, b: HeapEntry) => b.size - a.size);

  let totalInstances = 0;
  let totalSize = 0;
  for (const e of entries) {
    totalInstances += e.instances;
    totalSize += e.size;
  }

  return {
    origin,
    platform: {
      name: platformMeta.name ?? "",
      version: platformMeta.version ?? "",
      minecraftVersion: platformMeta.minecraftVersion ?? "",
      brand: platformMeta.brand ?? "",
    },
    system: extractSystemStats(meta.systemStatistics ?? {}),
    players: num(platformStats.playerCount),
    generatedTime: num(meta.generatedTime),
    heapUsed: num(heap.used),
    heapCommitted: num(heap.committed),
    heapInit: num(heap.init),
    heapMax: num(heap.max),
    nonHeapUsed: num(nonHeap.used),
    gc,
    entries,
    totalInstances,
    totalSize,
  };
}
