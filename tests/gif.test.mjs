// Кодировщик GIF89a. Проверяем не «не упало», а декодируемость: файл
// разбирается сторонним декодером (tests/helpers.mjs) и пиксели сверяются
// с исходными. Иначе битый LZW прошёл бы мимо тестов и всплыл уже гифкой,
// которую не открывает просмотрщик.

import test from "node:test";
import assert from "node:assert/strict";
import { loadScript, decodeGif } from "./helpers.mjs";

const { encode } = loadScript("gif-encoder.js").XVDGifEncoder;

// Кадр RGBA: colorAt(x, y) -> [r, g, b]
function makeFrame(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

// Ожидаемые цвета кадра в порядке пикселей
function expectedColors(width, height, colorAt) {
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.push(colorAt(x, y));
  }
  return out;
}

test("файл имеет структуру GIF89a: заголовок, палитра, цикл, трейлер", () => {
  const colorAt = () => [10, 20, 30];
  const gif = decodeGif(
    encode({
      frames: [makeFrame(4, 4, colorAt), makeFrame(4, 4, colorAt), makeFrame(4, 4, colorAt)],
      width: 4,
      height: 4,
      delayCs: 8,
    })
  );

  assert.equal(gif.signature, "GIF89a");
  assert.equal(gif.width, 4);
  assert.equal(gif.height, 4);
  assert.equal(gif.palette.length, 256, "объявлена полная палитра — значит и записана полностью");
  assert.equal(gif.frames.length, 3);
  assert.ok(gif.loops, "без NETSCAPE2.0 гифка проиграется один раз");
});

test("задержка кадров доезжает до файла", () => {
  const colorAt = () => [10, 20, 30];
  const gif = decodeGif(
    encode({ frames: [makeFrame(4, 4, colorAt)], width: 4, height: 4, delayCs: 8 })
  );
  assert.equal(gif.frames[0].delayCs, 8);
});

test("два цвета переживают кодирование без потерь", () => {
  const colorAt = (x, y) => ((x + y) % 2 ? [200, 210, 220] : [10, 20, 30]);
  const gif = decodeGif(
    encode({ frames: [makeFrame(8, 8, colorAt)], width: 8, height: 8, delayCs: 8 })
  );

  const frame = gif.frames[0];
  assert.equal(frame.indices.length, 64, "распаковалось ровно width * height пикселей");

  const expected = expectedColors(8, 8, colorAt);
  const actual = frame.indices.map((i) => gif.palette[i]);
  for (let i = 0; i < expected.length; i++) {
    assert.deepEqual([...actual[i]], expected[i], `пиксель ${i}`);
  }
});

test("256 цветов на 4096 пикселях переживают рост ширины кода LZW", () => {
  // Цвета разнесены по 5-битным корзинам гистограммы, поэтому палитра обязана
  // воспроизвести их точно, а разнобой по пикселям гонит словарь LZW далеко
  // за 512 записей — то есть проверяет переключение с 9 бит на 10 и 11.
  const palette256 = (i) => [(i & 7) * 32, ((i >> 3) & 7) * 32, (i >> 6) * 64];
  const colorAt = (x, y) => palette256((x * 7 + y * 13) % 256);

  const gif = decodeGif(
    encode({ frames: [makeFrame(64, 64, colorAt)], width: 64, height: 64, delayCs: 8 })
  );

  const frame = gif.frames[0];
  assert.equal(frame.indices.length, 4096);

  const expected = expectedColors(64, 64, colorAt);
  let mismatches = 0;
  for (let i = 0; i < expected.length; i++) {
    const got = gif.palette[frame.indices[i]];
    if (got[0] !== expected[i][0] || got[1] !== expected[i][1] || got[2] !== expected[i][2]) {
      mismatches++;
    }
  }
  assert.equal(mismatches, 0, `${mismatches} пикселей разъехались`);
});

test("несколько кадров кодируются независимо", () => {
  const first = (x, y) => ((x + y) % 2 ? [255, 0, 0] : [0, 0, 255]);
  const second = (x, y) => ((x + y) % 2 ? [0, 0, 255] : [255, 0, 0]);

  const gif = decodeGif(
    encode({
      frames: [makeFrame(8, 8, first), makeFrame(8, 8, second)],
      width: 8,
      height: 8,
      delayCs: 8,
    })
  );

  assert.equal(gif.frames.length, 2);
  const colorsOf = (f) => f.indices.map((i) => gif.palette[i]);
  const a = colorsOf(gif.frames[0]);
  const b = colorsOf(gif.frames[1]);
  assert.deepEqual([...a[0]], [0, 0, 255]);
  assert.deepEqual([...b[0]], [255, 0, 0]);
});

test("кодировщик отпускает кадры по мере обработки", () => {
  // Намеренное поведение: кадр 480x270 весит около полумегабайта, и без этого
  // все они держались бы в памяти до конца кодирования. Тест стоит здесь,
  // чтобы «утечку в аргументе» никто не «починил» обратно.
  const frames = [makeFrame(4, 4, () => [10, 20, 30])];
  encode({ frames, width: 4, height: 4, delayCs: 8 });
  assert.equal(frames[0], null);
});

test("без кадров кодировщик отказывается работать", () => {
  assert.throws(() => encode({ frames: [], width: 4, height: 4 }));
});
