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
    redditVideoSubfolder: "RedditVideos",
    redditVideoAlwaysAsk: false,
    redditImageSubfolder: "RedditImages",
    redditImageAlwaysAsk: false,
    // none | author | subreddit. Не флажок, как у картинок X: на реддите
    // для коллекции обычно осмысленнее сабреддит, а не автор поста.
    redditFolderBy: "none",
    redditCopyShortcut: true,
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
  // Каждый вид медиа складывается по своим настройкам. Соответствие задано
  // явным списком, а не склейкой имени ключа из названия вида: при склейке
  // опечатка молча отправила бы файлы в корень загрузок вместо подпапки.
  const PATH_KINDS = {
    video: { subfolder: "videoSubfolder", ask: "videoAlwaysAsk" },
    photo: { subfolder: "photoSubfolder", ask: "photoAlwaysAsk" },
    redditVideo: { subfolder: "redditVideoSubfolder", ask: "redditVideoAlwaysAsk" },
    redditImage: { subfolder: "redditImageSubfolder", ask: "redditImageAlwaysAsk" },
  };

  // Раскладка по вложенным папкам есть только у картинок. У видео её нет
  // намеренно: роликов от одного автора обычно единицы, и папка на каждого
  // превращает загрузки в свалку из папок с одним файлом.
  function groupFolder(kind, s, screenName, subreddit) {
    if (kind === "photo") return s.photoByAuthor ? sanitize(screenName) : null;
    if (kind === "redditImage") {
      if (s.redditFolderBy === "author") return sanitize(screenName);
      if (s.redditFolderBy === "subreddit") return sanitize(subreddit);
    }
    return null;
  }

  function buildPathParts(settings, { filename, kind, screenName, subreddit }) {
    const s = settings || {};
    const keys = PATH_KINDS[kind];

    const parts = [];
    const subfolder = keys ? sanitizeFolder(s[keys.subfolder]) : "";
    if (subfolder) parts.push(subfolder);

    const group = groupFolder(kind, s, screenName, subreddit);
    if (group) parts.push(group);

    if (filename) parts.push(filename);

    return { parts, saveAs: keys ? !!s[keys.ask] : false };
  }

  // --- Реддит ---
  // Разбор живёт здесь, а не в reddit.js: функция чистая, а значит
  // проверяемая тестами без браузера. Вся работа с DOM осталась там.

  // Адреса в ответе .json приходят HTML-экранированными: &amp; вместо &.
  // Параметр raw_json=1 это отключает, но полагаться на один только параметр
  // не стоит. Амперсанд раскодируем последним, иначе &amp;lt; схлопнулось бы
  // в < за два прохода.
  function decodeEntities(str) {
    return String(str || "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, String.fromCharCode(34))
      .replace(/&#39;/g, String.fromCharCode(39))
      .replace(/&amp;/g, "&");
  }

  // Реддит присылает нестандартный image/jpg наравне с image/jpeg.
  const MIME_EXT = {
    "image/jpg": "jpg",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };

  function extFromMime(mime) {
    return MIME_EXT[String(mime || "").toLowerCase()] || "jpg";
  }

  // У i.redd.it расширение лежит прямо в пути. jpeg приводим к jpg, чтобы
  // в папке не оказалось двух написаний одного и того же формата.
  function extFromUrl(url) {
    const match = /\.(jpg|jpeg|png|webp|gif)(?:$|[?#])/i.exec(String(url || ""));
    if (!match) return "";
    const ext = match[1].toLowerCase();
    return ext === "jpeg" ? "jpg" : ext;
  }

  // Галерея реддита из ответа <permalink>.json.
  //
  // Порядок берём из gallery_data.items, а не из ключей media_metadata:
  // там он свой, и нумерация файлов разъехалась бы с тем, что человек
  // видит в карусели.
  //
  // Ответ — массив из двух листингов: [0] пост, [1] комментарии. Лезем
  // строго в первый: у комментариев бывает собственный media_metadata
  // (гифки из giphy), и он подмешался бы в галерею.
  function parseGalleryJson(payload) {
    const post = payload?.[0]?.data?.children?.[0]?.data;
    if (!post) return [];

    const items = post.gallery_data?.items ?? [];
    const meta = post.media_metadata ?? {};
    const out = [];

    for (const item of items) {
      const id = item?.media_id;
      if (!id || item.is_deleted) continue;

      const entry = meta[id];
      // status не valid — картинку удалили или она не загрузилась.
      if (!entry || entry.status !== "valid") continue;
      // Кроме обычных картинок в галерее попадаются анимированные —
      // это настоящие gif, и берём мы их так же, по имени файла.
      if (entry.e !== "Image" && entry.e !== "AnimatedImage") continue;

      const ext = extFromMime(entry.m);
      out.push({
        // Оригинал лежит на i.redd.it. Запасной адрес у обычной картинки
        // в s.u, у анимированной — в s.gif. Первый ведёт на preview.redd.it
        // с параметром auto=webp, по нему вместо jpg может приехать webp под
        // именем .jpg, поэтому он именно запасной.
        url: `https://i.redd.it/${id}.${ext}`,
        fallbackUrl: decodeEntities(entry.s?.gif || entry.s?.u),
        ext,
      });
    }

    return out;
  }

  // Видео реддита. У v.redd.it картинка и звук лежат разными файлами (DASH,
  // новые ролики зовут их CMAF_*), и склеить их в браузере нечем. Но для
  // своего плеера реддит держит ещё и готовые mp4 со звуком на
  // packaged-media.redd.it, а список ссылок кладёт прямо в атрибут
  // packaged-media-json у <shreddit-player>. Пока он есть — мультиплексор
  // не нужен вовсе.
  //
  // Ссылки подписаны и живут ограниченное время (параметры e и s), поэтому
  // читать их надо в момент скачивания, а не запасать впрок.
  function parsePackagedMedia(json) {
    let payload = json;
    if (typeof json === "string") {
      try {
        payload = JSON.parse(json);
      } catch (e) {
        return null;
      }
    }

    const list = payload?.playbackMp4s?.permutations;
    if (!Array.isArray(list)) return null;

    const options = [];
    for (const item of list) {
      const url = item?.source?.url;
      if (!url) continue;
      options.push({
        url: decodeEntities(url),
        height: Number(item?.source?.dimensions?.height) || 0,
        codec: String(item?.source?.videoCodec || "").toUpperCase(),
      });
    }
    if (!options.length) return null;

    // Сначала разрешение, потом кодек. H264 предпочтительнее VP9 при равной
    // высоте: в mp4 его понимают все, включая проводник Windows и видео-
    // редакторы, а наборы у реддита одинаковые по разрешениям.
    const rank = (o) => (o.codec === "H264" ? 0 : 1);
    options.sort((x, y) => y.height - x.height || rank(x) - rank(y));

    return options[0];
  }

  // Фоновый скрипт отдаёт файлы строкой base64: через границу сообщений
  // двоичные данные не проходят. Нужно и content.js (для конвертации GIF),
  // и copy.js (для буфера обмена).
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // --- Что разрешено качать ---
  // Домены, с которых расширение согласно скачивать. Проверка живёт здесь,
  // а вызывается в background.js: content-скрипты работают на самой
  // странице, и прислать поддельное сообщение с чужим адресом может любой
  // скрипт этой страницы. Фоновый скрипт — единственный, у кого есть право
  // на загрузки, и он обязан сомневаться во всём, что ему приходит.
  //
  // Сверка идёт по точному совпадению или поддомену, поэтому подставной
  // evil-twimg.com сюда не пролезет.
  const ALLOWED_MEDIA_HOSTS = [
    "twimg.com", // X: pbs.twimg.com, video.twimg.com
    "redd.it", // реддит: i.redd.it, preview.redd.it, packaged-media.redd.it
  ];

  function isAllowedMediaUrl(url) {
    try {
      const u = new URL(url);
      // Только https: по http медиа не отдаётся, а разрешать схему без
      // шифрования значило бы открыть дорогу подмене ответа по пути.
      if (u.protocol !== "https:") return false;
      const host = u.hostname.toLowerCase();
      return ALLOWED_MEDIA_HOSTS.some(
        (allowed) => host === allowed || host.endsWith("." + allowed)
      );
    } catch (e) {
      return false;
    }
  }

  // --- Иконка кнопки ---
  // Одна на оба сайта: и content.js, и reddit.js рисуют одну и ту же
  // кнопку, и держать её двумя копиями значит когда-нибудь их развести.
  function downloadIconSVG(size) {
    const s = Number(size) > 0 ? Number(size) : 18.75;
    // Стрелка — точное вертикальное отражение стрелки из штатной кнопки
    // «поделиться», лоток взят оттуда без изменений. Так иконка совпадает
    // с соседними по геометрии и толщине штриха.
    return `
      <svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor" aria-hidden="true">
        <g><path d="M12 16l5.7-5.7-1.41-1.42L13 12.18V2.59h-2v9.59L7.7 8.88 6.29 10.3 12 16zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"></path></g>
      </svg>
    `;
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
    decodeEntities,
    extFromMime,
    extFromUrl,
    parseGalleryJson,
    parsePackagedMedia,
    ALLOWED_MEDIA_HOSTS,
    isAllowedMediaUrl,
    base64ToBytes,
    downloadIconSVG,
  };
})();
