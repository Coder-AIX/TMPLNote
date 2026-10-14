/**
 * HTML → DOCX 转换工具（用于导出 Word 文件）。
 *
 * 将笔记 HTML 解析为块级结构，转换为 docx 的段落/行内文本，并把已抽取的
 * 内嵌图片以 ImageRun 形式嵌入文档，最终生成真正的 `.docx` Blob。
 *
 * 依赖说明：
 * - 使用 `docx@^9`。该库体积较大，故 **在函数内部动态 import**，避免进入首屏。
 * - 仅在浏览器环境使用，依赖 `DOMParser` / `Blob` / `Image` / `URL.createObjectURL`。
 *
 * 模块不引入任何项目内其它文件，保持独立可测。
 */

/**
 * 图片按最大宽度等比缩放时允许的最大宽度（像素）。
 * @type {number}
 */
const MAX_IMAGE_WIDTH = 480;

/**
 * 图片尺寸读取失败时的兜底宽高（像素）。
 * @type {{width:number, height:number}}
 */
const FALLBACK_IMAGE_SIZE = { width: 400, height: 300 };

/**
 * 将笔记 HTML 转换为 `.docx` 文件 Blob。
 *
 * 处理规则：
 * - `html` 非字符串时按 `''` 处理，仅生成（可选的）标题空文档。
 * - 使用 `DOMParser` 解析 HTML，按 `doc.body` 的块级子节点生成段落：
 *   `h1/h2/h3` → Heading1/2/3；`p/div` → 普通段落；
 *   `blockquote` → 斜体、左缩进段落；`ul/ol > li` → 前缀 `• ` / `1. ` 段落；
 *   其它块 → 普通段落。
 * - 行内子节点映射为 `TextRun`（及 `ImageRun`）：`strong/b` → 加粗，
 *   `em/i` → 斜体，`u` → 下划线，`s/del` → 删除线，`br` → 换行，
 *   `code` → 等宽字体，`a` → 仅保留文本。
 * - `<img>` 的 `src` 命中 `options.images[].path` 时嵌入 `ImageRun`，
 *   尺寸按原始宽高以最大宽 {@link MAX_IMAGE_WIDTH} 等比缩放。
 * - 单个块节点转换异常时 `console.warn` 并跳过，不影响整体生成。
 *
 * @param {string} html 笔记 HTML。
 * @param {{title?:string, images?:Array<{path:string, bytes:Uint8Array, ext?:string}>}} [options]
 *        可选配置：`title` 标题；`images` 为已抽取的图片（`path` 与该 HTML 中
 *        `<img src>` 一致）。
 * @returns {Promise<Blob>} `.docx` 文件 Blob。
 */
export async function htmlToDocxBlob(html, options) {
    // docx 体积较大，函数内动态导入以避免进首屏
    const docx = await import('docx');

    const opts = options || {};
    const source = typeof html === 'string' ? html : '';

    // 解析 HTML；解析失败时退化为空文档
    let doc = null;
    try {
        doc = new DOMParser().parseFromString(source, 'text/html');
    } catch (error) {
        console.warn('[htmlToDocx] HTML 解析失败，生成空文档：', error);
    }

    const body = doc && doc.body ? doc.body : null;

    // 图片索引：path → { bytes, ext }
    const imageMap = buildImageMap(opts.images);

    // 预取文档中实际用到的图片尺寸（异步统一读取）
    let sizeMap = new Map();
    if (body && imageMap.size > 0) {
        sizeMap = await prefetchImageSizes(body, imageMap);
    }

    // 转换上下文
    const ctx = {
        docx: docx,
        imageMap: imageMap,
        sizeMap: sizeMap
    };

    const children = [];

    // 可选标题段落置于文档最前
    if (typeof opts.title === 'string' && opts.title.length > 0) {
        try {
            children.push(
                new docx.Paragraph({
                    heading: docx.HeadingLevel.HEADING_1,
                    children: [new docx.TextRun({ text: opts.title, bold: true })]
                })
            );
        } catch (error) {
            console.warn('[htmlToDocx] 标题段落生成失败，已跳过：', error);
        }
    }

    // 逐块转换 body 的块级子节点
    if (body) {
        const blocks = body.childNodes;
        for (let i = 0; i < blocks.length; i++) {
            const node = blocks[i];
            try {
                const paragraphs = convertBlock(node, ctx);
                for (let j = 0; j < paragraphs.length; j++) {
                    children.push(paragraphs[j]);
                }
            } catch (error) {
                // 单节点异常不得影响整体导出
                console.warn('[htmlToDocx] 节点转换失败，已跳过：', node, error);
            }
        }
    }

    const docxDocument = new docx.Document({
        sections: [{ children: children }]
    });

    return await docx.Packer.toBlob(docxDocument);
}

