import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, "..", "build");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

function pngChunk(name, data) {
  const type = Buffer.from(name, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  type.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 8 + data.length);
  return output;
}

function insideRoundedRectangle(x, y, size) {
  const radius = size * 0.1875;
  if ((x >= radius && x <= size - radius) || (y >= radius && y <= size - radius)) {
    return true;
  }
  const centerX = x < radius ? radius : size - radius;
  const centerY = y < radius ? radius : size - radius;
  return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const [currentX, currentY] = points[current];
    const [previousX, previousY] = points[previous];
    const crosses =
      currentY > y !== previousY > y &&
      x <
        ((previousX - currentX) * (y - currentY)) /
          (previousY - currentY) +
          currentX;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

function renderIcon(size) {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 64;
  const letter = [
    [14, 46], [14, 18], [22, 18], [32, 34], [42, 18], [50, 18],
    [50, 46], [43, 46], [43, 29], [32, 45], [21, 29], [21, 46],
  ].map(([x, y]) => [x * scale, y * scale]);
  const background = [46, 77, 66];
  const foreground = [255, 253, 248];

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sampleY = 0; sampleY < samples; sampleY += 1) {
        for (let sampleX = 0; sampleX < samples; sampleX += 1) {
          const x = pixelX + (sampleX + 0.5) / samples;
          const y = pixelY + (sampleY + 0.5) / samples;
          if (!insideRoundedRectangle(x, y, size)) {
            continue;
          }
          const color = insidePolygon(x, y, letter) ? foreground : background;
          red += color[0];
          green += color[1];
          blue += color[2];
          alpha += 255;
        }
      }
      const index = (pixelY * size + pixelX) * 4;
      const divisor = samples * samples;
      pixels[index] = Math.round(red / divisor);
      pixels[index + 1] = Math.round(green / divisor);
      pixels[index + 2] = Math.round(blue / divisor);
      pixels[index + 3] = Math.round(alpha / divisor);
    }
  }
  return pixels;
}

function encodePng(size) {
  const pixels = renderIcon(size);
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const targetOffset = row * (size * 4 + 1);
    scanlines[targetOffset] = 0;
    pixels.copy(scanlines, targetOffset + 1, row * size * 4, (row + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;

  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([directory, ...images.map(({ png }) => png)]);
}

await mkdir(outputDirectory, { recursive: true });
const images = iconSizes.map((size) => ({ size, png: encodePng(size) }));
await writeFile(resolve(outputDirectory, "icon.png"), images.at(-1).png);
await writeFile(resolve(outputDirectory, "icon.ico"), encodeIco(images));
