// Этот файл работает в контексте самой страницы (не в изолированном мире расширения),
// поэтому может перехватывать window.fetch и XMLHttpRequest, которые использует сам Twitter/X
// для подгрузки данных твитов (включая ссылки на видео и фото).

(function () {
  if (window.__xvdInjected) return;
  window.__xvdInjected = true;

  // Раньше здесь был список имён операций (TweetDetail, HomeTimeline и так
  // далее). X переименовывает их без предупреждения, и каждое переименование
  // означало молча пропавшие кнопки — так отвалилась лента на странице
  // пользователя. Плюс вкладки профиля («Медиа», «Ответы») ходят своими
  // операциями, которых в списке не было вовсе.
  //
  // Поэтому берём любой ответ GraphQL, а отбор делает сам разбор:
  // processTweetNode молча пропускает всё, где нет медиа. Цена — лишний
  // разбор JSON на ответах без твитов; выигрыш — расширение перестаёт
  // зависеть от того, как X сегодня называет свои запросы.
  const API_PATTERN = /\/graphql\//i;

  function processTweetNode(node, found) {
    const legacy = node.legacy || {};

    const tweetId = node.rest_id || legacy.id_str;
    if (typeof tweetId !== "string" || !/^\d+$/.test(tweetId)) return;

    const mediaList = node.media_entities2 ?? legacy.extended_entities?.media ??
      node.media_results?.result?.media ?? legacy.entities?.media;
    if (!Array.isArray(mediaList) || !mediaList.length) return;

    const screenName =
      (node.core &&
        node.core.user_results &&
        node.core.user_results.result &&
        node.core.user_results.result.legacy &&
        node.core.user_results.result.legacy.screen_name) ||
      (node.core &&
        node.core.user_results &&
        node.core.user_results.result &&
        node.core.user_results.result.core &&
        node.core.user_results.result.core.screen_name) ||
      null;

    const createdAt = Number(node.details?.created_at_ms) || node.details?.created_at ||
      legacy.created_at || null;

    const videos = [];
    const gifs = [];
    const photos = [];

    for (const m of mediaList) {
      if (!m) continue;
      const type = m.type || { Photo: "photo", Video: "video", AnimatedGif: "animated_gif" }[m.__typename];
      if (type === "photo" && m.media_url_https) {
        // Сохраняем оригинальный формат: у Твиттера бывают и .jpg, и .png.
        // Принудительный format=jpg пережимал бы PNG с потерей качества.
        const extMatch = m.media_url_https.match(/\.(jpg|jpeg|png|webp)$/i);
        const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
        const base = m.media_url_https.replace(/\.(jpg|jpeg|png|webp)$/i, "");
        photos.push({ url: `${base}?format=${ext}&name=orig`, ext });
      } else if (type === "video" || type === "animated_gif") {
        const variants = m.video_info?.variants || m.media_results?.result?.stream_management?.variants;
        if (!Array.isArray(variants)) continue;
        const mp4s = variants.filter(
          (v) => (v.content_type || v.type) === "video/mp4" && v.url
        );
        if (mp4s.length) {
          mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (type === "animated_gif") {
            gifs.push(mp4s[0].url);
          } else {
            videos.push(mp4s[0].url);
          }
        }
      }
    }

    if (videos.length || photos.length || gifs.length) {
      found[tweetId] = {
        screenName,
        createdAt,
        videos,
        gifs,
        photos,
      };
    }
  }

  function extractMedia(root, onPromise) {
    const found = Object.create(null);
    const visited = new WeakSet();

    function walk(node) {
      if (!node || typeof node !== "object" || visited.has(node)) return;
      visited.add(node);
      if (onPromise && node instanceof Promise) {
        onPromise(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node.rest_id || node.legacy?.id_str) {
        try {
          processTweetNode(node, found);
        } catch (e) {
          /* ignore malformed node */
        }
      }
      for (const value of Object.values(node)) walk(value);
    }

    walk(root);
    return found;
  }

  function reportMedia(payload, onPromise) {
    let media;
    try {
      media = extractMedia(payload, onPromise);
    } catch (e) {
      return;
    }
    if (Object.keys(media).length) {
      window.postMessage({ source: "xvd-extension", type: "media", data: media }, "*");
    }
  }

  // Первый экран x-web приходит в HTML. TanStack держит данные гидратации
  // во временных объектах страницы, а отложенные значения — в промисах.
  function observeInitialMedia() {
    const watchedPromises = new WeakSet();
    function watchPromise(promise) {
      if (watchedPromises.has(promise)) return;
      watchedPromises.add(promise);
      promise.then((payload) => reportMedia(payload, watchPromise)).catch(() => {});
    }
    function readInitialMedia() {
      reportMedia([window.$_TSR?.router, window.$R?.tsr], watchPromise);
    }

    readInitialMedia();
    if (document.readyState !== "loading") return;
    // Скрипт гидратации может удалить свой узел сразу после выполнения.
    const observer = new MutationObserver((records) => {
      const scriptChanged = records.some(({ addedNodes, removedNodes }) =>
        [...addedNodes, ...removedNodes].some((node) => node.nodeName === "SCRIPT")
      );
      if (scriptChanged) readInitialMedia();
    });
    observer.observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => {
      observer.disconnect();
      readInitialMedia();
    }, { once: true });
  }

  // --- fetch hook ---
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const urlArg = args[0];
    // fetch принимает строку, Request (адрес в .url) и URL (адрес в .href).
    // Раньше проверялось только .url, поэтому вызов с объектом URL давал
    // undefined и такой запрос вообще не рассматривался.
    const url =
      typeof urlArg === "string"
        ? urlArg
        : (urlArg && (urlArg.url || urlArg.href)) || "";
    const promise = origFetch.apply(this, args);
    if (url && API_PATTERN.test(url)) {
      promise
        .then((res) => res.clone().json())
        .then(reportMedia)
        .catch(() => {});
    }
    return promise;
  };

  // --- XHR hook ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    // Сюда тоже может прийти объект URL, а не строка.
    this.__xvdUrl = url == null ? "" : String(url);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__xvdUrl && API_PATTERN.test(this.__xvdUrl)) {
      this.addEventListener("load", function () {
        try {
          const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          reportMedia(data);
        } catch (e) {
          /* ignore */
        }
      }, { once: true });
    }
    return origSend.apply(this, args);
  };

  observeInitialMedia();
})();
