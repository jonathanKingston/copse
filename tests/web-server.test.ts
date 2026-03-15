import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "../web/server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForListening(server: ReturnType<typeof startWebServer>): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
}

function serverUrl(server: ReturnType<typeof startWebServer>): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server is not listening on a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = startWebServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(server);
  try {
    await fn(serverUrl(server));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

test("GET / serves index.html with text/html content-type", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") || "";
    assert.ok(ct.includes("text/html"), `expected text/html, got ${ct}`);
    const body = await res.text();
    assert.ok(body.length > 0, "response body should not be empty");
  });
});

test("GET /index.html serves with text/html content-type", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/index.html`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") || "";
    assert.ok(ct.includes("text/html"), `expected text/html, got ${ct}`);
  });
});

test("GET /styles.css serves with text/css content-type", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/styles.css`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") || "";
    assert.ok(ct.includes("text/css"), `expected text/css, got ${ct}`);
  });
});

test("GET /app.js serves with text/javascript content-type", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/app.js`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") || "";
    assert.ok(ct.includes("text/javascript"), `expected text/javascript, got ${ct}`);
  });
});

test("GET /nonexistent-file.txt returns 404", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nonexistent-file.txt`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(body.includes("Not found"), "body should say Not found");
  });
});

test("GET static path traversal is blocked", async () => {
  await withServer(async (baseUrl) => {
    // Attempt to traverse out of public dir using encoded ../
    const res = await fetch(`${baseUrl}/%2e%2e/package.json`);
    // Should be either 403 (forbidden) or 404 (not found in public dir)
    assert.ok(
      res.status === 403 || res.status === 404,
      `expected 403 or 404, got ${res.status}`,
    );
    await res.text(); // consume body
  });
});

// ---------------------------------------------------------------------------
// API: 404 for unknown endpoints
// ---------------------------------------------------------------------------

test("GET unknown API route returns 404 JSON", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(res.status, 404);
    const ct = res.headers.get("content-type") || "";
    assert.ok(ct.includes("application/json"), `expected JSON content-type, got ${ct}`);
    const body = await res.json();
    assert.ok(body.error, "should have error field");
    assert.match(body.error, /not found/i);
  });
});

test("POST unknown API route returns 404 JSON", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/nonexistent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "should have error field");
  });
});

// ---------------------------------------------------------------------------
// API: /api/issues validation
// ---------------------------------------------------------------------------

test("POST /api/issues fails on invalid templateChoice", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/repo",
        title: "title",
        body: "body",
        agent: "cursor",
        templateChoice: 99,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /templateChoice must be one of/);
  });
});

test("POST /api/issues fails on negative templateChoice", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/repo",
        title: "t",
        body: "b",
        agent: "cursor",
        templateChoice: -1,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /templateChoice/);
  });
});

// ---------------------------------------------------------------------------
// API: /api/chain-merge validation
// ---------------------------------------------------------------------------

test("POST /api/chain-merge fails with non-array prs", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chain-merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/repo", prs: "not-an-array" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /prs must be an array/);
  });
});

test("POST /api/chain-merge fails with too few prs", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chain-merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/repo",
        prs: [{ number: 1, headRefName: "b1" }],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /at least 2/);
  });
});

test("POST /api/chain-merge fails with invalid PR entries", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chain-merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/repo",
        prs: [
          { number: -1, headRefName: "b1" },
          { number: 2, headRefName: "b2" },
        ],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /valid number/);
  });
});

test("POST /api/chain-merge fails with invalid repo format", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chain-merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "not-a-valid-repo",
        prs: [
          { number: 1, headRefName: "b1" },
          { number: 2, headRefName: "b2" },
        ],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid repo/);
  });
});

// ---------------------------------------------------------------------------
// API: /api/branches/create-pr validation
// ---------------------------------------------------------------------------

test("POST /api/branches/create-pr fails with empty headRefName", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/branches/create-pr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/repo", headRefName: "" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /headRefName cannot be empty/);
  });
});

test("POST /api/branches/create-pr fails with invalid repo", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/branches/create-pr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "bad", headRefName: "my-branch" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid repo/);
  });
});

// ---------------------------------------------------------------------------
// API: PR action routes – repo/PR number validation
// ---------------------------------------------------------------------------

test("GET /api/pr/<invalid-repo>/<num>/comments returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/not-a-repo/10/comments`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid repo/);
  });
});

test("GET /api/pr/<repo>/<invalid-num>/comments returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/abc/comments`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid pull request number/);
  });
});

test("GET /api/pr/<repo>/0/comments returns 400 (PR number must be > 0)", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/0/comments`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid pull request number/);
  });
});

test("GET /api/pr/<invalid-repo>/<num>/files returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/bad/5/files`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid repo/);
  });
});

test("GET /api/pr/<repo>/<invalid-num>/files returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/-3/files`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid pull request number/);
  });
});

test("GET /api/pr/<invalid-repo>/<num>/artifacts returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/bad/5/artifacts`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid repo/);
  });
});

