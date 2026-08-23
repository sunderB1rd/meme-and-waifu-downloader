// Список разрешённых хостов — граница безопасности расширения.
//
// Content-скрипты работают на страницах X и реддита, а качать умеет только
// фоновый скрипт. Значит любой скрипт на этих страницах может прислать ему
// сообщение с произвольным адресом, и единственное, что стоит между таким
// сообщением и реальной загрузкой, — эта проверка.
//
// Ошибка здесь не проявляется никак: расширение продолжает работать, просто
// начинает скачивать то, что ему подсунули. Поэтому тесты.

import test from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers.mjs";

const { isAllowedMediaUrl, ALLOWED_MEDIA_HOSTS } = loadScript("shared.js").XVDShared;

test("пропускаются хосты, с которых мы действительно качаем", () => {
  const allowed = [
    "https://pbs.twimg.com/media/ABC.jpg",
    "https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/x.mp4",
    "https://i.redd.it/6hzy31iu2rkh1.jpeg",
    "https://preview.redd.it/abc.jpg?width=704&s=x",
    "https://packaged-media.redd.it/abc/pb/m2-res_720p.mp4?e=1&s=2",
    "https://v.redd.it/abc/CMAF_720.mp4",
  ];
  for (const url of allowed) assert.equal(isAllowedMediaUrl(url), true, url);
});

test("сам домен без поддомена тоже проходит", () => {
  for (const host of ALLOWED_MEDIA_HOSTS) {
    assert.equal(isAllowedMediaUrl(`https://${host}/a.jpg`), true, host);
  }
});

test("похожий хост не проходит", () => {
  // Ровно то, ради чего сверка идёт по точке перед доменом, а не по концу
  // строки: endsWith("redd.it") пропустил бы первые два адреса.
  const lookalikes = [
    "https://evilredd.it/a.jpg",
    "https://evil-twimg.com/a.jpg",
    "https://twimg.com.evil.com/a.jpg",
    "https://redd.it.evil.com/a.jpg",
    "https://notredd.it/a.jpg",
  ];
  for (const url of lookalikes) assert.equal(isAllowedMediaUrl(url), false, url);
});

test("логин в адресе не выдаёт чужой хост за свой", () => {
  // https://i.redd.it@evil.com/a.jpg — хост здесь evil.com, а не i.redd.it.
  // Глазами почти неотличимо, поэтому проверяем явно.
  assert.equal(isAllowedMediaUrl("https://i.redd.it@evil.com/a.jpg"), false);
  assert.equal(isAllowedMediaUrl("https://pbs.twimg.com:pass@evil.com/a.jpg"), false);
});

test("соседние домены реддита и твиттера не проходят", () => {
  // Аватарки и эмодзи лежат там же, но качать с них мы не собираемся,
  // а лишний домен в списке — лишняя поверхность.
  const outside = [
    "https://www.reddit.com/a.jpg",
    "https://styles.redditmedia.com/t5_x/styles/icon.png",
    "https://emoji.redditmedia.com/x/y",
    "https://twitter.com/a.jpg",
    "https://x.com/a.jpg",
  ];
  for (const url of outside) assert.equal(isAllowedMediaUrl(url), false, url);
});

test("только https", () => {
  // По http медиа не отдаётся, а разрешённая схема без шифрования означала бы
  // возможность подменить ответ по пути.
  assert.equal(isAllowedMediaUrl("http://i.redd.it/a.jpg"), false);
  assert.equal(isAllowedMediaUrl("ftp://i.redd.it/a.jpg"), false);
  assert.equal(isAllowedMediaUrl("file:///C:/windows/system32/a.jpg"), false);
  assert.equal(isAllowedMediaUrl("data:image/png;base64,AAAA"), false);
  assert.equal(isAllowedMediaUrl("javascript:alert(1)"), false);
});

test("регистр в адресе не помеха", () => {
  assert.equal(isAllowedMediaUrl("HTTPS://I.REDD.IT/A.JPG"), true);
});

test("мусор вместо адреса отклоняется, а не роняет проверку", () => {
  for (const value of [null, undefined, "", "не адрес", "//i.redd.it/a.jpg", 42, {}]) {
    assert.equal(isAllowedMediaUrl(value), false, String(value));
  }
});
