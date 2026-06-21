import assert from "./assertions.js";
import { chunks, fakeProvider, fakeStreamProvider, mod, withConsoleLog, withFetch, withPatchedGlobal } from "./helpers.js";

export const suiteName = "uploads";
export const cases = [
  ["reports dropped image note when no Gemini cookie is configured", async () => {
    const result = await mod.resolveImages({
      cookie: "",
      log_requests: false,
    }, [{ b64: "AAAA", mime: "image/png" }]);
    assert.equal(result.fileRefs, null);
    assert.match(result.droppedNote, /image input requires a configured GEMINI_COOKIE/);
  }],
  ["reports missing base64 decoder when no native or atob decoder exists", async () => {
    const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true, writable: true });
    try {
      await withPatchedGlobal("atob", undefined, async () => {
        await assert.rejects(() => mod.base64ToBytes("AAAA"), /base64 decoder is not available/);
      });
    } finally {
      if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
      else delete Uint8Array.fromBase64;
    }
  }],
  ["uploads a single image through the direct uploadImage helper", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const requests = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      requests.push({ href, init });
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-direct","Ylro7b":"pctx-direct"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["Push-ID"], "push-direct");
        assert.equal(init.headers["X-Client-Pctx"], "pctx-direct");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "image/jpeg");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Length"], "2");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/direct-image" } });
      }
      if (href === "https://upload.example/direct-image") {
        assert.equal(init.body.byteLength, 2);
        return new Response("/uploaded/direct-image-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const ref = await mod.uploadImage({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, new Uint8Array([1, 2]), "image/jpeg");
      assert.equal(ref, "/uploaded/direct-image-ref");
    });
    assert.deepEqual(requests.map((request) => request.href), [
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/direct-image",
    ]);
  }],
  ["uploads images through Scotty and returns sanitized filenames", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const requests = [];
    await withFetch(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url) === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-1","Ylro7b":"pctx-1","SNlM0e":"at-1"}', { status: 200 });
      }
      if (String(url) === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["Push-ID"], "push-1");
        assert.equal(init.headers["X-Client-Pctx"], "pctx-1");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "image/png");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/finalize" } });
      }
      if (String(url) === "https://upload.example/finalize") {
        assert.equal(init.method, "POST");
        assert.equal(init.headers["X-Goog-Upload-Command"], "upload, finalize");
        return new Response("/uploaded/image-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveImages({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, [{ b64: "aGVsbG8=", mime: "image/png", filename: "../unsafe name.png" }]);
      assert.deepEqual(result.fileRefs, [{ ref: "/uploaded/image-ref", name: "unsafe name.png" }]);
      assert.equal(result.droppedNote, "");
    });
    assert.equal(requests.length, 3);
  }],
  ["uploads multiple images in parallel while preserving order", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    let startCount = 0;
    const finalizes = [];
    await withFetch(async (url) => {
      const href = String(url);
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-1","Ylro7b":"pctx-1"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        const id = startCount;
        startCount += 1;
        return new Response("", { status: 200, headers: { "x-goog-upload-url": `https://upload.example/finalize/${id}` } });
      }
      if (href.startsWith("https://upload.example/finalize/")) {
        const id = href.split("/").pop();
        const gate = deferred();
        finalizes.push({ id, gate });
        if (finalizes.length === 3) {
          for (const item of finalizes) item.gate.resolve();
        }
        await gate.promise;
        return new Response(`/uploaded/image-${href.split("/").pop()}`, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveImages({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, [
        { b64: "YQ==", mime: "image/png", filename: "a.png" },
        { b64: "Yg==", mime: "image/png", filename: "b.png" },
        { b64: "Yw==", mime: "image/png", filename: "c.png" },
      ]);
      assert.deepEqual(result.fileRefs, [
        { ref: "/uploaded/image-0", name: "a.png" },
        { ref: "/uploaded/image-1", name: "b.png" },
        { ref: "/uploaded/image-2", name: "c.png" },
      ]);
      assert.equal(result.droppedNote, "");
    });
    assert.equal(startCount, 3);
    assert.deepEqual(finalizes.map((item) => item.id), ["0", "1", "2"]);
  }],
  ["returns dropped image note when upload start fails", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url) => {
      if (String(url) === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-1","Ylro7b":"pctx-1"}', { status: 200 });
      }
      return new Response("", { status: 500 });
    }, async () => {
      const result = await mod.resolveImages({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, [{ b64: "aGVsbG8=", mime: "image/png" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /some image uploads failed/);
    });
  }],
  ["fetches remote image URLs and derives filenames from URL paths", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const requests = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      requests.push({ href, init });
      if (href === "https://images.example/path/remote%20image.webp?size=large") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        });
      }
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-url","Ylro7b":"pctx-url"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "image/webp");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Length"], "3");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/url-finalize" } });
      }
      if (href === "https://upload.example/url-finalize") {
        return new Response("/uploaded/url-image-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveImages({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, [{ url: "https://images.example/path/remote%20image.webp?size=large" }]);
      assert.deepEqual(result.fileRefs, [{ ref: "/uploaded/url-image-ref", name: "remote image.webp" }]);
      assert.equal(result.droppedNote, "");
    });
    assert.deepEqual(requests.map((item) => item.href), [
      "https://images.example/path/remote%20image.webp?size=large",
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/url-finalize",
    ]);
  }],
  ["retries text upload after RotateCookies refreshes an auth failure", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const seenCookies = [];
    let startCalls = 0;
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") {
        seenCookies.push(init.headers.Cookie);
        return new Response('{"qKIAYe":"push-rotate","Ylro7b":"pctx-rotate"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        startCalls += 1;
        seenCookies.push(init.headers.Cookie);
        if (startCalls === 1) return new Response("", { status: 401 });
        assert.equal(init.headers.Cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/rotated-text" } });
      }
      if (href === "https://accounts.google.com/RotateCookies") {
        assert.equal(init.headers.Cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi");
        return new Response("", {
          status: 200,
          headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
        });
      }
      if (href === "https://upload.example/rotated-text") {
        return new Response("/uploaded/rotated-text-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const ref = await mod.uploadTextFile({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, "hello after rotate", "rotated.txt");
      assert.deepEqual(ref, { ref: "/uploaded/rotated-text-ref", name: "rotated.txt" });
    });
    assert.equal(startCalls, 2);
    assert.deepEqual(seenCookies, [
      "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
      "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
    ]);
  }],
  ["uploads text files as Gemini file refs", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    let uploadBodyLength = 0;
    await withFetch(async (url, init = {}) => {
      if (String(url) === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-1","Ylro7b":"pctx-1"}', { status: 200 });
      }
      if (String(url) === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "text/plain; charset=utf-8");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/text" } });
      }
      uploadBodyLength = init.body.byteLength;
      return new Response("/uploaded/text-ref", { status: 200 });
    }, async () => {
      const ref = await mod.uploadTextFile({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, "hello", "message.txt");
      assert.deepEqual(ref, { ref: "/uploaded/text-ref", name: "message.txt" });
      assert.equal(uploadBodyLength, 5);
    });
  }],
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
