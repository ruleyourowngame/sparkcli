import type { Thread } from "./parse.js";
import { formatPct, shortClass } from "./analyze.js";

// Batch descendants of the TUI's tree view: `--tree` prints the call tree
// top-down with a min-pct cutoff, `--focus SUBSTR` roots the view at every
// frame matching a substring — who calls it (full chains) and what runs
// beneath it. Both existed as ad-hoc _tree.mjs/_focus.mjs scripts before.

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

function sumTimes(times: number[]): number {
  let s = 0;
  for (const v of times) s += v;
  return s;
}

function frameName(thread: Thread, ref: number): string {
  const n = thread.nodes[ref]!;
  return `${shortClass(n.className || "?")}.${n.methodName || "?"}`;
}

export function renderTree(
  thread: Thread,
  opts: { color: boolean; minPct: number; depth: number },
): string {
  const c = opts.color;
  const total = thread.total || 1;
  const out: string[] = [];
  out.push(paint(`─── call tree — "${thread.name}" (min ${opts.minPct}%, depth ${opts.depth}) ───`, C.cyan, c));

  const walk = (refs: number[], depth: number) => {
    if (depth >= opts.depth) return;
    const sorted = [...refs].sort(
      (a, b) => sumTimes(thread.nodes[b]!.times) - sumTimes(thread.nodes[a]!.times),
    );
    for (const ref of sorted) {
      const n = thread.nodes[ref]!;
      const pct = (sumTimes(n.times) / total) * 100;
      if (pct < opts.minPct) continue;
      const col = pct >= 20 ? C.red : pct >= 5 ? C.yellow : pct >= 1 ? "" : C.dim;
      out.push(
        `${paint(formatPct(pct).padStart(7), col, c)}  ${"  ".repeat(depth)}${frameName(thread, ref)}`,
      );
      walk(n.childrenRefs, depth + 1);
    }
  };
  walk(thread.childrenRefs, 0);
  return out.join("\n");
}

/** Parent index for every node reachable from the thread roots (-1 = root). */
function buildParents(thread: Thread): Int32Array {
  const parents = new Int32Array(thread.nodes.length).fill(-1);
  const stack = [...thread.childrenRefs];
  const seen = new Set<number>(stack);
  while (stack.length > 0) {
    const ref = stack.pop()!;
    const n = thread.nodes[ref];
    if (!n) continue;
    for (const cref of n.childrenRefs) {
      if (!seen.has(cref)) {
        seen.add(cref);
        parents[cref] = ref;
        stack.push(cref);
      }
    }
  }
  return parents;
}

export function renderFocus(
  thread: Thread,
  focus: string,
  opts: { color: boolean; minPct: number; depth: number; top: number },
): string {
  const c = opts.color;
  const total = thread.total || 1;
  const needle = focus.toLowerCase();
  const matchesNeedle = (ref: number): boolean => {
    const n = thread.nodes[ref]!;
    return `${n.className}.${n.methodName}`.toLowerCase().includes(needle);
  };

  // Topmost matching nodes: don't double-count a frame nested under itself.
  const hits: number[] = [];
  const stack = [...thread.childrenRefs];
  const fromRoot = new Set<number>(stack);
  while (stack.length > 0) {
    const ref = stack.pop()!;
    const n = thread.nodes[ref];
    if (!n) continue;
    if (matchesNeedle(ref)) {
      hits.push(ref);
      continue;
    }
    for (const cref of n.childrenRefs) {
      if (!fromRoot.has(cref)) {
        fromRoot.add(cref);
        stack.push(cref);
      }
    }
  }
  hits.sort((a, b) => sumTimes(thread.nodes[b]!.times) - sumTimes(thread.nodes[a]!.times));

  const out: string[] = [];
  const focusTotal = hits.reduce((s, r) => s + sumTimes(thread.nodes[r]!.times), 0);
  out.push(
    paint(`─── focus "${focus}" — "${thread.name}" ───`, C.cyan, c) +
      `  ${paint(formatPct((focusTotal / total) * 100), focusTotal / total >= 0.05 ? C.red : C.bold, c)} of thread across ${hits.length} call site${hits.length === 1 ? "" : "s"}`,
  );
  if (hits.length === 0) return out.join("\n");

  const parents = buildParents(thread);

  out.push("");
  out.push(paint(`Caller chains (top ${Math.min(hits.length, opts.top)} by inclusive):`, C.bold, c));
  for (const ref of hits.slice(0, opts.top)) {
    const pct = (sumTimes(thread.nodes[ref]!.times) / total) * 100;
    const chain: number[] = [];
    for (let p = ref; p !== -1; p = parents[p]!) chain.push(p);
    chain.reverse(); // root → match
    const shown = chain.slice(-12);
    out.push(`  ${paint(formatPct(pct).padStart(7), pct >= 5 ? C.red : pct >= 1 ? C.yellow : C.dim, c)}  ${chain.length > shown.length ? "… " : ""}${shown.map((r) => frameName(thread, r)).join(paint(" → ", C.gray, c))}`);
  }

  // Merged subtree: what actually runs beneath the focus frame(s).
  out.push("");
  out.push(paint(`Merged tree below focus (min ${opts.minPct}% of thread, depth ${opts.depth}):`, C.bold, c));
  // Aggregate children of all hits by frame identity, level by level.
  type Group = { label: string; time: number; childRefs: number[] };
  const groupChildren = (refs: number[]): Group[] => {
    const map = new Map<string, Group>();
    for (const ref of refs) {
      const n = thread.nodes[ref]!;
      for (const cref of n.childrenRefs) {
        const cn = thread.nodes[cref];
        if (!cn) continue;
        const label = `${cn.className}#${cn.methodName}`;
        const g = map.get(label);
        const t = sumTimes(cn.times);
        if (g) {
          g.time += t;
          g.childRefs.push(cref);
        } else {
          map.set(label, { label, time: t, childRefs: [cref] });
        }
      }
    }
    return [...map.values()].sort((a, b) => b.time - a.time);
  };
  const walkMerged = (refs: number[], depth: number) => {
    if (depth >= opts.depth) return;
    for (const g of groupChildren(refs)) {
      const pct = (g.time / total) * 100;
      if (pct < opts.minPct) continue;
      const col = pct >= 20 ? C.red : pct >= 5 ? C.yellow : pct >= 1 ? "" : C.dim;
      const first = thread.nodes[g.childRefs[0]!]!;
      out.push(
        `${paint(formatPct(pct).padStart(7), col, c)}  ${"  ".repeat(depth)}${shortClass(first.className || "?")}.${first.methodName || "?"}`,
      );
      walkMerged(g.childRefs, depth + 1);
    }
  };
  walkMerged(hits, 0);

  return out.join("\n");
}
