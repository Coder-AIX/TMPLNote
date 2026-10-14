/**
 * exportBundle.js — 「选择性导出」编排层
 *
 * 职责：
 * - 依据用户勾选的笔记 id 与文件夹 id，组装出一个 ZIP 压缩包。
 * - 每篇笔记按目标格式转换为 Markdown（.md）/ 纯文本（.txt）/ Word（.docx），
 *   并把 HTML 中内嵌的 data:image 图片抽取为独立文件（md/txt 走相对路径引用，
 *   docx 直接内嵌进文档、不再额外写 assets）。
 * - 在 ZIP 根写入 `manifest.json`，记录导出格式、导出时间、涉及的文件夹与笔记条目。
 *
 * 设计要点：
 * - 纯数据层编排：只依赖 db 单例与若干纯工具函数，不 import 任何 Svelte / stores。
 * - 选择集规则：
 *   · 直接选中笔记 = noteIds（无论是否为模板）；
 *   · 选中文件夹 = 连同其全部子文件夹下的「非模板」笔记一起导出；
 *   · 模板笔记仅在 noteIds 显式包含时导出，且统一落入顶层 `模板/` 目录（忽略其 folderId）。
 * - 目录结构：根/未分类 → `未分类`；根文件夹 → `name`；子文件夹 → `父/子`。
 */
import { db } from './index.js';
import { ROOT_ID } from './schema.js';
import { extractImages } from '../utils/htmlAssets.js';
import { htmlToMarkdown } from '../utils/htmlToMarkdown.js';
import { htmlToPlainText } from '../utils/htmlToText.js';
import { htmlToDocxBlob } from '../utils/htmlToDocx.js';
import { createZipBlob } from '../utils/zip.js';

/** 支持的导出格式（顺序即 UI 展示顺序，非其中之一时回退 markdown） */
export const EXPORT_FORMATS = ['markdown', 'text', 'docx'];

/** 模板笔记统一存放的顶层目录名 */
const TEMPLATE_DIR = '模板';

/** 未分类路径段（folderId === ROOT_ID 时的目录名） */
const UNCATEGORIZED_DIR = '未分类';

/** 非法 / 空路径段兜底名 */
const FALLBACK_SEGMENT = '未命名';

/**
 * 生成导出文件名：`tmplnote-export-YYYYMMDD-HHmmss.zip`（本地时间，补零）。
 *
 * @param {Date} [date=new Date()] 用于生成文件名的时间点（本地时区）。
 * @returns {string} 形如 `tmplnote-export-20260101-090000.zip` 的文件名。
 */
export function exportFilename(date = new Date()) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const yyyy = pad(d.getFullYear(), 4);
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `tmplnote-export-${yyyy}${mm}${dd}-${hh}${mi}${ss}.zip`;
}

/**
 * 将任意值归一化为「文件夹 id」字符串：`null` / `undefined` 视作 {@link ROOT_ID}。
 *
 * @param {*} value 原始值。
 * @returns {string} 归一化后的字符串 id。
 */
function normalizeFolderId(value) {
    return value === undefined || value === null ? ROOT_ID : String(value);
}

/**
 * 将输入归一化为去重的 id 字符串数组。
 *
 * 保留空串（{@link ROOT_ID} 亦为合法取值），仅丢弃 `null` / `undefined`。
 *
 * @param {*} value 任意输入（通常为字符串数组）。
 * @returns {string[]} 去重后的 id 列表。
 */
function toIdList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const set = new Set();
    for (const item of value) {
        if (item === null || item === undefined) {
            continue;
        }
        set.add(String(item));
    }
    return Array.from(set);
}

/**
 * 清理路径段：去除非法字符、控制字符、首尾空白与首尾点。
 *
 * 规则：
 * - 去除 `[\\/:*?"<>|]`；
 * - 去除控制字符 `\u0000-\u001f`；
 * - 去除首尾空白与首尾点；
 * - 结果为空则返回 {@link FALLBACK_SEGMENT}。
 *
 * @param {*} value 原始名称。
 * @returns {string} 安全的路径段。
 */
function safeSegment(value) {
    let text = value === undefined || value === null ? '' : String(value);
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '');
    text = text.replace(/^[\s.]+|[\s.]+$/g, '');
    return text || FALLBACK_SEGMENT;
}

/**
 * 计算某笔记所属的目录路径。
 *
 * - {@link ROOT_ID}（未分类）→ `未分类`；
 * - 根文件夹 → `name`；
 * - 子文件夹 → `父/子`；
 * - 文件夹缺失时回退为 `未分类`。
 *
 * @param {string} folderId 笔记的 folderId。
 * @param {Map<string, Object>} folderMap id → folder 映射。
 * @returns {string} 目录路径（已逐段 safeSegment）。
 */
