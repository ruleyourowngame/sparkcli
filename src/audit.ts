import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Report } from "./parse.js";
import { hotSpots, formatPct, shortClass } from "./analyze.js";

export interface AuditOptions {
  top: number;
  thread?: string;
  repo: string;
  minPct: number;
}

const SOURCE_GLOBS = [
  "aspaper-server/src/minecraft/java",
  "paper-server/src/main/java",
  "paper-server/src/main/java",
  "core/src/main/java",
  "plugin/src/main/java",
];

const NATIVE_PREFIXES = ["l.2.so", "native.", "java.lang.Thread", "j.l.Thread", "j.u.", "j.l.", "j.i.", "i.n.", "j.u.c.l.", "j.u.c.", "c.s.m.", "c.s.c."];

function isJavaUserCode(className: string): boolean {
  if (!className) return false;
  for (const p of NATIVE_PREFIXES) {
    if (className.startsWith(p + ".")) return false;
  }
  if (className.startsWith("net.minecraft.")) return true;
  if (className.startsWith("org.bukkit.")) return true;
  if (className.startsWith("io.papermc.")) return true;
  if (className.startsWith("com.destroystokyo.")) return true;
  if (className.startsWith("com.infernalsuite.")) return true;
  return false;
}

function expandClass(short: string): string {
  return short
    .replace(/^n\.m\./, "net.minecraft.")
    .replace(/^o\.b\.c\./, "org.bukkit.craftbukkit.")
    .replace(/^o\.b\./, "org.bukkit.")
    .replace(/^i\.p\.p\./, "io.papermc.paper.")
    .replace(/^i\.p\./, "io.papermc.")
    .replace(/^c\.d\.p\./, "com.destroystokyo.paper.")
    .replace(/^c\.i\.a\./, "com.infernalsuite.asp.");
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "build" || e.name === ".gradle" || e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".java")) yield p;
  }
}

async function buildIndex(repo: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const roots = SOURCE_GLOBS.map((s) => path.join(repo, s)).filter(async (p) => {
    try {
      const st = await stat(p);
      return st.isDirectory();
    } catch {
      return false;
    }
  });
  for (const root of roots) {
    for await (const file of walk(root)) {
      const base = path.basename(file, ".java");
      if (!index.has(base)) index.set(base, []);
      index.get(base)!.push(file);
    }
  }
  return index;
}

export interface AuditFinding {
  rank: number;
  className: string;
  methodName: string;
  selfPct: number;
  inclPct: number;
  files: string[];
  status: "located" | "external" | "ambiguous" | "missing";
  note: string;
}

export async function audit(report: Report, opts: AuditOptions): Promise<AuditFinding[]> {
  const thread =
    (opts.thread
      ? report.threads.find((t) => t.name.toLowerCase().includes(opts.thread!.toLowerCase()))
      : null) ??
    report.threads.find((t) => /^Server thread$/i.test(t.name)) ??
    report.threads[0]!;

  const frames = hotSpots(thread).sort((a, b) => b.inclusive - a.inclusive);
  const total = thread.total || 1;

  const index = await buildIndex(opts.repo);

  const findings: AuditFinding[] = [];
  for (let i = 0; i < frames.length && findings.length < opts.top; i++) {
    const f = frames[i]!;
    const selfPct = (f.self / total) * 100;
    const inclPct = (f.inclusive / total) * 100;
    if (inclPct < opts.minPct) continue;
    const fullClass = expandClass(f.className);

    let status: AuditFinding["status"] = "external";
    let files: string[] = [];
    let note = "";

    if (!isJavaUserCode(fullClass)) {
      status = "external";
      note = "JDK/Netty/Moonrise/native — typically inherent, skip";
    } else {
      const last = fullClass.split(".").pop() ?? "";
      // strip inner class suffix for lookup
      const outer = last.split("$")[0]!;
      const candidates = index.get(outer) ?? [];
      const expectedPath = fullClass.replace(/\./g, "/") + ".java";
      const matched = candidates.filter((c) => c.endsWith(expectedPath) || c.endsWith(expectedPath.replace(/\$[^/]+\.java$/, ".java")));
      if (matched.length === 1) {
        status = "located";
        files = matched;
      } else if (matched.length > 1) {
        status = "ambiguous";
        files = matched;
      } else if (candidates.length > 0) {
        status = "ambiguous";
        files = candidates;
        note = "name match but path mismatch (lookup vs. expected path)";
      } else {
        status = "missing";
        note = "class name not found in repo (may live in a runtime dep)";
      }
    }

    findings.push({
      rank: findings.length + 1,
      className: fullClass,
      methodName: f.methodName,
      selfPct,
      inclPct,
      files,
      status,
      note,
    });
  }

  return findings;
}

export function renderAudit(findings: AuditFinding[], color: boolean): string {
  const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m", red: "\x1b[31m" };
  const paint = (s: string, code: string) => (color ? `${code}${s}${C.reset}` : s);

  const out: string[] = [];
  out.push(paint("─── audit (hot frames → source location) ───────────────", C.cyan));
  for (const f of findings) {
    const sym = f.status === "located" ? paint("●", C.green) : f.status === "ambiguous" ? paint("◐", C.yellow) : f.status === "external" ? paint("○", C.dim) : paint("✗", C.red);
    const rank = `${f.rank}`.padStart(2);
    const incl = formatPct(f.inclPct).padStart(7);
    const self = formatPct(f.selfPct).padStart(7);
    const label = `${shortClass(f.className)}.${f.methodName}`;
    out.push(`${sym} ${rank}. ${paint(incl, C.bold)} incl  ${paint(self, C.dim)} self  ${label}`);
    if (f.files.length > 0) {
      for (const file of f.files.slice(0, 3)) out.push(`     ${paint(file, C.dim)}`);
      if (f.files.length > 3) out.push(`     ${paint(`... +${f.files.length - 3} more`, C.dim)}`);
    } else if (f.note) {
      out.push(`     ${paint(f.note, C.dim)}`);
    }
  }
  return out.join("\n");
}
