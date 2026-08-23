(function () {
  // Firefox использует browser.*, Chrome — chrome.*
  const browser = globalThis.browser ?? globalThis.chrome;

  // Дефолты, санитизация и сборка пути — общие с content.js (shared.js).
  // Пока они были продублированы здесь, превью могло разойтись с тем, куда
  // на самом деле падает файл.
  const { DEFAULT_SETTINGS: defaults, sanitizeFolder, buildPathParts } =
    globalThis.XVDShared;

  const textFields = [
    "videoSubfolder",
    "photoSubfolder",
    "redditVideoSubfolder",
    "redditImageSubfolder",
  ];
  const toggleFields = [
    "videoAlwaysAsk",
    "photoAlwaysAsk",
    "photoByAuthor",
    "gifConvert",
    "copyShortcut",
    "redditVideoAlwaysAsk",
    "redditImageAlwaysAsk",
  ];
  // На реддите папку осмысленно раскладывать и по автору, и по сабреддиту,
  // поэтому здесь выбор из трёх, а не тумблер, как у картинок X. Действует
  // только на картинки — у видео раскладки нет, как и на X.
  const radioFields = ["redditFolderBy"];

  const els = {};
  for (const key of [...textFields, ...toggleFields, ...radioFields]) {
    els[key] = document.getElementById(key);
  }
  const previews = {
    video: document.getElementById("videoPreview"),
    photo: document.getElementById("photoPreview"),
    redditVideo: document.getElementById("redditVideoPreview"),
    redditImage: document.getElementById("redditImagePreview"),
  };

  // Значение группы хранится в самой отмеченной кнопке, а не в контейнере.
  // Если не отмечена ни одна (в хранилище лежит что-то постороннее),
  // отвечаем первым вариантом — он же и дефолтный.
  function radioValue(key) {
    const checked = els[key].querySelector("input:checked");
    return checked ? checked.value : "none";
  }

  function setRadio(key, value) {
    const input =
      els[key].querySelector(`input[value="${value}"]`) ||
      els[key].querySelector("input");
    if (input) input.checked = true;
  }

  // Подставные автор и сабреддит для превью: настройки управляют только
  // папками, поэтому имя файла в превью не показывается — оно всегда
  // одинаковое, зато занимает вторую строку и растит окно.
  const SAMPLE = { author: "author", subreddit: "subreddit" };

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
    for (const key of radioFields) s[key] = radioValue(key);
    return s;
  }

  function updatePreviews() {
    const settings = currentSettings();

    for (const [kind, el] of [
      ["video", previews.video],
      ["photo", previews.photo],
      ["redditVideo", previews.redditVideo],
      ["redditImage", previews.redditImage],
    ]) {
      // Имя файла не передаём — тогда buildPathParts вернёт одни папки.
      const { parts } = buildPathParts(settings, {
        kind,
        screenName: SAMPLE.author,
        subreddit: SAMPLE.subreddit,
      });
      el.innerHTML = renderPath(["Downloads", ...parts]);
    }
  }

  // --- Вкладки ---
  const tabs = [...document.querySelectorAll(".tab")];
  const panels = new Map(
    [...document.querySelectorAll("[data-panel]")].map((el) => [el.dataset.panel, el])
  );

  function selectTab(name) {
    if (!panels.has(name)) name = "x";
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", tab.dataset.tab === name ? "true" : "false");
    }
    for (const [key, panel] of panels) {
      panel.hidden = key !== name;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      selectTab(tab.dataset.tab);
      // Запоминаем: человек обычно настраивает один сайт и возвращается
      // к нему же, а не пересматривает обе вкладки каждый раз.
      browser.storage.local.set({ activeTab: tab.dataset.tab });
    });
  }

  async function load() {
    const stored = await browser.storage.local.get(defaults);
    for (const key of textFields) {
      els[key].value = stored[key];
    }
    for (const key of toggleFields) {
      els[key].checked = !!stored[key];
    }
    for (const key of radioFields) {
      setRadio(key, stored[key]);
    }
    updatePreviews();

    // Вкладка хранится отдельно от настроек загрузки: это состояние
    // интерфейса, и content-скриптам оно ни к чему.
    const ui = await browser.storage.local.get({ activeTab: "x" });
    selectTab(ui.activeTab);
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

  for (const key of radioFields) {
    // Слушаем группу целиком: change всплывает от самой радиокнопки.
    els[key].addEventListener("change", async () => {
      await browser.storage.local.set({ [key]: radioValue(key) });
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