export default htmlToDocxBlob;

/**
 * 将 `options.images` 构建为 `path → { bytes, ext }` 的映射。
 *
 * 非法项（缺少 `path` 或 `bytes`）直接忽略。
 *
 * @param {Array<{path:string, bytes:Uint8Array, ext?:string}>|undefined} images 图片列表。
 * @returns {Map<string, {bytes:Uint8Array, ext:string}>} 图片索引。
 */
function buildImageMap(images) {
    const map = new Map();
    if (!Array.isArray(images)) {
        return map;
    }
    for (let i = 0; i < images.length; i++) {
        const item = images[i];
        if (!item || typeof item.path !== 'string' || !item.path) {
            continue;
        }
        if (!(item.bytes instanceof Uint8Array)) {
            continue;
        }
        map.set(item.path, {
            bytes: item.bytes,
            ext: normalizeExt(item.ext, item.path)
        });
    }
    return map;
}

/**
 * 归一化图片扩展名：优先使用显式 `ext`，否则从 `path` 后缀推断。
 *
 * @param {string|undefined} ext 显式扩展名（可带点号）。
 * @param {string} path 图片路径（用于兜底推断）。
 * @returns {string} 小写、不带点号的扩展名；无法判断时为 `'png'`。
 */
function normalizeExt(ext, path) {
    let value = typeof ext === 'string' ? ext.trim().toLowerCase() : '';
    if (value.charAt(0) === '.') {
        value = value.slice(1);
    }
    if (value) {
        return value === 'jpeg' ? 'jpg' : value;
    }

    // 从路径后缀推断
    const dot = typeof path === 'string' ? path.lastIndexOf('.') : -1;
    if (dot !== -1 && dot < path.length - 1) {
        const suffix = path.slice(dot + 1).trim().toLowerCase();
        if (suffix) {
            return suffix === 'jpeg' ? 'jpg' : suffix;
        }
    }
    return 'png';
}

/**
 * 将 ext 映射为 docx ImageRun 支持的 `type`。
 *
 * docx v9 的 RegularImageOptions 仅支持 `'jpg' | 'png' | 'gif' | 'bmp'`，
 * 其它（如 webp/svg/bin）统一回退为 `'png'`。
 *
 * @param {string} ext 图片扩展名。
 * @returns {'png'|'jpg'|'gif'|'bmp'} docx 图片类型。
 */
function extToDocxType(ext) {
    switch (ext) {
        case 'jpg':
        case 'jpeg':
            return 'jpg';
        case 'gif':
            return 'gif';
        case 'bmp':
            return 'bmp';
        case 'png':
            return 'png';
        default:
            return 'png';
    }
}

/**
 * 扫描 HTML 中所有命中的 `<img>`，批量预取原始尺寸。
 *
 * 命中条件：`src` 存在于 `imageMap` 中。读取失败或无浏览器 API 时
 * 使用 {@link FALLBACK_IMAGE_SIZE} 兜底。
 *
 * @param {HTMLElement} body 文档 body。
 * @param {Map<string, {bytes:Uint8Array, ext:string}>} imageMap 图片索引。
 * @returns {Promise<Map<string, {width:number, height:number}>>} 路径 → 原始尺寸。
 */
