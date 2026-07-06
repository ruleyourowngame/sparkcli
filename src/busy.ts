import type { StackNode, Thread, Report } from "./parse.js";
import { formatPct, shortClass, type Frame } from "./analyze.js";

/**
 * Idle-time classification.
 *
 * Spark profiles (async-profiler wall-ish sampling) attribute samples to
 * threads even while they sit parked in an executor's take()/awaitWork()
 * loop. Ranking threads by raw sampled time therefore surfaces pools with
 * many sleeping workers ("Craft Scheduler Thread (x54)" at 19% that is
 * 99.9% park) above the threads doing actual work. We classify the
 * well-known blocking/park frames as *idle sinks*: during tree walks their
 * whole subtree counts as idle, everything else as busy.
 *
 * Deliberately NOT idle: monitor *enter* (lock contention is a real
 * finding), socket read/write (DB/network wait is worth seeing on an IO
 * thread), and ForkJoinPool.awaitWork's own self time (pool scan churn).
 */
const IDLE_MATCHERS: Array<{ cls: RegExp; method: RegExp }> = [
  // Java-level parking / sleeping
  { cls: /^(jdk\.internal\.misc|sun\.misc)\.Unsafe$/, method: /^park$/ },
  { cls: /^java\.util\.concurrent\.locks\.LockSupport$/, method: /^park/ },
  { cls: /^java\.lang\.Object$/, method: /^wait0?$/ },
  { cls: /^java\.lang\.Thread$/, method: /^(sleep|sleep0|sleepNanos|yield|yield0|onSpinWait)$/ },
  { cls: /^java\.lang\.ref\.Reference$/, method: /^waitForReferencePendingList$/ },
  // console reader blocked on stdin (terminalconsole/jline BufferedReader.readLine)
  { cls: /^sun\.nio\.cs\.StreamDecoder$/, method: /^implRead$/ },
  // the JVM launcher thread pthread_joins the real main thread forever
  { cls: /^libjli\.so$/, method: /^CallJavaMainInNewThread$/ },
  // NIO / netty event loops waiting for IO readiness
  { cls: /^sun\.nio\.ch\.EPoll$/, method: /^wait$/ },
  { cls: /^sun\.nio\.ch\.KQueue$/, method: /^poll$/ },
  { cls: /^sun\.nio\.ch\.Net$/, method: /^(poll|accept)$/ },
  { cls: /^io\.netty\.channel\.epoll\./, method: /^epollWait/ },
  { cls: /^io\.netty\.channel\.kqueue\./, method: /^kqueueWait/ },
  // HotSpot native park / VM idle loops
  {
    cls: /^libjvm\.so$/,
    method:
      /^(Unsafe_Park$|Parker::park$|PosixSemaphore::wait$|os::PlatformEvent::park|os::PlatformMonitor::wait|Monitor::wait|ObjectMonitor::wait|SafepointSynchronize::block$|WatcherThread::sleep$|VMThread::wait_for_operation$|JavaThread::sleep$|os::sleep$)/,
  },
  // libc blocking syscalls (cond-wait, not cond-signal; epoll/poll/select/sleep)
  {
    cls: /^libc\.so/,
    method:
      /^(pthread_cond_(timed)?wait|epoll_p?wait|poll|__poll|select|pselect|nanosleep|clock_nanosleep|sem_(timed)?wait|accept4?|wait4|waitpid)/,
  },
];

export function isIdleFrame(n: StackNode): boolean {
  if (!n.className || !n.methodName) return false;
  for (const m of IDLE_MATCHERS) {
    if (m.cls.test(n.className) && m.method.test(n.methodName)) return true;
  }
  return false;
}

// A frame whose "class" is a native image (libc.so.6, libjvm.so, an extracted
// /tmp/loaderXXX.tmp, "native", ...) rather than a Java class.
export function isNativeFrame(n: StackNode): boolean {
  const c = n.className;
  if (!c) return true;
  return c === "native" || c.includes(".so") || c.startsWith("/") || c.endsWith(".tmp");
}

/**
 * Busy time under native-ROOTED stacks: call chains that never pass through a
 * Java frame (threads created by a native lib, or stacks the profiler could
 * not unwind into Java). A raw `syscall` leaf there is unattributable — the
 * sampler cannot tell a blocked futex/io_uring wait from a busy poll, so this
 * time may be 100% idle. Field-tested: 35 JNIC/Polar threads parked in futex
 * showed up as "94% busy in syscall" and dwarfed the real hot spots.
 * Verify with ground truth (`/proc/<pid>/task/<tid>/stat` deltas + `wchan`).
 */
