/**
 * importBundle.js — 「导入」编排层
 *
 * 职责：
 * - 解析本应用导出的 ZIP（含 manifest.json）或单个 md / txt / docx 文件；
 * - 将文件内容转换为笔记对象（HTML 正文），必要时回填 ZIP 内的图片；
 * - 以 merge（合并、按 id 去重）或 replace（覆盖）模式写回 IndexedDB；
 * - 写库前完成文件夹与笔记的引用完整性修复。
 *
 * 设计要点：
 * - 纯数据层编排：只依赖 db 单例与若干纯工具函数，不 import 任何 Svelte / stores。
 * - ZIP 图片回填：md/txt 导出时图片以 `assets/<base>/xxx` 相对路径引用，
 *   导入时把同目录下 `assets/` 条目编码为 dataURL，键为相对引用路径，交给
 *   markdownToHtml 在 <img src> 上回填。
 * - 单文件导入始终新建（生成新 id），不参与 merge 去重，也不触发 replace 清空。
 */
import { db } from './index.js';
import { ROOT_ID } from './schema.js';
import { readZipEntries } from '../utils/zip.js';
import { markdownToHtml } from '../utils/markdownToHtml.js';
import { textToHtml } from '../utils/textToHtml.js';
import { docxToHtml } from '../utils/docxToHtml.js';

/** manifest.json 在 ZIP 根目录的固定路径 */
const MANIFEST_PATH = 'manifest.json';

/** 导出格式标识 */
const EXPORT_FORMAT = 'tmplnote-export';

/** 生成唯一 id（优先 crypto.randomUUID，回退时间戳 + 随机串） */
function createId(prefix) {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 将任意值归一化为「id」字符串：`null` / `undefined` 视作 {@link ROOT_ID}。
 * @param {*} value 原始值。
 * @returns {string} 归一化后的字符串 id。
 */
function normalizeId(value) {
    return value === undefined || value === null ? ROOT_ID : String(value);
}

/**
 * 依据扩展名判断导入文件类型。
 * @param {File} file 待判断的文件。
 * @returns {'zip'|'markdown'|'text'|'docx'|'unknown'} 文件类型。
 */
export function fileKind(file) {
    const name = String((file && file.name) || '').toLowerCase();
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1) : '';
    if (ext === 'zip') {
        return 'zip';
    }
    if (ext === 'md' || ext === 'markdown') {
        return 'markdown';
    }
    if (ext === 'txt') {
        return 'text';
    }
    if (ext === 'docx') {
        return 'docx';
    }
    return 'unknown';
}

/**
 * 取路径的最后一段（同时兼容 `/` 与 `\` 分隔）。
 * @param {string} path 原始路径。
 * @returns {string} 文件名。
 */
function baseName(path) {
    const text = String(path || '');
    const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return slash >= 0 ? text.slice(slash + 1) : text;
}

/**
 * 取文件名（去路径）并去掉扩展名。
 * @param {string} path 原始路径。
 * @returns {string} 去扩展名的名称。
 */
function stripExtension(path) {
    const base = baseName(path);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 取路径的扩展名（小写，不含点号）。
 * @param {string} path 原始路径。
 * @returns {string} 小写扩展名；无扩展名时返回空串。
 */
function extensionOf(path) {
    const base = baseName(path);
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * 将字节解码为 UTF-8 文本，并去除可能存在的 BOM。
 * @param {Uint8Array} bytes 原始字节。
 * @returns {string} 解码后的文本。
 */
function bytesToText(bytes) {
    const text = new TextDecoder('utf-8').decode(bytes);
    return text.replace(/^\uFEFF/, '');
}

/**
 * 依据扩展名推断图片 MIME 类型。
 * @param {string} ext 扩展名（大小写不敏感，不含点号）。
 * @returns {string} 对应的 MIME 类型；未知时返回 `application/octet-stream`。
 */
function extToMime(ext) {
    switch (String(ext || '').toLowerCase()) {
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'gif':
            return 'image/gif';
        case 'webp':
            return 'image/webp';
        case 'svg':
            return 'image/svg+xml';
        case 'bmp':
            return 'image/bmp';
        default:
            return 'application/octet-stream';
    }
}

/**
 * 将字节数组编码为 base64（分块处理，避免大图触发调用栈溢出）。
 * @param {Uint8Array} bytes 原始字节。
 * @returns {string} base64 字符串。
 */
function bytesToBase64(bytes) {
    if (typeof btoa === 'function') {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const slice = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, slice);
        }
        return btoa(binary);
    }
    // Node 环境兜底
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    return '';
}

