#!/usr/bin/env node
// Готовит файлы для релиза на GitHub.
//
//   node release.mjs           — пересобрать и сложить архивы
//   node release.mjs --sign    — то же плюс подпись на AMO
//
// Подпись отделена флагом намеренно: номер версии расходуется на AMO
// безвозвратно, повторно его не примут. Обычный прогон должен быть безопасным
// и повторяемым сколько угодно раз.
//
// Всё готовое уезжает ВНЕ репозитория — туда же, где лежат старые подписанные
// сборки. В гите архивам делать нечего (см. .gitignore), но и терять их нельзя.
//
// Упаковка идёт через bsdtar (он же C:\Windows\System32\tar.exe, есть в
// Windows начиная с 10 1803). Своего zip в Node нет, а зависимость ради одной
// команды тянуть не хочется. Из-за этого скрипт работает только на Windows —
// в отличие от build.mjs, который переносим.
//
// Именно bsdtar, а НЕ Compress-Archive из PowerShell: тот в Windows
// PowerShell 5.1 пишет пути с обратными слэшами, что противоречит
// спецификации ZIP. Windows такое читает, а macOS и Linux создают файлы с
// буквальным «\» в имени — распакованная папка ломается, и «загрузить
// распакованное» в Chrome не работает.

import {
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const artifacts = join(root, "..", "meme-and-waifu-downloader-artifacts");

const NAME = "waifu-and-meme-downloader";
const sign = process.argv.includes("--sign");

const version = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version;

// --- Пересборка ---
execFileSync("node", ["build.mjs"], { cwd: root, stdio: "inherit" });

mkdirSync(artifacts, { recursive: true });

// --- Архивы ---
const TAR = "C:\\Windows\\System32\\tar.exe";

function zip(sourceDir, outName) {
  const out = join(artifacts, outName);
  rmSync(out, { force: true }); // bsdtar не перезаписывает, а дописывает
  // Имена файлов перечисляем явно вместо «.»: иначе каждая запись в архиве
  // получит префикс «./». Манифест должен лежать в корне архива, иначе
  // Chrome при загрузке распакованного его не найдёт.
  execFileSync(TAR, ["-a", "-c", "-f", out, "-C", sourceDir, ...readdirSync(sourceDir)], {
    stdio: "inherit",
  });
  console.log(`  ${outName}`);
}

if (!existsSync(TAR)) {
  console.error(`Не найден ${TAR} — без него архивы не собрать.`);
  process.exit(1);
}

console.log(`\nАрхивы (версия ${version}):`);
zip(join(dist, "chrome"), `${NAME}-${version}-chrome.zip`);
zip(join(dist, "firefox"), `${NAME}-${version}-firefox-unsigned.zip`);

// --- Подпись ---
if (sign) {
  const firefoxDist = join(dist, "firefox");

  console.log(`\nПодпись версии ${version} на AMO...`);
  // Ключи web-ext берёт из ~/.web-ext-config.mjs — в команде их нет намеренно,
  // чтобы секрет не попадал ни в историю оболочки, ни в вывод.
  // Запускаем из dist/firefox: web-ext пакует ту папку, из которой вызван,
  // и в корне репозитория в сборку уехали бы README, build.mjs и сам dist.
  execSync("web-ext sign", { cwd: firefoxDist, stdio: "inherit" });

  const outDir = join(firefoxDist, "web-ext-artifacts");
  const xpi = existsSync(outDir)
    ? readdirSync(outDir).find((f) => f.endsWith(".xpi"))
    : null;

  if (!xpi) {
    console.error("\nweb-ext отработал, но .xpi не найден — забрать нечего.");
    process.exit(1);
  }

  // Имя от web-ext содержит хеш загрузки и человеку ничего не говорит.
  const named = `${NAME}-${version}-firefox.xpi`;
  copyFileSync(join(outDir, xpi), join(artifacts, named));
  console.log(`\nПодписано:\n  ${named}`);

  // Служебный файл web-ext: dist полностью пересоздаётся при каждой сборке,
  // так что здесь он не переживёт следующий build.mjs.
  const uuid = join(firefoxDist, ".amo-upload-uuid");
  if (existsSync(uuid)) copyFileSync(uuid, join(artifacts, ".amo-upload-uuid"));
}

console.log(`\nГотово. Всё лежит в:\n  ${artifacts}`);
if (!sign) console.log("\nПодпись не запускалась. Для неё: node release.mjs --sign");
