import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../inject.js", import.meta.url), "utf8");
const media = [
  { type: "photo", media_url_https: "https://pbs.twimg.com/media/new.png" },
  {
    type: "video",
    video_info: { variants: [
      { content_type: "application/x-mpegURL", url: "https://video.twimg.com/master.m3u8" },
      { content_type: "video/mp4", url: "https://video.twimg.com/low.mp4", bitrate: 100 },
      { content_type: "video/mp4", url: "https://video.twimg.com/high.mp4", bitrate: 200 },
    ] },
  },
  {
    type: "animated_gif",
    video_info: { variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/animation.mp4" }] },
  },
];

function runHook(payload, readyState = "complete") {
  const messages = [];
  const window = {
    fetch: async () => ({ clone: () => ({ json: async () => payload }) }),
    postMessage: (message) => messages.push(message),
  };
  let notifyMutation;
  let stopped = false;
  const events = new Map();
  runInNewContext(script, {
    window,
    Promise,
    XMLHttpRequest: class {},
    document: {
      readyState,
      addEventListener: (type, handler) => events.set(type, handler),
    },
    MutationObserver: class {
      constructor(handler) { notifyMutation = handler; }
      observe() {}
      disconnect() { stopped = true; }
    },
  });
  return { window, messages, events, notifyMutation, stopped: () => stopped };
}

test("перехватывает медиа из старого и нового GraphQL X", async () => {
  const payload = {
    old: {
      rest_id: "1",
      legacy: { extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/old.png" }] } },
    },
    recent: {
      rest_id: "2",
      details: { created_at_ms: "1793820210000" },
      core: { user_results: { result: { core: { screen_name: "author" } } } },
      media_entities2: media,
    },
  };
  const { window, messages } = runHook(payload);
  await window.fetch("https://api.x.com/graphql/query/Timeline");
  await new Promise(setImmediate);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data["1"].photos[0].url, "https://pbs.twimg.com/media/old?format=png&name=orig");
  const recent = messages[0].data["2"];
  assert.equal(recent.screenName, "author");
  assert.equal(recent.createdAt, 1793820210000);
  assert.equal(recent.photos[0].url, "https://pbs.twimg.com/media/new?format=png&name=orig");
  assert.equal(recent.videos[0], "https://video.twimg.com/high.mp4");
  assert.equal(recent.gifs[0], "https://video.twimg.com/animation.mp4");
});

test("читает отложенное медиа первого экрана без запроса GraphQL", async () => {
  const { window, messages, notifyMutation, events, stopped } = runHook(null, "loading");
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  window.$_TSR = { router: { dehydratedData: promise } };
  const scriptMutation = [{ addedNodes: [], removedNodes: [{ nodeName: "SCRIPT" }] }];
  notifyMutation(scriptMutation);
  notifyMutation(scriptMutation);
  delete window.$_TSR;
  events.get("DOMContentLoaded")();
  resolve({ data: { post: { rest_id: "3", media_entities2: media } } });
  await new Promise(setImmediate);
  assert.equal(stopped(), true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data["3"].videos[0], "https://video.twimg.com/high.mp4");
});