async function prefetchImageSizes(body, imageMap) {
    const paths = new Set();
    const nodes = body.querySelectorAll ? body.querySelectorAll('img') : [];
    for (let i = 0; i < nodes.length; i++) {
        const src = nodes[i].getAttribute('src') || '';
        if (imageMap.has(src)) {
            paths.add(src);
        }
    }

    const sizeMap = new Map();
    const tasks = [];
    paths.forEach(function (path) {
        const entry = imageMap.get(path);
        tasks.push(
            readImageSize(entry.bytes, entry.ext).then(function (size) {
                sizeMap.set(path, size);
            })
        );
    });

    await Promise.all(tasks);
    return sizeMap;
}

/**
 * 读取单张图片的原始宽高。
 *
 * 通过 `Blob` + `URL.createObjectURL` 构造临时 URL，用 `Image` 读取
 * `naturalWidth/naturalHeight`，读取完成后立即 `revokeObjectURL`。
 * 缺少浏览器 API、超时或读取失败时，返回 {@link FALLBACK_IMAGE_SIZE}。
 *
 * @param {Uint8Array} bytes 图片字节。
 * @param {string} ext 图片扩展名。
 * @returns {Promise<{width:number, height:number}>} 原始尺寸。
 */
function readImageSize(bytes, ext) {
    return new Promise(function (resolve) {
        if (
            typeof Image === 'undefined' ||
            typeof Blob === 'undefined' ||
            typeof URL === 'undefined' ||
            typeof URL.createObjectURL !== 'function'
        ) {
            resolve({ width: FALLBACK_IMAGE_SIZE.width, height: FALLBACK_IMAGE_SIZE.height });
            return;
        }

        let url;
        try {
            const mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext || 'png');
            url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        } catch (error) {
            resolve({ width: FALLBACK_IMAGE_SIZE.width, height: FALLBACK_IMAGE_SIZE.height });
            return;
        }

        const img = new Image();
        let settled = false;
        const timer = setTimeout(function () {
            finish({ width: FALLBACK_IMAGE_SIZE.width, height: FALLBACK_IMAGE_SIZE.height });
        }, 3000);

        /**
         * 结束读取：只生效一次，并清理定时器与 objectURL。
         * @param {{width:number, height:number}} size 结果尺寸。
         */
        function finish(size) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            try {
                URL.revokeObjectURL(url);
            } catch (error) {
                // 忽略 revoke 异常
            }
            resolve(size);
        }

        img.onload = function () {
            const width = img.naturalWidth || img.width;
            const height = img.naturalHeight || img.height;
            if (width > 0 && height > 0) {
                finish({ width: width, height: height });
            } else {
                finish({ width: FALLBACK_IMAGE_SIZE.width, height: FALLBACK_IMAGE_SIZE.height });
            }
        };
        img.onerror = function () {
            finish({ width: FALLBACK_IMAGE_SIZE.width, height: FALLBACK_IMAGE_SIZE.height });
        };

        img.src = url;
    });
}

/**
 * 按最大宽等比缩放图片尺寸。
 *
 * 宽度不超过 {@link MAX_IMAGE_WIDTH} 时保持原始尺寸；超出则等比缩小，
 * 高度至少为 1。
 *
 * @param {{width:number, height:number}} size 原始尺寸。
 * @returns {{width:number, height:number}} 缩放后尺寸。
 */
function scaleImageSize(size) {
    const width = size && size.width > 0 ? size.width : FALLBACK_IMAGE_SIZE.width;
    const height = size && size.height > 0 ? size.height : FALLBACK_IMAGE_SIZE.height;
    if (width <= MAX_IMAGE_WIDTH) {
        return { width: Math.round(width), height: Math.round(height) };
    }
    const ratio = MAX_IMAGE_WIDTH / width;
    return {
        width: MAX_IMAGE_WIDTH,
        height: Math.max(1, Math.round(height * ratio))
    };
}

