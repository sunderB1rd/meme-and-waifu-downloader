// Разбор данных реддита. Фикстура — обрезанный настоящий ответ
// <permalink>.json, включая комментарий со своим media_metadata: именно на
// нём проверяется, что галерея не подхватывает чужие картинки.

import test from "node:test";
import assert from "node:assert/strict";
import { deepEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScript } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const gallery = JSON.parse(readFileSync(join(here, "fixtures/reddit-gallery.json"), "utf8"));

const {
  DEFAULT_SETTINGS,
  decodeEntities,
  extFromMime,
  extFromUrl,
  parseGalleryJson,
  buildPathParts,
} = loadScript("shared.js").XVDShared;

test("галерея разбирается в порядке gallery_data.items", () => {
  // В media_metadata ключи идут своим порядком: если брать его, нумерация
  // файлов разъедется с тем, что человек видит в карусели.
  const items = parseGalleryJson(gallery);
  deepEqual(
    items.map((i) => i.url),
    [
      "https://i.redd.it/uys6xcc7o5kh1.jpg",
      "https://i.redd.it/irs5qdc7o5kh1.jpg",
      "https://i.redd.it/mvnx9ec7o5kh1.png",
    ]
  );
});

test("расширение берётся из mime, а не из ключа", () => {
  const items = parseGalleryJson(gallery);
  deepEqual(items.map((i) => i.ext), ["jpg", "jpg", "png"]);
});

test("запасной адрес приходит раскодированным", () => {
  // Без этого в адрес уехал бы &amp; и подпись s= перестала бы сходиться
  const [first] = parseGalleryJson(gallery);
  assert.ok(!first.fallbackUrl.includes("&amp;"), first.fallbackUrl);
  assert.ok(first.fallbackUrl.includes("width=704&format=pjpg"));
});

test("удалённые, битые и анимированные записи пропускаются", () => {
  // В фикстуре шесть записей в gallery_data, годных из них три
  assert.equal(parseGalleryJson(gallery).length, 3);
});

test("media_metadata из комментариев не попадает в галерею", () => {
  // У комментария с гифкой giphy свой media_metadata со status: invalid.
  // Если разбирать весь ответ подряд, он подмешается к картинкам поста.
  const items = parseGalleryJson(gallery);
  assert.ok(!items.some((i) => i.url.includes("giphy")));
});

test("разбор не падает на мусоре", () => {
  for (const payload of [null, undefined, [], {}, [{}], [{ data: {} }], "строка"]) {
    deepEqual(parseGalleryJson(payload), []);
  }
});

test("пост без галереи даёт пустой список", () => {
  deepEqual(parseGalleryJson([{ data: { children: [{ data: { title: "текст" } }] } }]), []);
});

test("decodeEntities разворачивает то, чем реддит экранирует адреса", () => {
  assert.equal(decodeEntities("a&amp;b"), "a&b");
  assert.equal(decodeEntities("&lt;тег&gt;"), "<тег>");
  // Амперсанд раскодируется последним, иначе &amp;lt; схлопнулось бы в <
  assert.equal(decodeEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeEntities(null), "");
});

test("extFromMime знает нестандартный image/jpg реддита", () => {
  assert.equal(extFromMime("image/jpg"), "jpg");
  assert.equal(extFromMime("image/jpeg"), "jpg");
  assert.equal(extFromMime("image/png"), "png");
  assert.equal(extFromMime("image/gif"), "gif");
  // Неизвестное не должно ронять имя файла
  assert.equal(extFromMime("application/octet-stream"), "jpg");
  assert.equal(extFromMime(null), "jpg");
});

test("extFromUrl читает расширение из адреса i.redd.it", () => {
  assert.equal(extFromUrl("https://i.redd.it/6hzy31iu2rkh1.jpeg"), "jpg");
  assert.equal(extFromUrl("https://i.redd.it/abc.png"), "png");
  assert.equal(extFromUrl("https://preview.redd.it/abc.jpg?width=704&s=x"), "jpg");
  // Точка должна быть настоящей, а не любым символом
  assert.equal(extFromUrl("https://i.redd.it/abcjpg"), "");
  assert.equal(extFromUrl("https://www.reddit.com/gallery/1vrt47j"), "");
});

test("путь реддита складывается из своих настроек", () => {
  const parts = (settings) =>
    buildPathParts(settings, {
      filename: "a.jpg",
      kind: "reddit",
      screenName: "MiyurinMiyu",
      subreddit: "typemoon",
    }).parts;

  deepEqual(parts(DEFAULT_SETTINGS), ["RedditImages", "a.jpg"]);
  deepEqual(parts({ ...DEFAULT_SETTINGS, redditFolderBy: "author" }), [
    "RedditImages",
    "MiyurinMiyu",
    "a.jpg",
  ]);
  deepEqual(parts({ ...DEFAULT_SETTINGS, redditFolderBy: "subreddit" }), [
    "RedditImages",
    "typemoon",
    "a.jpg",
  ]);
});

test("настройки реддита не влияют на X и наоборот", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    redditFolderBy: "subreddit",
    redditAlwaysAsk: true,
    photoByAuthor: true,
  };

  const photo = buildPathParts(settings, {
    filename: "a.jpg",
    kind: "photo",
    screenName: "someone",
    subreddit: "typemoon",
  });
  deepEqual(photo.parts, ["TwitterImages", "someone", "a.jpg"]);
  assert.equal(photo.saveAs, false, "redditAlwaysAsk не должен спрашивать про картинки X");

  const reddit = buildPathParts(settings, {
    filename: "a.jpg",
    kind: "reddit",
    screenName: "someone",
    subreddit: "typemoon",
  });
  deepEqual(reddit.parts, ["RedditImages", "typemoon", "a.jpg"]);
  assert.equal(reddit.saveAs, true);
});
