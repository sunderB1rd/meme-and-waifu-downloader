#!/usr/bin/env node
// Рисует иконки расширения из logo.svg.
//
//   node make-icons.mjs          — пишет icon-16/32/48/96/128.png в icons/
//   node make-icons.mjs куда/то  — то же, но в указанную папку
//
// Исходник иконки — SVG, растр из него производный: правится вектор, PNG
// пересобираются. Chrome иконку в SVG не принимает, только растр, поэтому
// файлы должны существовать в любом случае.
//
// Растеризатор и PNG-кодировщик здесь свои. Не из любви к велосипедам:
// зависимостей в проекте нет вовсе, а поддержать нужно ровно то, что
// встречается в нашем logo.svg — абсолютные M, L, H, V, C, Z, сплошные
// заливки и два правила заполнения. Ни обводок, ни градиентов, ни
// трансформаций, ни дуг здесь не разбирается: появятся в SVG — упрёмся
// в понятную ошибку, а не в тихо кривую картинку.

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(root, "icons");
const SIZES = [16, 32, 48, 96, 128];

// Выборок на пиксель по каждой оси. Четыре достаточно: на 16 пикселях
// разница с восемью уже не видна, а время растёт вчетверо.
const SS = 4;

// --- PNG ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  // Каждой строке предшествует байт фильтра. Ноль — «без фильтра»: сжатие
  // выйдет чуть хуже, зато кодировщик остаётся в двадцать строк.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Разбор SVG ---

const NAMED_COLORS = { black: [0, 0, 0], white: [255, 255, 255] };

function parseColor(value) {
  if (!value || value === "none") return null;
  if (NAMED_COLORS[value]) return NAMED_COLORS[value];
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`не понимаю цвет: ${value}`);
}

// Кубическая кривая режется на отрезки. Шаг выбирается по длине ломаной
// из опорных точек: у мелких скруглений хватит четырёх, у длинных дуг
// рамки нужны десятки, иначе на 128 пикселях видны грани.
function flattenCubic(points, p0, p1, p2, p3) {
  const rough =
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const steps = Math.min(64, Math.max(4, Math.ceil(rough / 2)));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

function parsePathData(d) {
  const tokens = d.match(/[A-Za-z]|[-+]?[0-9]*[.]?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || [];
  const subpaths = [];

  let points = null;
  let cursor = [0, 0];
  let start = [0, 0];
  let command = "";
  let i = 0;

  const number = () => {
    const value = Number(tokens[i++]);
    if (!Number.isFinite(value)) throw new Error(`ожидалось число в пути, а не «${tokens[i - 1]}»`);
    return value;
  };

  const open = () => {
    points = [cursor.slice()];
    subpaths.push(points);
  };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) command = tokens[i++];

    switch (command) {
      case "M":
        cursor = [number(), number()];
        start = cursor.slice();
        open();
        // Пары координат после M продолжают контур линиями — так гласит
        // спецификация, и редакторы этим пользуются.
        command = "L";
        break;
      case "L":
        cursor = [number(), number()];
        points.push(cursor.slice());
        break;
      case "H":
        cursor = [number(), cursor[1]];
        points.push(cursor.slice());
        break;
      case "V":
        cursor = [cursor[0], number()];
        points.push(cursor.slice());
        break;
      case "C": {
        const p1 = [number(), number()];
        const p2 = [number(), number()];
        const p3 = [number(), number()];
        flattenCubic(points, cursor, p1, p2, p3);
        cursor = p3;
        break;
      }
      case "Z":
        cursor = start.slice();
        points = null;
        break;
      default:
        throw new Error(`команда «${command}» в пути не поддерживается`);
    }

    if (command !== "Z" && !points) open();
  }

  return subpaths.filter((sub) => sub.length > 2);
}

