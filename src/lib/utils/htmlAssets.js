/**
 * HTML 资源抽取工具（导出功能专用）。
 *
 * 编辑器将图片以 DataURL 形式内嵌进笔记 HTML（形如
 * `<img src="data:image/png;base64,...">`），并无独立的图片仓库。
 * 导出 ZIP 时需要把这些内嵌图片抽取为独立文件，并把 HTML 中的
 * `src` 重写为相对路径引用。
 *
 * 本模块仅在浏览器环境使用：依赖 `DOMParser` / `atob` /
 * `Uint8Array`，且不引入任何项目内其它文件。
 */

/**
 * 解析 data URL，返回 MIME 类型、扩展名与字节内容。
 *
 * 支持两种编码形式：
 * - `data:<mime>;base64,<data>`：使用 `atob` 解码为二进制字节。
 * - `data:<mime>;utf8,<uri-encoded>`：先 `decodeURIComponent`，
 *   再按 UTF-8 编码为字节（用于内联 SVG 等文本图片）。
 *
 * 仅当 MIME 以 `image/` 开头时才视为图片；参数非法、非图片、
 * 或解析失败时一律返回 `null`。
 *
 * @param {string} dataUrl 待解析的 data URL 字符串。
 * @returns {{mime:string, ext:string, bytes:Uint8Array}|null}
 *          解析结果；失败返回 `null`。
 */
export function dataUrlToBytes(dataUrl) {
    if (typeof dataUrl !== 'string') {
        return null;
    }

    // 必须以 data: 开头，且至少包含一个逗号分隔的数据段
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1 || !dataUrl.startsWith('data:')) {
        return null;
    }

    // 头部形如 image/png;base64 或 image/svg+xml;utf8
    const header = dataUrl.slice(5, commaIndex);
    const body = dataUrl.slice(commaIndex + 1);

    const parts = header.split(';');
    const mime = (parts[0] || '').trim().toLowerCase();

    // 仅接受图片类型
    if (!mime.startsWith('image/')) {
        return null;
    }

    // 判断是否为 base64 编码（头部的任一参数为 base64）
    const isBase64 = parts.some(function (part) {
        return part.trim().toLowerCase() === 'base64';
    });

    try {
        if (isBase64) {
            const binary = atob(body);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return { mime: mime, ext: guessExt(mime), bytes: bytes };
        }

        // 非 base64：按 utf8（URI 编码）处理，回退为原始文本
        let text;
        try {
            text = decodeURIComponent(body);
        } catch (err) {
            text = body;
        }
        const bytes = utf8ToBytes(text);
        return { mime: mime, ext: guessExt(mime), bytes: bytes };
    } catch (err) {
        // atob 抛出异常或其它解析错误
        return null;
    }
}

/**
 * 依据 MIME 类型推断图片扩展名。
 *
 * 映射表：
 * - image/png      → 'png'
 * - image/jpeg     → 'jpg'
 * - image/gif      → 'gif'
 * - image/webp     → 'webp'
 * - image/svg+xml  → 'svg'
 * - image/bmp      → 'bmp'
 * - 其它           → 'bin'
 *
 * @param {string} mime MIME 类型字符串（大小写不敏感）。
 * @returns {string} 不带点号的扩展名。
 */
export function guessExt(mime) {
    const normalized = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
    switch (normalized) {
        case 'image/png':
            return 'png';
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpg';
        case 'image/gif':
            return 'gif';
        case 'image/webp':
            return 'webp';
        case 'image/svg+xml':
            return 'svg';
        case 'image/bmp':
            return 'bmp';
        default:
            return 'bin';
    }
}

/**
 * 抽取 HTML 中所有内嵌 data:image 图片，并把 `src` 重写为相对路径。
 *
 * 处理规则：
 * - `html` 非字符串时按空字符串处理。
 * - 使用 `DOMParser` 解析 HTML，返回以 `doc.body.innerHTML` 为准。
 * - 仅处理 `src` 以 `data:` 开头且能被 {@link dataUrlToBytes} 成功解析的
 *   `<img>`；其它图片（http/https/blob 等远程或外部引用）保持不变，
 *   也不纳入结果。
 * - 每张成功抽取的图片按 `prefix-n.ext` 命名（`n` 从 `startIndex` 起自增），
 *   并把 `src` 设为 `dir` 前缀下的相对路径。
 *
 * @param {string} html 待处理的 HTML 字符串。
 * @param {{dir?:string, prefix?:string, startIndex?:number}} [options]
 *        可选配置：
 *        - `dir` 图片相对目录，默认 `''`（与 HTML 同级）。
 *        - `prefix` 文件名前缀，默认 `'img'`。
 *        - `startIndex` 起始编号，默认 `1`。
 * @returns {{html:string, images:Array<{name:string, path:string, mime:string, ext:string, bytes:Uint8Array}>}}
 *          重写后的 HTML 与抽取出的图片列表。
 */
export function extractImages(html, options) {
    const opts = options || {};
    const dir = typeof opts.dir === 'string' ? opts.dir : '';
    const prefix = typeof opts.prefix === 'string' && opts.prefix ? opts.prefix : 'img';
    const startIndex = Number.isInteger(opts.startIndex) ? opts.startIndex : 1;

    const source = typeof html === 'string' ? html : '';
    const doc = new DOMParser().parseFromString(source, 'text/html');

    const images = [];
    let n = startIndex;

    const nodes = doc.body ? doc.body.querySelectorAll('img') : [];
    for (let i = 0; i < nodes.length; i++) {
        const img = nodes[i];
        const src = img.getAttribute('src') || '';

        // 仅处理内嵌 data URL，远程/外部引用保持不变
        if (!src.startsWith('data:')) {
            continue;
        }

        const decoded = dataUrlToBytes(src);
        if (!decoded) {
            continue;
        }

        const ext = guessExt(decoded.mime);
        const name = prefix + '-' + n + '.' + ext;
        const path = dir ? dir + '/' + name : name;

        img.setAttribute('src', path);
        images.push({
            name: name,
            path: path,
            mime: decoded.mime,
            ext: ext,
            bytes: decoded.bytes
        });

        n++;
    }

    const resultHtml = doc.body ? doc.body.innerHTML : '';
    return { html: resultHtml, images: images };
}

/**
 * 将字符串按 UTF-8 编码为字节数组（内部工具，不导出）。
 *
 * 优先使用浏览器内置 `TextEncoder`；在缺失时回退为手工编码实现。
 *
 * @param {string} text 待编码文本。
 * @returns {Uint8Array} UTF-8 字节。
 */
function utf8ToBytes(text) {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(text);
    }

    const bytes = [];
    for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i);

        // 代理对：合并高位与低位
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
                i++;
            }
        }

        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            bytes.push(
                0xe0 | (code >> 12),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f)
            );
        } else {
            bytes.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f)
            );
        }
    }
    return new Uint8Array(bytes);
}
