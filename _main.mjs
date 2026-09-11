import { load } from "./src/fetch.ts";
import { parse } from "./src/parse.ts";

const url = process.argv[2];
const src = await load(url);
const rep = await parse(src.origin, src.bytes);
const th = rep.threads.find(t => t.name.includes("Server Thread - ES"))
        || rep.threads.find(t => t.name.includes("Server thread"));
const nodes = th.nodes;
const sum = a => (a || []).reduce((x, y) => x + y, 0);
const incl = n => sum(n.times);
const self = n => incl(n) - n.childrenRefs.reduce((s, r) => s + incl(nodes[r]), 0);
const name = n => `${n.className}.${n.methodName}`;

const T = th.childrenRefs.reduce((s, r) => s + incl(nodes[r]), 0);

// find the active tick root: DedicatedServer.B (the 1.8 server tick)
let tickRoot = null;
function find(ref) {
  const n = nodes[ref];
  if (!tickRoot && (name(n).includes("DedicatedServer.B") || name(n).includes("MinecraftServer.B"))) { tickRoot = ref; return; }
  for (const r of n.childrenRefs) find(r);
}
for (const r of th.childrenRefs) find(r);

const ACTIVE = incl(nodes[tickRoot]);            // samples inside the real tick
console.log(`Server thread total samples: ${T}  (~${(T*4/1000).toFixed(1)}s wall)`);
console.log(`Active tick (${name(nodes[tickRoot])}): ${ACTIVE} samples = ${(100*ACTIVE/T).toFixed(2)}% of thread, parked = ${(100*(T-ACTIVE)/T).toFixed(2)}%`);
console.log(`Median MSPT 0.92ms => proportions below are shares of that active tick time.\n`);

// bucket self-time by subsystem across the active subtree
const buckets = {};
function categorize(n) {
  const c = n.className || "";
  const f = name(n);
  if (c.startsWith("net.minecraft.server")) {
    if (/PlayerConnection|NetworkManager|Packet|ServerConnection/.test(c)) return "NMS: packet handling";
    if (/Entity|EntityLiving|EntityHuman|EntityPlayer/.test(c)) return "NMS: entity tick";
    if (/Chunk|Block|Container|ChunkSection|ChunkProvider|World/.test(c)) return "NMS: world/chunk/block";
    if (/DataWatcher/.test(c)) return "NMS: entity metadata (DataWatcher)";
    return "NMS: other";
  }
  if (c.startsWith("org.bukkit")) {
    if (/PluginManager|RegisteredListener|HandlerList/.test(c)) return "Bukkit: event dispatch";
    if (/CraftScheduler/.test(c)) return "Bukkit: scheduler";
    return "Bukkit: other";
  }
  if (/^(gg\.scala|dev\.reximian|mc\.arch|com\.archmc|net\.evilblock|io\.github)/.test(c)) return `PLUGIN: ${c.split(".").slice(0,3).join(".")}`;
  if (c.startsWith("java.util")) return "JDK: collections";
  if (c.startsWith("java.") || c.startsWith("jdk.") || c.startsWith("sun.")) return "JDK: other";
  if (c.startsWith("native.") || c.includes("libc") || c.startsWith("l.s") || c.includes(".so")) return "native / JIT / GC stubs";
  if (c === "" || c.startsWith("p.")) return "native / JIT / GC stubs";
  return `other: ${c.split(".").slice(0,2).join(".")}`;
}
function walkSelf(ref) {
  const n = nodes[ref];
  const s = self(n);
  if (s > 0) { const k = categorize(n); buckets[k] = (buckets[k] || 0) + s; }
  for (const r of n.childrenRefs) walkSelf(r);
}
walkSelf(tickRoot);

console.log("=== Active tick CPU by subsystem (self-time, % of active tick) ===");
Object.entries(buckets).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
  if (100*v/ACTIVE < 0.3) return;
  console.log(`  ${(100*v/ACTIVE).toFixed(1).padStart(5)}%   ${k}`);
});

// also: the inclusive tree of the tick, only branches >= 3% of active
console.log("\n=== Active tick tree (inclusive, >=3% of active tick) ===");
function walk(ref, indent, d) {
  const kids = [...nodes[ref].childrenRefs].sort((a,b)=>incl(nodes[b])-incl(nodes[a]));
  for (const r of kids) {
    const k = nodes[r];
    if (100*incl(k)/ACTIVE < 3) continue;
    console.log("  ".repeat(indent) + (100*incl(k)/ACTIVE).toFixed(1).padStart(5) + "%  " + name(k));
    if (d > 0) walk(r, indent+1, d-1);
  }
}
walk(tickRoot, 1, 40);
