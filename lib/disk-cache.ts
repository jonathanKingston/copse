import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CACHE_DIR = join(homedir(), ".copse", "cache");
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 500;
const CLEANUP_AGE_MS = 30 * 60 * 1000; // 30 minutes — remove files older than this on startup

let _cleanupDone = false;

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

/** Hash the cache key into a hex filename. */
function cacheFilename(key: string): string {
  return createHash("sha256").update(key).digest("hex") + ".json";
}

function cachePath(key: string): string {
  return join(CACHE_DIR, cacheFilename(key));
}

/**
 * Auto-clean stale cache entries on first use.
 * Removes files whose mtime is older than CLEANUP_AGE_MS.
 * Also caps total entries at MAX_CACHE_ENTRIES by removing oldest first.
 */
export function cleanupDiskCache(): void {
  if (_cleanupDone) return;
  _cleanupDone = true;
  try {
    ensureCacheDir();
    const entries = readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const fullPath = join(CACHE_DIR, f);
        try {
          const stat = statSync(fullPath);
          return { path: fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; mtimeMs: number } => e !== null);

    const now = Date.now();
    // Remove stale entries
    for (const entry of entries) {
      if (now - entry.mtimeMs > CLEANUP_AGE_MS) {
        try { unlinkSync(entry.path); } catch { /* ignore */ }
      }
    }

    // Cap size: keep newest MAX_CACHE_ENTRIES
    const remaining = entries
      .filter((e) => now - e.mtimeMs <= CLEANUP_AGE_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of remaining.slice(MAX_CACHE_ENTRIES)) {
      try { unlinkSync(entry.path); } catch { /* ignore */ }
    }
  } catch {
    // Cache cleanup is best-effort; don't break the CLI.
  }
}

/**
 * Read a cached value from disk if it exists and hasn't expired.
 * @param key  The cache key (e.g. `gh\0api\0...`)
 * @param ttlMs  Maximum age in milliseconds (defaults to 5 min)
 * @returns The cached string value, or null if miss/expired.
 */
export function diskCacheGet(key: string, ttlMs: number = DEFAULT_TTL_MS): string | null {
  try {
    const fp = cachePath(key);
    const stat = statSync(fp);
    if (Date.now() - stat.mtimeMs > ttlMs) {
      // Expired — remove it opportunistically.
      try { unlinkSync(fp); } catch { /* ignore */ }
      return null;
    }
    return readFileSync(fp, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write a value to the disk cache.
 * @param key  The cache key
 * @param value  The string value to cache
 */
export function diskCacheSet(key: string, value: string): void {
  try {
    ensureCacheDir();
    writeFileSync(cachePath(key), value, "utf-8");
  } catch {
    // Best-effort; don't break the CLI.
  }
}

/** Exported for testing. */
export { CACHE_DIR };
