import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer, DEFAULT_MAX_BODY_BYTES } from "../web/server.js";

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

test("web API fails fast on invalid template choice", async () => {
  const server = startWebServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(server);
  const baseUrl = serverUrl(server);
  try {
    const response = await fetch(`${baseUrl}/api/issues`, {
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
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(String(body.error || ""), /templateChoice must be one of/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("web API returns 413 when request body exceeds max size", async () => {
  const maxBodyBytes = 256; // very small limit for testing
  const server = startWebServer({ host: "127.0.0.1", port: 0, maxBodyBytes });
  await waitForListening(server);
  const baseUrl = serverUrl(server);
  try {
    const oversizedPayload = JSON.stringify({ data: "x".repeat(maxBodyBytes + 1) });
    const response = await fetch(`${baseUrl}/api/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedPayload,
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.match(String(body.error || ""), /maximum allowed size/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("web API accepts request body within max size", async () => {
  const server = startWebServer({ host: "127.0.0.1", port: 0, maxBodyBytes: DEFAULT_MAX_BODY_BYTES });
  await waitForListening(server);
  const baseUrl = serverUrl(server);
  try {
    // A small valid payload should not trigger the size limit (will fail for other reasons like invalid templateChoice, but NOT 413)
    const response = await fetch(`${baseUrl}/api/issues`, {
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
    assert.notEqual(response.status, 413, "Small payload should not trigger 413");
    assert.equal(response.status, 400); // fails on templateChoice validation, not size
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("web API fails fast on invalid PR route repo", async () => {
  const server = startWebServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(server);
  const baseUrl = serverUrl(server);
  try {
    const response = await fetch(`${baseUrl}/api/pr/not-a-repo/10/comments`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(String(body.error || ""), /Invalid repo/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
