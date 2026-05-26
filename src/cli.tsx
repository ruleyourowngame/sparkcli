#!/usr/bin/env node
import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { load } from "./fetch.js";
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

const HEADER_HEIGHT = 7;

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

function Header({ report }: { report: Report }) {
  const { platform, stats, numberOfTicks, samplerMode, samplerEngine, threads } = report;
  const duration = (report.endTime - report.startTime) / 1000;
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

function App({ input }: { input: string }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const src = await load(input);
        const report = await parse(src.origin, src.bytes);
        if (report.threads.length === 0) {
          setScreen({ kind: "error", message: "Report contains no threads." });
          return;
        }
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
  }, [input]);

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
      else if (mods.return) {
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
          <Text color="cyan">…</Text> loading <Text dimColor>{input}</Text>
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
      "  --top N          rows per hot-spot section (default 25)",
      "  --thread NAME    target thread (substring match; default: Server thread)",
      "  --audit PATH     map top frames to source files inside a repo (e.g. a Paper fork checkout)",
      "  --min-pct N      audit: only frames with inclusive >= N% (default 0.1)",
      "  --flags PATH     discover -Dasp.* runtime toggles in a repo and list them",
      "  --color          force ANSI color",
      "  --no-color       disable ANSI color",
      "",
      "Examples:",
      "  sparkcli https://spark.lucko.me/AbCdEfGhIj",
      "  sparkcli AbCdEfGhIj",
      "  sparkcli ./report.bin --no-tui --top 30",
      "  sparkcli AbCdEfGhIj --json | jq '.frames[0]'",
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
} else if (args.tui) {
  render(<App input={args.input} />);
} else {
  (async () => {
    const { load } = await import("./fetch.js");
    const { parse } = await import("./parse.js");
    const { renderText } = await import("./report.js");
    try {
      const src = await load(args.input);
      const report = await parse(src.origin, src.bytes);
      const out = renderText(report, {
        top: args.top,
        thread: args.thread,
        color: args.color,
        json: args.json,
      });
      process.stdout.write(out + "\n");

      if (args.audit) {
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
    } catch (e) {
      console.error("error:", e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  })();
}
