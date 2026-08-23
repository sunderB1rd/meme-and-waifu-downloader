// Копирование картинки в буфер обмена.
//
// Общее для X и реддита: механика одна — забрать оригинал через фоновый
// скрипт, перегнать в PNG, положить в буфер и показать подсказку. Различается
// только то, где искать открытую картинку, и это решает вызывающий.
//
// Отдаётся как globalThis.XVDCopy.

(function () {
  const browser = globalThis.browser ?? globalThis.chrome;
  const { base64ToBytes } = globalThis.XVDShared;

  // Браузеры надёжно принимают в буфер только PNG, поэтому JPEG и webp
  // приходится перерисовывать через canvas. PNG отдаём как есть.
  async function bytesToPngBlob(bytes, ext) {
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    const source = new Blob([bytes], { type: mime });
    if (ext === "png") return source;

    const url = URL.createObjectURL(source);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);

      return await new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob вернул пустоту"))),
          "image/png"
        );
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Адрес можно передать готовым, а можно функцией: у галереи реддита он
  // добывается запросом, и если сходить за ним до записи в буфер, окно
  // пользовательского жеста успеет закрыться и браузер откажет. Внутри
  // промиса, отданного ClipboardItem, ждать можно сколько угодно.
  async function fetchAsPng(input) {
    const { url, ext } = typeof input.source === "function" ? await input.source() : input;
    if (!url) throw new Error("nothing to copy");

    // Забираем через фоновый скрипт: у медиахостов нет заголовков CORS,
    // content script сам файл не получит.
    const res = await browser.runtime.sendMessage({ type: "fetchMedia", url });
    if (!res || !res.success) throw new Error((res && res.error) || "fetch failed");
    return bytesToPngBlob(base64ToBytes(res.base64), ext || "jpg");
  }

  // Серия копирований подряд: чем быстрее гребёшь картинки, тем дальше
  // уезжает подпись. Счётчик живёт в памяти вкладки и сбрасывается после
  // паузы — реагировать он должен на «тащу пачкой», а не на «скопировал
  // десяток за день». Ступени точные: между ними подпись обычная, иначе
  // шутка приедается на второй раз.
  const STREAK_RESET_MS = 30000;
  const STREAK_MESSAGES = {
    3: "📋 Image copied ×3",
    5: "🔥 On a roll",
    10: "🚀 Easy there",
    15: "😭 Stop it",
  };
  let streak = 0;
  let lastCopyAt = 0;

  function copiedMessage() {
    const now = Date.now();
    streak = now - lastCopyAt > STREAK_RESET_MS ? 1 : streak + 1;
    lastCopyAt = now;
    return STREAK_MESSAGES[streak] || "📋 Image copied";
  }

  let toastTimer = null;

  // anchor — элемент, у которого показать подпись. Привязываем к картинке,
  // а не к окну: в просмотрщике она редко занимает всю ширину, и подпись по
  // центру экрана висела бы сбоку от неё. Координаты getBoundingClientRect
  // отсчитываются от окна — как раз то, что нужно для position: fixed.
  function toast(text, ok, anchor) {
    let el = document.querySelector(".xvd-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "xvd-toast";
      document.body.appendChild(el);
    }

    if (anchor) {
      const r = anchor.getBoundingClientRect();
      el.style.left = `${r.left + r.width / 2}px`;
      // Не даём уехать за верхний край, если картинка выше экрана.
      el.style.top = `${Math.max(16, r.top + 16)}px`;
    } else {
      el.style.left = "50%";
      el.style.top = "16px";
    }

    el.textContent = text;
    el.classList.toggle("xvd-toast-error", !ok);
    el.classList.add("xvd-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("xvd-toast-show"), 1800);
  }

  let busy = false;

  // { url, ext } либо { source }, плюс необязательный anchor для подписи.
  async function copyImage(request) {
    if (busy) return false;
    busy = true;

    const anchor = request.anchor;
    try {
      const png = fetchAsPng(request);
      try {
        // Промис внутри ClipboardItem держит жест «свежим», пока картинка
        // качается: иначе долгая загрузка съедала бы окно пользовательского
        // действия и браузер отказывал бы в записи.
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      } catch (err) {
        // Не всякий браузер принимает промис — тогда дожидаемся блоба.
        await navigator.clipboard.write([new ClipboardItem({ "image/png": await png })]);
      }
      toast(copiedMessage(), true, anchor);
      return true;
    } catch (err) {
      console.warn("[XVD] copy failed:", err);
      toast("⚠️ Copy failed", false, anchor);
      return false;
    } finally {
      busy = false;
    }
  }

  // Нажатие Ctrl+C, которое стоит перехватывать: без модификаторов сверх
  // самого Ctrl, не во время набора текста и не поверх выделения — там
  // копирование принадлежит браузеру.
  function isCopyShortcut(e) {
    // e.code, а не e.key: на не-латинской раскладке key придёт кириллицей.
    if (e.code !== "KeyC") return false;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;

    const active = document.activeElement;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable)
    ) {
      return false;
    }

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && String(selection).trim()) return false;

    return true;
  }

  globalThis.XVDCopy = { copyImage, isCopyShortcut };
})();
