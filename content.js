(function () {
  // Firefox использует browser.*, Chrome — chrome.*. Оба поддерживают промисы
  // в MV3, поэтому достаточно одного алиаса, без полифилла.
  const browser = globalThis.browser ?? globalThis.chrome;

  // tweetId -> { screenName, createdAt, videos: [], gifs: [], photos: [{url, ext}] }
  const mediaMap = new Map();
  // ключ картинки -> { tweetId, idx } — обратный индекс, чтобы не перебирать всю карту
  const photoIndex = new Map();
  const MAX_TWEETS = 600;

  let settingsCache = null;

  const DEFAULT_SETTINGS = {
    videoSubfolder: "TwitterVideos",
    videoAlwaysAsk: false,
    photoSubfolder: "TwitterImages",
    photoAlwaysAsk: false,
    photoByAuthor: false,
    gifConvert: true,
  };

  // Параметры конвертации. X отдаёт «гифки» как mp4, поэтому настоящий .gif
  // приходится собирать самим: покадрово через <video> + canvas.
  const GIF_FPS = 12.5;
  const GIF_MAX_WIDTH = 480;
  const GIF_MAX_FRAMES = 150;
  const GIF_MAX_SOURCE_BYTES = 15 * 1024 * 1024;

  async function getSettings() {
    if (settingsCache) return settingsCache;
    settingsCache = await browser.storage.local.get(DEFAULT_SETTINGS);
    return settingsCache;
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") settingsCache = null;
  });

  // --- Внедряем inject.js в контекст страницы ---
  function injectPageScript() {
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("inject.js");
    script.onload = function () {
      this.remove();
    };
    script.onerror = function (e) {
      console.error("[XVD] failed to inject inject.js:", e);
    };
    (document.head || document.documentElement).appendChild(script);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectPageScript, { once: true });
  } else {
    injectPageScript();
  }

  // --- Ключ картинки: в ленте адрес вида /media/ABC, из API — /media/ABC.jpg ---
  function baseMediaKey(url) {
    try {
      const path = new URL(url, location.origin).pathname;
      return path.replace(/\.(jpg|jpeg|png|webp|gif)$/i, "");
    } catch (e) {
      return url;
    }
  }

  function indexPhotos(tweetId, info) {
    info.photos.forEach((p, idx) => {
      photoIndex.set(baseMediaKey(p.url), { tweetId, idx });
    });
  }

  function dropTweet(tweetId) {
    const info = mediaMap.get(tweetId);
    if (!info) return;
    for (const p of info.photos) {
      const key = baseMediaKey(p.url);
      const entry = photoIndex.get(key);
      if (entry && entry.tweetId === tweetId) photoIndex.delete(key);
    }
    mediaMap.delete(tweetId);
  }

  function setMedia(tweetId, info) {
    if (mediaMap.has(tweetId)) dropTweet(tweetId);
    mediaMap.set(tweetId, info);
    indexPhotos(tweetId, info);
    // Ограничиваем рост при длительном скролле: Map хранит порядок вставки,
    // поэтому первый ключ — самая старая запись.
    while (mediaMap.size > MAX_TWEETS) {
      const oldest = mediaMap.keys().next().value;
      if (oldest === undefined) break;
      dropTweet(oldest);
    }
  }

  // --- Приём данных о медиа ---
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "xvd-extension" || msg.type !== "media") return;
    if (!msg.data || typeof msg.data !== "object") return;

    for (const [tweetId, info] of Object.entries(msg.data)) {
      if (!info || !Array.isArray(info.photos)) continue;
      info.videos = Array.isArray(info.videos) ? info.videos : [];
      info.gifs = Array.isArray(info.gifs) ? info.gifs : [];
      setMedia(tweetId, info);
    }
    requestScan();
  });

  // --- Имена файлов и пути ---
  // Для имён файлов и авторов нужен запасной вариант, иначе получится пустое имя.
  function sanitize(str) {
    return sanitizeSegment(str) || "unknown";
  }

  // Для сегмента пути фолбэк не нужен: пустой сегмент просто выбрасывается,
  // иначе подпапка «...» превратилась бы в папку с именем unknown.
  function sanitizeSegment(str) {
    return String(str || "")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 60);
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
    const author = sanitize(info.screenName);
    const date = formatDate(info.createdAt);
    const idx = typeof index === "number" ? `_${index + 1}` : "";
    const gifMark = kind === "gif" ? "_gif" : "";
    return `${author}_${date}_${tweetId}${gifMark}${idx}.${ext}`;
  }

  async function buildPath(filename, kind, screenName) {
    const s = await getSettings();
    const isPhoto = kind === "photo";
    const subfolder = sanitizeFolder(isPhoto ? s.photoSubfolder : s.videoSubfolder);
    const parts = [];
    if (subfolder) parts.push(subfolder);
    if (isPhoto && s.photoByAuthor) parts.push(sanitize(screenName));
    parts.push(filename);
    return {
      path: parts.join("/"),
      saveAs: isPhoto ? !!s.photoAlwaysAsk : !!s.videoAlwaysAsk,
    };
  }

  async function downloadOne(url, filename, kind, screenName) {
    const { path, saveAs } = await buildPath(filename, kind, screenName);
    const res = await browser.runtime.sendMessage({
      type: "download",
      url,
      filename: path,
      saveAs,
    });
    if (!res || !res.success) {
      console.warn("[XVD] download failed:", path, res && res.error);
      return false;
    }
    return true;
  }

  // --- Конвертация «гифки» X (на деле mp4) в настоящий GIF ---

  function waitEvent(target, name, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${name}`));
      }, timeoutMs);

      function onOk() {
        cleanup();
        resolve();
      }
      function onErr() {
        cleanup();
        reject(new Error(`error event on ${name}`));
      }
      function cleanup() {
        clearTimeout(timer);
        target.removeEventListener(name, onOk);
        target.removeEventListener("error", onErr);
      }

      target.addEventListener(name, onOk, { once: true });
      target.addEventListener("error", onErr, { once: true });
    });
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function mp4ToGif(url) {
    if (!globalThis.XVDGifEncoder) throw new Error("encoder is not loaded");

    const res = await browser.runtime.sendMessage({ type: "fetchMedia", url });
    if (!res || !res.success) {
      throw new Error((res && res.error) || "fetch failed");
    }
    if (res.size > GIF_MAX_SOURCE_BYTES) {
      throw new Error("source is too large");
    }

    const blob = new Blob([base64ToBytes(res.base64)], { type: "video/mp4" });
    const objectUrl = URL.createObjectURL(blob);

    try {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = objectUrl;

      await waitEvent(video, "loadeddata");

      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) throw new Error("bad duration");

      const scale = Math.min(1, GIF_MAX_WIDTH / (video.videoWidth || GIF_MAX_WIDTH));
      const width = Math.max(2, Math.round((video.videoWidth || GIF_MAX_WIDTH) * scale));
      const height = Math.max(2, Math.round((video.videoHeight || 270) * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      const frames = [];
      const step = 1 / GIF_FPS;

      for (let t = 0; t < duration && frames.length < GIF_MAX_FRAMES; t += step) {
        video.currentTime = t;
        await waitEvent(video, "seeked");
        ctx.drawImage(video, 0, 0, width, height);
        frames.push(ctx.getImageData(0, 0, width, height).data);
      }

      if (!frames.length) throw new Error("no frames captured");

      return globalThis.XVDGifEncoder.encode({
        frames,
        width,
        height,
        delayCs: Math.round(100 / GIF_FPS),
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function saveViaAnchor(bytes, filename) {
    // Запасной путь, если downloads API не принял data: URL.
    // Подпапка из настроек здесь не учитывается — файл попадёт
    // в стандартную папку загрузок.
    const blob = new Blob([bytes], { type: "image/gif" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function downloadGif(sourceUrl, filename, screenName) {
    const bytes = await mp4ToGif(sourceUrl);
    const { path, saveAs } = await buildPath(filename, "video", screenName);
    const res = await browser.runtime.sendMessage({
      type: "downloadData",
      base64: bytesToBase64(bytes),
      mime: "image/gif",
      filename: path,
      saveAs,
    });
    if (res && res.success) return true;

    if (res && res.canFallback) {
      console.warn("[XVD] could not prepare the file, saving via link:", res.error);
      saveViaAnchor(bytes, filename);
      return true;
    }

    // Сюда попадает и отмена диалога сохранения — повторять не нужно
    console.warn("[XVD] gif was not saved:", res && res.error);
    return false;
  }

  function flashResult(btn, ok) {
    btn.classList.remove("xvd-loading");
    btn.classList.add(ok ? "xvd-success" : "xvd-error");
    setTimeout(() => btn.classList.remove("xvd-success", "xvd-error"), 2500);
  }

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

  // --- Кнопка в панели действий: скачивает всё медиа поста ---
  function mediaCount(info) {
    return info.videos.length + info.gifs.length + info.photos.length;
  }

  function describeMedia(info) {
    const total = mediaCount(info);
    if (total > 1) return `Download all (${total})`;
    if (info.videos.length) return "Download video";
    if (info.gifs.length) return "Download GIF";
    return "Download image";
  }

  async function downloadAll(info, tweetId, btn) {
    if (btn.dataset.xvdBusy) return;
    btn.dataset.xvdBusy = "1";
    btn.classList.remove("xvd-success", "xvd-error");
    btn.classList.add("xvd-loading");

    const settings = await getSettings();
    const convertGifs = !!settings.gifConvert;

    const jobs = [];
    info.videos.forEach((url, i) => {
      const idx = info.videos.length > 1 ? i : undefined;
      jobs.push({ url, filename: buildFilename(info, tweetId, "mp4", idx, "video"), kind: "video" });
    });
    info.gifs.forEach((url, i) => {
      const idx = info.gifs.length > 1 ? i : undefined;
      jobs.push({
        url,
        // Суффикс нужен, только если файл остаётся mp4 — иначе его не отличить
        // от обычного видео. У сконвертированного расширение .gif говорит само.
        filename: buildFilename(
          info,
          tweetId,
          convertGifs ? "gif" : "mp4",
          idx,
          convertGifs ? "video" : "gif"
        ),
        kind: "video",
        asGif: convertGifs,
      });
    });
    info.photos.forEach((p, i) => {
      const idx = info.photos.length > 1 ? i : undefined;
      jobs.push({
        url: p.url,
        filename: buildFilename(info, tweetId, p.ext || "jpg", idx, "photo"),
        kind: "photo",
      });
    });

    let allOk = true;
    for (const job of jobs) {
      try {
        const ok = job.asGif
          ? await downloadGif(job.url, job.filename, info.screenName)
          : await downloadOne(job.url, job.filename, job.kind, info.screenName);
        if (!ok) allOk = false;
      } catch (e) {
        allOk = false;
        console.warn("[XVD] download error:", e);
      }
    }
    delete btn.dataset.xvdBusy;
    flashResult(btn, allOk);
  }

  function findActionBar(article) {
    const groups = article.querySelectorAll('div[role="group"]');
    if (!groups.length) return null;
    return groups[groups.length - 1];
  }

  // Твиттер использует иконки 18.75px в ленте и 22.5px на странице поста.
  // Computed style устойчивее getBoundingClientRect: его не искажают трансформы.
  function detectIconSize(actionBar) {
    const svg = actionBar.querySelector("svg");
    if (svg) {
      const w = parseFloat(window.getComputedStyle(svg).width);
      if (w >= 12 && w <= 40) return w;
    }
    return 18.75;
  }

  function addTweetButton(article, tweetId, info) {
    if (!mediaCount(info)) return;
    const actionBar = findActionBar(article);
    if (!actionBar) return;

    // Узлы переиспользуются при скролле: если кнопка осталась от другого твита,
    // она указывала бы на чужое медиа — пересоздаём.
    const existing = actionBar.querySelector(".xvd-video-btn");
    if (existing) {
      if (existing.dataset.xvdTweet === tweetId) return;
      const oldWrapper = existing.closest(".xvd-btn-wrapper");
      (oldWrapper || existing).remove();
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "xvd-download-btn xvd-video-btn";
    btn.title = describeMedia(info);
    btn.dataset.xvdTweet = tweetId;

    const iconSize = detectIconSize(actionBar);
    // Та же пропорция, что у Твиттера: иконка 18.75px в кнопке ~34px
    const btnSize = Math.round(iconSize * 1.8);
    btn.style.width = `${btnSize}px`;
    btn.style.height = `${btnSize}px`;
    btn.innerHTML = downloadIconSVG(iconSize);

    const total = mediaCount(info);
    if (total > 1) {
      const badge = document.createElement("span");
      badge.className = "xvd-badge";
      badge.textContent = total;
      btn.appendChild(badge);
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadAll(info, tweetId, btn);
    });

    const wrapper = document.createElement("div");
    wrapper.className = "xvd-btn-wrapper";
    wrapper.appendChild(btn);
    actionBar.appendChild(wrapper);
  }

  // --- Кнопки на отдельных картинках (лента + вьювер) ---
  function lookupPhoto(key) {
    const entry = photoIndex.get(key);
    if (!entry) return null;
    const info = mediaMap.get(entry.tweetId);
    if (!info || !info.photos[entry.idx]) return null;
    return { tweetId: entry.tweetId, info, idx: entry.idx };
  }

  function addPhotoButtons() {
    const imgs = document.querySelectorAll('img[src*="pbs.twimg.com/media/"]');

    imgs.forEach((img) => {
      if (!img.src) return;
      const key = baseMediaKey(img.src);
      const container = img.closest('div[data-testid="tweetPhoto"]') || img.parentElement;

      // React при перерисовке переписывает className своим значением и стирает
      // наш класс, из-за чего кнопка переставала показываться по наведению.
      // Кнопку он не трогает — она не в его дереве. Поэтому класс возвращаем.
      if (container && container.querySelector(".xvd-photo-btn")) {
        container.classList.add("xvd-photo-container");
      }

      // src мог смениться на другую картинку в переиспользованном узле
      if (img.dataset.xvdKey === key) return;

      const match = lookupPhoto(key);
      if (!match) return; // не фото твита (например, аватарка в карточке)

      const { tweetId, info, idx } = match;
      const photo = info.photos[idx];

      if (!container) return;

      const stale = container.querySelector(".xvd-photo-btn");
      if (stale) stale.remove();

      img.dataset.xvdKey = key;
      container.classList.add("xvd-photo-container");
      if (window.getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "xvd-photo-btn";
      btn.title = "Download image";
      btn.innerHTML = downloadIconSVG(18.75);
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.dataset.xvdBusy) return;
        btn.dataset.xvdBusy = "1";
        btn.classList.remove("xvd-success", "xvd-error");
        btn.classList.add("xvd-loading");
        const filename = buildFilename(
          info,
          tweetId,
          photo.ext || "jpg",
          info.photos.length > 1 ? idx : undefined,
          "photo"
        );
        try {
          const ok = await downloadOne(photo.url, filename, "photo", info.screenName);
          flashResult(btn, ok);
        } catch (err) {
          console.warn("[XVD] download error:", err);
          flashResult(btn, false);
        }
        delete btn.dataset.xvdBusy;
      });

      container.appendChild(btn);
    });
  }

  function getTweetId(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const match = a.getAttribute("href").match(/status\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  // У цитат медиа принадлежит вложенному твиту, а не внешнему —
  // тогда ищем владельца по картинкам внутри статьи.
  function resolveByImages(article) {
    const imgs = article.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
    for (const img of imgs) {
      if (!img.src) continue;
      const match = lookupPhoto(baseMediaKey(img.src));
      if (match) return { tweetId: match.tweetId, info: match.info };
    }
    return null;
  }

  function scanTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      const tweetId = getTweetId(article);
      let info = tweetId ? mediaMap.get(tweetId) : null;
      let ownerId = tweetId;

      if (!info || !mediaCount(info)) {
        const fallback = resolveByImages(article);
        if (fallback) {
          info = fallback.info;
          ownerId = fallback.tweetId;
        }
      }

      if (info && ownerId) addTweetButton(article, ownerId, info);
    }
    // Картинки ищем по всей странице — так кнопка работает и в ленте, и во вьювере.
    addPhotoButtons();
  }

  // Твиттер мутирует DOM почти непрерывно, поэтому склеиваем серии
  // изменений в один проход на кадр вместо сканирования на каждую мутацию.
  let scanScheduled = false;
  function requestScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      try {
        scanTweets();
      } catch (e) {
        console.warn("[XVD] scan error:", e);
      }
    });
  }

  const observer = new MutationObserver(requestScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });

  requestScan();
})();
