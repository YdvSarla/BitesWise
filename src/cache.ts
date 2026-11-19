import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CACHE_DIR = new URL("../.cache/", import.meta.url).pathname;
const TTL_MS = Number(process.env.CACHE_TTL_SECONDS ?? 300) * 1000;

interface Entry<T> {
  savedAt: number;
  value: T;
}

function fileFor(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  return `${CACHE_DIR}${hash}.json`;
}

export function cacheGet<T>(key: string): T | undefined {
  try {
    const entry = JSON.parse(readFileSync(fileFor(key), "utf8")) as Entry<T>;
    if (Date.now() - entry.savedAt > TTL_MS) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

export function cacheSet<T>(key: string, value: T): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const entry: Entry<T> = { savedAt: Date.now(), value };
  writeFileSync(fileFor(key), JSON.stringify(entry));
}
