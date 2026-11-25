(function () {
  // Firefox использует browser.*, Chrome — chrome.*. Оба поддерживают промисы
  // в MV3, поэтому достаточно одного алиаса, без полифилла.
  const browser = globalThis.browser ?? globalThis.chrome;

  // tweetId -> { screenName, createdAt, videos: [], gifs: [], photos: [{url, ext}] }
  const mediaMap = new Map();
  // ключ картинки -> { tweetId, idx } — обратный индекс, чтобы не перебирать всю карту
  const photoIndex = new Map();
  const MAX_TWEETS = 600;
  const PHOTO_SELECTOR = 'img[src*="pbs.twimg.com/media/"], img[srcset*="pbs.twimg.com/media/"]';
  const VIEWER_SELECTOR = '[aria-modal="true"], [role="dialog"]';
  const STATUS_PATH = /^\/(\w+)\/status\/(\d+)(?:[/?#]|$)/;
  const buttonMedia = new WeakMap();
  const photoButtons = new Map();

  let settingsCache = null;

  // Санитизация, имена файлов и дефолты настроек живут в shared.js: те же
  // функции нужны попапу для превью пути, и расходиться им нельзя.
  const { DEFAULT_SETTINGS, buildFilename, baseMediaKey, buildPathParts, downloadIconSVG, base64ToBytes } =
    globalThis.XVDShared;

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
  // Обработчик Ctrl+C должен решить, вмешиваться ли, до вызова
  // preventDefault — то есть синхронно. Асинхронный getSettings() для этого
  // не годится, поэтому держим значение отдельной переменной и обновляем её
  // при старте и при каждом изменении настроек.
  let copyShortcutEnabled = DEFAULT_SETTINGS.copyShortcut;
  async function refreshCopyShortcut() {
    try {
      copyShortcutEnabled = !!(await getSettings()).copyShortcut;
    } catch (e) {
      /* настройки недоступны — остаёмся на значении по умолчанию */
    }
  }
  refreshCopyShortcut();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      settingsCache = null;
      refreshCopyShortcut();
    }
  });

  // --- Внедряем inject.js в контекст страницы ---
  function injectPageScript() {
    const root = document.head || document.documentElement;
    if (!root) {
      // На document_start корневой элемент ещё может не быть создан.
      const observer = new MutationObserver(() => {
        if (!document.documentElement) return;
        observer.disconnect();
        injectPageScript();
      });
      observer.observe(document, { childList: true });
      return;
    }
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("inject.js");
    script.onload = function () {
      this.remove();
    };
    script.onerror = function (e) {
      console.error("[XVD] failed to inject inject.js:", e);
    };
    root.appendChild(script);
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

  // --- Путь сохранения ---
  async function buildPath(filename, kind, screenName) {
    const { parts, saveAs } = buildPathParts(await getSettings(), {
      filename,
      kind,
      screenName,
    });
    return { path: parts.join("/"), saveAs };
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
    }
    return res || { success: false };
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

    // Предел передаём отсюда, чтобы он остался в одном месте: фоновый скрипт
    // отсечёт файл по Content-Length, не скачивая его целиком.
    const res = await browser.runtime.sendMessage({
      type: "fetchMedia",
      url,
      maxBytes: GIF_MAX_SOURCE_BYTES,
    });
    if (!res || !res.success) {
      throw new Error((res && res.error) || "fetch failed");
    }
    if (res.size > GIF_MAX_SOURCE_BYTES) {
      throw new Error("source is too large");
    }

    const blob = new Blob([base64ToBytes(res.base64)], { type: "video/mp4" });
    const objectUrl = URL.createObjectURL(blob);
    let video = null;

    try {
      video = document.createElement("video");
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
        try {
          await waitEvent(video, "seeked");
        } catch (e) {
          // Один сорвавшийся кадр не повод терять всю конвертацию: с уже
          // набранными кадрами гифка выйдет короче, но рабочая.
          if (frames.length) break;
          throw e;
        }
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
      // Отпускаем декодер сразу, не дожидаясь сборщика мусора: <video> держит
      // не только память, но и слот аппаратного декодирования, а их у системы
      // считанное число. При нескольких гифках подряд они копились бы.
      // removeAttribute, а не src = "": пустая строка разрешается в адрес
      // страницы, и браузер пытался бы грузить её как видео.
      if (video) {
        video.removeAttribute("src");
        video.load();
      }
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
    if (res && res.success) return res;

    if (res && res.canFallback) {
      console.warn("[XVD] could not prepare the file, saving via link:", res.error);
      saveViaAnchor(bytes, filename);
      return { success: true, pending: true };
    }

    // Сюда попадает и отмена диалога сохранения — повторять не нужно
    console.warn("[XVD] gif was not saved:", res && res.error);
    return res || { success: false };
  }

  function flashResult(btn, ok, pending = false) {
    btn.classList.remove("xvd-loading");
    if (ok && pending) return;
    btn.classList.add(ok ? "xvd-success" : "xvd-error");
    setTimeout(() => btn.classList.remove("xvd-success", "xvd-error"), 2500);
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
    let pending = false;
    for (const job of jobs) {
      try {
        const result = job.asGif
          ? await downloadGif(job.url, job.filename, info.screenName)
          : await downloadOne(job.url, job.filename, job.kind, info.screenName);
        if (!result.success) allOk = false;
        pending ||= !!result.pending;
      } catch (e) {
        allOk = false;
        console.warn("[XVD] download error:", e);
      }
    }
    delete btn.dataset.xvdBusy;
    flashResult(btn, allOk, pending);
  }

  function findActionBar(article) {
    const actions = [...article.querySelectorAll("[data-engagement-action]")].filter(
      (action) => action.closest("article") === article
    );
    const reply = actions.find((action) => action.dataset.engagementAction === "reply");
    const replyGroup = reply?.closest('[role="group"]');
    if (replyGroup?.closest("article") === article) return replyGroup;
    if (actions.length > 1) {
      let bar = actions[0].parentElement;
      while (bar !== article) {
        if (actions.every((action) => bar.contains(action))) return bar;
        bar = bar.parentElement;
      }
    }
    const groups = [...article.querySelectorAll('[role="group"]')].filter(
      (group) => group.closest("article") === article
    );
    return groups.at(-1) || reply?.parentElement || null;
  }

  // Иконки у твиттера 18.75px в ленте и 22.5px на странице поста, а цвет
  // зависит от выбранной темы. И то и другое снимаем с соседней иконки, а не
  // задаём числом: computed style устойчивее getBoundingClientRect, его не
  // искажают трансформы. Свою кнопку из поиска исключаем — она в той же панели.
  function detectIconStyle(actionBar) {
    const svg = [...actionBar.querySelectorAll("svg")].find(
      (el) => !el.closest(".xvd-download-btn")
    );
    if (!svg) return { size: 18.75, color: "" };

    const style = window.getComputedStyle(svg);
    const size = parseFloat(style.width);
    return {
      size: size >= 12 && size <= 40 ? size : 18.75,
      color: style.color || "",
    };
  }

  // Круг под иконкой X рисует отдельным слоем с постоянным отступом, а не
  // пропорциональным. Множитель, подогнанный под ленту, промахивался бы на
  // странице поста: там иконка крупнее, и круг выходил на 2.5px шире соседних.
  // Поэтому сначала пробуем измерить кнопку соседа, и только если её бокс равен
  // самой иконке (круг нарисован поверх) — добавляем отступ сами.
  const ICON_PADDING = 8;
  function detectButtonSize(actionBar, iconSize) {
    const sibling = actionBar.querySelector('button:not(.xvd-download-btn), div[role="button"]');
    if (sibling) {
      const height = sibling.getBoundingClientRect().height;
      if (height > iconSize + 2 && height <= iconSize + ICON_PADDING * 3) {
        return Math.round(height);
      }
    }
    return Math.round(iconSize + ICON_PADDING * 2);
  }

  function addTweetButton(article, tweetId, info) {
    const actionBar = findActionBar(article);

    // Узлы переиспользуются при скролле: если кнопка осталась от другого твита,
    // она указывала бы на чужое медиа — пересоздаём.
    const existing = [...article.querySelectorAll(".xvd-video-btn")].find(
      (btn) => btn.closest("article") === article
    );
    if (existing) {
      if (actionBar?.contains(existing) && info &&
          existing.dataset.xvdTweet === tweetId && existing.title === describeMedia(info)) {
        buttonMedia.set(existing, info);
        return;
      }
      const oldWrapper = existing.closest(".xvd-btn-wrapper");
      (oldWrapper || existing).remove();
    }
    if (!actionBar || !info || !mediaCount(info)) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "xvd-download-btn xvd-video-btn";
    btn.title = describeMedia(info);
    btn.dataset.xvdTweet = tweetId;
    buttonMedia.set(btn, info);

    const { size: iconSize, color } = detectIconStyle(actionBar);
    const btnSize = detectButtonSize(actionBar, iconSize);
    btn.style.width = `${btnSize}px`;
    btn.style.height = `${btnSize}px`;
    // Цвет отдаём переменной, а не в style.color: инлайновое свойство
    // перебило бы подсветку при наведении и зелёный с красным после загрузки.
    if (color) btn.style.setProperty("--xvd-icon-color", color);
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
      downloadAll(buttonMedia.get(btn), tweetId, btn);
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

  function mediaImageSource(img, path) {
    // В X src может быть заглушкой, пока браузер не выбрал вариант из srcset.
    const prefix = `https://pbs.twimg.com/${path}/`;
    if (img.currentSrc.startsWith(prefix)) return img.currentSrc;
    if (img.src.startsWith(prefix)) return img.src;
    for (const candidate of img.srcset.split(",")) {
      const url = candidate.trim().split(/\s+/, 1)[0];
      if (url.startsWith(prefix)) return url;
    }
    return null;
  }

  function originalPhoto(source) {
    const url = new URL(source);
    const extMatch = /\.(jpg|jpeg|png|webp|gif)$/i.exec(url.pathname);
    let ext = (url.searchParams.get("format") || extMatch?.[1] || "jpg").toLowerCase();
    if (!/^(jpg|jpeg|png|webp|gif)$/.test(ext)) return null;
    // WebP в srcset — формат превью; CDN отдаёт полноразмерный JPEG.
    if (ext === "webp") ext = "jpg";
    if (extMatch) url.pathname = url.pathname.slice(0, -extMatch[0].length);
    url.search = new URLSearchParams({ format: ext, name: "orig" });
    return { url: url.href, ext };
  }

  function photoInViewer(img, source) {
    const identity = STATUS_PATH.exec(location.pathname);
    const view = VIEWER_PATH.exec(location.pathname);
    if (!identity || !view || !img.closest(VIEWER_SELECTOR)) return null;
    const photo = source && originalPhoto(source);
    if (!photo) return null;
    return {
      tweetId: identity[2],
      idx: 0,
      viewerIndex: Number(view[2]) - 1,
      info: { screenName: identity[1], photos: [photo] },
    };
  }

  function addPhotoButtons(visiblePhotos) {
    const imgs = new Set(document.querySelectorAll(PHOTO_SELECTOR));
    const viewerImg = VIEWER_PATH.test(location.pathname) ? visiblePhotoImg() : null;
    for (const [img, entry] of photoButtons) {
      if (imgs.has(img)) continue;
      entry.btn.remove();
      photoButtons.delete(img);
    }

    imgs.forEach((img) => {
      const source = mediaImageSource(img, "media");
      const key = source && baseMediaKey(source);
      const media = img.closest('picture') || img;
      const container = img.closest('div[data-testid="tweetPhoto"]') || media.parentElement;
      const match = key && (lookupPhoto(key) || visiblePhotos.get(img) ||
        (img === viewerImg && photoInViewer(img, source)));
      const existing = photoButtons.get(img);

      // React при перерисовке переписывает className своим значением и стирает
      // наш класс, из-за чего кнопка переставала показываться по наведению.
      // Контейнер он также может заменить, переиспользовав сам <img>.
      if (existing && match && container && existing.btn.parentElement === container &&
          img.dataset.xvdKey === key) {
        container.classList.add("xvd-photo-container");
        existing.match = match;
        return;
      }
      if (existing) {
        existing.btn.remove();
        photoButtons.delete(img);
      }
      if (!match || !container) return;

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
      const entry = { btn, match };
      photoButtons.set(img, entry);
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.dataset.xvdBusy) return;
        btn.dataset.xvdBusy = "1";
        btn.classList.remove("xvd-success", "xvd-error");
        btn.classList.add("xvd-loading");
        const { tweetId, info, idx, viewerIndex } = entry.match;
        const photo = info.photos[idx];
        const filename = buildFilename(
          info,
          tweetId,
          photo.ext || "jpg",
          viewerIndex ?? (info.photos.length > 1 ? idx : undefined),
          "photo"
        );
        try {
          const result = await downloadOne(photo.url, filename, "photo", info.screenName);
          flashResult(btn, result.success, result.pending);
        } catch (err) {
          console.warn("[XVD] download error:", err);
          flashResult(btn, false);
        }
        delete btn.dataset.xvdBusy;
      });

      container.appendChild(btn);
    });
  }

  // --- Копирование картинки в буфер по Ctrl+C ---
  // Только в полноэкранном просмотрщике: там картинка одна, и не нужно гадать,
  // какую из четырёх в посте имел в виду пользователь.
  //
  // Смысл в качестве: у браузера есть своё «Копировать изображение», но оно
  // берёт то, что отрисовано, а в ленте X отдаёт уменьшенные версии. Мы кладём
  // в буфер тот же оригинал (name=orig), что скачала бы кнопка.

  const VIEWER_PATH = /\/status\/(\d+)\/photo\/(\d+)/;

  // Номер снимка берём из адреса, а не из DOM: в карусели X держит все
  // картинки поста одновременно и одинакового размера, просто сдвинув лишние
  // за край экрана. Выбор «самой крупной» давал ничью, и всегда побеждала
  // первая — при четырёх картинках копировалась не та.
  function viewerPhoto() {
    const match = VIEWER_PATH.exec(location.pathname);
    if (!match) return null;

    const info = mediaMap.get(match[1]);
    const idx = Number(match[2]) - 1;
    if (info && info.photos[idx]) return { info, idx, photo: info.photos[idx] };

    // Запасной путь на случай, если данных по этому посту у нас нет.
    const img = visiblePhotoImg();
    if (!img) return null;
    const source = mediaImageSource(img, "media");
    if (!source) return null;
    const found = lookupPhoto(baseMediaKey(source));
    if (found) return { photo: found.info.photos[found.idx] };
    const fallback = photoInViewer(img, source);
    return fallback ? { photo: fallback.info.photos[fallback.idx] } : null;
  }

  // Считаем площадь пересечения с экраном, а не собственный размер картинки:
  // у сдвинутых за край кадров карусели она нулевая.
  function visiblePhotoImg() {
    const dialog = [...document.querySelectorAll(VIEWER_SELECTOR)].find((el) => el.querySelector(PHOTO_SELECTOR));
    const imgs = (dialog || document).querySelectorAll(PHOTO_SELECTOR);
    let best = null;
    let bestArea = 0;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    }
    return bestArea > 0 ? best : null;
  }

  // Слушаем на фазе перехвата: у X свои обработчики клавиш, и они могут
  // остановить всплытие раньше нас.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!copyShortcutEnabled || !XVDCopy.isCopyShortcut(e)) return;

      const target = viewerPhoto();
      if (!target) return;

      e.preventDefault();
      XVDCopy.copyImage({
        url: target.photo.url,
        ext: target.photo.ext,
        // Подпись показываем у самой картинки — во вьювере она редко
        // занимает всю ширину.
        anchor: visiblePhotoImg(),
      });
    },
    true
  );

  function getTweetIdentity(article) {
    const wrapper = article.closest('[role="link"][data-href]');
    const href = wrapper?.getAttribute("data-href");
    if (href) {
      const wrapped = STATUS_PATH.exec(href.startsWith(location.origin + "/") ? href.slice(location.origin.length) : href);
      if (wrapped) return wrapped;
    }
    const links = article.querySelectorAll('a[href*="/status/"]');
    let firstLink = null;
    for (const a of links) {
      if (a.origin !== location.origin || a.closest("article") !== article || a.closest('[data-testid="quoteTweet"]')) continue;
      const match = STATUS_PATH.exec(a.pathname);
      if (match && (a.querySelector("time") || a.getAttribute("aria-hidden") === "true")) return match;
      firstLink ||= match;
    }
    return firstLink;
  }

  // У цитат медиа принадлежит вложенному твиту, а не внешнему —
  // тогда ищем владельца по картинкам внутри статьи.
  function resolveByImages(article) {
    const imgs = article.querySelectorAll(PHOTO_SELECTOR);
    for (const img of imgs) {
      const source = mediaImageSource(img, "media");
      if (!source) continue;
      const match = lookupPhoto(baseMediaKey(source));
      if (match) return { tweetId: match.tweetId, info: match.info };
    }
    return null;
  }

  function collectRenderedMedia(article, identity, visiblePhotos) {
    const info = { screenName: identity[1], createdAt: null, photos: [], videos: [], gifs: [] };
    const indices = new Map();
    for (const img of article.querySelectorAll(PHOTO_SELECTOR)) {
      if (img.closest("article") !== article) continue;
      const source = mediaImageSource(img, "media");
      if (!source) continue;
      const photo = originalPhoto(source);
      if (!photo) continue;
      const key = baseMediaKey(photo.url);
      if (!indices.has(key)) {
        indices.set(key, info.photos.length);
        info.photos.push(photo);
      }
      visiblePhotos.set(img, { tweetId: identity[2], info, idx: indices.get(key) });
    }
    const gifs = new Set();
    for (const element of article.querySelectorAll('img[src*="tweet_video_thumb/"], img[srcset*="tweet_video_thumb/"], video')) {
      if (element.closest("article") !== article) continue;
      const isVideo = element.localName === "video";
      const source = isVideo ? element.poster : mediaImageSource(element, "tweet_video_thumb");
      const gif = /^https:\/\/pbs\.twimg\.com\/tweet_video_thumb\/([\w-]+)\./.exec(source || "");
      if (gif) {
        gifs.add(`https://video.twimg.com/tweet_video/${gif[1]}.mp4`);
      } else if (isVideo) {
        const url = element.currentSrc || element.src;
        if (!/^https:\/\/video\.twimg\.com\/[^?#]+\.mp4(?:[?#]|$)/i.test(url)) continue;
        if (url.startsWith("https://video.twimg.com/tweet_video/")) gifs.add(url);
        else info.videos.push(url);
      }
    }
    info.gifs = [...gifs];
    return mediaCount(info) ? info : null;
  }

  function scanTweets() {
    const articles = document.querySelectorAll("article");
    const visiblePhotos = new WeakMap();
    for (const article of articles) {
      const identity = getTweetIdentity(article);
      const tweetId = identity?.[2];
      let info = tweetId ? mediaMap.get(tweetId) : null;
      let ownerId = tweetId;

      if (!info || !mediaCount(info)) {
        const fallback = resolveByImages(article);
        if (fallback) {
          info = fallback.info;
          ownerId = fallback.tweetId;
        }
      }

      // Разметка первого экрана может содержать фото раньше данных GraphQL.
      if (!info && tweetId) info = collectRenderedMedia(article, identity, visiblePhotos);
      addTweetButton(article, ownerId, info);
    }
    // Картинки ищем по всей странице — так кнопка работает и в ленте, и во вьювере.
    addPhotoButtons(visiblePhotos);
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
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "poster", "href", "data-href", "data-engagement-action"],
  });
  // Устанавливаем приёмник сообщений до запуска внедрённого скрипта.
  injectPageScript();

  requestScan();
})();
