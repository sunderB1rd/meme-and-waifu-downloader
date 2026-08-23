// Скачивание картинок с реддита.
//
// Работает только на reddit.com и ничего не знает про X. Общее у них —
// shared.js (имена файлов и пути) и background.js (единственное, что умеет
// качать). Путь X этот файл не трогает вовсе.
//
// В отличие от X, перехватывать сеть не нужно: у нового реддита всё, что
// требуется для одиночной картинки, лежит прямо в атрибутах <shreddit-post>.
// За галереей ходим в <permalink>.json, и только по клику — иначе на скролле
// ленты мы устроили бы реддиту дождь из запросов.

(function () {
  const browser = globalThis.browser ?? globalThis.chrome;

  const {
    DEFAULT_SETTINGS,
    buildFilename,
    buildPathParts,
    extFromUrl,
    decodeEntities,
    parsePackagedMedia,
    parseGalleryJson,
    downloadIconSVG,
  } = globalThis.XVDShared;

  let settingsCache = null;
  async function getSettings() {
    if (settingsCache) return settingsCache;
    settingsCache = await browser.storage.local.get(DEFAULT_SETTINGS);
    return settingsCache;
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") settingsCache = null;
  });

  // --- Пост из атрибутов ---
  function readPost(el) {
    const type = el.getAttribute("post-type");
    // gif — это отдельный тип поста, но по устройству он тот же image:
    // content-href ведёт прямо на настоящий .gif, конвертировать нечего.
    const known = ["image", "gif", "gallery", "video"];
    if (!known.includes(type)) return null;

    const id = (el.getAttribute("id") || "").replace(/^t3_/, "");
    if (!id) return null;

    return {
      type,
      id,
      permalink: el.getAttribute("permalink") || "",
      author: el.getAttribute("author") || "",
      subreddit: el.getAttribute("subreddit-name") || "",
      createdAt: el.getAttribute("created-timestamp") || "",
      contentHref: el.getAttribute("content-href") || "",
    };
  }

  // --- Адреса медиа ---
  async function fetchPostJson(post) {
    // У галереи и видео content-href ведёт на страницу, а не на файл,
    // поэтому за адресами идём в API. raw_json=1 просит реддит не
    // экранировать ссылки в ответе.
    const base = post.permalink.replace(/[/]+$/, "");
    if (!base) return null;

    const res = await fetch(`${base}.json?raw_json=1`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function postData(payload) {
    return payload?.[0]?.data?.children?.[0]?.data ?? null;
  }

  // Плеер ищем по id поста, а не по сохранённой ссылке на узел: карточки
  // переиспользуются при скролле, и запасённая ссылка указывала бы на чужой пост.
  function findPlayer(post) {
    return document.querySelector(
      `shreddit-player[post-id="t3_${post.id}"], shreddit-player-2[post-id="t3_${post.id}"]`
    );
  }

  async function collectVideo(post) {
    // Готовый mp4 со звуком из атрибута плеера — лучший вариант: один файл,
    // склеивать нечего. Ссылки подписаны и живут ограниченное время, поэтому
    // читаем их в момент скачивания.
    const player = findPlayer(post);
    const packaged = player && parsePackagedMedia(player.getAttribute("packaged-media-json"));
    if (packaged) return [{ url: packaged.url, ext: "mp4" }];

    // Иначе остаётся то, что отдаёт API, а там дорожка без звука: у v.redd.it
    // картинка и звук лежат разными файлами. Для немого ролика (is_gif или
    // has_audio: false) это и есть весь файл, для остальных звук потребует
    // мультиплексора — его пока нет.
    const data = postData(await fetchPostJson(post));
    const video = data?.secure_media?.reddit_video || data?.media?.reddit_video;
    if (!video?.fallback_url) return [];

    const silent = video.is_gif === true || video.has_audio === false;
    if (!silent) {
      console.warn(
        "[XVD] reddit: готового mp4 со звуком нет, скачивается дорожка без звука:",
        post.id
      );
    }
    return [{ url: decodeEntities(video.fallback_url), ext: "mp4" }];
  }

  async function collectMedia(post) {
    if (post.type === "image" || post.type === "gif") {
      // content-href — прямой оригинал на i.redd.it. Из <img src> адрес брать
      // нельзя: у постов со спойлером там лежит замыленное превью, и мы
      // скачали бы мазню.
      if (!post.contentHref) return [];
      return [{ url: post.contentHref, ext: extFromUrl(post.contentHref) || "jpg" }];
    }

    if (post.type === "video") return collectVideo(post);

    return parseGalleryJson(await fetchPostJson(post));
  }

  // Текущий кадр карусели. Реддит держит все кадры в разметке разом и прячет
  // лишние через visibility, поэтому «самый видимый» искать не нужно —
  // достаточно спросить, у кого visible. Номер в slot="page-N" совпадает
  // с порядком в gallery_data.items, так что он же годится как индекс.
  function visibleGalleryIndex(container) {
    for (const li of container.querySelectorAll('gallery-carousel li[slot^="page-"]')) {
      const visible =
        li.style.visibility === "visible" ||
        window.getComputedStyle(li).visibility === "visible";
      if (!visible) continue;
      const n = Number(li.getAttribute("slot").replace("page-", ""));
      if (Number.isFinite(n) && n > 0) return n - 1;
    }
    return 0;
  }

  // --- Скачивание ---
  // Гифки и кадры галерей — это картинки, и складываются они к картинкам.
  // К видео относится только post-type="video".
  function pathKind(post) {
    return post.type === "video" ? "redditVideo" : "redditImage";
  }

  async function downloadOne(url, filename, settings, post) {
    const { parts, saveAs } = buildPathParts(settings, {
      filename,
      kind: pathKind(post),
      screenName: post.author,
      subreddit: post.subreddit,
    });

    const res = await browser.runtime.sendMessage({
      type: "download",
      url,
      filename: parts.join("/"),
      saveAs,
    });

    if (!res || !res.success) {
      console.warn("[XVD] reddit download failed:", url, res && res.error);
      return false;
    }
    return true;
  }

  // only — индекс одной картинки галереи или null, если нужны все.
  // Нумерация в имени файла считается от полного размера галереи в обоих
  // случаях: скачанная поодиночке третья картинка должна получить _3,
  // а не _1, иначе она затрёт первую.
  async function downloadPost(post, btn, only) {
    if (btn.dataset.xvdBusy) return;
    btn.dataset.xvdBusy = "1";
    btn.classList.remove("xvd-success", "xvd-error");
    btn.classList.add("xvd-loading");

    let ok = false;
    try {
      const settings = await getSettings();
      const media = await collectMedia(post);
      if (!media.length) throw new Error("no media found");

      const total = media.length;
      const chosen =
        only == null
          ? media.map((item, index) => ({ item, index }))
          : media[only]
            ? [{ item: media[only], index: only }]
            : [];
      if (!chosen.length) throw new Error("index is out of range");

      const info = { screenName: post.author, createdAt: post.createdAt };
      ok = true;

      for (const { item, index } of chosen) {
        const filename = buildFilename(
          info,
          post.id,
          item.ext || "jpg",
          total > 1 ? index : undefined,
          post.type === "video" ? "video" : "photo"
        );

        let done = await downloadOne(item.url, filename, settings, post);
        // Запасной адрес на preview.redd.it: если оригинала на i.redd.it
        // не оказалось, пробуем то, что реддит отдал сам.
        if (!done && item.fallbackUrl) {
          done = await downloadOne(item.fallbackUrl, filename, settings, post);
        }
        if (!done) ok = false;
      }
    } catch (e) {
      ok = false;
      console.warn("[XVD] reddit download error:", e);
    }

    btn.classList.remove("xvd-loading");
    btn.classList.add(ok ? "xvd-success" : "xvd-error");
    setTimeout(() => btn.classList.remove("xvd-success", "xvd-error"), 2500);
    delete btn.dataset.xvdBusy;
  }

  // --- Кнопки ---
  function makeButton(className, title, post) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.title = title;
    btn.dataset.xvdPost = post.id;
    return btn;
  }

  function onClick(btn, run) {
    // В ленте карточка поста целиком накрыта ссылкой <a slot="full-post-link">,
    // и переход реддит запускает не только по click. Пока гасился один click,
    // кнопка в ленте просто открывала пост, а на странице поста, где этой
    // ссылки нет, та же кнопка работала. Поэтому гасим всё, что уводит.
    for (const type of ["pointerdown", "mousedown", "auxclick"]) {
      btn.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
  }

  // Кнопка поверх картинки: качает то, что сейчас видно.
  function addImageButton(container, post) {
    const btn = makeButton(
      "xvd-photo-btn",
      post.type === "video"
        ? "Download video"
        : post.type === "gif"
          ? "Download GIF"
          : "Download image",
      post
    );
    btn.innerHTML = downloadIconSVG(18.75);
    onClick(btn, () => {
      // Кадр карусели спрашиваем в момент клика, а не при создании кнопки:
      // между ними человек мог пролистать галерею.
      const only = post.type === "gallery" ? visibleGalleryIndex(container) : null;
      downloadPost(post, btn, only);
    });
    container.appendChild(btn);
  }

  // Сколько кадров в галерее. Считаем по разметке карусели: это нужно только
  // для подписи, скачивание всё равно идёт по ответу .json.
  function galleryCount(container) {
    if (!container) return 0;
    return container.querySelectorAll('gallery-carousel li[slot^="page-"]').length;
  }

  // Панель действий поста лежит в теневом дереве shreddit-post, и стили
  // документа туда не достают. Зато у панели есть именованные слоты, а слот
  // наполняется из светлого DOM — такой элемент остаётся в дереве документа
  // и наши стили на него действуют.
  //
  // Имя слота не угадываем: пробуем по очереди и проверяем assignedSlot.
  // Если слота с таким именем нет, элемент просто не отрисуется.
  //
  // Список короткий не случайно. У слота бывает запасное содержимое, и оно
  // показывается ровно до тех пор, пока в слот ничего не назначено:
  // мы один раз сели в "share-button" и тем самым убрали у поста родную
  // кнопку «поделиться». Поэтому сюда можно брать только слоты, которые
  // либо пусты, либо уже чем-то заняты:
  //   repost-button       — занят выпадашкой репоста, встаём следом за ней
  //   action-row-whitespace — пустая распорка в конце строки
  // Нельзя: share-button (запасная кнопка «поделиться»),
  // mod-content-actions и promote-post-button (там инструменты модератора).
  const ACTION_SLOTS = ["repost-button", "action-row-whitespace"];

  function placeInActionBar(postEl, btn) {
    for (const name of ACTION_SLOTS) {
      btn.slot = name;
      postEl.appendChild(btn);
      if (btn.assignedSlot) return true;
      btn.remove();
    }
    btn.removeAttribute("slot");
    return false;
  }

  // Вид кнопки снимаем с соседней родной, а не задаём числами. Фон у них
  // полупрозрачный — он и рассчитан на то, что под кнопкой может оказаться
  // что угодно, поэтому подобранный на глаз непрозрачный цвет выглядел бы
  // чужеродно при смене темы или фона карточки.
  //
  // Панель действий лежит в теневом дереве shreddit-post, но оно открытое,
  // так что до соседа мы дотягиваемся. Первым берём кнопку комментариев:
  // из всех родных она ближе всего устроена — значок плюс число.
  const NEIGHBOUR_SELECTORS = [
    '[data-action-bar-action="comments"]',
    '[data-post-click-location="repost-button"]',
    '[data-testid="action-row"] button',
  ];

  // Значения уходят в переменные, а не в style.color и style.background:
  // инлайновые свойства перебили бы подсветку при наведении и зелёный
  // с красным после загрузки.
  function applyNeighbourLook(postEl, btn) {
    if (btn.style.getPropertyValue("--xvd-bg")) return; // уже сняли
    const root = postEl.shadowRoot;
    if (!root) return;

    let neighbour = null;
    for (const selector of NEIGHBOUR_SELECTORS) {
      neighbour = root.querySelector(selector);
      if (neighbour) break;
    }
    if (!neighbour) return;

    const s = window.getComputedStyle(neighbour);
    // Панель может быть ещё не отрисована — тогда снимать нечего,
    // попробуем на следующем проходе.
    if (!s.height || parseFloat(s.height) < 8) return;

    btn.style.setProperty("--xvd-bg", s.backgroundColor);
    btn.style.setProperty("--xvd-fg", s.color);
    btn.style.setProperty("--xvd-h", s.height);
    btn.style.setProperty("--xvd-radius", s.borderRadius);
    btn.style.setProperty("--xvd-px", s.paddingLeft);
    btn.style.setProperty("--xvd-fs", s.fontSize);
    btn.style.setProperty("--xvd-fw", s.fontWeight);

    // Фон наведения и нажатия из computed style так просто не достать: он
    // отражает текущее состояние, а сосед в момент опроса не нажат. Зато
    // getComputedStyle отдаёт и пользовательские свойства, в том числе
    // объявленные на самом элементе, — а реддит держит цвета состояний
    // именно в них. Забираем и повторяем его же конструкцию в CSS.
    for (const [ours, theirs] of [
      ["--xvd-bg-hover", "--button-color-background-hover"],
      ["--xvd-bg-active", "--button-color-background-active"],
      ["--xvd-pressed", "--color-interactive-pressed"],
    ]) {
      const value = s.getPropertyValue(theirs).trim();
      if (value) btn.style.setProperty(ours, value);
    }
  }

  // Подпись кнопки в панели действий. У галереи она качает все кадры,
  // у остальных постов — единственное, что там есть.
  function actionLabel(post, total) {
    if (post.type === "gallery") {
      return total > 1 ? `Download all (${total})` : "Download all";
    }
    if (post.type === "video") return "Download video";
    if (post.type === "gif") return "Download GIF";
    return "Download image";
  }

  // Кнопка в панели действий поста — та же, что у X внизу твита.
  function addActionButton(postEl, container, post) {
    const total = post.type === "gallery" ? galleryCount(container) : 1;
    const btn = makeButton("xvd-reddit-all-btn", actionLabel(post, total), post);
    btn.innerHTML = downloadIconSVG(16);

    if (total > 1) {
      const label = document.createElement("span");
      label.textContent = total;
      btn.appendChild(label);
    }
    onClick(btn, () => downloadPost(post, btn, null));

    if (placeInActionBar(postEl, btn)) {
      applyNeighbourLook(postEl, btn);
      return;
    }

    // Запасное место — вторым кружком поверх медиа, но только у галереи:
    // там кнопка на картинке качает один кадр, а эта все. У остальных постов
    // обе делали бы одно и то же, и второй кружок был бы просто шумом.
    if (post.type !== "gallery" || !container) return;

    btn.className = "xvd-photo-btn xvd-photo-btn-all";
    btn.innerHTML = downloadIconSVG(18.75);
    if (total > 1) {
      const badge = document.createElement("span");
      badge.className = "xvd-badge";
      badge.textContent = total;
      btn.appendChild(badge);
    }
    container.appendChild(btn);
  }

  // Панель действий гидратируется позже карточки. Пока её нет, слот не
  // находится: у галереи кнопка садится на запасное место, у остальных постов
  // не появляется вовсе. И то и другое лечится повтором на следующих проходах,
  // но не бесконечным — иначе на прокрутке мы пересоздавали бы её каждый кадр.
  const PLACEMENT_RETRIES = 10;

  function ensureActionButton(postEl, container, post) {
    const existing = postEl.querySelector(".xvd-reddit-all-btn, .xvd-photo-btn-all");

    // Уже в панели и от этого же поста — больше ничего не нужно.
    if (
      existing &&
      existing.dataset.xvdPost === post.id &&
      existing.classList.contains("xvd-reddit-all-btn")
    ) {
      applyNeighbourLook(postEl, existing);
      return;
    }

    const [forPost, count] = String(postEl.dataset.xvdPlaceTries || "").split(":");
    const tries = forPost === post.id ? Number(count) || 0 : 0;
    if (tries >= PLACEMENT_RETRIES) return;

    if (existing) existing.remove();
    postEl.dataset.xvdPlaceTries = `${post.id}:${tries + 1}`;
    addActionButton(postEl, container, post);
  }

  // Узлы переиспользуются при скролле: кнопка от другого поста качала бы
  // чужие картинки, поэтому сверяем принадлежность и пересоздаём.
  function ensureButton(scope, selector, post, create) {
    const existing = scope.querySelector(selector);
    if (existing) {
      if (existing.dataset.xvdPost === post.id) return;
      existing.remove();
    }
    create();
  }

  // --- Полноэкранный просмотрщик ---
  // Какой пост открыт, по разметке лайтбокса надёжно не понять: у галереи
  // внутри есть <gallery-carousel post-id>, а у одиночной картинки его нет.
  // Зато просмотрщик всегда открывают кликом по посту, так что запоминаем
  // последний такой клик и держим его запасным вариантом.
  //
  // Слушаем на фазе перехвата: реддит на своих обработчиках может остановить
  // всплытие раньше нас.
  let lastClickedPost = null;
  document.addEventListener(
    "click",
    (e) => {
      const el =
        e.target instanceof Element && e.target.closest("shreddit-post[post-type]");
      if (el) lastClickedPost = readPost(el);
    },
    true
  );

  function lightboxTarget(box) {
    const carousel = box.querySelector("gallery-carousel[post-id]");
    // Номер кадра спрашиваем у самой карусели просмотрщика, а не у той,
    // что осталась в ленте: пролистывают-то открытую.
    const only = carousel ? visibleGalleryIndex(box) : null;

    if (carousel) {
      const id = (carousel.getAttribute("post-id") || "").replace(/^t3_/, "");
      const el = id && document.querySelector(`shreddit-post[id="t3_${id}"]`);
      const post = el && readPost(el);
      if (post) return { post, only };
    }

    return lastClickedPost ? { post: lastClickedPost, only } : null;
  }

  // Крестик закрытия сидит в правом верхнем углу, поэтому встаём левее него.
  // Отступ, размер и фон снимаем с него же: числами тут промахнуться легко,
  // а выглядеть кнопка должна как родная соседка крестика.
  function placeInLightbox(box, btn) {
    const host = box.querySelector('[data-testid="lightbox-template"]') || box;
    host.appendChild(btn);

    const close = box.querySelector('[data-testid="close-button"]');
    if (!close) return;

    const s = window.getComputedStyle(close);
    const gap = parseFloat(s.right) || 12;
    const width = close.getBoundingClientRect().width || 40;

    btn.style.top = s.top;
    btn.style.right = `${gap + width + 8}px`;
    btn.style.setProperty("--xvd-size", s.height);
    btn.style.setProperty("--xvd-radius", s.borderRadius);
    btn.style.setProperty("--xvd-bg", s.backgroundColor);
  }

  function lightboxLabel(post) {
    // В просмотрщике кнопка всегда качает то, что открыто, — даже у галереи.
    if (post.type === "video") return "Download video";
    if (post.type === "gif") return "Download GIF";
    return "Download image";
  }

  function ensureLightboxButton() {
    const box = document.getElementById("shreddit-media-lightbox");
    if (!box) return;

    const target = lightboxTarget(box);
    if (!target) return;

    const existing = box.querySelector(".xvd-lightbox-btn");
    if (existing && existing.dataset.xvdPost === target.post.id) return;
    if (existing) existing.remove();

    const btn = makeButton("xvd-lightbox-btn", lightboxLabel(target.post), target.post);
    btn.innerHTML = downloadIconSVG(20);
    onClick(btn, () => {
      // Кадр спрашиваем в момент нажатия: галерею могли пролистать.
      const now = lightboxTarget(box);
      if (now) downloadPost(now.post, btn, now.only);
    });

    placeInLightbox(box, btn);
  }

  function scan() {
    for (const el of document.querySelectorAll("shreddit-post[post-type]")) {
      const post = readPost(el);
      if (!post) continue;

      const container = el.querySelector('[slot="post-media-container"]');
      if (container) {
        // Класс возвращаем на каждом проходе: реддит перерисовывает карточки
        // и переписывает className своим значением, ровно как React у X.
        container.classList.add("xvd-photo-container");
        if (window.getComputedStyle(container).position === "static") {
          container.style.position = "relative";
        }
        ensureButton(container, ".xvd-photo-btn:not(.xvd-photo-btn-all)", post, () =>
          addImageButton(container, post)
        );
      }

      ensureActionButton(el, container, post);
    }

    ensureLightboxButton();
  }

  let scanScheduled = false;
  function requestScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      try {
        scan();
      } catch (e) {
        console.warn("[XVD] reddit scan error:", e);
      }
    });
  }

  new MutationObserver(requestScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  requestScan();
})();
