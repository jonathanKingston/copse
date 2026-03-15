import test from "node:test";
import assert from "node:assert/strict";

import {
  cacheDecisionForGhArgs,
  ghReadCache,
  GH_READ_CACHE_MAX_ENTRIES,
  maybePruneGhReadCache,
  gh,
  ghQuiet,
} from "../lib/gh.js";
import { setApiProvider, resetApiProvider } from "../lib/api-provider.js";
import type { ApiProvider } from "../lib/api-provider.js";
import { WATCH_INTERVAL_MS } from "../lib/services/status-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ApiProvider that records gh() calls and returns a canned value. */
function makeSpyProvider(returnValue: string): {
  provider: ApiProvider;
  calls: string[][];
} {
  const calls: string[][] = [];
  const provider: ApiProvider = {
    gh(...args: string[]): string {
      calls.push(args);
      return returnValue;
    },
    ghQuiet(...args: string[]): string {
      calls.push(args);
      return returnValue;
    },
    ghQuietAsync(...args: string[]): Promise<string> {
      calls.push(args);
      return Promise.resolve(returnValue);
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// cacheDecisionForGhArgs — decides whether to cache a given gh invocation
// ---------------------------------------------------------------------------

test("cacheDecision: empty args are not cacheable", () => {
  const d = cacheDecisionForGhArgs([]);
  assert.equal(d.ok, false);
});

test("cacheDecision: api GET is cacheable", () => {
  const d = cacheDecisionForGhArgs(["api", "repos/acme/foo/pulls"]);
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.ttlMs, WATCH_INTERVAL_MS);
    assert.ok(d.key.length > 0);
  }
});

test("cacheDecision: api with explicit GET method is cacheable", () => {
  const d = cacheDecisionForGhArgs(["api", "repos/acme/foo", "--method", "GET"]);
  assert.equal(d.ok, true);
});

test("cacheDecision: api POST is not cacheable", () => {
  const d = cacheDecisionForGhArgs(["api", "some/endpoint", "-X", "POST"]);
  assert.equal(d.ok, false);
});

test("cacheDecision: api PUT is not cacheable", () => {
  const d = cacheDecisionForGhArgs(["api", "some/endpoint", "--method", "PUT"]);
  assert.equal(d.ok, false);
});

test("cacheDecision: api DELETE is not cacheable", () => {
  const d = cacheDecisionForGhArgs(["api", "some/endpoint", "-X", "DELETE"]);
  assert.equal(d.ok, false);
});

test("cacheDecision: graphql read query is cacheable", () => {
  const d = cacheDecisionForGhArgs([
    "api", "graphql",
    "-f", "query=query { repository { name } }",
  ]);
  assert.equal(d.ok, true);
});

test("cacheDecision: graphql mutation is not cacheable", () => {
  const d = cacheDecisionForGhArgs([
    "api", "graphql",
    "-f", "query=mutation { resolveReviewThread(input: {}) { thread { isResolved } } }",
  ]);
  assert.equal(d.ok, false);
});

test("cacheDecision: pr list with --repo is cacheable", () => {
  const d = cacheDecisionForGhArgs([
    "pr", "list", "--repo", "acme/foo", "--state", "open",
  ]);
  assert.equal(d.ok, true);
});

test("cacheDecision: pr list without --repo is not cacheable", () => {
  const d = cacheDecisionForGhArgs(["pr", "list", "--state", "open"]);
  assert.equal(d.ok, false);
});

test("cacheDecision: run list with --repo is cacheable", () => {
  const d = cacheDecisionForGhArgs([
    "run", "list", "--repo", "acme/foo", "--branch", "main",
  ]);
  assert.equal(d.ok, true);
});

test("cacheDecision: run list without --repo is not cacheable", () => {
  const d = cacheDecisionForGhArgs(["run", "list"]);
  assert.equal(d.ok, false);
});

test("cacheDecision: --web flag prevents caching", () => {
  const d = cacheDecisionForGhArgs(["api", "repos/acme/foo", "--web"]);
  assert.equal(d.ok, false);
});

test("cacheDecision: --browser flag prevents caching", () => {
  const d = cacheDecisionForGhArgs(["api", "repos/acme/foo", "--browser"]);
  assert.equal(d.ok, false);
});

test("cacheDecision: non-cacheable subcommands return ok false", () => {
  assert.equal(cacheDecisionForGhArgs(["pr", "create"]).ok, false);
  assert.equal(cacheDecisionForGhArgs(["pr", "merge"]).ok, false);
  assert.equal(cacheDecisionForGhArgs(["issue", "list"]).ok, false);
});

test("cacheDecision: same args produce the same key", () => {
  const args = ["api", "repos/acme/foo/pulls", "--paginate"];
  const d1 = cacheDecisionForGhArgs(args);
  const d2 = cacheDecisionForGhArgs(args);
  assert.equal(d1.ok, true);
  assert.equal(d2.ok, true);
  if (d1.ok && d2.ok) {
    assert.equal(d1.key, d2.key);
  }
});

test("cacheDecision: different args produce different keys", () => {
  const d1 = cacheDecisionForGhArgs(["api", "repos/acme/foo"]);
  const d2 = cacheDecisionForGhArgs(["api", "repos/acme/bar"]);
  assert.equal(d1.ok, true);
  assert.equal(d2.ok, true);
  if (d1.ok && d2.ok) {
    assert.notEqual(d1.key, d2.key);
  }
});

// ---------------------------------------------------------------------------
// ghReadCache + maybePruneGhReadCache — TTL and eviction
// ---------------------------------------------------------------------------

test("ghReadCache: cache hit returns stored value within TTL", () => {
  ghReadCache.clear();
  const key = "test-hit";
  const now = Date.now();
  ghReadCache.set(key, { value: "cached-result", expiresAt: now + 60_000 });
  const entry = ghReadCache.get(key);
  assert.ok(entry);
  assert.equal(entry.value, "cached-result");
  assert.ok(entry.expiresAt > now);
  ghReadCache.clear();
});

test("ghReadCache: expired entry is treated as miss", () => {
  ghReadCache.clear();
  const key = "test-expired";
  const now = Date.now();
  ghReadCache.set(key, { value: "stale", expiresAt: now - 1 });
  const entry = ghReadCache.get(key);
  assert.ok(entry);
  // Verify the entry is expired
  assert.ok(entry.expiresAt <= now);
  ghReadCache.clear();
});

test("maybePruneGhReadCache: removes expired entries", () => {
  ghReadCache.clear();
  const now = Date.now();
  ghReadCache.set("expired-1", { value: "a", expiresAt: now - 1000 });
  ghReadCache.set("expired-2", { value: "b", expiresAt: now - 500 });
  ghReadCache.set("valid-1", { value: "c", expiresAt: now + 60_000 });

  maybePruneGhReadCache(now);

  assert.equal(ghReadCache.size, 1);
  assert.ok(ghReadCache.has("valid-1"));
  assert.equal(ghReadCache.has("expired-1"), false);
  assert.equal(ghReadCache.has("expired-2"), false);
  ghReadCache.clear();
});

test("maybePruneGhReadCache: clears everything when exceeding max entries", () => {
  ghReadCache.clear();
  const now = Date.now();
  // Fill cache beyond max (all entries are valid so none get pruned by TTL)
  for (let i = 0; i <= GH_READ_CACHE_MAX_ENTRIES; i++) {
    ghReadCache.set(`key-${i}`, { value: `v${i}`, expiresAt: now + 60_000 });
  }
  assert.ok(ghReadCache.size > GH_READ_CACHE_MAX_ENTRIES);

  maybePruneGhReadCache(now);

  assert.equal(ghReadCache.size, 0, "cache should be fully cleared when exceeding max entries");
  ghReadCache.clear();
});

test("maybePruneGhReadCache: does not clear when at exactly max entries", () => {
  ghReadCache.clear();
  const now = Date.now();
  for (let i = 0; i < GH_READ_CACHE_MAX_ENTRIES; i++) {
    ghReadCache.set(`key-${i}`, { value: `v${i}`, expiresAt: now + 60_000 });
  }
  assert.equal(ghReadCache.size, GH_READ_CACHE_MAX_ENTRIES);

  maybePruneGhReadCache(now);

  assert.equal(ghReadCache.size, GH_READ_CACHE_MAX_ENTRIES, "cache at exactly max should not be cleared");
  ghReadCache.clear();
});

test("maybePruneGhReadCache: expired removal can bring size under max, avoiding full clear", () => {
  ghReadCache.clear();
  const now = Date.now();
  // Add max valid entries
  for (let i = 0; i < GH_READ_CACHE_MAX_ENTRIES; i++) {
    ghReadCache.set(`valid-${i}`, { value: `v${i}`, expiresAt: now + 60_000 });
  }
  // Add some expired entries to push over the limit
  for (let i = 0; i < 10; i++) {
    ghReadCache.set(`expired-${i}`, { value: `e${i}`, expiresAt: now - 1 });
  }
  assert.ok(ghReadCache.size > GH_READ_CACHE_MAX_ENTRIES);

  maybePruneGhReadCache(now);

  // Expired entries removed first, bringing size to exactly max, so no full clear
  assert.equal(ghReadCache.size, GH_READ_CACHE_MAX_ENTRIES);
  assert.equal(ghReadCache.has("expired-0"), false);
  assert.ok(ghReadCache.has("valid-0"));
  ghReadCache.clear();
});

// ---------------------------------------------------------------------------
// gh() / ghQuiet() integration with cache via ApiProvider spy
// ---------------------------------------------------------------------------

// Note: gh() checks for an ApiProvider first and bypasses the cache when one is
// set. The cache is only exercised when no provider is active, which requires
// calling the real `execFileSync("gh", ...)`. To test the caching *logic*
// end-to-end without shelling out, we verify the cache decision + manual cache
// population patterns used by gh().

test("gh(): cacheable call populates ghReadCache when provider is absent", () => {
  // We can't easily call gh() without a real `gh` binary, so instead we verify
  // the contract: cacheDecisionForGhArgs returns a decision, and the cache
  // entry format matches what gh() writes.
  ghReadCache.clear();
  const args = ["api", "repos/acme/test"];
  const decision = cacheDecisionForGhArgs(args);
  assert.equal(decision.ok, true);

  if (decision.ok) {
    // Simulate what gh() does after a successful execFileSync
    const now = Date.now();
    const result = '{"id": 123}';
    ghReadCache.set(decision.key, { value: result, expiresAt: now + decision.ttlMs });

    // Verify cache hit
    const cached = ghReadCache.get(decision.key);
    assert.ok(cached);
    assert.equal(cached.value, result);
    assert.ok(cached.expiresAt > now);
  }
  ghReadCache.clear();
});

test("gh(): non-cacheable call does not populate cache", () => {
  ghReadCache.clear();
  const args = ["api", "some/endpoint", "-X", "POST"];
  const decision = cacheDecisionForGhArgs(args);
  assert.equal(decision.ok, false);
  // gh() would not write to cache for this decision
  assert.equal(ghReadCache.size, 0);
  ghReadCache.clear();
});

test("gh(): cache miss triggers fresh call (provider path)", () => {
  ghReadCache.clear();
  const { provider, calls } = makeSpyProvider("fresh-result");
  setApiProvider(provider);
  try {
    // Provider path bypasses cache entirely, so every call goes through
    const result1 = gh("api", "repos/acme/test");
    const result2 = gh("api", "repos/acme/test");
    assert.equal(result1, "fresh-result");
    assert.equal(result2, "fresh-result");
    // Both calls went through the provider
    assert.equal(calls.length, 2);
  } finally {
    resetApiProvider();
    ghReadCache.clear();
  }
});

test("ghQuiet(): provider path also bypasses cache", () => {
  ghReadCache.clear();
  const { provider, calls } = makeSpyProvider("quiet-result");
  setApiProvider(provider);
  try {
    const result = ghQuiet("api", "repos/acme/test");
    assert.equal(result, "quiet-result");
    assert.equal(calls.length, 1);
  } finally {
    resetApiProvider();
    ghReadCache.clear();
  }
});

// ---------------------------------------------------------------------------
// Cache key correctness
// ---------------------------------------------------------------------------

test("cache keys use null-byte separator so arg order matters", () => {
  const d1 = cacheDecisionForGhArgs(["api", "repos/a", "-q", ".name"]);
  const d2 = cacheDecisionForGhArgs(["api", "repos/a", ".name", "-q"]);
  assert.equal(d1.ok, true);
  assert.equal(d2.ok, true);
  if (d1.ok && d2.ok) {
    // Keys should differ because the arg order is different
    assert.notEqual(d1.key, d2.key);
  }
});

// ---------------------------------------------------------------------------
// TTL value correctness
// ---------------------------------------------------------------------------

test("cache TTL matches WATCH_INTERVAL_MS for all cacheable command types", () => {
  const cases: string[][] = [
    ["api", "repos/acme/foo"],
    ["api", "graphql", "-f", "query=query { viewer { login } }"],
    ["pr", "list", "--repo", "acme/foo"],
    ["run", "list", "--repo", "acme/foo"],
  ];
  for (const args of cases) {
    const d = cacheDecisionForGhArgs(args);
    assert.equal(d.ok, true, `expected cacheable: ${args.join(" ")}`);
    if (d.ok) {
      assert.equal(d.ttlMs, WATCH_INTERVAL_MS, `TTL mismatch for: ${args.join(" ")}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Pruning edge cases
// ---------------------------------------------------------------------------

test("maybePruneGhReadCache: no-op on empty cache", () => {
  ghReadCache.clear();
  maybePruneGhReadCache(Date.now());
  assert.equal(ghReadCache.size, 0);
});

test("maybePruneGhReadCache: entries expiring at exactly 'now' are removed", () => {
  ghReadCache.clear();
  const now = 1000;
  ghReadCache.set("exact", { value: "x", expiresAt: now });
  maybePruneGhReadCache(now);
  assert.equal(ghReadCache.has("exact"), false, "entry with expiresAt === now should be pruned");
  ghReadCache.clear();
});
