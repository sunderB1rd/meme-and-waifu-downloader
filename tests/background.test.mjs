import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const sources = ["shared.js", "background.js"].map((file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
);

function background({ download, search, fetch }) {
  let onMessage;
  const listeners = new Set();
  const chrome = {
    downloads: {
      download,
      search,
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
    runtime: { onMessage: { addListener(fn) { onMessage = fn; } } },
  };
  const context = { chrome, URL, fetch, btoa, setTimeout, clearTimeout };
  for (const source of sources) runInNewContext(source, context);
  const send = (msg) => new Promise((resolve) => onMessage(msg, null, resolve));
  return { send, listeners };
}

const url = "https://video.twimg.com/clip.mp4";

test("считывает прерывание, случившееся до установки слушателя", async () => {
  const { send, listeners } = background({
    download: async () => 42,
    search: async ({ id }) => {
      assert.equal(id, 42);
      return [{ state: "interrupted", error: "NETWORK_FAILED" }];
    },
  });
  const result = await send({ type: "download", url });
  assert.equal(result.success, false);
  assert.equal(result.retryable, true);
  assert.equal(listeners.size, 0);
});

test("отмена диалога не разрешает повтор скачивания", async () => {
  const { send } = background({
    download: async () => { throw new Error("Download canceled by the user"); },
  });
  const result = await send({ type: "download", url, saveAs: true });
  assert.equal(result.canceled, true);
  assert.equal(result.retryable, false);
});

test("останавливает чтение слишком большого GIF без Content-Length", async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(3));
      controller.enqueue(new Uint8Array(2));
    },
    cancel() { canceled = true; },
  });
  const { send } = background({ fetch: async () => new Response(body) });
  const result = await send({ type: "fetchMedia", url, maxBytes: 4 });
  assert.equal(result.success, false);
  assert.equal(result.error, "source is too large");
  assert.equal(canceled, true);
});
