import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const USERCONTENT = "https://spark-usercontent.lucko.me";
const VIEWER = "spark.lucko.me";

export interface Source {
  origin: string;
  bytes: Uint8Array;
  /**
   * MIME type the payload was stored as, e.g. `application/x-spark-sampler`
   * or `application/x-spark-heap`. Empty for local files (sniff by content).
   */
  contentType: string;
}

function extractCode(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.hostname === VIEWER || url.hostname.endsWith("." + VIEWER) || url.hostname.endsWith("spark-usercontent.lucko.me")) {
      const code = url.pathname.replace(/^\/+/, "").split("/")[0];
      return code || null;
    }
  } catch {
    // not a URL
  }
  if (/^[A-Za-z0-9]{8,16}$/.test(input)) return input;
  return null;
}

export async function load(input: string): Promise<Source> {
  if (existsSync(input)) {
    const buf = await readFile(input);
    return { origin: input, bytes: new Uint8Array(buf), contentType: "" };
  }

  const code = extractCode(input);
  if (!code) {
    throw new Error(`Could not interpret \`${input}\` as a file, spark URL, or spark code.`);
  }

  const url = `${USERCONTENT}/${code}`;
  const res = await fetch(url, {
    headers: {
      // usercontent ignores Accept and serves whatever was stored, but list
      // every format we can read so the request stays honest / future-proof.
      Accept:
        "application/x-spark-sampler, application/x-spark-heap, application/x-spark-health",
      Referer: "https://spark.lucko.me/",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  return { origin: url, bytes: new Uint8Array(ab), contentType };
}