/**
 * 将字节数组转为 dataURL。
 * @param {Uint8Array} bytes 原始字节。
 * @param {string} mime MIME 类型。
 * @returns {string} 形如 `data:image/png;base64,...` 的 dataURL。
 */
function bytesToDataUrl(bytes, mime) {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/**
 * 使用 DOMParser 清洗 HTML：移除 `<script>`、所有 `on*` 属性，
 * 以及 `javascript:` 协议的 `href` / `src`。
 *
 * 与 markdownToHtml 内部清洗规则保持一致，docx 转换结果亦走一遍此流程。
 *
 * @param {string} html 待清洗的 HTML。
 * @returns {string} 清洗后的 HTML（body 的 innerHTML）；失败时原样返回。
 */
function sanitizeHtml(html) {
    const source = typeof html === 'string' ? html : '';
    try {
        const doc = new DOMParser().parseFromString(source, 'text/html');
        doc.querySelectorAll('script').forEach((node) => node.remove());
        doc.querySelectorAll('*').forEach((el) => {
            const toRemove = [];
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on')) {
                    toRemove.push(attr.name);
                    continue;
                }
                if (name === 'href' || name === 'src') {
                    const value = (attr.value || '').replace(/\s/g, '').toLowerCase();
                    if (value.startsWith('javascript:')) {
                        el.setAttribute(attr.name, '');
                    }
                }
            }
            toRemove.forEach((name) => el.removeAttribute(name));
        });
        return doc.body ? doc.body.innerHTML : '';
    } catch {
        return source;
    }
}

/**
 * 将 manifest 中的文件夹归一化为标准结构。
 * @param {Object} [input] manifest 中的文件夹条目。
 * @returns {{id:string, name:string, parentId:string, createdAt:number, updatedAt:number}}
 */
function normalizeFolder(input = {}) {
    return {
        id: String(input.id ?? ''),
        name: String(input.name ?? ''),
        parentId: normalizeId(input.parentId),
        createdAt: Number(input.createdAt) || Date.now(),
        updatedAt: Number(input.updatedAt) || Date.now()
    };
}

/**
 * 从 ZIP 条目中解析 manifest.json。
 * @param {Array<{path:string, bytes:Uint8Array}>} entries ZIP 条目列表。
 * @returns {Object} 解析后的 manifest 对象。
 * @throws {Error} 缺失或格式非法时抛出中文错误。
 */
function parseManifest(entries) {
    const manifestEntry = entries.find((entry) => entry.path === MANIFEST_PATH);
    if (!manifestEntry) {
        throw new Error('无法解析该 ZIP：缺少有效的 manifest.json。');
    }
    let manifest;
    try {
        manifest = JSON.parse(bytesToText(manifestEntry.bytes));
    } catch {
        throw new Error('无法解析该 ZIP：缺少有效的 manifest.json。');
    }
    if (!manifest || manifest.format !== EXPORT_FORMAT) {
        throw new Error('无法解析该 ZIP：缺少有效的 manifest.json。');
    }
    return manifest;
}

/**
 * 预览导入（不写库）。
 *
 * - ZIP：读取并校验 manifest，返回其中记录的文件夹与笔记条目（仅元信息）。
 * - 单文件（md / txt / docx）：返回由文件名推断的单条笔记条目。
 *
 * @param {File} file 待导入的文件。
 * @returns {Promise<{kind:string, format?:string, folders:Array, entries:Array<{path:string,title:string,folderId:string,isTemplate:boolean}>}>}
 * @throws {Error} ZIP manifest 非法或文件类型不支持时抛出中文错误。
 */
export async function inspectImport(file) {
    const kind = fileKind(file);
    if (kind === 'zip') {
        const entries = await readZipEntries(await file.arrayBuffer());
        const manifest = parseManifest(entries);
        return {
            kind: 'zip',
            format: manifest.dataFormat,
            folders: manifest.folders || [],
            entries: (manifest.notes || []).map((note) => ({
                path: note.file,
                title: note.title,
                folderId: normalizeId(note.folderId),
                isTemplate: Boolean(note.isTemplate)
            }))
        };
    }
    if (kind === 'unknown') {
        throw new Error('不支持的导入文件类型。');
    }
    return {
        kind,
        format: kind,
        folders: [],
        entries: [{
            path: file.name,
            title: stripExtension(file.name),
            folderId: ROOT_ID,
            isTemplate: false
        }]
    };
}

