import type { Thread, StackNode } from "./parse.js";
import { formatPct } from "./analyze.js";

/**
 * Bin every frame in a thread's call tree by package prefix. Surfaces
 * cumulative cost of plugins / libraries whose individual frames are
 * each well below the top-N cutoff of the regular hot-spots view.
 *
 * Self-time is summed (each sample credits exactly one frame). Inclusive
 * is also summed but we deliberately *don't* dedup by stack — for a
 * namespace rollup the question is "how much wall-time has any frame in
 * this namespace on the stack", which inherently double-counts when a
 * namespace appears nested in itself (e.g. CompletableFuture chains).
 * Two columns side-by-side make this obvious.
 */
export interface NamespaceBucket {
  prefix: string;
  /** Friendly label, e.g. "Paper" or "Scala (gg.scala.*)". */
  label: string;
  self: number;
  inclusive: number;
  /** Distinct (class, method) pairs that hit this bucket. */
  uniqueFrames: number;
  /** Top 3 frames inside the bucket by self-time. */
  topFrames: Array<{ className: string; methodName: string; self: number }>;
}

/**
 * Ordered: longer / more specific prefixes first. The first match wins,
 * so e.g. `com.mongodb.client` (specific) is checked before
 * `com.mongodb` (generic).
 */
const DEFAULT_RULES: Array<{ prefix: string; label: string }> = [
  // -- Paper / Spigot / Bukkit core --------------------------------------------
  { prefix: "net.minecraft.", label: "Minecraft (vanilla)" },
  { prefix: "io.papermc.paper.", label: "Paper (io.papermc.paper)" },
  { prefix: "io.papermc.", label: "Paper (io.papermc)" },
  { prefix: "com.destroystokyo.paper.", label: "Paper (legacy)" },
  { prefix: "org.bukkit.craftbukkit.", label: "CraftBukkit" },
  { prefix: "org.bukkit.", label: "Bukkit API" },
  { prefix: "org.spigotmc.", label: "Spigot" },

  // -- Moonrise / chunk system / async patches ---------------------------------
  { prefix: "ca.spottedleaf.moonrise.", label: "Moonrise" },
  { prefix: "ca.spottedleaf.", label: "ca.spottedleaf.*" },

  // -- Known fork branding -----------------------------------------------------
  { prefix: "com.universespigot.", label: "UniverseSpigot" },
  { prefix: "com.infernalsuite.", label: "InfernalSuite (ASP/SWM)" },

  // -- Common third-party plugin packages --------------------------------------
  { prefix: "ac.grim.", label: "GrimAC (anti-cheat)" },
  { prefix: "com.comphenix.protocol.", label: "ProtocolLib" },
  { prefix: "com.github.retrooper.packetevents.", label: "PacketEvents" },
  { prefix: "io.github.retrooper.packetevents.", label: "PacketEvents" },
  { prefix: "me.clip.placeholderapi.", label: "PlaceholderAPI" },
  { prefix: "net.coreprotect.", label: "CoreProtect" },
  { prefix: "com.coreprotect.", label: "CoreProtect" },
  { prefix: "com.sk89q.worldedit.", label: "WorldEdit" },
  { prefix: "com.sk89q.worldguard.", label: "WorldGuard" },
  { prefix: "me.angeschossen.lands.", label: "Lands" },
  { prefix: "net.william278.husktowns.", label: "HuskTowns" },
  { prefix: "com.viaversion.", label: "ViaVersion" },
  { prefix: "us.myles.viaversion.", label: "ViaVersion (legacy)" },
  { prefix: "co.aikar.commands.", label: "ACF (commands)" },
  { prefix: "me.lucko.spark.", label: "spark (profiler)" },
  { prefix: "me.lucko.helper.", label: "helper" },
  { prefix: "net.evilblock.cubed.", label: "Cubed" },
  { prefix: "com.mongodb.", label: "MongoDB driver" },
  { prefix: "redis.clients.jedis.", label: "Jedis (redis)" },
  { prefix: "com.cryptomorin.xseries.", label: "XSeries" },

  // -- Project-specific (Arch fleet) -------------------------------------------
  { prefix: "gg.scala.", label: "Scala (gg.scala.*)" },
  { prefix: "lol.arch.survival.rootkit.", label: "Rootkit (lol.arch.survival)" },
  { prefix: "lol.arch.", label: "lol.arch.*" },
  { prefix: "xyz.connorchickenway.stella.", label: "Stella (tab)" },
  { prefix: "gg.tropic.", label: "tropic.*" },
  { prefix: "mc.arch.", label: "mc.arch.*" },
  { prefix: "dev.reximian9k.", label: "reximian9k (spigot fork)" },

  // -- JDK / Netty / runtime ---------------------------------------------------
  { prefix: "io.netty.", label: "Netty" },
  { prefix: "java.util.concurrent.", label: "java.util.concurrent" },
  { prefix: "java.lang.invoke.", label: "java.lang.invoke (MethodHandle)" },
  { prefix: "java.util.", label: "java.util" },
  { prefix: "java.lang.", label: "java.lang" },
  { prefix: "java.io.", label: "java.io" },
  { prefix: "java.nio.", label: "java.nio" },
  { prefix: "jdk.internal.", label: "jdk.internal" },
  { prefix: "sun.", label: "sun.*" },
  { prefix: "it.unimi.dsi.fastutil.", label: "fastutil" },
  { prefix: "com.google.common.", label: "Guava" },
  { prefix: "com.google.gson.", label: "Gson" },

  // -- Native / JVM internals --------------------------------------------------
  { prefix: "native.", label: "Native (JVM internals)" },
  { prefix: "/usr/lib", label: "libc / OS" },
];

