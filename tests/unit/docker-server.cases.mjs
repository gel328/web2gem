import assert from "./assertions.js";
import { createDockerServer, requestHeaders, requestUrl } from "../../scripts/docker-server.mjs";

export const suiteName = "docker server";
export const cases = [
  ["normalizes raw Node headers and forwarded request URLs", async () => {
    const headers = requestHeaders(["X-Test", "one", "x-test", "two", "Host", "worker.example"]);
    assert.equal(headers.get("x-test"), "one, two");
    assert.equal(headers.get("host"), "worker.example");

    const url = requestUrl({
      headers: {
        host: "internal.example",
        "x-forwarded-host": "api.example, proxy.example",
        "x-forwarded-proto": "https, http",
      },
      url: "/v1/models?q=1",
    }, 9999);
    assert.equal(url, "https://api.example/v1/models?q=1");

    const fallbackUrl = requestUrl({
      headers: {
        host: "internal.example",
        "x-forwarded-proto": ["https", "http"],
      },
      url: "/v1/models",
    }, 9999);
    assert.equal(fallbackUrl, "https://internal.example/v1/models");
  }],
  ["adapts Node HTTP requests to Worker fetch with streamed bodies", async () => {
    const seen = {};
    const server = createDockerServer({
      port: 0,
      env: { API_KEYS: "[]", CUSTOM_ENV: "ok" },
      worker: {
        async fetch(request, env, ctx) {
          seen.url = request.url;
          seen.method = request.method;
          seen.env = env;
          seen.body = await request.text();
          ctx.waitUntil(Promise.resolve());
          return new Response(JSON.stringify({
            url: request.url,
            method: request.method,
            body: seen.body,
            env: env.CUSTOM_ENV,
          }), {
            status: 201,
            headers: {
              "content-type": "application/json",
              "x-adapter": "docker",
            },
          });
        },
      },
    });
    await listen(server);
    try {
      const port = server.address().port;
      const resp = await fetch(`http://127.0.0.1:${port}/v1/test`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-forwarded-proto": "https",
          host: "worker.example",
        },
        body: "hello",
      });
      assert.equal(resp.status, 201);
      assert.equal(resp.headers.get("x-adapter"), "docker");
      const body = await resp.json();
      assert.match(body.url, /^https:\/\/127\.0\.0\.1:\d+\/v1\/test$/);
      assert.equal(body.method, "POST");
      assert.equal(body.body, "hello");
      assert.equal(body.env, "ok");
      assert.equal(seen.body, "hello");
    } finally {
      await close(server);
    }
  }],
  ["does not stream response bodies for HEAD requests", async () => {
    const seen = {};
    const server = createDockerServer({
      worker: {
        async fetch(request) {
          seen.method = request.method;
          return new Response("body should not be sent", {
            status: 200,
            headers: {
              "x-head-check": "ok",
            },
          });
        },
      },
    });
    await listen(server);
    try {
      const port = server.address().port;
      const resp = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers.get("x-head-check"), "ok");
      assert.equal(await resp.text(), "");
      assert.equal(seen.method, "HEAD");
    } finally {
      await close(server);
    }
  }],
  ["returns generic JSON errors for adapter failures", async () => {
    const server = createDockerServer({
      worker: {
        async fetch() {
          throw new Error("boom");
        },
      },
    });
    await listen(server);
    try {
      const port = server.address().port;
      const resp = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(resp.status, 500);
      assert.match(resp.headers.get("content-type"), /^application\/json\b/);
      assert.deepEqual(await resp.json(), { error: { message: "internal server error" } });
    } finally {
      await close(server);
    }
  }],
];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}
