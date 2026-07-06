import type { Report, StackNode, Thread } from "./parse.js";
import { isIdleFrame } from "./busy.js";
import { formatPct, shortClass } from "./analyze.js";

/**
 * Source (plugin/mod) attribution.
 *
 * Spark reports carry class_sources: className -> plugin name, resolved
 * server-side from each class's protection domain. That map is the only
 * reliable way to attribute obfuscated plugin code (package `a.b`, classes
 * renamed to `aSG`) — package-prefix heuristics can't.
 *
 * aggregateBySource() walks every thread's busy subtree and credits each
 * frame's SELF time to the nearest enclosing attribution:
 *   - deepest frame with a class_sources entry wins (plugin calling into
 *     NMS/OBC credits the plugin, not the server);
 *   - unattributed Java frames outside any plugin bucket by package;
 *   - pure-native stacks (threads spawned by a native lib — no Java frames
 *     at all) bucket by the first non-generic shared object on the path, so
 *     an extracted `/tmp/loaderXXX.tmp` shows up by name instead of melting
 *     into "libc".
 */

export function sourceOfClass(report: Report, className: string): string | null {
  if (!className) return null;
  const direct = report.classSources[className];
  if (direct) return direct;
  // lambdas & inner classes: Foo$$Lambda$12 / Foo$Bar -> Foo
  const dollar = className.indexOf("$");
  if (dollar > 0) {
    const outer = report.classSources[className.slice(0, dollar)];
    if (outer) return outer;
  }
  return null;
}

// Generic system objects that should never *become* an attribution: they are
// plumbing every stack passes through.
const GENERIC_NATIVE =
  /^(libc\.so|libc-|libm\.so|libpthread|librt\.so|ld-linux|linux-vdso|\[vdso\]|libjvm\.so|libjava\.so|libjli\.so|libnio\.so|libnet\.so|libzip\.so|libverify\.so|native$|unknown$|\?+$)/;

// A frame whose "class" is really a native image path / soname, e.g.
// "libc.so.6", "/tmp/loader123.tmp", "/usr/lib/.../libzstd.so".
function nativeLibName(className: string, methodName: string): string | null {
  const looksNative = (s: string) =>
    s.startsWith("/") || s.includes(".so") || s.endsWith(".tmp") || s === "native";
  if (looksNative(className)) {
    // spark encodes some native frames as class "native" + method "<path>"
    const lib = className === "native" ? methodName : className;
    const base = lib.startsWith("/") ? lib.slice(lib.lastIndexOf("/") + 1) : lib;
    return base || null;
  }
  return null;
}

function packageBucket(className: string): string {
  const parts = className.split(".");
  if (parts.length <= 1) return className;
  return parts.slice(0, Math.min(3, parts.length - 1)).join(".") + ".*";
}

export interface SourceBucket {
  /** Plugin name, "(native) libfoo.so", or "pkg.prefix.*". */
  name: string;
  /** true when the name came from class_sources (a real plugin/mod). */
  isPlugin: boolean;
  busySelf: number;
  /** Hottest self-time frame inside this bucket, for orientation. */
  topFrame: string;
  topFrameSelf: number;
  /** Hottest thread for this bucket. */
  topThread: string;
  topThreadSelf: number;
}

function sumTimes(times: number[]): number {
  let s = 0;
  for (const v of times) s += v;
  return s;
}