/**
 * 为某篇笔记构建图片映射（key 为 md 内相对引用，value 为 dataURL）。
 *
 * 扫描所有路径以 `${dirPrefix}assets/` 开头的 ZIP 条目，去掉 dirPrefix 得到
 * 相对引用键（如 `assets/Note/img-1.png`），与 markdownToHtml 的 images 约定一致。
 *
 * @param {Array<{path:string, bytes:Uint8Array}>} entries 全部 ZIP 条目。
 * @param {string} dirPrefix 笔记文件所在目录前缀（以 `/` 结尾，根目录为空串）。
 * @returns {Map<string, string>} 相对引用 → dataURL 的映射。
 */
function collectImages(entries, dirPrefix) {
    /** @type {Map<string, string>} */
    const images = new Map();
    const assetsPrefix = `${dirPrefix}assets/`;
    for (const entry of entries) {
        if (!entry.path.startsWith(assetsPrefix)) {
            continue;
        }
        const key = entry.path.slice(dirPrefix.length);
        images.set(key, bytesToDataUrl(entry.bytes, extToMime(extensionOf(key))));
    }
    return images;
}

/**
 * 将单篇 manifest 笔记转换为可写库的笔记对象。
 *
 * @param {Object} note manifest 中的笔记条目。
 * @param {Map<string, Uint8Array>} entryMap 路径 → 字节。
 * @param {Array<{path:string, bytes:Uint8Array}>} entries 全部 ZIP 条目（用于图片回填）。
 * @param {string} dataFormat manifest 声明的数据格式。
 * @returns {Promise<Object>} 归一化后的笔记对象。
 */
async function convertZipNote(note, entryMap, entries, dataFormat) {
    const filePath = String(note.file || '');
    const bytes = entryMap.get(filePath);
    if (!bytes) {
        throw new Error(`缺少笔记文件：${filePath}`);
    }

    const dirPrefix = filePath.includes('/')
        ? filePath.slice(0, filePath.lastIndexOf('/') + 1)
        : '';

    let html;
    if (dataFormat === 'markdown') {
        const images = collectImages(entries, dirPrefix);
        html = markdownToHtml(bytesToText(bytes), { images });
    } else if (dataFormat === 'text') {
        html = textToHtml(bytesToText(bytes));
    } else if (dataFormat === 'docx') {
        const result = await docxToHtml(bytes);
        html = sanitizeHtml(result.html);
    } else {
        // 未知 dataFormat：按 markdown 兜底，避免整包失败
        const images = collectImages(entries, dirPrefix);
        html = markdownToHtml(bytesToText(bytes), { images });
    }

    return {
        id: String(note.id),
        title: note.title || '未命名笔记',
        content: html,
        folderId: normalizeId(note.folderId),
        pinned: Boolean(note.pinned),
        isTemplate: Boolean(note.isTemplate),
        createdAt: Number(note.createdAt) || Date.now(),
        updatedAt: Number(note.updatedAt) || Date.now()
    };
}

/**
 * 执行导入。
 *
 * @param {File} file 待导入的 ZIP 或单文件。
 * @param {{mode?:'merge'|'replace', selectedPaths?:string[]}} [options]
 *        - `mode`：ZIP 导入模式，`merge`（默认，按 id 去重）或 `replace`（先清空）；
 *        - `selectedPaths`：仅导入 manifest 中 file 命中该列表的笔记（缺省或空数组表示全部）。
 * @returns {Promise<{notes:number, folders:number, skipped:number, errors:string[]}>}
 *          实际写入的笔记数、文件夹数、merge 跳过数与错误信息列表。
 * @throws {Error} ZIP manifest 非法或文件类型不支持时抛出中文错误。
 */
