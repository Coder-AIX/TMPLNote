import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/icons');

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const idat = deflateSync(raw, { level: 9 });
    return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const BRAND = [255, 122, 0];

function inRoundedRect(x, y, size, radius) {
    const px = x + 0.5;
    const py = y + 0.5;
    let cx = px;
    let cy = py;
    if (px < radius) {
        cx = radius;
    } else if (px > size - radius) {
        cx = size - radius;
    }
    if (py < radius) {
        cy = radius;
    } else if (py > size - radius) {
        cy = size - radius;
    }
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius;
}

function drawIcon(size, maskable) {
    const rgba = Buffer.alloc(size * size * 4);
    const radius = size * 0.1875;

    const padding = maskable ? 0.20 : 0.16;
    const g = size * (1 - 2 * padding);
    const x0 = (size - g) / 2;
    const y0 = (size - g) / 2;

    const barLeft = x0;
    const barRight = x0 + g;
    const barTop = y0;
    const barBottom = y0 + 0.22 * g;
    const stemLeft = x0 + 0.36 * g;
    const stemRight = x0 + 0.64 * g;
    const stemBottom = y0 + g;

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const px = x + 0.5;
            const py = y + 0.5;

            const inBar = px >= barLeft && px <= barRight && py >= barTop && py <= barBottom;
            const inStem = px >= stemLeft && px <= stemRight && py >= barTop && py <= stemBottom;
            const inT = inBar || inStem;

            let r = 0;
            let gr = 0;
            let b = 0;
            let a = 0;

            if (inT) {
                r = 255;
                gr = 255;
                b = 255;
                a = 255;
            } else if (maskable || inRoundedRect(x, y, size, radius)) {
                r = BRAND[0];
                gr = BRAND[1];
                b = BRAND[2];
                a = 255;
            }

            const i = (y * size + x) * 4;
            rgba[i] = r;
            rgba[i + 1] = gr;
            rgba[i + 2] = b;
            rgba[i + 3] = a;
        }
    }

    return rgba;
}

function main() {
    mkdirSync(outDir, { recursive: true });

    const targets = [
        { file: 'icon-192.png', size: 192, maskable: false },
        { file: 'icon-512.png', size: 512, maskable: false },
        { file: 'icon-maskable-512.png', size: 512, maskable: true }
    ];

    for (const { file, size, maskable } of targets) {
        const rgba = drawIcon(size, maskable);
        const png = encodePng(size, size, rgba);
        writeFileSync(resolve(outDir, file), png);
        console.log(`${file}: ${png.length} bytes`);
    }
}

main();
