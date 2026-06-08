#!/usr/bin/env node
import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { load, type Source } from "./fetch.js";
import { parse, type Report, type Thread } from "./parse.js";
import {
  hotSpots,
  buildTree,
  formatPct,
  shortClass,
  type Frame,
  type TreeRow,
} from "./analyze.js";

type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "summary"; report: Report }
  | { kind: "thread"; report: Report; threadIndex: number; mode: ThreadMode };

type ThreadMode =
  | { kind: "hotspots"; sort: "self" | "inclusive"; cursor: number }
  | { kind: "tree"; cursor: number; expanded: Set<string> };

const HEADER_HEIGHT = 8;

function useTermSize(): { rows: number; cols: number } {
  const [size, setSize] = useState(() => ({
    rows: process.stdout.rows || 30,
    cols: process.stdout.columns || 100,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ rows: process.stdout.rows || 30, cols: process.stdout.columns || 100 });
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  return size;
}

function cpuTone(frac: number): "green" | "yellow" | "red" {
  return frac >= 0.9 ? "red" : frac >= 0.7 ? "yellow" : "green";
}

function Header({ report }: { report: Report }) {
  const { platform, stats, system, numberOfTicks, samplerMode, samplerEngine, threads } = report;
  const duration = (report.endTime - report.startTime) / 1000;
  const hasCpu = system.cpuThreads > 0 || system.cpuProcess1m > 0 || system.cpuSystem1m > 0;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>
          {platform.brand || platform.name} {platform.version}
        </Text>
        <Text dimColor> · MC {platform.minecraftVersion}</Text>
        <Text dimColor> · {samplerEngine}/{samplerMode}</Text>
        <Text dimColor> · {threads.length} threads</Text>
      </Box>
      <Box>
        <Text>
          TPS <Text color={stats.tps1m >= 19.5 ? "green" : stats.tps1m >= 15 ? "yellow" : "red"}>
            {stats.tps1m.toFixed(2)}
          </Text>/{stats.tps5m.toFixed(2)}/{stats.tps15m.toFixed(2)}
        </Text>
        <Text dimColor>  ·  </Text>
        <Text>
          MSPT med <Text color={stats.msptMedian <= 50 ? "green" : "red"}>{stats.msptMedian.toFixed(1)}</Text>
          {" "}p95 <Text>{stats.msptP95.toFixed(1)}</Text>
          {" "}max <Text>{stats.msptMax.toFixed(1)}</Text>
        </Text>
        <Text dimColor>  ·  </Text>
        <Text>{stats.players} players · {numberOfTicks} ticks · {duration.toFixed(1)}s</Text>
      </Box>
      {hasCpu && (
        <Box>
          <Text dimColor>CPU </Text>
          <Text>process </Text>
          <Text color={cpuTone(system.cpuProcess1m)}>{(system.cpuProcess1m * 100).toFixed(1)}%</Text>
          <Text>/{(system.cpuProcess15m * 100).toFixed(1)}%</Text>
          <Text dimColor>  ·  </Text>
          <Text>system </Text>
          <Text color={cpuTone(system.cpuSystem1m)}>{(system.cpuSystem1m * 100).toFixed(1)}%</Text>
          <Text>/{(system.cpuSystem15m * 100).toFixed(1)}%</Text>
          <Text dimColor> (1m/15m)</Text>
          {system.cpuThreads > 0 && <Text dimColor>  ·  {system.cpuThreads} cores</Text>}
        </Box>
      )}
    </Box>
  );
}