export function aggregateBySource(report: Report): { buckets: SourceBucket[]; busyAll: number } {
  const map = new Map<string, SourceBucket>();
  let busyAll = 0;

  const credit = (
    bucketName: string,
    isPlugin: boolean,
    self: number,
    frame: string,
    threadName: string,
  ) => {
    busyAll += self;
    let b = map.get(bucketName);
    if (!b) {
      b = {
        name: bucketName,
        isPlugin,
        busySelf: 0,
        topFrame: frame,
        topFrameSelf: 0,
        topThread: threadName,
        topThreadSelf: 0,
      };
      map.set(bucketName, b);
    }
    b.busySelf += self;
    if (self > b.topFrameSelf) {
      b.topFrameSelf = self;
      b.topFrame = frame;
    }
    if (self > b.topThreadSelf) {
      b.topThreadSelf = self;
      b.topThread = threadName;
    }
  };

  for (const t of report.threads) {
    // ctx = attribution inherited from ancestors; plugin attributions are
    // sticky (NMS called by a plugin stays the plugin's cost) until a deeper
    // class_sources hit replaces them.
    const visit = (ref: number, ctx: { name: string; isPlugin: boolean } | null) => {
      const n = t.nodes[ref];
      if (!n) return;
      if (isIdleFrame(n)) return; // idle subtree: not busy time, skip

      let next = ctx;
      const src = sourceOfClass(report, n.className);
      if (src) {
        next = { name: src, isPlugin: true };
      } else if (!ctx || !ctx.isPlugin) {
        const lib = nativeLibName(n.className, n.methodName);
        if (lib) {
          if (!GENERIC_NATIVE.test(lib)) next = { name: `(native) ${lib}`, isPlugin: false };
        } else if (n.className.includes(".")) {
          next = { name: packageBucket(n.className), isPlugin: false };
        }
      }

      const inclusive = sumTimes(n.times);
      let childTotal = 0;
      for (const cref of n.childrenRefs) {
        const c = t.nodes[cref];
        if (!c) continue;
        childTotal += sumTimes(c.times);
        visit(cref, next);
      }
      const self = Math.max(0, inclusive - childTotal);
      if (self > 0) {
        const bucket = next ?? { name: "(unattributed native)", isPlugin: false };
        credit(bucket.name, bucket.isPlugin, self, `${shortClass(n.className)}.${n.methodName}`, t.name);
      }
    };
    for (const root of t.childrenRefs) visit(root, null);
  }

  const buckets = [...map.values()].sort((a, b) => b.busySelf - a.busySelf);
  return { buckets, busyAll };
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function paint(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${C.reset}` : s;
}

export function renderSources(report: Report, opts: { color: boolean }): string {
  const c = opts.color;
  const out: string[] = [];
  out.push(paint(`─── sources — ${report.sources.length} plugins/mods ───────────────────`, C.cyan, c));
  if (report.sources.length === 0) {
    out.push(paint("report carries no plugin metadata (older spark, or disabled)", C.dim, c));
    return out.join("\n");
  }
  const nameW = Math.min(
    40,
    report.sources.reduce((w, s) => Math.max(w, s.name.length), 4),
  );
  for (const s of report.sources) {
    out.push(
      `  ${paint(s.name.padEnd(nameW), C.bold, c)}  ${s.version}${s.author ? paint(`  · ${s.author}`, C.gray, c) : ""}`,
    );
  }
  return out.join("\n");
}

export function renderBySource(
  report: Report,
  opts: { top: number; color: boolean; minPct: number },
): string {
  const c = opts.color;
  const { buckets, busyAll } = aggregateBySource(report);
  const denom = busyAll || 1;
  const out: string[] = [];
  out.push(paint("─── busy self-time by source (all threads) ────────────", C.cyan, c));
  out.push(
    paint(
      "plugin attribution via spark class_sources (sticky through NMS/native callees);",
      C.dim,
      c,
    ),
  );
  out.push(paint("non-plugin frames bucket by package or native library.", C.dim, c));
  out.push("");
  out.push(paint(`${"busy%".padStart(8)}  source  ·  hottest frame  ·  hottest thread`, C.dim, c));
  let shown = 0;
  for (const b of buckets) {
    const pct = (b.busySelf / denom) * 100;
    if (pct < opts.minPct || shown >= opts.top) continue;
    shown++;
    const col = pct >= 10 ? C.red : pct >= 3 ? C.yellow : C.dim;
    const tag = b.isPlugin ? paint(" [plugin]", C.cyan, c) : "";
    out.push(
      `${paint(formatPct(pct).padStart(8), col, c)}  ${paint(b.name, C.bold, c)}${tag}` +
        paint(`  ·  ${b.topFrame}  ·  ${b.topThread}`, C.gray, c),
    );
  }
  if (buckets.length > shown) {
    out.push(paint(`  ... +${buckets.length - shown} more below ${opts.minPct}% / top-${opts.top}`, C.dim, c));
  }
  return out.join("\n");
}

export function bySourceJson(report: Report, top: number): object {
  const { buckets, busyAll } = aggregateBySource(report);
  return {
    busyTotal: busyAll,
    buckets: buckets.slice(0, Math.max(top, 1)).map((b) => ({
      name: b.name,
      isPlugin: b.isPlugin,
      busySelf: b.busySelf,
      busyPct: (b.busySelf / (busyAll || 1)) * 100,
      topFrame: b.topFrame,
      topThread: b.topThread,
    })),
  };
}
