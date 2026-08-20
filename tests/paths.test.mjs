// Пути и имена файлов: то, что видит пользователь на диске, и единственная
// часть расширения, которую можно проверить без браузера.

import test from "node:test";
import assert from "node:assert/strict";
// Массивы приезжают из vm-контекста, у них другой Array.prototype — строгое
// сравнение спотыкается о прототип, хотя содержимое совпадает.
import { deepEqual } from "node:assert";
import { loadScript } from "./helpers.mjs";

const {
  DEFAULT_SETTINGS,
  sanitize,
  sanitizeSegment,
  sanitizeFolder,
  formatDate,
  buildFilename,
  baseMediaKey,
  buildPathParts,
} = loadScript("shared.js").XVDShared;

test("sanitizeSegment убирает запрещённые в имени файла символы", () => {
  // Обратный слэш задаём кодом: в исходнике он спорит с экранированием
  const bs = String.fromCharCode(92);
  assert.equal(sanitizeSegment(`a<b>c:d"e/f${bs}g|h?i*j`), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(sanitizeSegment("нормальное имя"), "нормальное имя");
});

test("sanitizeSegment срезает точки и пробелы по краям", () => {
  // Windows молча отбрасывает хвостовые точки и пробелы, и файл уезжает не туда
  assert.equal(sanitizeSegment("  .имя.  "), "имя");
  assert.equal(sanitizeSegment("..."), "");
});

test("sanitizeSegment ограничивает длину", () => {
  assert.equal(sanitizeSegment("я".repeat(200)).length, 60);
});

test("sanitize подставляет запасное имя, sanitizeSegment — нет", () => {
  // Разница намеренная: пустое имя файла недопустимо, пустой сегмент пути
  // просто выбрасывается, иначе подпапка «...» стала бы папкой unknown
  assert.equal(sanitize(""), "unknown");
  assert.equal(sanitize("..."), "unknown");
  assert.equal(sanitize(null), "unknown");
  assert.equal(sanitizeSegment(""), "");
});

test("sanitizeFolder сохраняет вложенность", () => {
  assert.equal(sanitizeFolder("Art/Twitter"), "Art/Twitter");
  assert.equal(sanitizeFolder(" Art / Twitter "), "Art/Twitter");
  assert.equal(sanitizeFolder("a//b"), "a/b");
});

test("sanitizeFolder не даёт выйти за папку загрузок", () => {
  // Firefox отклонит такой путь целиком — до него доводить нельзя
  for (const input of ["../evil", "a/../../evil", "./../..", "..", "../"]) {
    const result = sanitizeFolder(input);
    assert.ok(!result.split("/").includes(".."), `«${input}» -> «${result}»`);
    assert.ok(!result.startsWith("/"), `«${input}» -> «${result}»`);
  }
  assert.equal(sanitizeFolder("../evil"), "evil");
  assert.equal(sanitizeFolder(".."), "");
});

test("sanitizeFolder переживает пустоту и мусор", () => {
  assert.equal(sanitizeFolder(""), "");
  assert.equal(sanitizeFolder("   "), "");
  assert.equal(sanitizeFolder(null), "");
  assert.equal(sanitizeFolder(undefined), "");
});

test("formatDate понимает формат даты твиттера", () => {
  // Полдень по UTC: любой разумный часовой пояс оставит ту же дату
  assert.equal(formatDate("Thu Aug 13 12:00:00 +0000 2026"), "2026-08-13");
  assert.equal(formatDate(new Date(2026, 7, 13)), "2026-08-13");
});

test("formatDate не роняет имя файла на мусоре", () => {
  assert.equal(formatDate(null), "unknown-date");
  assert.equal(formatDate(""), "unknown-date");
  assert.equal(formatDate("не дата"), "unknown-date");
});

test("buildFilename собирает автор_дата_id", () => {
  const info = { screenName: "someone", createdAt: "Thu Aug 13 12:00:00 +0000 2026" };
  assert.equal(
    buildFilename(info, "1234567890", "jpg", undefined, "photo"),
    "someone_2026-08-13_1234567890.jpg"
  );
});

test("buildFilename нумерует с единицы, а не с нуля", () => {
  const info = { screenName: "someone", createdAt: "Thu Aug 13 12:00:00 +0000 2026" };
  assert.equal(
    buildFilename(info, "1", "jpg", 0, "photo"),
    "someone_2026-08-13_1_1.jpg"
  );
  assert.equal(
    buildFilename(info, "1", "jpg", 3, "photo"),
    "someone_2026-08-13_1_4.jpg"
  );
});

test("buildFilename помечает несконвертированную гифку", () => {
  // Без пометки такой mp4 не отличить от обычного видео
  const info = { screenName: "someone", createdAt: null };
  assert.equal(buildFilename(info, "1", "mp4", undefined, "gif"), "someone_unknown-date_1_gif.mp4");
  assert.equal(buildFilename(info, "1", "gif", undefined, "video"), "someone_unknown-date_1.gif");
});

test("buildFilename переживает пост без автора", () => {
  assert.equal(buildFilename({}, "1", "jpg", undefined, "photo"), "unknown_unknown-date_1.jpg");
  assert.equal(buildFilename(null, "1", "jpg", undefined, "photo"), "unknown_unknown-date_1.jpg");
});

test("baseMediaKey сводит адрес из ленты и адрес из API к одному ключу", () => {
  // Ровно та проверка, на которой держится поиск картинки: в ленте адрес идёт
  // без расширения, из API — с расширением и параметрами
  const fromFeed = "https://pbs.twimg.com/media/ABCdef123";
  const fromApi = "https://pbs.twimg.com/media/ABCdef123.jpg?format=jpg&name=orig";
  assert.equal(baseMediaKey(fromFeed), baseMediaKey(fromApi));
  assert.equal(baseMediaKey(fromApi), "/media/ABCdef123");
});

test("baseMediaKey не путает разные картинки", () => {
  assert.notEqual(
    baseMediaKey("https://pbs.twimg.com/media/AAA.jpg"),
    baseMediaKey("https://pbs.twimg.com/media/BBB.jpg")
  );
});

test("baseMediaKey не падает на мусоре", () => {
  assert.equal(baseMediaKey("не адрес"), "/%D0%BD%D0%B5%20%D0%B0%D0%B4%D1%80%D0%B5%D1%81");
  assert.equal(baseMediaKey(""), "/");
  assert.equal(typeof baseMediaKey(null), "string");
});

test("buildPathParts: путь по умолчанию", () => {
  const video = buildPathParts(DEFAULT_SETTINGS, { filename: "a.mp4", kind: "video" });
  deepEqual(video.parts, ["TwitterVideos", "a.mp4"]);

  const photo = buildPathParts(DEFAULT_SETTINGS, { filename: "a.jpg", kind: "photo" });
  deepEqual(photo.parts, ["TwitterImages", "a.jpg"]);
});

test("buildPathParts: раскладка по авторам только для картинок", () => {
  const settings = { ...DEFAULT_SETTINGS, photoByAuthor: true };
  deepEqual(
    buildPathParts(settings, { filename: "a.jpg", kind: "photo", screenName: "someone" }).parts,
    ["TwitterImages", "someone", "a.jpg"]
  );
  // Для видео та же настройка ничего не меняет
  deepEqual(
    buildPathParts(settings, { filename: "a.mp4", kind: "video", screenName: "someone" }).parts,
    ["TwitterVideos", "a.mp4"]
  );
});

test("buildPathParts: пустая подпапка означает корень загрузок", () => {
  const settings = { ...DEFAULT_SETTINGS, videoSubfolder: "" };
  deepEqual(buildPathParts(settings, { filename: "a.mp4", kind: "video" }).parts, ["a.mp4"]);
});

test("buildPathParts: автор без имени не создаёт папку без имени", () => {
  const settings = { ...DEFAULT_SETTINGS, photoByAuthor: true };
  const { parts } = buildPathParts(settings, { filename: "a.jpg", kind: "photo", screenName: "" });
  deepEqual(parts, ["TwitterImages", "unknown", "a.jpg"]);
});

test("buildPathParts: подпапка не выпускает за папку загрузок", () => {
  const settings = { ...DEFAULT_SETTINGS, photoSubfolder: "../../Windows/System32" };
  const { parts } = buildPathParts(settings, { filename: "a.jpg", kind: "photo" });
  deepEqual(parts, ["Windows/System32", "a.jpg"]);
  assert.ok(!parts.join("/").includes(".."));
});

test("buildPathParts: saveAs берётся из флага своего типа медиа", () => {
  const settings = { ...DEFAULT_SETTINGS, photoAlwaysAsk: true, videoAlwaysAsk: false };
  assert.equal(buildPathParts(settings, { filename: "a.jpg", kind: "photo" }).saveAs, true);
  assert.equal(buildPathParts(settings, { filename: "a.mp4", kind: "video" }).saveAs, false);
});

test("buildPathParts переживает отсутствие настроек", () => {
  // storage.local может быть пуст при первом запуске
  const { parts, saveAs } = buildPathParts(undefined, { filename: "a.jpg", kind: "photo" });
  deepEqual(parts, ["a.jpg"]);
  assert.equal(saveAs, false);
});
