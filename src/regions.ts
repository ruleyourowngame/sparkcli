import type { Report, StackNode, Thread } from "./parse.js";
import { computeBusy } from "./busy.js";
import { formatPct, hotSpots, shortClass } from "./analyze.js";

/**
 * Region / thread rollups.
 *
 * On a regionised server (Grid, Folia) one region tick thread ticks many regions over the course
 * of a profile, so a thread is not a unit of work and a pool is not a workload. Our spark fork
 * tags every sampled node with the region it was taken in (`context`) and the thread it ran on
 * (`threadName`), at the finest granularity - one node per region per thread. That means a single
 * profile can be read three ways, and this module is the roll-up for the first two:
 *
 *   - by region  ("which region is eating the server")
 *   - by thread  ("is the work spread across the pool, or is one thread pinned flat")
 *   - the matrix (the raw nodes, what --all-threads already shows)
 *
 * Reports from an unmodified spark carry no context at all, in which case every function here
 * returns an empty list and the caller falls back to the plain thread view.
 */

export interface Group {
  /** Stable key: the raw context (`region/world/42`) or the thread name. */
  key: string;
  /** Human label, e.g. `Region #42 (world @ 128,-64 - 31 chunks, 84 entities)`. */
  label: string;
  /** Member nodes: one per thread (for a region group) or per region (for a thread group). */
  members: Thread[];
  total: number;
  busy: number;
  idle: number;
}

const GLOBAL_TICK = "global-tick";

/** Strips the label suffix the server appends for the finest grouping (" @ Thread #3"). */
function regionLabel(thread: Thread): string {
  const at = thread.name.lastIndexOf(" @ ");
  return at === -1 ? thread.name : thread.name.slice(0, at);
}

function collect(
  report: Report,
  keyOf: (t: Thread) => string | undefined,
  labelOf: (t: Thread) => string,
): Group[] {
  const groups = new Map<string, Group>();
  for (const thread of report.threads) {
    const key = keyOf(thread);
    if (key === undefined || key === "") continue;

    let group = groups.get(key);
    if (!group) {
      group = { key, label: labelOf(thread), members: [], total: 0, busy: 0, idle: 0 };
      groups.set(key, group);
    }
    group.members.push(thread);
    group.total += thread.total;
    group.busy += thread.busy;
    group.idle += thread.idle;
  }

  const out = [...groups.values()];
  for (const group of out) {
    group.members.sort((a, b) => b.busy - a.busy || b.total - a.total);
  }
  // busy-first, same reasoning as parse.ts: an idle region that sampled a lot of park() is not
  // the region you are looking for
  out.sort((a, b) => b.busy - a.busy || b.total - a.total);
  return out;
}

/** Groups nodes by the region they were sampled in. Empty if the report carries no contexts. */
export function groupByRegion(report: Report): Group[] {
  return collect(report, (t) => t.context, regionLabel);
}

/**
 * Groups nodes by the thread they ran on.
 *
 * Only nodes that carry a context are included: threads with no context are already one node each
 * and appear in the normal thread view, and folding them in here would just duplicate them.
 */
export function groupByThread(report: Report): Group[] {
  return collect(
    report,
    (t) => (t.context ? t.threadName : undefined),
    (t) => t.threadName ?? t.name,
  );
}

export function hasRegionData(report: Report): boolean {
  return report.threads.some((t) => !!t.context);
}

function nodeKey(n: StackNode): string {
  return `${n.className} ${n.methodName} ${n.lineNumber} ${n.parentLineNumber}`;
}

function addTimes(into: number[], from: number[]): void {
  for (let i = 0; i < from.length; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0);
}

/**
 * Merges several thread trees into one synthetic {@link Thread}, so the existing hot-spot, tree
 * and focus renderers can be pointed at a whole region rather than one region-thread pair.
 *
 * Sound because every node's `times` array is positionally indexed against the report's single
 * global `time_windows` list (spark encodes all threads against one ProtoTimeEncoder), so the
 * windows line up and merging is an elementwise add.
 */
