(function () {
  // Firefox использует browser.*, Chrome — chrome.*
  const browser = globalThis.browser ?? globalThis.chrome;

  // Дефолты, санитизация и сборка пути — общие с content.js (shared.js).
  // Пока они были продублированы здесь, превью могло разойтись с тем, куда
  // на самом деле падает файл.
  const {
    DEFAULT_SETTINGS: defaults,
    sanitizeFolder,
    buildFilename,
    buildPathParts,
  } = globalThis.XVDShared;

  const textFields = ["videoSubfolder", "photoSubfolder"];
  const toggleFields = [
    "videoAlwaysAsk",
    "photoAlwaysAsk",
    "photoByAuthor",
    "gifConvert",
    "copyShortcut",
  ];

  const els = {};
  for (const key of [...textFields, ...toggleFields]) {
    els[key] = document.getElementById(key);
  }
  const previews = {
    video: document.getElementById("videoPreview"),
    photo: document.getElementById("photoPreview"),
  };

  // Пример, на котором показываем итоговый путь. Поля те же, что у настоящего
  // твита, — превью строится тем же buildFilename, что и реальное имя файла.
  const SAMPLE = {
    info: { screenName: "author", createdAt: new Date(2026, 7, 13) },
    tweetId: "1234567890",
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Вложенную подпапку («Art/Twitter») разбираем на сегменты, чтобы превью
  // выглядело так же, как путь на диске, а не одной склеенной строкой.
  function renderPath(segments) {
    const flat = segments.flatMap((s) => String(s || "").split("/")).filter(Boolean);
    const leaf = flat.pop();
    const chain = flat.map(escapeHtml).join('<span class="sep"> / </span>');
    const sep = chain ? '<span class="sep"> / </span>' : "";
    return `${chain}${sep}<span class="leaf">${escapeHtml(leaf)}</span>`;
  }

  // Превью считаем по тому, что сейчас в полях, а не по сохранённому:
  // путь должен меняться по мере набора.
  function currentSettings() {
    const s = {};
    for (const key of textFields) s[key] = els[key].value;
    for (const key of toggleFields) s[key] = els[key].checked;
    return s;
  }

  function updatePreviews() {
    const settings = currentSettings();

    for (const [kind, ext, el] of [
      ["video", "mp4", previews.video],
      ["photo", "jpg", previews.photo],
    ]) {
      const filename = buildFilename(SAMPLE.info, SAMPLE.tweetId, ext, undefined, kind);
      const { parts } = buildPathParts(settings, {
        filename,
        kind,
        screenName: SAMPLE.info.screenName,
      });
      el.innerHTML = renderPath(["Downloads", ...parts]);
    }
  }

  async function load() {
    const stored = await browser.storage.local.get(defaults);
    for (const key of textFields) {
      els[key].value = stored[key];
    }
    for (const key of toggleFields) {
      els[key].checked = !!stored[key];
    }
    updatePreviews();
  }

  for (const key of textFields) {
    // input — чтобы превью обновлялось по мере набора
    els[key].addEventListener("input", updatePreviews);
    els[key].addEventListener("change", async () => {
      const value = sanitizeFolder(els[key].value);
      els[key].value = value;
      await browser.storage.local.set({ [key]: value });
      updatePreviews();
    });
  }

  for (const key of toggleFields) {
    els[key].addEventListener("change", async () => {
      await browser.storage.local.set({ [key]: els[key].checked });
      updatePreviews();
    });
  }

  // Пасхалка: клик по сердцу в футере. Позиционируем от самого сердца, а не
  // от центра окна, чтобы сердечки вылетали именно из него.
  const heart = document.querySelector(".footer .heart");
  if (heart) {
    heart.addEventListener("click", () => {
      const rect = heart.getBoundingClientRect();
      for (let i = 0; i < 6; i++) {
        const spark = document.createElement("span");
        spark.className = "spark";
        spark.textContent = "♥";
        spark.style.left = `${rect.left + rect.width / 2}px`;
        spark.style.top = `${rect.top}px`;
        spark.style.setProperty("--dx", `${(Math.random() - 0.5) * 64}px`);
        spark.style.animationDelay = `${i * 45}ms`;
        document.body.appendChild(spark);
        setTimeout(() => spark.remove(), 1200 + i * 45);
      }
    });
  }

  const versionEl = document.getElementById("version");
  if (versionEl) {
    versionEl.textContent = `v${browser.runtime.getManifest().version}`;
  }

  load();
})();
