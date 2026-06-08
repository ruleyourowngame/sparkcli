import { openSync, readSync, fstatSync, closeSync } from "node:fs";

// ─── Streaming HPROF (.hprof) reader ────────────────────────────────────────
//
// JVM heap dumps are binary and huge (multi-GB), so we never load the file
// into memory — we scan it with a sliding buffer in bounded memory. Two things
// a class histogram (a `jmap -histo` from the dump) CANNOT answer but a dump
// CAN: "what is holding these objects". So beyond the histogram we offer an
// immediate-referrer pass: for a target class (e.g. char[]), aggregate which
// classes hold a reference to its instances. That's the leak-finder view.
//
// Format ref: JDK `hprof` binary spec (HEAP_DUMP_SEGMENT sub-records).

// Basic-type byte sizes, indexed by HPROF type tag.
const TYPE_SIZE: Record<number, number> = {
  2: 0, // object — filled in from idSize at runtime
  4: 1, // boolean
  5: 2, // char
  6: 4, // float
  7: 8, // double
  8: 1, // byte
  9: 2, // short
  10: 4, // int
  11: 8, // long
};
const TYPE_NAME: Record<number, string> = {
  4: "boolean", 5: "char", 6: "float", 7: "double",
  8: "byte", 9: "short", 10: "int", 11: "long",
};

const OBJ_HEADER = 16; // approx HotSpot array/object header for shallow sizing

class Reader {
  private fd: number;
  private buf: Buffer;
  private bufLen = 0;
  private pos = 0;
  private base = 0; // absolute file offset of buf[0]
  readonly size: number;
  idSize = 8;

  constructor(path: string, bufBytes = 8 * 1024 * 1024) {
    this.fd = openSync(path, "r");
    this.size = fstatSync(this.fd).size;
    this.buf = Buffer.allocUnsafe(bufBytes);
  }
  close() { closeSync(this.fd); }
  absOffset() { return this.base + this.pos; }
  atEnd() { return this.absOffset() >= this.size; }

