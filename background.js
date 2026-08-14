(function () {
  // Firefox использует browser.*, Chrome — chrome.*
  const browser = globalThis.browser ?? globalThis.chrome;

  // Медиа X всегда лежит на twimg.com. Проверяем здесь, а не в content.js:
  // тот работает на странице твиттера, и прислать ему поддельное сообщение
  // с чужим адресом может любой скрипт этой страницы.
  function isAllowedMediaUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      const host = u.hostname.toLowerCase();
      return host === "twimg.com" || host.endsWith(".twimg.com");
    } catch (e) {
      return false;
    }
  }

  function waitForDownload(downloadId) {
    return new Promise((resolve) => {
      let done = false;

      function finish(result) {
        if (done) return;
        done = true;
        browser.downloads.onChanged.removeListener(listener);
        clearTimeout(timer);
        resolve(result);
      }

      function listener(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === "complete") {
          finish({ success: true });
        } else if (delta.state && delta.state.current === "interrupted") {
          finish({
            success: false,
            error: (delta.error && delta.error.current) || "interrupted",
          });
        }
      }

      browser.downloads.onChanged.addListener(listener);

      // Подстраховка: крупное видео может качаться дольше, чем нам стоит держать
      // индикатор. Считаем запуск успешным — статус виден в менеджере загрузок.
      const timer = setTimeout(() => finish({ success: true, pending: true }), 20000);
    });
  }

  async function handleDownload(msg) {
    if (!isAllowedMediaUrl(msg.url)) {
      return { success: false, error: "url is not on twimg.com" };
    }
    try {
      const downloadId = await browser.downloads.download({
        url: msg.url,
        filename: msg.filename || "twitter_media",
        saveAs: !!msg.saveAs,
      });
      return await waitForDownload(downloadId);
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  }

  function bytesToBase64(bytes) {
    // По кускам, иначе большой массив разложит стек вызовов
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // Content script не может забрать файл с video.twimg.com напрямую: там нет
  // заголовков CORS. У фонового скрипта есть host_permissions, ему можно.
  async function fetchMedia(url, maxBytes) {
    if (!isAllowedMediaUrl(url)) {
      return { success: false, error: "url is not on twimg.com" };
    }
    try {
      const res = await fetch(url);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      // Отказываем по заголовку, пока тело не прочитано: иначе крупный ролик
      // сначала выкачается целиком и раздуется в base64, и только потом будет
      // отброшен по размеру.
      const declared = Number(res.headers.get("content-length"));
      if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
        return { success: false, error: "source is too large" };
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { success: true, base64: bytesToBase64(buf), size: buf.length };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  }

  function base64ToBlob(base64, mime) {
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // downloads.download не принимает data: URL, поэтому нужен blob.
  // В Firefox фоновый скрипт — событийная страница с DOM, createObjectURL доступен.
  // В service worker Chrome его нет, там blob создаётся в offscreen-документе.
  const hasObjectUrl =
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function";

  let offscreenPending = null;

  async function ensureOffscreen() {
    if (!browser.offscreen) throw new Error("offscreen API is unavailable");
    if (browser.offscreen.hasDocument && (await browser.offscreen.hasDocument())) return;
    if (!offscreenPending) {
      offscreenPending = browser.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Create a blob URL for the converted GIF",
      });
    }
    // Промис нужен только чтобы не создать документ дважды из параллельных
    // вызовов. Держать его после завершения нельзя: документ могли закрыть,
    // и тогда следующий вызов проскочил бы мимо создания на готовом промисе.
    const pending = offscreenPending;
    try {
      await pending;
    } finally {
      if (offscreenPending === pending) offscreenPending = null;
    }
  }

  async function makeBlobUrl(base64, mime) {
    if (hasObjectUrl) return URL.createObjectURL(base64ToBlob(base64, mime));
    await ensureOffscreen();
    const res = await browser.runtime.sendMessage({
      target: "offscreen",
      type: "makeBlobUrl",
      base64,
      mime,
    });
    if (!res || !res.url) throw new Error("offscreen document returned nothing");
    return res.url;
  }

  function revokeBlobUrl(url) {
    if (hasObjectUrl) {
      URL.revokeObjectURL(url);
      return;
    }
    browser.runtime
      .sendMessage({ target: "offscreen", type: "revokeBlobUrl", url })
      .catch(() => {});
  }

  async function downloadData(msg) {
    let url;
    try {
      url = await makeBlobUrl(msg.base64, msg.mime || "application/octet-stream");
    } catch (e) {
      // Только здесь имеет смысл запасной путь: файл вообще не удалось подготовить
      return {
        success: false,
        canFallback: true,
        error: `blob url: ${e && e.message ? e.message : e}`,
      };
    }

    try {
      const downloadId = await browser.downloads.download({
        url,
        filename: msg.filename || "twitter_media",
        saveAs: !!msg.saveAs,
      });
      return await waitForDownload(downloadId);
    } catch (e) {
      // Сюда попадает и отмена диалога сохранения. Повторять через ссылку нельзя:
      // пользователь увидит второе окно, хотя он уже отказался.
      return { success: false, error: e && e.message ? e.message : String(e) };
    } finally {
      // Отзывать сразу нельзя — загрузка ещё читает данные по этой ссылке
      setTimeout(() => revokeBlobUrl(url), 60000);
    }
  }

  // Chrome не принимает промис, возвращённый из обработчика: нужно вызвать
  // sendResponse и вернуть true, чтобы канал остался открытым. Firefox
  // такой вариант тоже поддерживает, поэтому код общий.
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.target === "offscreen") return false; // это не нам

    if (msg.type === "download" && msg.url) {
      handleDownload(msg).then(sendResponse);
      return true;
    }
    if (msg.type === "fetchMedia" && msg.url) {
      fetchMedia(msg.url, msg.maxBytes).then(sendResponse);
      return true;
    }
    if (msg.type === "downloadData" && msg.base64) {
      downloadData(msg).then(sendResponse);
      return true;
    }
    return false;
  });
})();
