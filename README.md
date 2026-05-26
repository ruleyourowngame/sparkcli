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

Top 10 self-time hot spots in "Server thread":
  self%    incl%    frame
   62.1%   62.1%   libc.so.6.__pthread_cond_timedwait
   4.20%   4.81%   ServerLevel.tickChunk
   2.95%   3.40%   CollisionUtil.getCollisionsForBlocksOrWorldBorder
   ...
```

> *(short code, platform name, and counts above are illustrative — every spark report renders the same shape with your own data.)*

## Install

Requires Node ≥ 18.

```bash
git clone https://github.com/ruleyourowngame/sparkcli
cd sparkcli
npm install
npm link            # exposes `sparkcli` globally
```

Or run without linking:

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
| `--audit PATH` | map top frames to source files inside a repo |
| `--min-pct N` | audit: only frames with inclusive ≥ N% (default 0.1) |
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