function Footer({ hint }: { hint: string }) {
  return (
    <Box paddingX={1}>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}

function SummaryScreen({
  report,
  cursor,
}: {
  report: Report;
  cursor: number;
}) {
  const { rows: termRows } = useTermSize();
  const listRows = Math.max(5, termRows - HEADER_HEIGHT - 4);
  const start = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), report.threads.length - listRows));
  const visible = report.threads.slice(start, start + listRows);
  const totalThreadTime = report.threads.reduce((s, t) => s + t.total, 0) || 1;
  return (
    <Box flexDirection="column">
      <Header report={report} />
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text bold underline>Threads (by total sampled time)</Text>
        </Box>
        {report.threads.length === 0 && (
          <Text color="yellow">No thread samples in this report — statistics-only snapshot (CPU/system above).</Text>
        )}
        {visible.map((t, i) => {
          const idx = start + i;
          const pct = (t.total / totalThreadTime) * 100;
          const sel = idx === cursor;
          return (
            <Box key={idx}>
              <Text color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "▸ " : "  "}
                {pct.toFixed(1).padStart(5)}%  {truncate(t.name, 80)}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Footer hint="↑/↓ select  · Enter inspect thread · q quit" />
    </Box>
  );
}

function ThreadHotspots({
  thread,
  sort,
  cursor,
}: {
  thread: Thread;
  sort: "self" | "inclusive";
  cursor: number;
}) {
  const frames = useMemo(() => {
    const all = hotSpots(thread);
    all.sort((a, b) => (sort === "self" ? b.self - a.self : b.inclusive - a.inclusive));
    return all;
  }, [thread, sort]);
  const { rows: termRows } = useTermSize();
  const listRows = Math.max(5, termRows - HEADER_HEIGHT - 6);
  const start = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), frames.length - listRows));
  const visible = frames.slice(start, start + listRows);
  const total = thread.total || 1;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>
          {truncate(thread.name, 70)}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          sort=
        </Text>
        <Text color="yellow" bold>{sort}</Text>
        <Text dimColor> · {frames.length} unique frames · thread total {total.toFixed(0)}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {"  ".padEnd(2)}
          {"self%".padStart(7)}{" "}
          {"incl%".padStart(7)}{" "}
          frame
        </Text>
      </Box>
      {visible.map((f: Frame, i) => {
        const idx = start + i;
        const sel = idx === cursor;
        const selfPct = (f.self / total) * 100;
        const inclPct = (f.inclusive / total) * 100;
        return (
          <Box key={f.key}>
            <Text color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "▸ " : "  "}
              {formatPct(selfPct).padStart(7)}{" "}
              {formatPct(inclPct).padStart(7)}{" "}
              {truncate(`${shortClass(f.className)}.${f.methodName}${f.lineNumber > 0 ? ":" + f.lineNumber : ""}`, 80)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ThreadTree({
  thread,
  cursor,
  expanded,
}: {
  thread: Thread;
  cursor: number;
  expanded: Set<string>;
}) {
  const rows: TreeRow[] = useMemo(() => buildTree(thread, expanded), [thread, expanded]);
  const { rows: termRows, cols } = useTermSize();
  const listRows = Math.max(5, termRows - HEADER_HEIGHT - 5);
  const start = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), rows.length - listRows));
  const visible = rows.slice(start, start + listRows);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{truncate(thread.name, 70)}</Text>
        <Text dimColor>  · tree view · {rows.length} visible nodes</Text>
      </Box>
      <Box>
        <Text dimColor>{"   pct  ".padEnd(8)}  frame</Text>
      </Box>
      {visible.map((row, i) => {
        const idx = start + i;
        const sel = idx === cursor;
        const indent = "  ".repeat(row.depth);
        const marker = row.hasChildren ? (row.expanded ? "▾ " : "▸ ") : "· ";
        const line = `${indent}${marker}${row.label}`;
        return (
          <Box key={`${row.path.join(",")}:${idx}`}>
            <Text color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {formatPct(row.pct).padStart(7)}{"  "}
              {truncate(line, Math.max(20, cols - 12))}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function App({ source }: { source: Source }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const report = await parse(source.origin, source.bytes);
        // A report can legitimately have zero thread samples (statistics-only
        // snapshot). Still show the summary so the CPU/system header is visible.
        const main = Math.max(
          0,
          report.threads.findIndex((t) =>
            /^Server thread$/i.test(t.name) || /server.*thread/i.test(t.name),
          ),
        );
        setCursor(main);
        setScreen({ kind: "summary", report });
      } catch (e) {
        setScreen({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [source]);

  useInput((key, mods) => {
    if (mods.ctrl && key === "c") {
      exit();
      return;
    }
    if (key === "q") {
      if (screen.kind === "thread") {
        setScreen({ kind: "summary", report: screen.report });
        return;
      }
      exit();
      return;
    }
    if (screen.kind === "summary") {
      const max = screen.report.threads.length - 1;
      if (mods.upArrow || key === "k") setCursor((c) => Math.max(0, c - 1));
      else if (mods.downArrow || key === "j") setCursor((c) => Math.min(max, c + 1));
      else if (mods.pageUp) setCursor((c) => Math.max(0, c - 10));
      else if (mods.pageDown) setCursor((c) => Math.min(max, c + 10));
      else if (mods.return && screen.report.threads.length > 0) {
        setScreen({
          kind: "thread",
          report: screen.report,
          threadIndex: cursor,
          mode: { kind: "hotspots", sort: "self", cursor: 0 },
        });
        setCursor(0);
      }
      return;
    }
    if (screen.kind === "thread") {
      const thread = screen.report.threads[screen.threadIndex]!;
      if (mods.escape) {
        setScreen({ kind: "summary", report: screen.report });
        setCursor(screen.threadIndex);
        return;
      }
      if (key === "t") {
        const next: ThreadMode =
          screen.mode.kind === "hotspots"
            ? { kind: "tree", cursor: 0, expanded: new Set() }
            : { kind: "hotspots", sort: "self", cursor: 0 };
        setScreen({ ...screen, mode: next });
        setCursor(0);
        return;
      }
      if (screen.mode.kind === "hotspots") {
        const m = screen.mode;
        const all = hotSpots(thread);
        const max = all.length - 1;
        if (mods.upArrow || key === "k") setCursor((c) => Math.max(0, c - 1));
        else if (mods.downArrow || key === "j") setCursor((c) => Math.min(max, c + 1));
        else if (mods.pageUp) setCursor((c) => Math.max(0, c - 10));
        else if (mods.pageDown) setCursor((c) => Math.min(max, c + 10));
        else if (key === "s")
          setScreen({
            ...screen,
            mode: { kind: "hotspots", sort: m.sort === "self" ? "inclusive" : "self", cursor: 0 },
          });
        return;
      }
      if (screen.mode.kind === "tree") {
        const m = screen.mode;
        const rows = buildTree(thread, m.expanded);
        const max = rows.length - 1;
        if (mods.upArrow || key === "k") setCursor((c) => Math.max(0, c - 1));
        else if (mods.downArrow || key === "j") setCursor((c) => Math.min(max, c + 1));
        else if (mods.pageUp) setCursor((c) => Math.max(0, c - 10));
        else if (mods.pageDown) setCursor((c) => Math.min(max, c + 10));
        else if (mods.return || key === " ") {
          const row = rows[cursor];
          if (row?.hasChildren) {
            const key = row.path.join(".");
            const next = new Set(m.expanded);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            setScreen({ ...screen, mode: { ...m, expanded: next } });
          }
        } else if (key === "x") {
          setScreen({ ...screen, mode: { ...m, expanded: new Set() } });
          setCursor(0);
        } else if (key === "e") {
          const row = rows[cursor];
          if (row?.hasChildren) {
            const path = row.path.join(".");
            const next = new Set(m.expanded);
            next.add(path);
            for (let d = 1; d <= 3; d++) {
              for (const r of buildTree(thread, next)) {
                if (r.path.join(".").startsWith(path) && r.hasChildren) {
                  next.add(r.path.join("."));
                }
              }
            }
            setScreen({ ...screen, mode: { ...m, expanded: next } });
          }
        }
        return;
      }
    }
  });

  if (screen.kind === "loading") {
    return (
      <Box paddingX={1}>
        <Text>
          <Text color="cyan">…</Text> loading <Text dimColor>{source.origin}</Text>
        </Text>
      </Box>
    );
  }
  if (screen.kind === "error") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red" bold>error</Text>
        <Text>{screen.message}</Text>
      </Box>
    );
  }
  if (screen.kind === "summary") {
    return <SummaryScreen report={screen.report} cursor={cursor} />;
  }
  // thread
  const thread = screen.report.threads[screen.threadIndex]!;
  return (
    <Box flexDirection="column">
      <Header report={screen.report} />
      {screen.mode.kind === "hotspots" ? (
        <ThreadHotspots thread={thread} sort={screen.mode.sort} cursor={cursor} />
      ) : (
        <ThreadTree thread={thread} cursor={cursor} expanded={screen.mode.expanded} />
      )}
      <Footer
        hint={
          screen.mode.kind === "hotspots"
            ? "↑/↓ move · s toggle self/incl · t tree view · Esc/q back"
            : "↑/↓ move · Enter/Space toggle · e expand 3 levels · x collapse all · t hotspots · Esc/q back"
        }
      />
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}

interface ParsedArgs {
  input: string;
  tui: boolean;
  top: number;
  thread?: string;
  json: boolean;
  color: boolean;
  audit?: string;
  minPct: number;
  flagsRepo?: string;
  chain?: string;
  byNamespace?: boolean;
  heap?: boolean;
  hprof?: boolean;
  retainers?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    input: "",
    tui: process.stdin.isTTY === true && process.stdout.isTTY === true,
    top: 25,
    json: false,
    color: process.stdout.isTTY === true && !process.env["NO_COLOR"],
    minPct: 0.1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--tui": args.tui = true; break;
      case "--no-tui": args.tui = false; break;
      case "--json": args.json = true; args.tui = false; break;
      case "--no-color": args.color = false; break;
      case "--color": args.color = true; break;
      case "--top": args.top = parseInt(argv[++i] ?? "25", 10); break;
      case "--thread": args.thread = argv[++i]; break;
      case "--audit": args.audit = argv[++i]; args.tui = false; break;
      case "--min-pct": args.minPct = parseFloat(argv[++i] ?? "0.1"); break;
      case "--flags": args.flagsRepo = argv[++i]; args.tui = false; break;
      case "--chain": args.chain = argv[++i]; args.tui = false; break;
      case "--by-namespace":
      case "--by-plugin":
        args.byNamespace = true;
        args.tui = false;
        break;
      case "--heap":
        args.heap = true;
        args.tui = false;
        break;
      case "--hprof":
        args.hprof = true;
        args.tui = false;
        break;
      case "--retainers":
      case "--retained-by":
        args.retainers = argv[++i];
        args.tui = false;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
        if (!args.input) args.input = a;
        else {
          console.error(`Unexpected positional: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function printUsage() {
  console.error(
    [
      "Usage: sparkcli <spark-url | code | file> [flags]",
      "",
      "  Auto-detects TTY: interactive when run from a terminal, batch otherwise.",
      "",
      "Flags:",
      "  --tui            force interactive Ink TUI",
      "  --no-tui         force batch text output",
      "  --json           batch JSON output (implies --no-tui)",
      "  --heap           force heap-summary mode (auto-detected for x-spark-heap URLs)",
      "  --hprof          force JVM heap-dump mode for a local .hprof (auto-detected by magic)",
      "  --retainers CLS  .hprof: show which classes reference instances of CLS (e.g. 'char[]')",
      "  --top N          rows per hot-spot / heap-class / retainer section (default 25)",
      "  --thread NAME    target thread (substring match; default: Server thread)",
      "  --audit PATH     map top frames to source files inside a repo (e.g. a Paper fork checkout)",
      "  --min-pct N      audit: only frames with inclusive >= N% (default 0.1)",
      "  --flags PATH     discover -Dasp.* runtime toggles in a repo and list them",
      "  --by-namespace   roll up self-time by package prefix (Paper, plugins, Netty, ...).",
      "                   Alias: --by-plugin. Surfaces cumulative cost of plugin code",
      "                   whose individual frames sit below the top-N cutoff.",
      "  --color          force ANSI color",
      "  --no-color       disable ANSI color",
      "",
      "Examples:",
      "  sparkcli https://spark.lucko.me/AbCdEfGhIj",
      "  sparkcli AbCdEfGhIj",
      "  sparkcli ./report.bin --no-tui --top 30",
      "  sparkcli AbCdEfGhIj --json | jq '.frames[0]'",
      "  sparkcli https://spark.lucko.me/HeapCode --top 30   # heap summary, auto-detected",
      "  sparkcli ./heap.bin --heap --json | jq '.topClasses[0]'",
      "  sparkcli ./dump.hprof --top 30                      # JVM heap dump class histogram",
      "  sparkcli ./dump.hprof --retainers 'char[]'          # who is holding the char[]",
    ].join("\n"),
  );
}

const args = parseArgs(process.argv.slice(2));
if (!args.input && !args.flagsRepo) {
  printUsage();
  process.exit(2);
}

if (args.flagsRepo && !args.input) {
  (async () => {
    const { discoverFlags, renderFlags } = await import("./flags.js");
    const flags = await discoverFlags(args.flagsRepo!);
    process.stdout.write(renderFlags(flags, args.color) + "\n");
  })();
} else {
  (async () => {
    try {
      // JVM heap dumps (.hprof) are huge & binary — stream them straight off
      // disk via a bounded-memory parser; NEVER load() the whole file.
      const { existsSync } = await import("node:fs");
      if (existsSync(args.input)) {
        const { isHprofFile, hprofHistogram, hprofRetainers, renderHprofHistogram, renderHprofRetainers } =
          await import("./hprof.js");
        if (args.retainers || args.hprof || isHprofFile(args.input)) {
          if (args.retainers) {
            const rr = hprofRetainers(args.input, args.retainers);
            process.stdout.write(renderHprofRetainers(rr, { color: args.color, json: args.json, top: args.top }) + "\n");
          } else {
            const h = hprofHistogram(args.input, Math.max(args.top, 1000));
            process.stdout.write(renderHprofHistogram(h, { color: args.color, json: args.json, top: args.top }) + "\n");
          }
          return;
        }
      }

      const src = await load(args.input);

      // Heap summaries carry no thread samples to navigate, so render the flat
      // class histogram in batch even under a TTY. Auto-detected from the
      // stored content-type, or forced with --heap (e.g. for local .bin files).
      const isHeap = args.heap || src.contentType.includes("x-spark-heap");
      if (isHeap) {
        const { parseHeap } = await import("./parse.js");
        const { renderHeap } = await import("./heap.js");
        const heap = await parseHeap(src.origin, src.bytes);
        process.stdout.write(
          renderHeap(heap, { top: args.top, color: args.color, json: args.json }) + "\n",
        );
        return;
      }

      if (args.tui) {
        render(<App source={src} />);
        return;
      }

      const { renderText } = await import("./report.js");
      const report = await parse(src.origin, src.bytes);
      const out = renderText(report, {
        top: args.top,
        thread: args.thread,
        color: args.color,
        json: args.json,
      });
      process.stdout.write(out + "\n");

      if ((args.audit || args.byNamespace) && report.threads.length === 0) {
        console.error(
          "note: report has no thread samples — skipping audit/namespace rollup (statistics-only snapshot).",
        );
      }

      if (args.audit && report.threads.length > 0) {
        const { audit, renderAudit } = await import("./audit.js");
        const findings = await audit(report, {
          top: args.top,
          thread: args.thread,
          repo: args.audit,
          minPct: args.minPct,
        });
        process.stdout.write("\n" + renderAudit(findings, args.color) + "\n");

        const { discoverFlags, renderFlags } = await import("./flags.js");
        const flags = await discoverFlags(args.audit);
        if (flags.length > 0) {
          process.stdout.write("\n" + renderFlags(flags, args.color) + "\n");
        }
      }

      if (args.byNamespace && report.threads.length > 0) {
        const { aggregateByNamespace, renderNamespaces } = await import(
          "./namespaces.js"
        );
        const thread =
          (args.thread
            ? report.threads.find((t) =>
                t.name.toLowerCase().includes(args.thread!.toLowerCase()),
              )
            : null) ??
          report.threads.find((t) => /^Server thread$/i.test(t.name)) ??
          report.threads[0]!;
        const buckets = aggregateByNamespace(thread);
        const out = renderNamespaces(buckets, thread.total, {
          top: args.top,
          color: args.color,
          minPct: args.minPct,
        });
        process.stdout.write(
          "\n" +
            `─── namespace rollup — thread "${thread.name}" ───\n` +
            out +
            "\n",
        );
      }
    } catch (e) {
      console.error("error:", e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  })();
}