function sumTimes(times: number[]): number {
  let s = 0;
  for (const v of times) s += v;
  return s;
}

function lookupPrefix(
  className: string,
  rules: Array<{ prefix: string; label: string }>,
): { prefix: string; label: string } {
  for (const r of rules) {
    if (className.startsWith(r.prefix)) return r;
  }
  // Fall through: synthesize a label from the leading 2 segments.
  const parts = className.split(".");
  if (parts.length >= 2) {
    const prefix = `${parts[0]}.${parts[1]}.`;
    return { prefix, label: `(other) ${prefix}*` };
  }
  return { prefix: className || "(unknown)", label: className || "(unknown)" };
}

export function aggregateByNamespace(
  thread: Thread,
  rules: Array<{ prefix: string; label: string }> = DEFAULT_RULES,
): NamespaceBucket[] {
  const buckets = new Map<
    string,
    {
      bucket: NamespaceBucket;
      // running top-3 by self for each bucket
      contributors: Map<string, { className: string; methodName: string; self: number }>;
    }
  >();

  for (const n of thread.nodes) {
    if (!n.className) continue;
    const { prefix, label } = lookupPrefix(n.className, rules);

    const inclusive = sumTimes(n.times);
    let childTotal = 0;
    for (const ref of n.childrenRefs) {
      const c = thread.nodes[ref];
      if (c) childTotal += sumTimes(c.times);
    }
    const self = Math.max(0, inclusive - childTotal);

    let entry = buckets.get(prefix);
    if (!entry) {
      entry = {
        bucket: { prefix, label, self: 0, inclusive: 0, uniqueFrames: 0, topFrames: [] },
        contributors: new Map(),
      };
      buckets.set(prefix, entry);
    }
    entry.bucket.self += self;
    entry.bucket.inclusive += inclusive;

    const fkey = `${n.className}#${n.methodName}`;
    const existingContrib = entry.contributors.get(fkey);
    if (existingContrib) {
      existingContrib.self += self;
    } else {
      entry.contributors.set(fkey, {
        className: n.className,
        methodName: n.methodName,
        self,
      });
      entry.bucket.uniqueFrames += 1;
    }
  }

  return [...buckets.values()].map(({ bucket, contributors }) => ({
    ...bucket,
    topFrames: [...contributors.values()]
      .sort((a, b) => b.self - a.self)
      .slice(0, 3),
  }));
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

function paint(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${C.reset}` : s;
}

export function renderNamespaces(
  buckets: NamespaceBucket[],
  threadTotal: number,
  opts: { top: number; color: boolean; minPct: number },
): string {
  const sorted = [...buckets].sort((a, b) => b.self - a.self);

  const out: string[] = [];
  out.push(paint("─── namespace rollup (self-time per package) ───────────", C.cyan, opts.color));
  out.push(
    paint(
      `${"self%".padStart(7)}  ${"incl%".padStart(7)}  ${"frames".padStart(6)}  bucket`,
      C.dim,
      opts.color,
    ),
  );

  let shown = 0;
  for (const b of sorted) {
    const selfPct = (b.self / (threadTotal || 1)) * 100;
    const inclPct = (b.inclusive / (threadTotal || 1)) * 100;
    if (selfPct < opts.minPct) continue;
    if (shown >= opts.top) break;
    shown++;

    const selfCol = selfPct >= 5 ? C.red : selfPct >= 1 ? C.yellow : C.dim;
    out.push(
      `${paint(formatPct(selfPct).padStart(7), selfCol, opts.color)}  ` +
        `${paint(formatPct(inclPct).padStart(7), C.dim, opts.color)}  ` +
        `${String(b.uniqueFrames).padStart(6)}  ${paint(b.label, C.bold, opts.color)}`,
    );

    // Top contributors inside this bucket — useful for "ok, gg.scala.* is hot,
    // but which class specifically?"
    for (const tf of b.topFrames) {
      if (tf.self === 0) continue;
      const tfPct = (tf.self / (threadTotal || 1)) * 100;
      if (tfPct < 0.01) continue;
      out.push(
        paint(
          `         ${formatPct(tfPct).padStart(7)}            └─ ${shortenClass(tf.className)}.${tf.methodName}`,
          C.dim,
          opts.color,
        ),
      );
    }
  }

  if (sorted.length > shown) {
    out.push(
      paint(
        `  ... +${sorted.length - shown} more buckets below ${opts.minPct}% / top-${opts.top}`,
        C.dim,
        opts.color,
      ),
    );
  }

  return out.join("\n");
}

function shortenClass(cls: string): string {
  if (!cls.includes(".")) return cls;
  const parts = cls.split(".");
  const last = parts.pop()!;
  return parts.map((p) => p[0] ?? "").join(".") + "." + last;
}
