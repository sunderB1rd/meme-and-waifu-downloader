// Нужен только Chrome: в его service worker нет URL.createObjectURL,
// а downloads.download не принимает data: URL. Offscreen-документ имеет DOM,
// поэтому blob создаётся здесь и его ссылка принадлежит origin расширения —
// фоновый скрипт может её скачать.
(function () {
  const browser = globalThis.browser ?? globalThis.chrome;

  function base64ToBlob(base64, mime) {
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || "application/octet-stream" });
  }

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return false;

    if (msg.type === "makeBlobUrl") {
      try {
        sendResponse({ url: URL.createObjectURL(base64ToBlob(msg.base64, msg.mime)) });
      } catch (e) {
        sendResponse({ error: e && e.message ? e.message : String(e) });
      }
      return false;
    }

    if (msg.type === "revokeBlobUrl") {
      try {
        URL.revokeObjectURL(msg.url);
      } catch (e) {
        /* уже отозван — не страшно */
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();
