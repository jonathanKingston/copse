import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "../web/server.js";

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
