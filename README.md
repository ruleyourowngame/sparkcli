# sparkcli

Terminal browser for [spark](https://github.com/lucko/spark) profiler reports.

Point it at a `spark.lucko.me/<code>` URL, a bare code, or a local `.bin`/`.json` file. Get an interactive [Ink](https://github.com/vadimdemedes/ink) TUI when stdout is a TTY, batch text when it isn't, and JSON when you ask for it.

```
$ sparkcli https://spark.lucko.me/AbCdEfGhIj --no-tui --top 10

─── spark report ───────────────────────────────────────
platform : Paper 1.21-DEV-abc1234  MC 1.21
sampler  : ASYNC/EXECUTION  interval=4000μs
ticks    : 12000  dur 600.0s  players 50
TPS      : 20.00 / 20.00 / 20.00   MSPT med 12.4 p95 28.1 max 110.0
CPU      : process 87.8% / 70.3%   system 72.4% / 72.7%   (1m/15m)  cores 2
memory   : 87.3 GiB / 123 GiB (71.2%)   uptime 2h 7m
           AMD Ryzen 9 7950X3D 16-Core Processor

Windows (2 × ~1m — CPU process/system · TPS · MSPT med · players):
  #1   60.1s   cpu 86.2% / 73.3%   tps 20.00   mspt 0.49   players 10
  #2   37.9s   cpu 87.4% / 72.5%   tps 19.99   mspt 0.46   players 9

Top 10 self-time hot spots in "Server thread":
  self%    incl%    frame
   62.1%   62.1%   libc.so.6.__pthread_cond_timedwait
   4.20%   4.81%   ServerLevel.tickChunk
   2.95%   3.40%   CollisionUtil.getCollisionsForBlocksOrWorldBorder
   ...
```

> *(short code, platform name, and counts above are illustrative — every spark report renders the same shape with your own data.)*

## Install

Requires Node ≥ 18 (and `npm`, which ships with it).

### One-off (no install)

```bash
npx -y github:ruleyourowngame/sparkcli https://spark.lucko.me/AbCdEfGhIj
```

`npx` downloads to its cache, runs once, and stays out of your PATH. Use this if you just want to try it.

### Global install

```bash
npm install -g github:ruleyourowngame/sparkcli
sparkcli https://spark.lucko.me/AbCdEfGhIj
```

Puts a `sparkcli` binary on your PATH (typically `~/.npm-global/bin/` or `/usr/local/bin/`, depending on your npm prefix).

Update later with the same command — npm pulls latest `main`. Uninstall with:

```bash
npm uninstall -g sparkcli
```

### From source (for hacking on sparkcli itself)

```bash
git clone https://github.com/ruleyourowngame/sparkcli
cd sparkcli
npm install
npm link            # exposes `sparkcli` globally from your checkout
```

Or run directly without linking:

```bash
npm start -- https://spark.lucko.me/AbCdEfGhIj
```

## Usage

```
sparkcli <spark-url | code | file> [flags]
```

| flag | what |
|---|---|
| `--tui` | force interactive TUI (default when stdout is a terminal) |
| `--no-tui` | force batch text output |
| `--json` | JSON output (implies `--no-tui`) — pipe through `jq` |
| `--top N` | rows per hot-spot section (default 25) |
| `--thread NAME` | target thread (substring match; default: `Server thread`) |
| `--all-threads` | rank ALL threads by busy (non-idle) time + cross-thread busy-frame rollup. Park/wait/epoll idle sinks are excluded, so 50 sleeping pool workers stop outranking the one thread doing real work. Alias: `--threads` |
| `--tree` | batch top-down call tree of the target thread |
| `--focus SUBSTR` | drill into frames matching SUBSTR: caller chains to them + the merged tree below them |
| `--depth N` | max depth for `--tree` / `--focus` subtree (default 8) |
| `--audit PATH` | map top frames to source files inside a repo |
| `--min-pct N` | audit/tree/focus/all-threads: hide rows below N% (default 0.1) |
| `--flags PATH` | scan a repo for `-Dasp.*` runtime toggles |
| `--color` / `--no-color` | force/disable ANSI color |

### Examples

```bash
# Interactive TUI (auto-detected on a terminal)
sparkcli https://spark.lucko.me/AbCdEfGhIj

# Just dump a summary + top 30 frames as text
sparkcli AbCdEfGhIj --no-tui --top 30

# Machine-readable JSON for scripting
sparkcli ./report.bin --json | jq '.frames[] | select(.selfPct > 1.0)'

# Which threads actually burn CPU (idle park time excluded)?
sparkcli AbCdEfGhIj --all-threads --top 30

# Who calls this hot method, and what runs beneath it?
sparkcli AbCdEfGhIj --thread "Netty Epoll" --focus "Connection\$2.write" --depth 20

# Batch call tree of a world ticker thread
sparkcli AbCdEfGhIj --thread "universe-world-ticker" --tree --depth 10 --min-pct 1

# Audit: map hot frames to source files in a checked-out Paper fork
sparkcli https://spark.lucko.me/AbCdEfGhIj --audit ~/code/Paper --top 20

# Inventory all -Dasp.* JVM flags declared in a fork
sparkcli --flags ~/code/Paper
```

### TUI keys

- `↑` `↓` / `j` `k` — move
- `PgUp` `PgDn` — page
- `Enter` — open thread / expand tree node
- `s` — toggle self↔inclusive sort
- `t` — toggle hot-spots ↔ tree view
- `e` — expand 3 levels (tree)
- `x` — collapse all (tree)
- `Esc` / `q` — back / quit
- `Ctrl-C` — exit

## What it does

- **Fetches** from `spark-usercontent.lucko.me` with the right `Accept: application/x-spark-sampler` header. Spark's response is gzip; Node's built-in `fetch` decodes it.
- **Decodes** the protobuf payload (`SamplerData`) using the [official spark `.proto`](https://github.com/lucko/spark/tree/master/spark-common/src/main/proto/spark) loaded at runtime via [protobufjs](https://github.com/protobufjs/protobuf.js).
- **Walks the flattened tree** — spark serializes each thread's call tree post-order DFS into a single `children[]` array; `children_refs[]` are indices into that array. sparkcli rebuilds the tree, computes per-frame self / inclusive time, and ranks.
- **Surfaces CPU & system stats** — process/system CPU usage (1m/15m), core count (cgroup-capped, so a 2-core cap on a 16-core host is visible), CPU model, memory, uptime, plus the per-window CPU·TPS·MSPT time series from `time_window_statistics`. A report with **zero thread samples** (a statistics-only snapshot) no longer errors — it just shows the CPU/system block.
- **Audit mode** walks the top-N inclusive frames and locates each one's source file inside a checked-out repo (looks under `paper-server`, `aspaper-server`, `core`, `plugin` source roots). Useful for "what file do I need to read to optimize this hot spot?"

## Why not just use spark's web viewer?

The web viewer is great for one report. sparkcli is for:
- diffing two profiles via `--json`
- piping into other tools (grep, jq, awk)
- correlating hot frames to a specific source tree
- running headless in CI / cron / a tmux pane
- not having to wait for the React viewer to load on a thin link

## Limitations

- **Heap dumps and health reports** aren't parsed yet — only sampler reports (the common case). Adding them is a few lines of protobuf decoding; PRs welcome.
- **Method-level dedup can over-count** native frames that recur across many call paths. For Java frames this is rare; for `libc.so.6.*pthread*` style symbols the inclusive sum can show > 100%. The fix is to dedup by stack identity instead of method, which sparkcli doesn't do yet.
- **No live/streaming** mode — sparkcli reads a finalized report, not a live profile.

## Development

```bash
npm install
npm run typecheck
npm start -- /path/to/report.bin
```

Source layout:

```
src/
├── cli.tsx        # entry: arg parsing + TUI vs batch dispatch
├── fetch.ts       # URL / code / file → bytes
├── parse.ts       # protobuf bytes → typed Report
├── analyze.ts     # tree walking, self / inclusive aggregation
├── report.ts      # batch text + JSON renderer
├── audit.ts       # frame → source-file locator
├── flags.ts       # repo scanner for -Dasp.* toggles
└── proto/         # spark's .proto files (copied from upstream)
```

## License

MIT — see [LICENSE](./LICENSE).

sparkcli is an unofficial client. spark itself is © lucko.