/**
 * 将一个块级节点转换为若干 docx 段落。
 *
 * @param {Node} node 块级节点。
 * @param {{docx:object, imageMap:Map, sizeMap:Map}} ctx 转换上下文。
 * @returns {Array<object>} 段落数组（可能为空）。
 */
function convertBlock(node, ctx) {
    const docx = ctx.docx;

    // 文本节点（含空白）直接忽略
    if (node.nodeType === 3) {
        const text = node.nodeValue || '';
        if (text.trim() === '') {
            return [];
        }
        return [new docx.Paragraph({ children: [new docx.TextRun({ text: text })] })];
    }

    if (node.nodeType !== 1) {
        return [];
    }

    const tag = (node.tagName || '').toLowerCase();

    // 标题
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        const level =
            tag === 'h1'
                ? docx.HeadingLevel.HEADING_1
                : tag === 'h2'
                  ? docx.HeadingLevel.HEADING_2
                  : docx.HeadingLevel.HEADING_3;
        return [new docx.Paragraph({ heading: level, children: collectInline(node, {}, ctx) })];
    }

    // 引用块：斜体 + 左缩进
    if (tag === 'blockquote') {
        return [
            new docx.Paragraph({
                indent: { left: 720 },
                children: collectInline(node, { italics: true }, ctx)
            })
        ];
    }

    // 无序 / 有序列表
    if (tag === 'ul' || tag === 'ol') {
        return convertList(node, tag === 'ol', ctx);
    }

    // 段落 / 通用块 / 其它块级元素
    return [new docx.Paragraph({ children: collectInline(node, {}, ctx) })];
}

/**
 * 转换列表节点为段落数组。
 *
 * 每个直接子 `li` 生成一个段落，前缀为 `• `（无序）或 `n. `（有序）。
 *
 * @param {HTMLElement} listNode 列表节点（`ul` / `ol`）。
 * @param {boolean} ordered 是否为有序列表。
 * @param {{docx:object, imageMap:Map, sizeMap:Map}} ctx 转换上下文。
 * @returns {Array<object>} 段落数组。
 */
function convertList(listNode, ordered, ctx) {
    const docx = ctx.docx;
    const paragraphs = [];
    const startAttr = ordered ? parseInt(listNode.getAttribute('start'), 10) : NaN;
    let index = Number.isNaN(startAttr) ? 1 : startAttr;

    const items = listNode.children ? listNode.children : [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || (item.tagName || '').toLowerCase() !== 'li') {
            continue;
        }
        try {
            const prefix = ordered ? index + '. ' : '• ';
            const children = [new docx.TextRun({ text: prefix })];
            const inline = collectInline(item, {}, ctx);
            for (let j = 0; j < inline.length; j++) {
                children.push(inline[j]);
            }
            paragraphs.push(new docx.Paragraph({ children: children }));
        } catch (error) {
            console.warn('[htmlToDocx] 列表项转换失败，已跳过：', item, error);
        }
        if (ordered) {
            index++;
        }
    }
    return paragraphs;
}

/**
 * 递归遍历行内子节点，收集 docx 行内元素（TextRun / ImageRun）。
 *
 * 格式向下继承：进入加粗/斜体等标签时，合并到 `style` 后继续递归，
 * 使嵌套文本继承父级格式。
 *
 * @param {Node} node 容器节点。
 * @param {{bold?:boolean, italics?:boolean, underline?:boolean, strike?:boolean, font?:string}} style 当前格式。
 * @param {{docx:object, imageMap:Map, sizeMap:Map}} ctx 转换上下文。
 * @returns {Array<object>} 行内元素数组。
 */
function collectInline(node, style, ctx) {
    const runs = [];
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i++) {
        const childRuns = inlineNode(children[i], style, ctx);
        for (let j = 0; j < childRuns.length; j++) {
            runs.push(childRuns[j]);
        }
    }
    return runs;
}

/**
 * 转换单个行内节点为行内元素数组。
 *
 * @param {Node} node 行内节点。
 * @param {{bold?:boolean, italics?:boolean, underline?:boolean, strike?:boolean, font?:string}} style 当前格式。
 * @param {{docx:object, imageMap:Map, sizeMap:Map}} ctx 转换上下文。
 * @returns {Array<object>} 行内元素数组（可能为空）。
 */