function folderPath(folderId, folderMap) {
    const id = normalizeFolderId(folderId);
    if (id === ROOT_ID) {
        return UNCATEGORIZED_DIR;
    }
    const folder = folderMap.get(id);
    if (!folder) {
        return UNCATEGORIZED_DIR;
    }
    const name = safeSegment(folder.name);
    const parentId = normalizeFolderId(folder.parentId);
    if (parentId === ROOT_ID) {
        return name;
    }
    const parent = folderMap.get(parentId);
    if (!parent) {
        return name;
    }
    return safeSegment(parent.name) + '/' + name;
}

/**
 * 展开文件夹选择集：返回「选中文件夹自身 + 其全部后代文件夹」的 id 集合。
 *
 * @param {string[]} ids 选中的文件夹 id 列表。
 * @param {Array<Object>} folders 全部文件夹。
 * @returns {Set<string>} 展开后的 id 集合。
 */
function expandDescendants(ids, folders) {
    /** @type {Map<string, string[]>} parentId → 子文件夹 id 列表 */
    const childrenMap = new Map();
    for (const folder of folders) {
        const parentId = normalizeFolderId(folder.parentId);
        const list = childrenMap.get(parentId) || [];
        list.push(String(folder.id));
        childrenMap.set(parentId, list);
    }

    const result = new Set();
    const stack = ids.slice();
    while (stack.length > 0) {
        const id = stack.pop();
        if (result.has(id)) {
            continue;
        }
        result.add(id);
        const children = childrenMap.get(id);
        if (children) {
            for (const child of children) {
                stack.push(child);
            }
        }
    }
    return result;
}

/**
 * 将某文件夹自身及其全部祖先加入 `out`（用于补齐目录结构的祖先节点）。
 *
 * @param {string} folderId 起始文件夹 id。
 * @param {Map<string, Object>} folderMap id → folder 映射。
 * @param {Set<string>} out 收集结果集合。
 */
function addSelfAndAncestors(folderId, folderMap, out) {
    const seen = new Set();
    let current = normalizeFolderId(folderId);
    while (current && current !== ROOT_ID && !seen.has(current)) {
        seen.add(current);
        const folder = folderMap.get(current);
        if (!folder) {
            break;
        }
        out.add(current);
        current = normalizeFolderId(folder.parentId);
    }
}

/**
 * 创建「同一目录内基础名去重」分配器。
 *
 * 首次出现返回原基础名；同一目录内重复时依次追加 ` (2)`、` (3)`……。
 * 同一篇笔记的正文文件与 assets 目录共用同一个去重后的基础名。
 *
 * @returns {(dir: string, base: string) => string} 分配函数。
 */
function createBaseAllocator() {
    /** @type {Map<string, Set<string>>} 目录 → 已占用基础名集合 */
    const usedByDir = new Map();
    return function uniqueBase(dir, base) {
        let used = usedByDir.get(dir);
        if (!used) {
            used = new Set();
            usedByDir.set(dir, used);
        }
        let candidate = base;
        let index = 2;
        while (used.has(candidate)) {
            candidate = `${base} (${index})`;
            index += 1;
        }
        used.add(candidate);
        return candidate;
    };
}

/**
 * 构建「选择性导出」ZIP。
 *
 * @param {{noteIds?:string[], folderIds?:string[], format?:'markdown'|'text'|'docx'}} [options]
 *        可选项：
 *        - `noteIds`：直接选中的笔记 id 列表（含模板笔记）；
 *        - `folderIds`：选中的文件夹 id 列表（连同子文件夹下的非模板笔记）；
 *        - `format`：导出格式，非 {@link EXPORT_FORMATS} 之一时回退 `'markdown'`。
 * @returns {Promise<{blob:Blob, filename:string, manifest:object}>}
 *          ZIP Blob、建议文件名与清单对象。
 */
