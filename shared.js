// Общие чистые функции: значения настроек по умолчанию, санитизация, имена
// файлов и сборка пути сохранения.
//
// Вынесены сюда, потому что нужны сразу в двух местах: content.js считает по
// ним реальный путь загрузки, popup.js — превью этого пути. Пока код был
// продублирован, правка в одном файле молча расходилась со вторым, и попап
// показывал не то, куда на самом деле падал файл.
//
// Отдаётся через globalThis, как и gif-encoder.js: сборка идёт без бандлера,
// а ES-модули в content script потребовали бы динамического import.

(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    videoSubfolder: "TwitterVideos",
    videoAlwaysAsk: false,
    photoSubfolder: "TwitterImages",
    photoAlwaysAsk: false,
    photoByAuthor: false,
    gifConvert: true,
    copyShortcut: true,
  };

  // Для сегмента пути фолбэк не нужен: пустой сегмент просто выбрасывается,
  // иначе подпапка «...» превратилась бы в папку с именем unknown.
  function sanitizeSegment(str) {
    return String(str || "")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 60);
  }

  // Для имён файлов и авторов запасной вариант нужен, иначе получится пустое имя.
  function sanitize(str) {
    return sanitizeSegment(str) || "unknown";
  }

  // Подпапка может содержать вложенность («Art/Twitter»), но не должна
  // позволять выход за пределы папки загрузок — Firefox такой путь отклонит.
  function sanitizeFolder(input) {
    return String(input || "")
      .split("/")
      .map((seg) => seg.trim())
      .filter((seg) => seg && seg !== "." && seg !== "..")
      .map(sanitizeSegment)
      .filter(Boolean)
      .join("/");
  }

  function formatDate(createdAt) {
    const d = createdAt ? new Date(createdAt) : null;
    if (!d || isNaN(d.getTime())) return "unknown-date";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // kind: "video" | "gif" | "photo"
  function buildFilename(info, tweetId, ext, index, kind) {
    const author = sanitize(info && info.screenName);
    const date = formatDate(info && info.createdAt);
    const idx = typeof index === "number" ? `_${index + 1}` : "";
    const gifMark = kind === "gif" ? "_gif" : "";
    return `${author}_${date}_${sanitize(tweetId)}${gifMark}${idx}.${ext}`;
  }

  // Ключ картинки: в ленте адрес вида /media/ABC, из API — /media/ABC.jpg.
  // База для относительных адресов взята константой: у абсолютных ссылок
  // twimg она не используется вовсе, а на pathname хост не влияет.
  function baseMediaKey(url) {
    try {
      const path = new URL(url, "https://x.com").pathname;
      return path.replace(/\.(jpg|jpeg|png|webp|gif)$/i, "");
    } catch (e) {
      return url;
    }
  }

  // Разбор пути на сегменты — общий для скачивания и для превью. Соединять их
  // в строку или рисовать по одному, решает вызывающий.
  function buildPathParts(settings, { filename, kind, screenName }) {
    const s = settings || {};
    const isPhoto = kind === "photo";
    const subfolder = sanitizeFolder(isPhoto ? s.photoSubfolder : s.videoSubfolder);
    const parts = [];
    if (subfolder) parts.push(subfolder);
    if (isPhoto && s.photoByAuthor) parts.push(sanitize(screenName));
    if (filename) parts.push(filename);
    return {
      parts,
      saveAs: isPhoto ? !!s.photoAlwaysAsk : !!s.videoAlwaysAsk,
    };
  }

  globalThis.XVDShared = {
    DEFAULT_SETTINGS,
    sanitize,
    sanitizeSegment,
    sanitizeFolder,
    formatDate,
    buildFilename,
    baseMediaKey,
    buildPathParts,
  };
})();
