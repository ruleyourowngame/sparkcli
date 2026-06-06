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

  const sys = meta.systemStatistics ?? {};
  const cpu = sys.cpu ?? {};
  const physical = sys.memory?.physical ?? {};
  const system: SystemStats = {
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