export async function importBundle(file, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const mode = opts.mode === 'replace' ? 'replace' : 'merge';
    const kind = fileKind(file);

    // ———— 单文件：始终新建，不参与去重，不触发 replace 清空 ————
    if (kind === 'markdown' || kind === 'text' || kind === 'docx') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let html;
        if (kind === 'markdown') {
            html = markdownToHtml(bytesToText(bytes));
        } else if (kind === 'text') {
            html = textToHtml(bytesToText(bytes));
        } else {
            const result = await docxToHtml(bytes);
            html = sanitizeHtml(result.html);
        }
        const now = Date.now();
        const note = {
            id: createId('n'),
            title: stripExtension(file.name) || '未命名笔记',
            content: html,
            folderId: ROOT_ID,
            pinned: false,
            isTemplate: false,
            createdAt: now,
            updatedAt: now
        };
        await db.put('notes', note);
        return { notes: 1, folders: 0, skipped: 0, errors: [] };
    }

    if (kind !== 'zip') {
        throw new Error('不支持的导入文件类型。');
    }

    // ———— ZIP 导入 ————
    const entries = await readZipEntries(await file.arrayBuffer());
    const entryMap = new Map(entries.map((entry) => [entry.path, entry.bytes]));
    const manifest = parseManifest(entries);

    const allNotes = Array.isArray(manifest.notes) ? manifest.notes : [];
    const selectedPaths = Array.isArray(opts.selectedPaths) ? opts.selectedPaths : null;
    const selectedNotes = selectedPaths && selectedPaths.length > 0
        ? allNotes.filter((note) => selectedPaths.includes(note.file))
        : allNotes;

    /** @type {string[]} */
    const errors = [];
    /** @type {Array<Object>} */
    const incomingNotes = [];
    const dataFormat = manifest.dataFormat;
    for (const note of selectedNotes) {
        try {
            incomingNotes.push(await convertZipNote(note, entryMap, entries, dataFormat));
        } catch (error) {
            const detail = error && error.message ? String(error.message) : String(error);
            errors.push(detail);
        }
    }

    const manifestFolders = (Array.isArray(manifest.folders) ? manifest.folders : [])
        .map(normalizeFolder);

    /** @type {Array<Object>} */
    let writeFolders;
    /** @type {Array<Object>} */
    let writeNotes;
    /** @type {Array<Object>} 用于引用完整性校验的完整文件夹集合 */
    let allFolders;
    let skipped = 0;

    if (mode === 'replace') {
        writeFolders = manifestFolders;
        writeNotes = incomingNotes;
        allFolders = manifestFolders;
    } else {
        const [curNotes, curFolders] = await Promise.all([
            db.getAll('notes'),
            db.getAll('folders')
        ]);
        const existingFolderIds = new Set(curFolders.map((folder) => String(folder.id)));
        const existingNoteIds = new Set(curNotes.map((note) => String(note.id)));

        writeFolders = [];
        for (const folder of manifestFolders) {
            if (existingFolderIds.has(folder.id)) {
                skipped += 1;
                continue;
            }
            existingFolderIds.add(folder.id); // 防止同批次重复 id
            writeFolders.push(folder);
        }

        writeNotes = [];
        for (const note of incomingNotes) {
            if (existingNoteIds.has(note.id)) {
                skipped += 1;
                continue;
            }
            existingNoteIds.add(note.id);
            writeNotes.push(note);
        }

        allFolders = curFolders.concat(writeFolders);
    }

    // ———— 引用完整性修复（作用于最终数据集）————
    const finalFolderIds = new Set(allFolders.map((folder) => String(folder.id)));
    const parentOf = new Map(
        allFolders.map((folder) => [String(folder.id), normalizeId(folder.parentId)])
    );

    // 文件夹：至多两级。父级缺失或父级并非根级时，提升为根级。
    for (const folder of writeFolders) {
        if (folder.parentId === ROOT_ID) {
            continue;
        }
        const parentExists = finalFolderIds.has(folder.parentId);
        const parentIsRoot = parentExists && parentOf.get(folder.parentId) === ROOT_ID;
        if (!parentExists || !parentIsRoot) {
            folder.parentId = ROOT_ID;
        }
    }

    // 笔记：folderId 悬空时归入未分类。
    for (const note of writeNotes) {
        if (note.folderId !== ROOT_ID && !finalFolderIds.has(note.folderId)) {
            note.folderId = ROOT_ID;
        }
    }

    // ———— 单事务写库 ————
    await db.transaction(['notes', 'folders'], 'readwrite', async (tx) => {
        const notesStore = tx.objectStore('notes');
        const foldersStore = tx.objectStore('folders');

        if (mode === 'replace') {
            notesStore.clear();
            foldersStore.clear();
        }

        for (const folder of writeFolders) {
            foldersStore.put(folder);
        }
        for (const note of writeNotes) {
            notesStore.put(note);
        }
    });

    return {
        notes: writeNotes.length,
        folders: writeFolders.length,
        skipped,
        errors
    };
}

export default importBundle;