test("GET /api/pr/<repo>/<invalid-num>/artifacts returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/notnum/artifacts`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid pull request number/);
  });
});

test("GET /api/pr/<invalid-repo>/<num>/agents returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/bad/5/agents`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid repo/);
  });
});

test("GET /api/pr/<repo>/<invalid-num>/agents returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/0/agents`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid pull request number/);
  });
});

// ---------------------------------------------------------------------------
// API: POST PR action routes – validation
// ---------------------------------------------------------------------------

test("POST /api/pr/<invalid-repo>/10/approve returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/bad/10/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid repo/);
  });
});

test("POST /api/pr/<repo>/<invalid-num>/rerun returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/abc/rerun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid pull request number/);
  });
});

test("POST /api/pr/<repo>/0/merge-auto returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/0/merge-auto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid pull request number/);
  });
});

test("POST /api/pr/<repo>/<num>/unknown-action returns 404", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/1/unknown-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(String(body.error || ""), /not found/i);
  });
});

// ---------------------------------------------------------------------------
// API: POST /api/pr/.../reply validation
// ---------------------------------------------------------------------------

test("POST /api/pr/<repo>/<num>/reply fails without inReplyToId", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/1/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "test" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /inReplyToId must be a positive number/);
  });
});

test("POST /api/pr/<repo>/<num>/reply fails with invalid inReplyToId", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/1/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "test", inReplyToId: -5 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /inReplyToId must be a positive number/);
  });
});

test("POST /api/pr/<repo>/<num>/reply fails with invalid delivery", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/1/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "test", inReplyToId: 100, delivery: "pigeon" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /delivery must be/);
  });
});

// ---------------------------------------------------------------------------
// API: POST /api/pr/.../batch-reply validation
// ---------------------------------------------------------------------------

test("POST /api/pr/<repo>/<num>/batch-reply fails without commentIds", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/1/batch-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "test" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /commentIds must be a non-empty array/);
  });
});

test("POST /api/pr/<repo>/<num>/batch-reply fails with empty commentIds", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/1/batch-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "test", commentIds: [] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /commentIds must be a non-empty array/);
  });
});

test("POST /api/pr/<repo>/<num>/batch-reply fails with invalid commentIds entries", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/1/batch-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "test", commentIds: [-1] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /positive numbers/);
  });
});

// ---------------------------------------------------------------------------
// API: Malformed JSON body handling
// ---------------------------------------------------------------------------

test("POST with malformed JSON returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /invalid JSON body/);
  });
});

test("POST with JSON array body returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2,3]",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /must be an object/);
  });
});

test("POST with empty body is treated as empty object", async () => {
  await withServer(async (baseUrl) => {
    // Empty body to /api/issues should fail on templateChoice validation, not JSON parsing
    const res = await fetch(`${baseUrl}/api/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    // Should get a validation error, not a JSON parsing error
    assert.match(String(body.error || ""), /templateChoice/);
  });
});

// ---------------------------------------------------------------------------
// API: /api/status scope validation
// ---------------------------------------------------------------------------

test("GET /api/status with invalid scope returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/status?scope=invalid-scope&repos=acme/repo`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ""), /Invalid scope/);
  });
});

// ---------------------------------------------------------------------------
// API: Content-Type headers on JSON responses
// ---------------------------------------------------------------------------

test("API error responses have application/json content-type", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    const ct = res.headers.get("content-type") || "";
    assert.ok(
      ct.includes("application/json"),
      `expected application/json, got ${ct}`,
    );
    await res.json(); // consume
  });
});

test("API 400 responses have application/json content-type", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "bad json{",
    });
    assert.equal(res.status, 400);
    const ct = res.headers.get("content-type") || "";
    assert.ok(
      ct.includes("application/json"),
      `expected application/json, got ${ct}`,
    );
    await res.json(); // consume
  });
});

// ---------------------------------------------------------------------------
// API: Cursor artifact download – missing path param
// ---------------------------------------------------------------------------

test("GET /api/cursor/agents/<id>/artifacts/download without path returns 400", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/cursor/agents/agent123/artifacts/download`);
    assert.equal(res.status, 400);
    const body = await res.json();
    // Either the Cursor API key check or the missing path check should fire
    assert.ok(body.error, "should have an error");
  });
});

// ---------------------------------------------------------------------------
// Method validation: GET on POST-only routes returns 404
// ---------------------------------------------------------------------------

test("GET on /api/issues returns 404 (POST only)", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/issues`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(String(body.error || ""), /not found/i);
  });
});

test("GET on /api/chain-merge returns 404 (POST only)", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chain-merge`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(String(body.error || ""), /not found/i);
  });
});

test("GET on /api/branches/create-pr returns 404 (POST only)", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/branches/create-pr`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(String(body.error || ""), /not found/i);
  });
});

test("GET on /api/pr/<repo>/<num>/approve returns 404 (POST only)", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/pr/acme%2Frepo/1/approve`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(String(body.error || ""), /not found/i);
  });
});