export function mergeThreads(members: Thread[], name: string): Thread {
  if (members.length === 1) return { ...members[0]!, name };

  const nodes: StackNode[] = [];
  const childIndex: Array<Map<string, number>> = [];
  const rootRefs: number[] = [];
  const rootIndex = new Map<string, number>();
  const times: number[] = [];

  const mergeLevel = (
    src: Thread,
    srcRefs: number[],
    destRefs: number[],
    destIndex: Map<string, number>,
  ): void => {
    for (const ref of srcRefs) {
      const node = src.nodes[ref];
      if (!node) continue;

      const key = nodeKey(node);
      let idx = destIndex.get(key);
      if (idx === undefined) {
        idx = nodes.length;
        nodes.push({ ...node, times: [...node.times], childrenRefs: [] });
        childIndex.push(new Map());
        destIndex.set(key, idx);
        destRefs.push(idx);
      } else {
        addTimes(nodes[idx]!.times, node.times);
      }
      mergeLevel(src, node.childrenRefs, nodes[idx]!.childrenRefs, childIndex[idx]!);
    }
  };

  for (const member of members) {
    addTimes(times, member.times);
    mergeLevel(member, member.childrenRefs, rootRefs, rootIndex);
  }

  const merged: Thread = {
    name,
    times,
    childrenRefs: rootRefs,
    nodes,
    total: times.reduce((a, b) => a + b, 0),
    busy: 0,
    idle: 0,
  };
  const { busy, idle } = computeBusy(merged);
  merged.busy = busy;
  merged.idle = idle;
  return merged;
}

/**
 * Resolves a `--region` argument to a group.
 *
 * Accepts a bare region id (`42`), the full context (`region/world/42`), `global` for the global
 * tick, or any substring of the label.
 */
export function pickRegion(report: Report, query: string): Group | undefined {
  const groups = groupByRegion(report);
  if (groups.length === 0) return undefined;

  const q = query.trim().toLowerCase();
  if (q === "global" || q === GLOBAL_TICK) {
    return groups.find((g) => g.key === GLOBAL_TICK);
  }
  return (
    groups.find((g) => g.key.toLowerCase() === q) ??
    groups.find((g) => g.key.toLowerCase().endsWith(`/${q}`)) ??
    groups.find((g) => g.label.toLowerCase().includes(q))
  );
}

/* ------------------------------------------------------------------ rendering */

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

function shareColor(share: number): string {
  return share >= 0.4 ? C.red : share >= 0.15 ? C.yellow : C.green;
}

export interface RenderOptions {
  top: number;
  color: boolean;
  /** Include the per-member split under each group. */
  detail?: boolean;
}

function accuracyNote(report: Report, color: boolean): string[] {
  const acc = report.contextAccuracy;
  if (!acc || acc.total === 0) return [];

  const placed = acc.total - acc.ambiguous - acc.unattributed;
  const lines = [
    paint(
      `attribution : ${placed.toLocaleString()} of ${acc.total.toLocaleString()} samples placed in a region` +
        `  (${acc.unattributed.toLocaleString()} had no region - idle or non-tick work,` +
        ` ${acc.ambiguous.toLocaleString()} ambiguous)`,
      C.dim,
      color,
    ),
  ];
  // the ambiguous count is the honest error bar on everything below
  const ambiguousShare = acc.ambiguous / acc.total;
  if (ambiguousShare > 0.02) {
    lines.push(
      paint(
        `  warning: ${(ambiguousShare * 100).toFixed(1)}% of samples landed on a thread that was changing` +
          ` region - the per-region splits below are correspondingly fuzzy`,
        C.yellow,
        color,
      ),
    );
  }
  return lines;
}

