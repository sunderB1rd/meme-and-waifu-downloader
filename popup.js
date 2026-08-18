(function () {
  // Firefox использует browser.*, Chrome — chrome.*
  const browser = globalThis.browser ?? globalThis.chrome;

  const defaults = {
    videoSubfolder: "TwitterVideos",
    videoAlwaysAsk: false,
    photoSubfolder: "TwitterImages",
    photoAlwaysAsk: false,
    photoByAuthor: false,
    gifConvert: true,
    copyShortcut: true,
  };

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

  // Пример, на котором показываем итоговый путь
  const SAMPLE_AUTHOR = "author";
  const SAMPLE_DATE = "2026-08-13";
  const SAMPLE_ID = "1234567890";

  // Та же санитизация, что при скачивании: Firefox отклонит путь с выходом
  // за пределы папки загрузок или с недопустимыми символами.
  function sanitizeSegment(str) {
    return String(str || "")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 60);
  }

  function sanitizeFolder(input) {
    return String(input || "")
      .split("/")
      .map((seg) => seg.trim())
      .filter((seg) => seg && seg !== "." && seg !== "..")
      .map(sanitizeSegment)
      .filter(Boolean)
      .join("/");
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderPath(parts, leaf) {
    const chain = parts
      .filter(Boolean)
      .map((p) => escapeHtml(p))
      .join('<span class="sep"> / </span>');
    const sep = chain ? '<span class="sep"> / </span>' : "";
    return `${chain}${sep}<span class="leaf">${escapeHtml(leaf)}</span>`;
  }

  function updatePreviews() {
    const videoSub = sanitizeFolder(els.videoSubfolder.value);
    previews.video.innerHTML = renderPath(
      ["Downloads", videoSub],
      `${SAMPLE_AUTHOR}_${SAMPLE_DATE}_${SAMPLE_ID}.mp4`
    );

    const photoSub = sanitizeFolder(els.photoSubfolder.value);
    const byAuthor = els.photoByAuthor.checked;
    previews.photo.innerHTML = renderPath(
      ["Downloads", photoSub, byAuthor ? SAMPLE_AUTHOR : null],
      `${SAMPLE_AUTHOR}_${SAMPLE_DATE}_${SAMPLE_ID}.jpg`
    );
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