function inlineNode(node, style, ctx) {
    const docx = ctx.docx;

    // 文本节点
    if (node.nodeType === 3) {
        let text = node.nodeValue || '';
        if (text === '') {
            return [];
        }
        // 非等宽字体时，将含换行的空白归一化为单空格，避免缩进残留
        if (style.font !== 'monospace' && /\n/.test(text)) {
            text = text.replace(/\s*\n\s*/g, ' ');
        }
        if (text === '') {
            return [];
        }
        return [new docx.TextRun(mergeRunOptions({ text: text }, style))];
    }

    if (node.nodeType !== 1) {
        return [];
    }

    const tag = (node.tagName || '').toLowerCase();

    // 图片
    if (tag === 'img') {
        const run = buildImageRun(node, ctx);
        return run ? [run] : [];
    }

    // 换行
    if (tag === 'br') {
        return [new docx.TextRun({ break: 1 })];
    }

    // 计算子级继承的格式
    let nextStyle = style;
    if (tag === 'strong' || tag === 'b') {
        nextStyle = cloneStyle(style, { bold: true });
    } else if (tag === 'em' || tag === 'i') {
        nextStyle = cloneStyle(style, { italics: true });
    } else if (tag === 'u') {
        nextStyle = cloneStyle(style, { underline: true });
    } else if (tag === 's' || tag === 'del' || tag === 'strike') {
        nextStyle = cloneStyle(style, { strike: true });
    } else if (tag === 'code') {
        nextStyle = cloneStyle(style, { font: 'monospace' });
    }
    // a / span / 其它内联标签：仅保留文本，格式不变

    return collectInline(node, nextStyle, ctx);
}

/**
 * 依据 `<img>` 构建 docx ImageRun。
 *
 * `src` 命中 `imageMap` 时按预取尺寸（最大宽 {@link MAX_IMAGE_WIDTH} 等比缩放）
 * 生成 ImageRun；未命中或生成异常时返回 `null`。
 *
 * @param {HTMLElement} node 图片节点。
 * @param {{docx:object, imageMap:Map, sizeMap:Map}} ctx 转换上下文。
 * @returns {object|null} ImageRun 或 `null`。
 */
function buildImageRun(node, ctx) {
    const docx = ctx.docx;
    const src = node.getAttribute('src') || '';
    const entry = ctx.imageMap.get(src);
    if (!entry) {
        return null;
    }

    try {
        const size = scaleImageSize(ctx.sizeMap.get(src));
        return new docx.ImageRun({
            data: entry.bytes,
            type: extToDocxType(entry.ext),
            transformation: { width: size.width, height: size.height }
        });
    } catch (error) {
        console.warn('[htmlToDocx] 图片嵌入失败，已跳过：', src, error);
        return null;
    }
}

/**
 * 合并行内格式到 TextRun 选项。
 *
 * @param {object} base 基础选项（如 `{ text }`）。
 * @param {{bold?:boolean, italics?:boolean, underline?:boolean, strike?:boolean, font?:string}} style 格式。
 * @returns {object} 合并后的 TextRun 选项。
 */
function mergeRunOptions(base, style) {
    const options = {
        text: base.text
    };
    if (style.bold) {
        options.bold = true;
    }
    if (style.italics) {
        options.italics = true;
    }
    if (style.underline) {
        options.underline = {};
    }
    if (style.strike) {
        options.strike = true;
    }
    if (style.font) {
        options.font = style.font;
    }
    return options;
}

/**
 * 克隆行内格式并覆盖指定字段（用于嵌套标签的格式继承）。
 *
 * @param {{bold?:boolean, italics?:boolean, underline?:boolean, strike?:boolean, font?:string}} style 原格式。
 * @param {object} patch 覆盖字段。
 * @returns {object} 新格式对象。
 */
function cloneStyle(style, patch) {
    return Object.assign({}, style, patch);
}
