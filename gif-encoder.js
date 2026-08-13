// Кодировщик GIF89a без зависимостей.
// Живёт в изолированном мире расширения рядом с content.js и отдаётся через globalThis.
//
// Почему свой, а не библиотека: готовые (gif.js и подобные) запускают кодирование
// в веб-воркере, а воркер из файла расширения браузеры создавать не дают —
// пришлось бы городить обход через blob. Для роликов на пару секунд
// однопоточного кодирования достаточно.

(function () {
  "use strict";

  // --- Палитра: median cut по гистограмме с точностью 5 бит на канал ---

  function buildHistogram(frames) {
    const hist = new Map();
    for (const data of frames) {
      // Шаг по пикселям: для палитры достаточно выборки, полный проход избыточен
      const step = data.length > 4 * 200000 ? 16 : 4;
      for (let i = 0; i < data.length; i += step) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const bin = hist.get(key);
        if (bin) {
          bin.count++;
          bin.r += r;
          bin.g += g;
          bin.b += b;
        } else {
          hist.set(key, { count: 1, r, g, b });
        }
      }
    }
    return Array.from(hist.values());
  }

  function boxBounds(bins) {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const bin of bins) {
      const r = bin.r / bin.count;
      const g = bin.g / bin.count;
      const b = bin.b / bin.count;
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
    return { rMin, rMax, gMin, gMax, bMin, bMax };
  }

  function medianCut(bins, maxColors) {
    if (!bins.length) return [[0, 0, 0]];

    let boxes = [bins];

    while (boxes.length < maxColors) {
      // Делим коробку с наибольшим разбросом — так палитра тратится там,
      // где цвета действительно различаются
      let target = -1;
      let bestSpread = 0;
      let bestChannel = "r";

      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        const b = boxBounds(boxes[i]);
        const spreads = [
          [b.rMax - b.rMin, "r"],
          [b.gMax - b.gMin, "g"],
          [b.bMax - b.bMin, "b"],
        ];
        spreads.sort((x, y) => y[0] - x[0]);
        if (spreads[0][0] > bestSpread) {
          bestSpread = spreads[0][0];
          target = i;
          bestChannel = spreads[0][1];
        }
      }

      if (target === -1 || bestSpread === 0) break;

      const box = boxes[target];
      box.sort((x, y) => x[bestChannel] / x.count - y[bestChannel] / y.count);

      // Режем по медиане веса, а не по середине списка: редкие цвета
      // не должны забирать себе половину коробки
      const total = box.reduce((s, bin) => s + bin.count, 0);
      let acc = 0;
      let cut = 1;
      for (let i = 0; i < box.length - 1; i++) {
        acc += box[i].count;
        if (acc >= total / 2) {
          cut = i + 1;
          break;
        }
      }

      boxes.splice(target, 1, box.slice(0, cut), box.slice(cut));
    }

    return boxes.map((box) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const bin of box) {
        r += bin.r;
        g += bin.g;
        b += bin.b;
        n += bin.count;
      }
      return n
        ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
        : [0, 0, 0];
    });
  }

  function makeMapper(palette) {
    const cache = new Map();
    return function nearest(r, g, b) {
      const key = (r << 16) | (g << 8) | b;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;

      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i];
        const dr = r - p[0];
        const dg = g - p[1];
        const db = b - p[2];
        // Веса под восприятие: глаз чувствительнее к зелёному
        const dist = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
          if (dist === 0) break;
        }
      }
      cache.set(key, best);
      return best;
    };
  }

  // --- LZW ---

  function lzwEncode(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let dict = new Map();

    const out = [];
    let bitBuffer = 0;
    let bitCount = 0;

    function emit(code) {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        out.push(bitBuffer & 0xff);
        bitBuffer >>= 8;
        bitCount -= 8;
      }
    }

    function resetDict() {
      dict = new Map();
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    }

    emit(clearCode);
    resetDict();

    let prefix = indices[0];

    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = prefix * 4096 + k;
      const found = dict.get(key);

      if (found !== undefined) {
        prefix = found;
        continue;
      }

      emit(prefix);
      dict.set(key, nextCode);
      nextCode++;

      if (nextCode > 4095) {
        emit(clearCode);
        resetDict();
      } else if (nextCode > 1 << codeSize) {
        codeSize++;
      }

      prefix = k;
    }

    emit(prefix);
    emit(eoiCode);

    if (bitCount > 0) out.push(bitBuffer & 0xff);

    return out;
  }

  // --- Сборка файла ---

  function writeString(bytes, str) {
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i));
  }

  function writeShort(bytes, value) {
    bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  function writeBlocks(bytes, data) {
    // Данные изображения идут блоками не длиннее 255 байт
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length);
      for (const b of chunk) bytes.push(b);
    }
    bytes.push(0);
  }

  /**
   * frames    — массив Uint8ClampedArray с пикселями RGBA
   * width/height — размеры кадра
   * delayCs   — задержка между кадрами в сотых долях секунды
   * onProgress — колбэк (0..1), вызывается по мере кодирования
   */
  function encode({ frames, width, height, delayCs = 8, loop = true, onProgress }) {
    if (!frames.length) throw new Error("нет кадров");

    const palette = medianCut(buildHistogram(frames), 256);
    const mapper = makeMapper(palette);

    const bytes = [];

    writeString(bytes, "GIF89a");
    writeShort(bytes, width);
    writeShort(bytes, height);
    bytes.push(0xf7); // глобальная палитра, 256 цветов
    bytes.push(0); // индекс фона
    bytes.push(0); // соотношение сторон пикселя

    for (let i = 0; i < 256; i++) {
      const c = palette[i] || [0, 0, 0];
      bytes.push(c[0], c[1], c[2]);
    }

    if (loop) {
      // NETSCAPE2.0 — расширение, которым задаётся бесконечный повтор
      bytes.push(0x21, 0xff, 11);
      writeString(bytes, "NETSCAPE2.0");
      bytes.push(3, 1);
      writeShort(bytes, 0);
      bytes.push(0);
    }

    const pixelCount = width * height;

    for (let f = 0; f < frames.length; f++) {
      const data = frames[f];
      const indices = new Uint8Array(pixelCount);
      for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
        indices[p] = mapper(data[i], data[i + 1], data[i + 2]);
      }

      // Graphic Control Extension: задержка и способ смены кадра
      bytes.push(0x21, 0xf9, 4, 0x04);
      writeShort(bytes, delayCs);
      bytes.push(0, 0);

      // Image Descriptor
      bytes.push(0x2c);
      writeShort(bytes, 0);
      writeShort(bytes, 0);
      writeShort(bytes, width);
      writeShort(bytes, height);
      bytes.push(0);

      bytes.push(8); // минимальный размер кода LZW
      writeBlocks(bytes, lzwEncode(indices, 8));

      if (onProgress) onProgress((f + 1) / frames.length);
    }

    bytes.push(0x3b); // конец файла

    return new Uint8Array(bytes);
  }

  globalThis.XVDGifEncoder = { encode };
})();