// JVM service threads (GC workers, JIT compilers, VM thread) legitimately
// live in native code — their native-rooted time is real work, not a blocked
// syscall masquerading as busy. Suppress the warning for them.
const JVM_NATIVE_THREADS =
  /^(Z(Worker|Driver|Director|Stat|Uncommitter)|G1 |GC |C[12] CompilerThre|VM Thread|VM Periodic|Service Thread|Monitor Deflati|Notification Thread|Common-Cleaner|Async-profiler|spark-async-sampler)/;

export function isJvmNativeThread(name: string): boolean {
  return JVM_NATIVE_THREADS.test(name);
}

export function nativeRootedBusy(thread: Thread): number {
  if (isJvmNativeThread(thread.name)) return 0;
  let acc = 0;
  const walkBusy = (ref: number) => {
    const n = thread.nodes[ref];
    if (!n) return;
    if (isIdleFrame(n)) return;
    let childInclusive = 0;
    for (const c of n.childrenRefs) {
      const cn = thread.nodes[c];
      if (!cn) continue;
      childInclusive += sumTimes(cn.times);
      walkBusy(c);
    }
    acc += Math.max(0, sumTimes(n.times) - childInclusive);
  };
  for (const root of thread.childrenRefs) {
    const n = thread.nodes[root];
    if (n && isNativeFrame(n)) walkBusy(root);
  }
  return acc;
}

function sumTimes(times: number[]): number {
  let s = 0;
  for (const v of times) s += v;
  return s;
}

/**
 * Split a thread's sampled time into busy vs idle by walking the call tree
 * and pruning at the topmost idle sink on each path (its inclusive time —
 * including the unresolved libc leaves below it — counts as idle).
 */
export function computeBusy(thread: Thread): { busy: number; idle: number } {
  let idle = 0;
  const stack: number[] = [...thread.childrenRefs];
  while (stack.length > 0) {
    const ref = stack.pop()!;
    const n = thread.nodes[ref];
    if (!n) continue;
    if (isIdleFrame(n)) {
      idle += sumTimes(n.times);
      continue; // prune: whole subtree is idle
    }
    for (const c of n.childrenRefs) stack.push(c);
  }
  const busy = Math.max(0, thread.total - idle);
  return { busy, idle };
}

/**
 * hotSpots() restricted to the busy part of the tree: nodes inside an idle
 * subtree are skipped entirely, so a pool thread's top frames show the tasks
 * it ran — not the park path it slept in.
 */
export function busyHotSpots(thread: Thread): Frame[] {
  const map = new Map<string, Frame>();
  const stack: number[] = [...thread.childrenRefs];
  while (stack.length > 0) {
    const ref = stack.pop()!;
    const n = thread.nodes[ref];
    if (!n) continue;
    if (isIdleFrame(n)) continue;
    for (const c of n.childrenRefs) stack.push(c);

    const inclusive = sumTimes(n.times);
    let childTotal = 0;
    let idleChildTotal = 0;
    for (const cref of n.childrenRefs) {
      const c = thread.nodes[cref];
      if (!c) continue;
      const t = sumTimes(c.times);
      childTotal += t;
      if (isIdleFrame(c)) idleChildTotal += t;
    }
    const self = Math.max(0, inclusive - childTotal);
    // busy-inclusive: don't credit a frame for time its children spent parked
    // (FutureTask.get would otherwise "include" the whole wait).
    const busyInclusive = Math.max(0, inclusive - idleChildTotal);

    const key = `${n.className}#${n.methodName}`;
    const existing = map.get(key);
    if (existing) {
      existing.inclusive += busyInclusive;
      existing.self += self;
      existing.hits += 1;
    } else {
      map.set(key, {
        key,
        className: n.className,
        methodName: n.methodName,
        lineNumber: n.lineNumber,
        inclusive: busyInclusive,
        self,
        hits: 1,
      });
    }
  }
  return [...map.values()];
}

export interface ThreadBusyRow {
  name: string;
  total: number;
  busy: number;
  idle: number;
  topFrames: Frame[];
}

export function aggregateAllThreads(report: Report, framesPerThread = 3): ThreadBusyRow[] {
  const rows: ThreadBusyRow[] = report.threads.map((t) => {
    const top = busyHotSpots(t)
      .sort((a, b) => b.self - a.self)
      .slice(0, framesPerThread);
    return { name: t.name, total: t.total, busy: t.busy, idle: t.idle, topFrames: top };
  });
  rows.sort((a, b) => b.busy - a.busy);
  return rows;
}