function renderGroups(
  groups: Group[],
  heading: string,
  memberNoun: "thread" | "region",
  report: Report,
  opts: RenderOptions,
): string {
  const c = opts.color;
  const out: string[] = [];
  out.push(paint(`--- ${heading} `.padEnd(58, "-"), C.cyan, c));

  if (groups.length === 0) {
    out.push(
      paint(
        "This report carries no region data. Profile a Grid/Folia server running a spark build",
        C.yellow,
        c,
      ),
    );
    out.push(
      paint("with context-aware grouping, and without --by-pool / --combine-all.", C.yellow, c),
    );
    return out.join("\n");
  }

  const busyTotal = groups.reduce((a, g) => a + g.busy, 0) || 1;
  out.push(...accuracyNote(report, c));
  out.push("");
  out.push(paint("  busy%      busy /   total", C.dim, c));

  for (const group of groups.slice(0, opts.top)) {
    const share = group.busy / busyTotal;
    out.push(
      `  ${paint((share * 100).toFixed(1).padStart(5) + "%", shareColor(share), c)}` +
        `  ${paint((group.busy / 1000).toFixed(1).padStart(7) + "s", C.dim, c)} /` +
        `${paint((group.total / 1000).toFixed(1).padStart(7) + "s", C.dim, c)}` +
        `   ${paint(group.label, C.bold, c)}`,
    );

    if (opts.detail && group.members.length > 1) {
      for (const member of group.members) {
        const memberShare = group.busy === 0 ? 0 : member.busy / group.busy;
        const name =
          memberNoun === "thread" ? (member.threadName ?? member.name) : regionLabel(member);
        out.push(
          paint(
            `            ${(memberShare * 100).toFixed(0).padStart(3)}% of it on  ${name}`,
            C.dim,
            c,
          ),
        );
      }
    }
  }

  if (groups.length > opts.top) {
    out.push(paint(`  ... +${groups.length - opts.top} more`, C.dim, c));
  }
  return out.join("\n");
}

/** Ranks regions by how much non-idle time was sampled inside them. */
export function renderRegions(report: Report, opts: RenderOptions): string {
  const groups = groupByRegion(report);
  return renderGroups(
    groups,
    `regions (${groups.length}), ranked by busy time`,
    "thread",
    report,
    { ...opts, detail: opts.detail ?? true },
  );
}

/**
 * One region in detail: where its time went, and which threads ticked it.
 *
 * The frames come from the merged tree across every thread that touched the region, so the
 * percentages are of the region's own work rather than of any one thread's.
 */
export function renderRegionDetail(group: Group, opts: RenderOptions): string {
  const c = opts.color;
  const merged = mergeThreads(group.members, group.label);
  const out: string[] = [];

  out.push(paint(`--- ${group.label} `.padEnd(58, "-"), C.cyan, c));
  out.push(
    paint(
      `sampled ${(merged.total / 1000).toFixed(1)}s total, ${(merged.busy / 1000).toFixed(1)}s busy` +
        ` across ${group.members.length} thread${group.members.length === 1 ? "" : "s"}` +
        ` (${group.members.map((m) => m.threadName ?? m.name).join(", ")})`,
      C.dim,
      c,
    ),
  );
  out.push("");

  const frames = hotSpots(merged).sort((a, b) => b.self - a.self);
  const total = merged.total || 1;
  out.push(paint("  self%    incl%    frame", C.dim, c));
  for (const f of frames.slice(0, opts.top)) {
    const self = (f.self / total) * 100;
    const incl = (f.inclusive / total) * 100;
    out.push(
      `  ${paint(formatPct(self).padStart(6), shareColor(self / 100), c)}  ` +
        `${paint(formatPct(incl).padStart(6), C.dim, c)}   ` +
        `${shortClass(f.className)}.${f.methodName}`,
    );
  }
  return out.join("\n");
}

/** Ranks region tick threads by busy time, showing how many regions each one serviced. */
export function renderByThread(report: Report, opts: RenderOptions): string {
  const groups = groupByThread(report);
  const rendered = renderGroups(
    groups,
    `region tick threads (${groups.length}), ranked by busy time`,
    "region",
    report,
    { ...opts, detail: opts.detail ?? false },
  );
  if (groups.length === 0) return rendered;

  // an even spread means the regioniser is balancing; one thread carrying everything is the
  // shape you see when a single region dominates and cannot be split
  const spread = groups.map((g) => g.members.length).join("/");
  return `${rendered}\n${paint(`  regions serviced per thread: ${spread}`, C.dim, opts.color)}`;
}