function parseSvg(svg) {
  const viewBox = /viewBox="([^"]+)"/.exec(svg);
  if (!viewBox) throw new Error("у svg нет viewBox");
  const [, , width, height] = viewBox[1].trim().split(/[\s,]+/).map(Number);

  const paths = [];
  for (const tag of svg.matchAll(/<path ([^>]*)>/g)) {
    const attrs = {};
    for (const attr of tag[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];

    const color = parseColor(attrs.fill);
    if (!color || !attrs.d) continue;

    paths.push({
      color,
      evenOdd: attrs["fill-rule"] === "evenodd",
      subpaths: parsePathData(attrs.d),
    });
  }

  if (!paths.length) throw new Error("в svg не нашлось ни одного залитого пути");
  return { width, height, paths };
}

// --- Растеризация ---

// Пересечения контура с горизонталью y, слева направо. Правило «низ строки
// не считается» (y < ymax) убирает двойной счёт в точках стыка отрезков.
function crossings(path, y) {
  const out = [];
  for (const sub of path.subpaths) {
    for (let i = 0; i < sub.length; i++) {
      const [x1, y1] = sub[i];
      const [x2, y2] = sub[(i + 1) % sub.length];
      if (y1 === y2) continue;
      if (y < Math.min(y1, y2) || y >= Math.max(y1, y2)) continue;
      out.push({
        x: x1 + ((y - y1) / (y2 - y1)) * (x2 - x1),
        winding: y2 > y1 ? 1 : -1,
      });
    }
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

function fillRow(mask, path, y, cols, scale) {
  mask.fill(0);
  const cross = crossings(path, y);
  let winding = 0;

  for (let i = 0; i < cross.length - 1; i++) {
    winding += cross[i].winding;
    const inside = path.evenOdd ? i % 2 === 0 : winding !== 0;
    if (!inside) continue;

    const from = Math.max(0, Math.ceil(cross[i].x / scale - 0.5));
    const to = Math.min(cols - 1, Math.ceil(cross[i + 1].x / scale - 0.5) - 1);
    for (let sx = from; sx <= to; sx++) mask[sx] = 1;
  }
}

function render(doc, size) {
  const cols = size * SS;
  const scale = doc.width / cols;
  const scaleY = doc.height / cols;

  const rgba = Buffer.alloc(size * size * 4);
  // Копим отдельно цвет и покрытие: усреднять цвет по прозрачным выборкам
  // нельзя, иначе края потемнеют.
  const sum = new Float64Array(size * size * 4);
  const masks = doc.paths.map(() => new Uint8Array(cols));

  for (let sy = 0; sy < cols; sy++) {
    const y = (sy + 0.5) * scaleY;
    for (let p = 0; p < doc.paths.length; p++) {
      fillRow(masks[p], doc.paths[p], y, cols, scale);
    }

    const py = (sy / SS) | 0;
    for (let sx = 0; sx < cols; sx++) {
      let color = null;
      // Художник: последний путь, накрывший точку, и определяет цвет.
      for (let p = 0; p < doc.paths.length; p++) {
        if (masks[p][sx]) color = doc.paths[p].color;
      }
      if (!color) continue;

      const o = (py * size + ((sx / SS) | 0)) * 4;
      sum[o] += color[0];
      sum[o + 1] += color[1];
      sum[o + 2] += color[2];
      sum[o + 3] += 1;
    }
  }

  const perPixel = SS * SS;
  for (let i = 0; i < size * size; i++) {
    const covered = sum[i * 4 + 3];
    if (!covered) continue;
    rgba[i * 4] = Math.round(sum[i * 4] / covered);
    rgba[i * 4 + 1] = Math.round(sum[i * 4 + 1] / covered);
    rgba[i * 4 + 2] = Math.round(sum[i * 4 + 2] / covered);
    rgba[i * 4 + 3] = Math.round((covered / perPixel) * 255);
  }

  return encodePng(size, rgba);
}

const doc = parseSvg(readFileSync(join(root, "logo.svg"), "utf8"));
console.log(`logo.svg: ${doc.paths.length} путей, холст ${doc.width}x${doc.height}`);

for (const size of SIZES) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, render(doc, size));
  console.log(`  ${file}`);
}
