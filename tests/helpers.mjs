// Вспомогательное для тестов: запуск браузерных скриптов в Node и разбор GIF.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// shared.js и gif-encoder.js — обычные скрипты: в браузере их подключает
// манифест, а сами они отдают себя через globalThis и никаких экспортов не
// имеют. Чтобы проверять их из Node, выполняем файл в отдельном контексте и
// забираем то, что он туда положил. URL приходится передать руками: в чистом
// vm-контексте есть только встроенные объекты языка, а это уже платформа.
export function loadScript(file) {
  const context = vm.createContext({ console, URL });
  vm.runInContext(readFileSync(join(root, file), "utf8"), context, { filename: file });
  return context;
}

// --- Разбор GIF ---
// Свой декодер, потому что проверять кодировщик его же кодом бессмысленно,
// а тянуть зависимость ради тестов проекту нельзя.

function lzwDecode(bytes, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;

  let dict = [];
  let codeSize = minCodeSize + 1;

  function reset() {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push(null, null); // места под clear и eoi
    codeSize = minCodeSize + 1;
  }
  reset();

  let bitPos = 0;
  function read() {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = bytes[bitPos >> 3];
      if (byte === undefined) return eoi;
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  }

  const out = [];
  let prev = null;

  for (;;) {
    const code = read();
    if (code === eoi) break;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }

    let entry;
    if (code < dict.length && dict[code]) {
      entry = dict[code];
    } else if (prev) {
      entry = [...prev, prev[0]]; // случай KwKwK
    } else {
      throw new Error("битый поток LZW");
    }

    out.push(...entry);

    if (prev) {
      dict.push([...prev, entry[0]]);
      // Ширина кода растёт на кадр раньше, чем у кодировщика: словарь
      // декодера отстаёт ровно на одну запись.
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }

  return out;
}

export function decodeGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => {
    const v = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    return v;
  };

  const signature = String.fromCharCode(...bytes.slice(0, 6));
  p = 6;

  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); // индекс фона
  u8(); // соотношение сторон пикселя

  const palette = [];
  const gctSize = 1 << ((packed & 0x07) + 1);
  for (let i = 0; i < gctSize; i++) palette.push([u8(), u8(), u8()]);

  const frames = [];
  let loops = false;
  let pendingDelay = null;

  for (;;) {
    const block = u8();
    if (block === undefined) throw new Error("файл кончился без трейлера");
    if (block === 0x3b) break;

    if (block === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        u8(); // размер блока
        u8(); // флаги
        pendingDelay = u16();
        u8(); // прозрачный индекс
        u8(); // терминатор
        continue;
      }
      let name = "";
      if (label === 0xff) {
        const size = u8();
        for (let i = 0; i < size; i++) name += String.fromCharCode(u8());
      }
      if (name.startsWith("NETSCAPE")) loops = true;
      for (;;) {
        const n = u8();
        if (!n) break;
        p += n;
      }
      continue;
    }

    if (block === 0x2c) {
      u16(); // left
      u16(); // top
      const w = u16();
      const h = u16();
      u8(); // флаги
      const minCodeSize = u8();
      const data = [];
      for (;;) {
        const n = u8();
        if (!n) break;
        for (let i = 0; i < n; i++) data.push(u8());
      }
      frames.push({ width: w, height: h, delayCs: pendingDelay, indices: lzwDecode(data, minCodeSize) });
      pendingDelay = null;
      continue;
    }

    throw new Error(`неизвестный блок 0x${block.toString(16)}`);
  }

  return { signature, width, height, palette, frames, loops, trailerAt: p - 1 };
}