/** Cross-thread rollup: busy self-time per frame summed over every thread. */
export function globalBusyFrames(report: Report): Array<Frame & { topThread: string }> {
  const map = new Map<string, Frame & { topThread: string; topThreadSelf: number }>();
  for (const t of report.threads) {
    for (const f of busyHotSpots(t)) {
      const existing = map.get(f.key);
      if (existing) {
        existing.self += f.self;
        existing.inclusive += f.inclusive;
        existing.hits += f.hits;
        if (f.self > existing.topThreadSelf) {
          existing.topThreadSelf = f.self;
          existing.topThread = t.name;
        }
      } else {
        map.set(f.key, { ...f, topThread: t.name, topThreadSelf: f.self });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.self - a.self);
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
};

function paint(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${C.reset}` : s;
}

export function renderAllThreads(
  report: Report,
  opts: { top: number; color: boolean; minPct: number },
): string {
  const c = opts.color;
  const isAlloc = report.samplerMode === "ALLOCATION";
  const rows = aggregateAllThreads(report);
  const busyAll = rows.reduce((s, r) => s + r.busy, 0) || 1;

  const out: string[] = [];
  out.push(
    paint(
      `─── all threads — ${isAlloc ? "allocations" : "busy (non-idle) time"} ─────────────────────`,
      C.cyan,
      c,
    ),
  );
  if (!isAlloc) {
    out.push(
      paint(
        "busy = samples outside park/wait/epoll idle sinks. busy%all is the share of",
        C.dim,
        c,
      ),
    );
    out.push(paint("all busy time across every thread; busy/thr of that thread's own samples.", C.dim, c));
  }
  out.push("");
  out.push(paint(`${"busy%all".padStart(9)}  ${"busy/thr".padStart(8)}  thread`, C.dim, c));

  let shown = 0;
  const byName = new Map(report.threads.map((t) => [t.name, t]));
  for (const r of rows) {
    const pctAll = (r.busy / busyAll) * 100;
    if (pctAll < opts.minPct) continue;
    if (shown >= opts.top) break;
    shown++;
    const pctThr = r.total > 0 ? (r.busy / r.total) * 100 : 0;
    const col = pctAll >= 10 ? C.red : pctAll >= 3 ? C.yellow : C.dim;
    const t = byName.get(r.name);
    const nativeFrac = t && t.busy > 0 ? nativeRootedBusy(t) / t.busy : 0;
    const warn =
      nativeFrac > 0.5
        ? paint(`  ⚠ ${(nativeFrac * 100).toFixed(0)}% native-rooted — may be blocked syscalls, not CPU`, C.yellow, c)
        : "";
    out.push(
      `${paint(formatPct(pctAll).padStart(9), col, c)}  ${paint(formatPct(pctThr).padStart(8), C.dim, c)}  ${paint(r.name, C.bold, c)}${warn}`,
    );
    for (const f of r.topFrames) {
      if (f.self <= 0) continue;
      const fPct = (f.self / busyAll) * 100;
      if (fPct < 0.01) continue;
      out.push(
        paint(
          `${"".padStart(9)}  ${formatPct(fPct).padStart(8)}    └─ ${shortClass(f.className)}.${f.methodName}`,
          C.dim,
          c,
        ),
      );
    }
  }
  if (rows.length > shown) {
    out.push(paint(`  ... +${rows.length - shown} more threads below ${opts.minPct}% / top-${opts.top}`, C.dim, c));
  }

  out.push("");
  out.push(paint(`Top ${opts.top} busy frames across ALL threads (self-time):`, C.bold, c));
  out.push(paint(`${"self%all".padStart(9)}  frame  ·  hottest thread`, C.dim, c));
  for (const f of globalBusyFrames(report).slice(0, opts.top)) {
    const pctAll = (f.self / busyAll) * 100;
    const col = pctAll >= 5 ? C.red : pctAll >= 1 ? C.yellow : C.dim;
    out.push(
      `${paint(formatPct(pctAll).padStart(9), col, c)}  ${shortClass(f.className)}.${f.methodName}` +
        paint(`  ·  ${f.topThread}`, C.gray, c),
    );
  }

  return out.join("\n");
}

export function allThreadsJson(report: Report, top: number): object {
  const rows = aggregateAllThreads(report, 5);
  const busyAll = rows.reduce((s, r) => s + r.busy, 0) || 1;
  return {
    busyTotal: busyAll,
    threads: rows.slice(0, Math.max(top, 1)).map((r) => ({
      name: r.name,
      total: r.total,
      busy: r.busy,
      idle: r.idle,
      busyPctOfAll: (r.busy / busyAll) * 100,
      busyPctOfThread: r.total > 0 ? (r.busy / r.total) * 100 : 0,
      topFrames: r.topFrames.map((f) => ({
        class: f.className,
        method: f.methodName,
        self: f.self,
        selfPctOfAllBusy: (f.self / busyAll) * 100,
      })),
    })),
    topBusyFrames: globalBusyFrames(report)
      .slice(0, Math.max(top, 1))
      .map((f) => ({
        class: f.className,
        method: f.methodName,
        self: f.self,
        selfPctOfAllBusy: (f.self / busyAll) * 100,
        hottestThread: f.topThread,
      })),
  };
}
