import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const FLAG_REGEX =
  /System\.getProperty\(\s*"(asp\.[A-Za-z0-9_.]+)"\s*(?:,\s*"([^"]*)"\s*)?\)/g;

export interface Flag {
  name: string;
  defaultValue: string;
  file: string;
  line: number;
  context: string;
}

async function* walkJava(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "build" || e.name === ".gradle" || e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJava(p);
    else if (e.name.endsWith(".java")) yield p;
  }
}

export async function discoverFlags(repo: string): Promise<Flag[]> {
  const roots = [
    path.join(repo, "aspaper-server", "src", "minecraft", "java"),
    path.join(repo, "paper-server", "src", "main", "java"),
    path.join(repo, "core", "src", "main", "java"),
    path.join(repo, "plugin", "src", "main", "java"),
  ];

  const flags: Flag[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    for await (const file of walkJava(root)) {
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]!;
        FLAG_REGEX.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = FLAG_REGEX.exec(line)) !== null) {
          const key = `${m[1]}@${file}:${lineIdx + 1}`;
          if (seen.has(key)) continue;
          seen.add(key);
          flags.push({
            name: m[1]!,
            defaultValue: m[2] ?? "(none)",
            file,
            line: lineIdx + 1,
            context: line.trim(),
          });
        }
      }
    }
  }
  flags.sort((a, b) => a.name.localeCompare(b.name));
  return flags;
}

export function renderFlags(flags: Flag[], color: boolean): string {
  const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m" };
  const paint = (s: string, code: string) => (color ? `${code}${s}${C.reset}` : s);
  const out: string[] = [];
  out.push(paint("─── ASP runtime toggles ────────────────────────────────", C.cyan));
  out.push(paint(`${flags.length} flag${flags.length === 1 ? "" : "s"} discovered`, C.dim));
  out.push("");
  for (const f of flags) {
    const defCol = f.defaultValue === "true" ? C.green : f.defaultValue === "false" ? C.yellow : C.dim;
    out.push(`${paint(f.name, C.bold)}  default=${paint(f.defaultValue, defCol)}`);
    out.push(`  ${paint(`${f.file}:${f.line}`, C.dim)}`);
    out.push(`  ${paint(f.context.slice(0, 110), C.dim)}`);
    out.push("");
  }
  out.push(paint("Set via JVM args, e.g.  -Dasp.skipPlayerPersistence=false", C.dim));
  return out.join("\n");
}
