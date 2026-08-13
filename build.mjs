#!/usr/bin/env node
// Собирает две версии расширения из общих исходников.
// Запуск:  node build.mjs
// Результат:  dist/firefox/ и dist/chrome/ — готовые папки для загрузки в браузер.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

// Файлы, общие для обеих сборок
const SHARED = [
  "content.js",
  "gif-encoder.js",
  "inject.js",
  "background.js",
  "popup.html",
  "popup.js",
  "offscreen.html",
  "offscreen.js",
  "style.css",
  "icons",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const firefoxManifest = readJson(join(root, "manifest.json"));
const chromeManifest = readJson(join(root, "manifest.chrome.json"));

// Версия — единый источник правды: манифест Firefox.
// Chrome-манифест подтягивает её автоматически, чтобы не расходились.
const version = firefoxManifest.version;
if (chromeManifest.version !== version) {
  chromeManifest.version = version;
  writeFileSync(
    join(root, "manifest.chrome.json"),
    JSON.stringify(chromeManifest, null, 2) + "\n"
  );
  console.log(`Версия в manifest.chrome.json подтянута до ${version}`);
}

rmSync(dist, { recursive: true, force: true });

for (const [target, manifest] of [
  ["firefox", firefoxManifest],
  ["chrome", chromeManifest],
]) {
  const out = join(dist, target);
  mkdirSync(out, { recursive: true });

  for (const item of SHARED) {
    const from = join(root, item);
    if (!existsSync(from)) {
      console.warn(`  пропущен (нет файла): ${item}`);
      continue;
    }
    cpSync(from, join(out, item), { recursive: true });
  }

  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Собрано: dist/${target}  (версия ${version})`);
}

console.log("\nГотово.");
console.log("  Firefox: about:debugging -> Load Temporary Add-on -> dist/firefox/manifest.json");
console.log("  Chrome:  chrome://extensions -> Загрузить распакованное -> папка dist/chrome");
