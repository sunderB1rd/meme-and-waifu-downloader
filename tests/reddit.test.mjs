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
      "https://i.redd.it/animatedcccccc.gif",
    ]
  );
});

test("расширение берётся из mime, а не из ключа", () => {
  const items = parseGalleryJson(gallery);
  deepEqual(items.map((i) => i.ext), ["jpg", "jpg", "png", "gif"]);
});

test("запасной адрес приходит раскодированным", () => {
  // Без этого в адрес уехал бы &amp; и подпись s= перестала бы сходиться
  const [first] = parseGalleryJson(gallery);
  assert.ok(!first.fallbackUrl.includes("&amp;"), first.fallbackUrl);
  assert.ok(first.fallbackUrl.includes("width=704&format=pjpg"));
});

test("удалённые и битые записи пропускаются, анимированные — нет", () => {
  // В фикстуре шесть записей в gallery_data: одна удалена, одна не
  // загрузилась, остаётся четыре — три картинки и гифка. Анимированные
  // кадры попадаются в обычных галереях наравне с картинками.
  assert.equal(parseGalleryJson(gallery).length, 4);
});

test("у анимированного кадра запасной адрес берётся из s.gif", () => {
  // У обычной картинки он лежит в s.u, у анимированной такого поля нет
  const animated = parseGalleryJson(gallery).find((i) => i.ext === "gif");
  assert.equal(animated.fallbackUrl, "https://i.redd.it/animatedcccccc.gif");
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

// --- Видео ---
// Реддит кладёт список готовых mp4 в атрибут плеера. Строка ниже — обрезанный
// настоящий packaged-media-json: два кодека, разные разрешения, экранированные
// амперсанды, как это и приезжает в HTML-атрибуте.

const packagedJson = JSON.stringify({
  playbackMp4s: {
    duration: 26,
    permutations: [
      {
        source: {
          url: "https://packaged-media.redd.it/abc/pb/m2-vp9-res_220p.mp4?v=1&amp;e=1787472000&amp;s=aa",
          dimensions: { width: 392, height: 220 },
          videoCodec: "VP9",
        },
      },
      {
        source: {
          url: "https://packaged-media.redd.it/abc/pb/m2-vp9-res_720p.mp4?v=1&amp;e=1787472000&amp;s=bb",
          dimensions: { width: 1280, height: 720 },
          videoCodec: "VP9",
        },
      },
      {
        source: {
          url: "https://packaged-media.redd.it/abc/pb/m2-res_360p.mp4?v=1&amp;e=1787472000&amp;s=cc",
          dimensions: { width: 640, height: 360 },
          videoCodec: "H264",
        },
      },
      {
        source: {
          url: "https://packaged-media.redd.it/abc/pb/m2-res_720p.mp4?v=1&amp;e=1787472000&amp;s=dd",
          dimensions: { width: 1280, height: 720 },
          videoCodec: "H264",
        },
      },
    ],
  },
});

const { parsePackagedMedia } = loadScript("shared.js").XVDShared;

test("из готовых mp4 берётся самое большое разрешение", () => {
  assert.equal(parsePackagedMedia(packagedJson).height, 720);
});

test("при равном разрешении H264 выигрывает у VP9", () => {
  // В mp4 H264 понимают все, включая проводник и видеоредакторы,
  // а наборы у реддита одинаковые по разрешениям
  const best = parsePackagedMedia(packagedJson);
  assert.equal(best.codec, "H264");
  assert.ok(best.url.endsWith("s=dd"), best.url);
});

test("адрес готового mp4 приходит раскодированным", () => {
  // Атрибут HTML, значит амперсанды экранированы; с &amp; подпись не сойдётся
  const best = parsePackagedMedia(packagedJson);
  assert.ok(!best.url.includes("&amp;"), best.url);
  assert.ok(best.url.includes("v=1&e=1787472000&s=dd"));
});

test("разбор принимает и строку, и уже разобранный объект", () => {
  const asObject = JSON.parse(packagedJson);
  assert.equal(parsePackagedMedia(asObject).url, parsePackagedMedia(packagedJson).url);
});

test("без готовых mp4 разбор честно отвечает «нечего брать»", () => {
  for (const payload of [null, undefined, "", "не json", "{}", {}, { playbackMp4s: {} }]) {
    assert.equal(parsePackagedMedia(payload), null, String(payload));
  }
  // Список есть, но в нём нет ни одной ссылки
  assert.equal(parsePackagedMedia({ playbackMp4s: { permutations: [{}, { source: {} }] } }), null);
});