export async function buildExport(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const noteIds = toIdList(opts.noteIds);
    const folderIds = toIdList(opts.folderIds);
    const format = EXPORT_FORMATS.includes(opts.format) ? opts.format : 'markdown';

    const [allNotesRaw, allFolders] = await Promise.all([
        db.getAll('notes'),
        db.getAll('folders')
    ]);

    // 排除已软删除（回收站）的笔记，不参与导出
    const allNotes = allNotesRaw.filter((note) => note && !note.deletedAt);

    /** @type {Map<string, Object>} */
    const noteMap = new Map();
    for (const note of allNotes) {
        if (note && note.id !== undefined && note.id !== null) {
            noteMap.set(String(note.id), note);
        }
    }
    /** @type {Map<string, Object>} */
    const folderMap = new Map();
    for (const folder of allFolders) {
        if (folder && folder.id !== undefined && folder.id !== null) {
            folderMap.set(String(folder.id), folder);
        }
    }

    // ———— 选择集 ————

    /** 选中的文件夹及其全部后代 */
    const descendantFolders = expandDescendants(folderIds, allFolders);

    /** @type {Map<string, Object>} id → note（去重） */
    const selected = new Map();

    // 直接选中的笔记：不受模板规则限制
    for (const id of noteIds) {
        const note = noteMap.get(id);
        if (note) {
            selected.set(String(note.id), note);
        }
    }

    // 选中文件夹（含子文件夹）下的非模板笔记
    for (const note of allNotes) {
        if (!note || note.isTemplate) {
            continue;
        }
        const folderId = normalizeFolderId(note.folderId);
        if (descendantFolders.has(folderId)) {
            selected.set(String(note.id), note);
        }
    }

    // 稳定顺序：createdAt 升序
    const selectedNotes = Array.from(selected.values()).sort((a, b) => {
        const createdA = Number(a.createdAt) || 0;
        const createdB = Number(b.createdAt) || 0;
        return createdA - createdB;
    });

    // ———— 逐篇转换 ————

    const uniqueBase = createBaseAllocator();
    /** @type {Array<{path:string, data:Uint8Array|string}>} */
    const noteFiles = [];
    const manifestNotes = [];

    for (const note of selectedNotes) {
        const id = String(note.id);
        const isTemplate = Boolean(note.isTemplate);
        const dir = isTemplate ? TEMPLATE_DIR : folderPath(note.folderId, folderMap);
        const dirPrefix = dir ? dir + '/' : '';
        const base = uniqueBase(dir, safeSegment(note.title));
        // dir 需为「相对笔记所在目录」的路径，故不含 dirPrefix；
        // 重写后的 <img src> = assets/<base>/img-1.png，相对 md 所在目录即可正确解析。
        const assetsDir = `assets/${base}`;

        const { html, images } = extractImages(note.content, { dir: assetsDir });

        let ext;
        let data;
        if (format === 'markdown') {
            ext = 'md';
            data = htmlToMarkdown(html);
        } else if (format === 'text') {
            ext = 'txt';
            data = htmlToPlainText(html);
        } else {
            ext = 'docx';
            const docxBlob = await htmlToDocxBlob(html, { title: note.title, images });
            data = new Uint8Array(await docxBlob.arrayBuffer());
        }

        const noteFile = `${dirPrefix}${base}.${ext}`;
        noteFiles.push({ path: noteFile, data: data });

        // md/txt 需额外写出图片文件；docx 已把图片内嵌进文档
        // images[].path 是相对笔记目录的路径，写入 ZIP 时需补上目录前缀。
        if (format !== 'docx') {
            for (const image of images) {
                noteFiles.push({ path: dirPrefix + image.path, data: image.bytes });
            }
        }

        manifestNotes.push({
            id: id,
            title: typeof note.title === 'string' ? note.title : String(note.title ?? ''),
            folderId: normalizeFolderId(note.folderId),
            pinned: Boolean(note.pinned),
            isTemplate: isTemplate,
            createdAt: Number(note.createdAt) || 0,
            updatedAt: Number(note.updatedAt) || 0,
            file: noteFile,
            images: format === 'docx' ? [] : images.map((image) => dirPrefix + image.path)
        });
    }

    // ———— 涉及到的文件夹（含祖先）————
    const involvedFolderIds = new Set();
    for (const folderId of descendantFolders) {
        addSelfAndAncestors(folderId, folderMap, involvedFolderIds);
    }
    for (const note of selectedNotes) {
        if (note.isTemplate) {
            continue;
        }
        const folderId = normalizeFolderId(note.folderId);
        if (folderId !== ROOT_ID) {
            addSelfAndAncestors(folderId, folderMap, involvedFolderIds);
        }
    }

    const manifestFolders = Array.from(involvedFolderIds)
        .map((id) => folderMap.get(id))
        .filter(Boolean)
        .map((folder) => ({
            id: String(folder.id),
            name: typeof folder.name === 'string' ? folder.name : String(folder.name ?? ''),
            parentId: normalizeFolderId(folder.parentId),
            createdAt: Number(folder.createdAt) || 0,
            updatedAt: Number(folder.updatedAt) || 0
        }))
        .sort((a, b) => {
            const diff = a.createdAt - b.createdAt;
            return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));
        });

    // ———— manifest.json 与打包 ————

    const manifest = {
        app: 'TMPLNote',
        format: 'tmplnote-export',
        version: 1,
        dataFormat: format,
        exportedAt: Date.now(),
        folders: manifestFolders,
        notes: manifestNotes
    };

    const files = [
        { path: 'manifest.json', data: JSON.stringify(manifest, null, 2) }
    ].concat(noteFiles);

    const blob = createZipBlob(files);

    return { blob: blob, filename: exportFilename(), manifest: manifest };
}

export default buildExport;
