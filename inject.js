// Этот файл работает в контексте самой страницы (не в изолированном мире расширения),
// поэтому может перехватывать window.fetch и XMLHttpRequest, которые использует сам Twitter/X
// для подгрузки данных твитов (включая ссылки на видео и фото).

(function () {
  if (window.__xvdInjected) return;
  window.__xvdInjected = true;
  console.log("[XVD] inject.js загружен и активен");

  const API_PATTERN = /graphql\/.+\/(TweetDetail|TweetResultByRestId|UserTweets|HomeTimeline|HomeLatestTimeline|SearchTimeline|TweetResultsByIds|Bookmarks|Likes|ListLatestTweetsTimeline|CommunityTweetsTimeline)/i;

  function processTweetNode(node, found) {
    const legacy = node.legacy;
    if (!legacy) return;

    const tweetId = node.rest_id || legacy.id_str;
    if (!tweetId) return;

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

    const createdAt = legacy.created_at || null;

    const mediaList =
      (legacy.extended_entities && legacy.extended_entities.media) ||
      (legacy.entities && legacy.entities.media) ||
      [];

    const videos = [];
    const gifs = [];
    const photos = [];

    for (const m of mediaList) {
      if (m.type === "photo" && m.media_url_https) {
        // Сохраняем оригинальный формат: у Твиттера бывают и .jpg, и .png.
        // Принудительный format=jpg пережимал бы PNG с потерей качества.
        const extMatch = m.media_url_https.match(/\.(jpg|jpeg|png|webp)$/i);
        const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
        const base = m.media_url_https.replace(/\.(jpg|jpeg|png|webp)$/i, "");
        photos.push({ url: `${base}?format=${ext}&name=orig`, ext });
      } else if (
        (m.type === "video" || m.type === "animated_gif") &&
        m.video_info &&
        Array.isArray(m.video_info.variants)
      ) {
        const mp4s = m.video_info.variants.filter(
          (v) => v.content_type === "video/mp4" && v.url
        );
        if (mp4s.length) {
          mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (m.type === "animated_gif") {
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

  function extractMedia(root) {
    const found = {};

    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node.legacy && (node.rest_id || node.legacy.id_str)) {
        try {
          processTweetNode(node, found);
        } catch (e) {
          /* ignore malformed node */
        }
      }
      for (const key in node) {
        walk(node[key]);
      }
    }

    walk(root);
    return found;
  }

  function reportMedia(payload) {
    let media;
    try {
      media = extractMedia(payload);
    } catch (e) {
      return;
    }
    if (Object.keys(media).length) {
      window.postMessage({ source: "xvd-extension", type: "media", data: media }, "*");
    }
  }

  // --- fetch hook ---
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const urlArg = args[0];
    const url = typeof urlArg === "string" ? urlArg : urlArg && urlArg.url;
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
    this.__xvdUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__xvdUrl && API_PATTERN.test(this.__xvdUrl)) {
      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          reportMedia(data);
        } catch (e) {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, args);
  };
})();