  private need(n: number) {
    if (this.bufLen - this.pos >= n) return;
    if (this.pos > 0) {
      this.buf.copyWithin(0, this.pos, this.bufLen);
      this.bufLen -= this.pos;
      this.base += this.pos;
      this.pos = 0;
    }
    while (this.bufLen < n) {
      const read = readSync(this.fd, this.buf, this.bufLen, this.buf.length - this.bufLen, this.base + this.bufLen);
      if (read === 0) throw new Error(`unexpected EOF at offset ${this.base + this.bufLen}`);
      this.bufLen += read;
    }
  }
  u1() { this.need(1); return this.buf[this.pos++]!; }
  u2() { this.need(2); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  u4() { this.need(4); const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  u8() { this.need(8); const hi = this.buf.readUInt32BE(this.pos); const lo = this.buf.readUInt32BE(this.pos + 4); this.pos += 8; return hi * 0x100000000 + lo; }
  id() { return this.idSize === 8 ? this.u8() : this.u4(); }
  bytes(n: number) { this.need(n); const b = Buffer.from(this.buf.subarray(this.pos, this.pos + n)); this.pos += n; return b; }
  // Skip n bytes, possibly far past the current buffer (large arrays).
  skip(n: number) {
    const target = this.absOffset() + n;
    if (target <= this.base + this.bufLen) {
      this.pos = target - this.base;
    } else {
      this.base = target;
      this.pos = 0;
      this.bufLen = 0;
    }
  }
}

function sizeOfType(type: number, idSize: number): number {
  return type === 2 ? idSize : (TYPE_SIZE[type] ?? 0);
}

// "[Ljava/lang/String;" -> "java.lang.String[]", "[C" -> "char[]", "a/b/C" -> "a.b.C"
function prettyClassName(raw: string): string {
  let dims = 0;
  let i = 0;
  while (raw[i] === "[") { dims++; i++; }
  let base: string;
  if (dims > 0) {
    const d = raw[i];
    const prim: Record<string, string> = { C: "char", B: "byte", I: "int", J: "long", S: "short", Z: "boolean", F: "float", D: "double" };
    if (d === "L") base = raw.slice(i + 1, raw.endsWith(";") ? -1 : undefined).replace(/\//g, ".");
    else base = prim[d!] ?? d!;
    return base + "[]".repeat(dims);
  }
  return raw.replace(/\//g, ".");
}

interface ClassLayout {
  nameId: number;
  superId: number;
  instSize: number;
  // instance fields declared on THIS class, in order (type tags)
  fieldTypes: number[];
}

export interface HistEntry { className: string; instances: number; size: number; }
export interface HprofHistogram {
  origin: string;
  totalInstances: number;
  totalSize: number;
  classes: HistEntry[];
}

export interface Referrer { className: string; count: number; }
export interface RetainerResult {
  target: string;
  targetInstances: number;
  targetSize: number;
  rootHeld: number; // how many target instances are GC roots directly
  referrers: Referrer[];
  scannedRefs: number;
}

// HPROF top-level record tags
const T_STRING = 0x01, T_LOAD_CLASS = 0x02, T_HEAP_DUMP = 0x0c, T_HEAP_DUMP_SEG = 0x1c;
// heap-dump sub-record tags
const H_CLASS_DUMP = 0x20, H_INSTANCE = 0x21, H_OBJ_ARRAY = 0x22, H_PRIM_ARRAY = 0x23;

interface Parsed {
  origin: string;
  idSize: number;
  strings: Map<number, string>;
  classNameByObjId: Map<number, number>; // classObjId -> nameStringId
  layouts: Map<number, ClassLayout>;
  // histogram accumulators
  instCount: Map<number, number>; // classObjId -> count
  instSize: Map<number, number>;
  arrCount: Map<number, number>; // arrayClassObjId -> count   (object arrays)
  arrSize: Map<number, number>;
  primCount: Map<number, number>; // type -> count   (primitive arrays)
  primSize: Map<number, number>;
}

// Read a GC-root / class / instance / array sub-record, dispatching on tag.
// `visit` lets pass-2 hook object refs; pass-1 passes undefined (skip mode).
function readHeapSubRecord(r: Reader, tag: number, p: Parsed, onTargetRefFrom?: (referrerKey: string) => void, targetSet?: Set<number>, rootCounter?: { n: number }): void {
  const idSize = r.idSize;
  switch (tag) {
    // ── GC roots ──
    case 0xff: r.id(); break;                                   // UNKNOWN
    case 0x01: r.id(); r.id(); break;                            // JNI GLOBAL
    case 0x02: r.id(); r.u4(); r.u4(); break;                    // JNI LOCAL
    case 0x03: r.id(); r.u4(); r.u4(); break;                    // JAVA FRAME
    case 0x04: r.id(); r.u4(); break;                            // NATIVE STACK
    case 0x05: { const id = r.id(); if (targetSet?.has(id) && rootCounter) rootCounter.n++; break; } // STICKY CLASS
    case 0x06: r.id(); r.u4(); break;                            // THREAD BLOCK
    case 0x07: { const id = r.id(); if (targetSet?.has(id) && rootCounter) rootCounter.n++; break; } // MONITOR USED
    case 0x08: { const id = r.id(); r.u4(); r.u4(); if (targetSet?.has(id) && rootCounter) rootCounter.n++; break; } // THREAD OBJ
    case 0x89: case 0x8a: case 0x8b: case 0x8c: case 0x8d: {     // extended roots (interned str, finalizing, debugger, ...)
      const id = r.id(); if (targetSet?.has(id) && rootCounter) rootCounter.n++; break;
    }
    case 0x8e: { const id = r.id(); r.u4(); r.u4(); if (targetSet?.has(id) && rootCounter) rootCounter.n++; break; } // JNI MONITOR

    // ── class definition ──
    case H_CLASS_DUMP: {
      const classObjId = r.id();
      r.u4(); // stack trace serial
      const superId = r.id();
      r.id(); r.id(); r.id(); r.id(); r.id(); // loader, signers, protdomain, reserved, reserved
      const instSize = r.u4();
      const cpCount = r.u2();
      for (let i = 0; i < cpCount; i++) { r.u2(); const t = r.u1(); r.skip(sizeOfType(t, idSize)); }
      const staticCount = r.u2();
      for (let i = 0; i < staticCount; i++) {
        r.id(); // field name string id
        const t = r.u1();
        if (t === 2) { const v = r.id(); if (targetSet?.has(v)) onTargetRefFrom?.(prettyOrRaw(p, classObjId) + " (static field)"); }
        else r.skip(sizeOfType(t, idSize));
      }
      const fieldCount = r.u2();
      const fieldTypes: number[] = [];
      for (let i = 0; i < fieldCount; i++) { r.id(); fieldTypes.push(r.u1()); }
      if (!p.layouts.has(classObjId)) {
        const name = p.classNameByObjId.get(classObjId) ?? 0;
        p.layouts.set(classObjId, { nameId: name, superId, instSize, fieldTypes });
      }
      // class objects themselves contribute to the histogram as java.lang.Class
      break;
    }

    // ── instance ──
    case H_INSTANCE: {
      r.id(); // object id (not needed when scanning for referrers)
      r.u4(); // stack serial
      const classObjId = r.id();
      const nbytes = r.u4();
      if (onTargetRefFrom) {
        // pass-2: decode object fields walking the class hierarchy
        const end = r.absOffset() + nbytes;
        let cid = classObjId;
        while (cid !== 0) {
          const layout = p.layouts.get(cid);
          if (!layout) break;
          for (const t of layout.fieldTypes) {
            if (t === 2) { const v = r.id(); if (targetSet!.has(v)) onTargetRefFrom(prettyOrRaw(p, classObjId)); }
            else r.skip(sizeOfType(t, idSize));
          }
          cid = layout.superId;
        }
        // be exact regardless of layout gaps
        if (r.absOffset() !== end) r.skip(end - r.absOffset());
      } else {
        // pass-1: histogram only
        p.instCount.set(classObjId, (p.instCount.get(classObjId) ?? 0) + 1);
        const layout = p.layouts.get(classObjId);
        const sz = layout?.instSize || OBJ_HEADER + nbytes;
        p.instSize.set(classObjId, (p.instSize.get(classObjId) ?? 0) + sz);
        r.skip(nbytes);
      }
      break;
    }

    // ── object array ──
    case H_OBJ_ARRAY: {
      r.id(); // object id (not needed when scanning for referrers)
      r.u4();
      const num = r.u4();
      const arrClassId = r.id();
      if (onTargetRefFrom) {
        for (let i = 0; i < num; i++) { const v = r.id(); if (targetSet!.has(v)) onTargetRefFrom(prettyOrRaw(p, arrClassId)); }
      } else {
        p.arrCount.set(arrClassId, (p.arrCount.get(arrClassId) ?? 0) + 1);
        p.arrSize.set(arrClassId, (p.arrSize.get(arrClassId) ?? 0) + OBJ_HEADER + num * idSize);
        r.skip(num * idSize);
      }
      break;
    }

    // ── primitive array ──
    case H_PRIM_ARRAY: {
      r.id();
      r.u4();
      const num = r.u4();
      const t = r.u1();
      if (!onTargetRefFrom) {
        p.primCount.set(t, (p.primCount.get(t) ?? 0) + 1);
        p.primSize.set(t, (p.primSize.get(t) ?? 0) + OBJ_HEADER + num * sizeOfType(t, idSize));
      }
      r.skip(num * sizeOfType(t, idSize));
      break;
    }

    default:
      throw new Error(`unknown heap sub-record tag 0x${tag.toString(16)} at offset ${r.absOffset()}`);
  }
}

function prettyOrRaw(p: Parsed, classObjId: number): string {
  const nameId = p.classNameByObjId.get(classObjId);
  const raw = nameId != null ? p.strings.get(nameId) : undefined;
  return raw ? prettyClassName(raw) : `class@${classObjId}`;
}

function readHeader(r: Reader): void {
  // null-terminated format string
  let s = "";
  for (;;) { const b = r.u1(); if (b === 0) break; s += String.fromCharCode(b); }
  r.idSize = r.u4();
  r.u8(); // timestamp
}

// Pass-1: histogram + class layouts (+ collect target object ids if a target
// class name is given, so pass-2 can find what references them).
function pass1(path: string, targetName?: string): { parsed: Parsed; targetIds: Set<number> | null } {
  const r = new Reader(path);
  readHeader(r);
  const p: Parsed = {
    origin: path, idSize: r.idSize,
    strings: new Map(), classNameByObjId: new Map(), layouts: new Map(),
    instCount: new Map(), instSize: new Map(), arrCount: new Map(), arrSize: new Map(),
    primCount: new Map(), primSize: new Map(),
  };
  let targetIds: Set<number> | null = targetName ? new Set<number>() : null;
  let targetClassIds: Set<number> | null = null;
  let targetPrimType = -1;

  while (!r.atEnd()) {
    const tag = r.u1();
    r.u4(); // time
    const len = r.u4();
    const start = r.absOffset();
    if (tag === T_STRING) {
      const id = r.id();
      p.strings.set(id, r.bytes(len - r.idSize).toString("utf8"));
    } else if (tag === T_LOAD_CLASS) {
      r.u4(); const classObjId = r.id(); r.u4(); const nameId = r.id();
      p.classNameByObjId.set(classObjId, nameId);
    } else if (tag === T_HEAP_DUMP || tag === T_HEAP_DUMP_SEG) {
      // STRING + LOAD_CLASS records precede the heap dump, so the target class
      // ids are fully resolvable the first time we reach a heap-dump segment.
      if (targetName && targetClassIds === null) {
        const t = resolveTarget(p, targetName);
        targetClassIds = t.classIds;
        targetPrimType = t.primType;
      }
      const end = start + len;
      while (r.absOffset() < end) {
        const sub = r.u1();
        if (targetIds && (sub === H_INSTANCE || sub === H_OBJ_ARRAY || sub === H_PRIM_ARRAY)) {
          collectAndRead(r, sub, p, targetIds, targetClassIds!, targetPrimType);
        } else {
          readHeapSubRecord(r, sub, p);
        }
      }
    } else {
      r.skip(len);
    }
  }
  r.close();
  return { parsed: p, targetIds };
}

// Like readHeapSubRecord pass-1 histogram, but also records the object id into
// `targetIds` when the object is an instance/array of the target class.
function collectAndRead(r: Reader, sub: number, p: Parsed, targetIds: Set<number>, targetClassIds: Set<number>, targetPrimType: number) {
  const idSize = r.idSize;
  if (sub === H_INSTANCE) {
    const objId = r.id(); r.u4(); const classObjId = r.id(); const nbytes = r.u4();
    p.instCount.set(classObjId, (p.instCount.get(classObjId) ?? 0) + 1);
    const layout = p.layouts.get(classObjId);
    p.instSize.set(classObjId, (p.instSize.get(classObjId) ?? 0) + (layout?.instSize || OBJ_HEADER + nbytes));
    if (targetClassIds.has(classObjId)) targetIds.add(objId);
    r.skip(nbytes);
  } else if (sub === H_OBJ_ARRAY) {
    const objId = r.id(); r.u4(); const num = r.u4(); const arrClassId = r.id();
    p.arrCount.set(arrClassId, (p.arrCount.get(arrClassId) ?? 0) + 1);
    p.arrSize.set(arrClassId, (p.arrSize.get(arrClassId) ?? 0) + OBJ_HEADER + num * idSize);
    if (targetClassIds.has(arrClassId)) targetIds.add(objId);
    r.skip(num * idSize);
  } else { // H_PRIM_ARRAY
    const objId = r.id(); r.u4(); const num = r.u4(); const t = r.u1();
    p.primCount.set(t, (p.primCount.get(t) ?? 0) + 1);
    p.primSize.set(t, (p.primSize.get(t) ?? 0) + OBJ_HEADER + num * sizeOfType(t, idSize));
    if (t === targetPrimType) targetIds.add(objId);
    r.skip(num * sizeOfType(t, idSize));
  }
}

function resolveTarget(p: Parsed, name: string): { classIds: Set<number>; primType: number } {
  const classIds = new Set<number>();
  let primType = -1;
  const want = name.trim();
  // primitive array?
  for (const [t, n] of Object.entries(TYPE_NAME)) {
    if (`${n}[]` === want) primType = Number(t);
  }
  for (const [classObjId, nameId] of p.classNameByObjId) {
    const raw = p.strings.get(nameId);
    if (raw && prettyClassName(raw) === want) classIds.add(classObjId);
  }
  return { classIds, primType };
}

export function hprofHistogram(path: string, top = 30): HprofHistogram {
  const { parsed: p } = pass1(path);
  const classes: HistEntry[] = [];
  let totalInstances = 0, totalSize = 0;
  const push = (className: string, instances: number, size: number) => {
    classes.push({ className, instances, size }); totalInstances += instances; totalSize += size;
  };
  for (const [cid, c] of p.instCount) push(prettyOrRaw(p, cid), c, p.instSize.get(cid) ?? 0);
  for (const [cid, c] of p.arrCount) push(prettyOrRaw(p, cid), c, p.arrSize.get(cid) ?? 0);
  for (const [t, c] of p.primCount) push(`${TYPE_NAME[t]}[]`, c, p.primSize.get(t) ?? 0);
  classes.sort((a, b) => b.size - a.size);
  return { origin: path, totalInstances, totalSize, classes: classes.slice(0, top) };
}

export function hprofRetainers(path: string, targetName: string): RetainerResult {
  // pass-1 collects target object ids + layouts + the histogram
  const { parsed: p, targetIds } = pass1(path, targetName);
  const ids = targetIds ?? new Set<number>();

  // target totals straight from pass-1's histogram (no extra file scan)
  const want = targetName.trim();
  let targetInstances = 0, targetSize = 0;
  for (const [cid, cnt] of p.instCount) if (prettyOrRaw(p, cid) === want) { targetInstances += cnt; targetSize += p.instSize.get(cid) ?? 0; }
  for (const [cid, cnt] of p.arrCount) if (prettyOrRaw(p, cid) === want) { targetInstances += cnt; targetSize += p.arrSize.get(cid) ?? 0; }
  for (const [t, cnt] of p.primCount) if (`${TYPE_NAME[t]}[]` === want) { targetInstances += cnt; targetSize += p.primSize.get(t) ?? 0; }
  if (targetInstances === 0) targetInstances = ids.size;

  // pass-2: scan again, counting which classes reference a target id
  const r = new Reader(path);
  readHeader(r);
  const refCounts = new Map<string, number>();
  const rootCounter = { n: 0 };
  let scanned = 0;
  const onRef = (key: string) => { refCounts.set(key, (refCounts.get(key) ?? 0) + 1); scanned++; };
  while (!r.atEnd()) {
    const tag = r.u1(); r.u4(); const len = r.u4(); const start = r.absOffset();
    if (tag === T_HEAP_DUMP || tag === T_HEAP_DUMP_SEG) {
      const end = start + len;
      while (r.absOffset() < end) {
        const sub = r.u1();
        readHeapSubRecord(r, sub, p, onRef, ids, rootCounter);
      }
    } else {
      r.skip(len);
    }
  }
  r.close();

  const referrers = [...refCounts.entries()].map(([className, count]) => ({ className, count })).sort((a, b) => b.count - a.count);
  return { target: targetName.trim(), targetInstances, targetSize, rootHeld: rootCounter.n, referrers, scannedRefs: scanned };
}

export function isHprofFile(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    const b = Buffer.allocUnsafe(13);
    readSync(fd, b, 0, 13, 0);
    closeSync(fd);
    return b.toString("latin1").startsWith("JAVA PROFILE");
  } catch {
    return false;
  }
}

// ── rendering ──
const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", cyan: "\x1b[36m" };
const paint = (s: string, code: string, color: boolean) => (color ? `${code}${s}${C.reset}` : s);
function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"]; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

export function renderHprofHistogram(h: HprofHistogram, opts: { color: boolean; json: boolean; top: number }): string {
  if (opts.json) return JSON.stringify({ kind: "hprof-histogram", origin: h.origin, totalInstances: h.totalInstances, totalSize: h.totalSize, classes: h.classes }, null, 2);
  const c = opts.color; const out: string[] = [];
  out.push(paint("─── hprof heap dump — class histogram ──────────────────", C.cyan, c));
  out.push(`${paint("source   :", C.dim, c)} ${h.origin}`);
  out.push(`${paint("live     :", C.dim, c)} ${fmtInt(h.totalInstances)} objects · ${fmtBytes(h.totalSize)} (counted)`);
  out.push("");
  out.push(paint(`Top ${opts.top} classes by shallow size:`, C.bold, c));
  out.push(paint(`  ${"size".padStart(9)}  ${"%heap".padStart(6)}  ${"instances".padStart(13)}  class`, C.dim, c));
  const denom = h.totalSize || 1;
  for (const e of h.classes.slice(0, opts.top)) {
    const share = (e.size / denom) * 100;
    const col = share >= 10 ? C.red : share >= 3 ? C.yellow : C.dim;
    out.push(`  ${paint(fmtBytes(e.size).padStart(9), col, c)}  ${paint((share.toFixed(1) + "%").padStart(6), C.dim, c)}  ${fmtInt(e.instances).padStart(13)}  ${e.className}`);
  }
  return out.join("\n");
}

export function renderHprofRetainers(rr: RetainerResult, opts: { color: boolean; json: boolean; top: number }): string {
  if (opts.json) return JSON.stringify({ kind: "hprof-retainers", ...rr, referrers: rr.referrers.slice(0, opts.top) }, null, 2);
  const c = opts.color; const out: string[] = [];
  out.push(paint("─── hprof retainers — who references the target ────────", C.cyan, c));
  out.push(`${paint("target   :", C.dim, c)} ${paint(rr.target, C.bold, c)}  ·  ${fmtInt(rr.targetInstances)} instances · ${fmtBytes(rr.targetSize)}`);
  if (rr.rootHeld > 0) out.push(`${paint("note     :", C.dim, c)} ${rr.rootHeld} instance(s) are GC roots directly`);
  out.push(`${paint("refs     :", C.dim, c)} ${fmtInt(rr.scannedRefs)} incoming references found`);
  out.push("");
  out.push(paint("Held by (immediate referrers, by class):", C.bold, c));
  out.push(paint(`  ${"refs".padStart(13)}  ${"share".padStart(6)}  referrer class`, C.dim, c));
  const denom = rr.scannedRefs || 1;
  for (const ref of rr.referrers.slice(0, opts.top)) {
    const share = (ref.count / denom) * 100;
    const col = share >= 25 ? C.red : share >= 10 ? C.yellow : C.dim;
    out.push(`  ${paint(fmtInt(ref.count).padStart(13), col, c)}  ${paint((share.toFixed(1) + "%").padStart(6), C.dim, c)}  ${ref.className}`);
  }
  out.push("");
  out.push(paint(`Re-run with --retainers "<referrer class>" to climb the chain toward the GC root.`, C.dim, c));
  return out.join("\n");
}
