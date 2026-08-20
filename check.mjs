#!/usr/bin/env node
// Предполётная проверка: всё, что можно проверить без браузера.
//
//   node check.mjs
//
// Смысл в том, что поломки этого расширения молчаливые. Файл, забытый в
// списке SHARED, не попадёт в сборку — расширение просто не заработает, без
// единого сообщения. Разъехавшиеся версии в манифестах отвалят автообновление
// так же тихо. Поэтому проверяем не только синтаксис, но и то, что собранная
// папка содержит всё, на что ссылаются манифесты и попап.
//
// Сборку скрипт запускает сам и проверяет её результат, а не список файлов в
// build.mjs: список может совпасть с реальностью только на бумаге. Побочный
// эффект — dist пересоздаётся.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
let failures = 0;

const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  ПЛОХО ${msg}`);
};
const section = (title) => console.log(`\n${title}`);

// --- Синтаксис ---
section("Синтаксис");
{
  const files = [
    ...readdirSync(root).filter((f) => /\.(js|mjs)$/.test(f)),
    ...readdirSync(join(root, "tests")).map((f) => join("tests", f)),
  ].filter((f) => /\.(js|mjs)$/.test(f));

  for (const file of files) {
    try {
      execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
    } catch (e) {
      fail(`${file}: ${String(e.stderr || e.message).trim().split("\n")[0]}`);
      continue;
    }
  }
  if (!failures) ok(`${files.length} файлов разбираются`);
}

// --- Манифесты и версии ---
section("Манифесты и версии");
const json = {};
for (const file of ["manifest.json", "manifest.chrome.json", "updates.json"]) {
  try {
    json[file] = JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (e) {
    fail(`${file}: ${e.message}`);
  }
}

const firefox = json["manifest.json"];
const chrome = json["manifest.chrome.json"];
const updates = json["updates.json"];
const version = firefox?.version;

if (firefox && chrome) {
  if (chrome.version === version) ok(`версия ${version} одинакова в обоих манифестах`);
  else fail(`версии разъехались: firefox ${version}, chrome ${chrome.version}`);
}

// Идентичность расширения для Firefox. Другой id — другое расширение:
// слетают настройки пользователя и рвётся связь с подписанными сборками.
const GECKO_ID = "xvd-extension@local.personal";
if (firefox) {
  const gecko = firefox.browser_specific_settings?.gecko ?? {};
  if (gecko.id === GECKO_ID) ok(`gecko id на месте`);
  else fail(`gecko id изменён: ${gecko.id} (ожидался ${GECKO_ID})`);
}

// Автообновления встают молча, если номер или имя файла не совпали.
if (updates && version) {
  const entry = updates.addons?.[GECKO_ID]?.updates?.[0];
  if (!entry) {
    fail(`updates.json: нет записи для ${GECKO_ID}`);
  } else if (entry.version !== version) {
    fail(`updates.json: версия ${entry.version}, а в манифесте ${version}`);
  } else if (!entry.update_link.includes(`/v${version}/`) || !entry.update_link.includes(version + "-firefox.xpi")) {
    fail(`updates.json: ссылка не ведёт на файл версии ${version}`);
  } else {
    ok("updates.json согласован с манифестом");
  }
}

// --- Метки, которые нельзя переименовывать ---
section("Метки канала");
{
  // Значение произвольное, но должно совпадать на обеих сторонах postMessage,
  // иначе content.js молча отсеет все сообщения от inject.js.
  const label = "xvd-extension";
  const sides = ["inject.js", "content.js"].filter((f) =>
    readFileSync(join(root, f), "utf8").includes(`"${label}"`)
  );
  if (sides.length === 2) ok(`метка «${label}» совпадает в inject.js и content.js`);
  else fail(`метка «${label}» найдена только в: ${sides.join(", ") || "нигде"}`);
}

// --- Сборка и её содержимое ---
section("Сборка");
try {
  execFileSync(process.execPath, ["build.mjs"], { cwd: root, stdio: "pipe" });
  ok("build.mjs отработал");
} catch (e) {
  fail(`build.mjs упал: ${String(e.stderr || e.message).trim()}`);
}

// Chrome создаёт offscreen-документ из кода, манифест о нём не знает —
// поэтому в списке ссылок его нужно назвать руками.
const EXTRA_REFS = ["offscreen.html", "offscreen.js"];

function manifestRefs(manifest) {
  const refs = new Set(EXTRA_REFS);
  const add = (v) => {
    if (typeof v === "string" && v) refs.add(v);
  };
  add(manifest.action?.default_popup);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  Object.values(manifest.icons ?? {}).forEach(add);
  for (const cs of manifest.content_scripts ?? []) {
    (cs.js ?? []).forEach(add);
    (cs.css ?? []).forEach(add);
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    (war.resources ?? []).forEach(add);
  }
  add(manifest.background?.service_worker);
  (manifest.background?.scripts ?? []).forEach(add);
  return refs;
}

// Попап тянет свои скрипты и шрифты сам — манифест о них тоже не знает.
function htmlRefs(html) {
  const refs = new Set();
  for (const m of html.matchAll(/src="([^"]+)"/g)) refs.add(m[1]);
  for (const m of html.matchAll(/url\("([^"]+)"\)/g)) refs.add(m[1]);
  return new Set([...refs].filter((r) => !/^(https?:|data:)/.test(r)));
}

for (const [target, manifest] of [
  ["firefox", firefox],
  ["chrome", chrome],
]) {
  if (!manifest) continue;
  const out = join(root, "dist", target);
  if (!existsSync(out)) {
    fail(`dist/${target} не собрана`);
    continue;
  }

  const refs = manifestRefs(manifest);
  const popup = join(out, "popup.html");
  if (existsSync(popup)) {
    for (const r of htmlRefs(readFileSync(popup, "utf8"))) refs.add(r);
  }

  const missing = [...refs].filter((r) => !existsSync(join(out, r)));
  if (missing.length) fail(`dist/${target}: не хватает ${missing.join(", ")}`);
  else ok(`dist/${target}: все ${refs.size} упомянутых файлов на месте`);
}

// --- Тесты ---
section("Тесты");
try {
  // Файлы перечисляем явно: каталог в --test на Windows принимается за
  // отдельный тестовый файл, и прогон падает до первого теста.
  const testFiles = readdirSync(join(root, "tests"))
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => join("tests", f));
  const out = execFileSync(process.execPath, ["--test", ...testFiles], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
  const pass = out.match(/[#\u2139]\s*pass\s+(\d+)/)?.[1] ?? "?";
  ok(`${pass} тестов прошли`);
} catch (e) {
  fail("тесты не прошли:");
  console.log(String(e.stdout || e.message));
}

console.log(
  failures
    ? `\nПроблем: ${failures}. Собирать и подписывать рано.`
    : "\nВсё чисто."
);
process.exit(failures ? 1 : 0);
