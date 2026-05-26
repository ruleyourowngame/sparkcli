import type { StackNode, Thread } from "./parse.js";

function sumTimes(times: number[]): number {
  let s = 0;
  for (const v of times) s += v;
  return s;
}

export interface Frame {
  key: string;
  className: string;
  methodName: string;
  lineNumber: number;
  inclusive: number;
  self: number;
  hits: number;
}

export function hotSpots(thread: Thread): Frame[] {
  const map = new Map<string, Frame>();
  for (const n of thread.nodes) {
    const inclusive = sumTimes(n.times);
    let childTotal = 0;
    for (const ref of n.childrenRefs) {
      const c = thread.nodes[ref];
      if (c) childTotal += sumTimes(c.times);
    }
    const self = Math.max(0, inclusive - childTotal);
    const key = `${n.className}#${n.methodName}`;
    const existing = map.get(key);
    if (existing) {
      existing.inclusive += inclusive;
      existing.self += self;
      existing.hits += 1;
    } else {
      map.set(key, {
        key,
        className: n.className,
        methodName: n.methodName,
        lineNumber: n.lineNumber,
        inclusive,
        self,
        hits: 1,
      });
    }
  }
  return [...map.values()];
}

export interface TreeRow {
  depth: number;
  label: string;
  pct: number;
  inclusive: number;
  hasChildren: boolean;
  expanded: boolean;
  path: number[];
  refIndex: number;
}

export function buildTree(
  thread: Thread,
  expanded: Set<string>,
  maxDepth = 32,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const total = thread.total || 1;

  const walk = (refIndex: number, depth: number, path: number[]) => {
    const node = thread.nodes[refIndex];
    if (!node) return;
    const inclusive = sumTimes(node.times);
    const pct = (inclusive / total) * 100;
    const pathKey = path.join(".");
    const isExpanded = expanded.has(pathKey);
    const label = formatFrame(node);
    rows.push({
      depth,
      label,
      pct,
      inclusive,
      hasChildren: node.childrenRefs.length > 0,
      expanded: isExpanded,
      path: path.slice(),
      refIndex,
    });
    if (isExpanded && depth < maxDepth) {
      const sortedChildren = [...node.childrenRefs].sort((a, b) => {
        return sumTimes(thread.nodes[b]!.times) - sumTimes(thread.nodes[a]!.times);
      });
      for (const childRef of sortedChildren) {
        walk(childRef, depth + 1, [...path, childRef]);
      }
    }
  };

  const sortedRoots = [...thread.childrenRefs].sort((a, b) => {
    return sumTimes(thread.nodes[b]!.times) - sumTimes(thread.nodes[a]!.times);
  });
  for (const rootRef of sortedRoots) {
    walk(rootRef, 0, [rootRef]);
  }

  return rows;
}

export function formatFrame(node: StackNode): string {
  if (!node.className && !node.methodName) {
    return "(unknown)";
  }
  const cls = node.className || "?";
  const m = node.methodName || "?";
  if (node.lineNumber > 0) {
    return `${shortClass(cls)}.${m}():${node.lineNumber}`;
  }
  return `${shortClass(cls)}.${m}()`;
}

export function shortClass(cls: string): string {
  if (!cls.includes(".")) return cls;
  const parts = cls.split(".");
  const last = parts.pop()!;
  return parts.map((p) => p[0] ?? "").join(".") + "." + last;
}

export function formatPct(p: number): string {
  if (p >= 10) return p.toFixed(1) + "%";
  return p.toFixed(2) + "%";
}
