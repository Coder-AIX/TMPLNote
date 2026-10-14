/**
 * backup.js — 「导入导出（备份/恢复）」数据层仓储
 *
 * 职责：
 * - 导出：把 notes / folders / 外观设置打包为标准备份对象（交给 utils/backup.js 构造）。
 * - 导入：把已解析的备份对象写回 IndexedDB，支持 merge（合并）与 replace（覆盖）两种模式，
 *   并在写库前于内存完成归一化与引用完整性修复。
 *
 * 设计要点：
 * - 纯数据层：只依赖 db 单例与各领域仓储，不 import 任何 Svelte / stores。
 * - 导入的归一化「保留原时间戳」，与「新建」时刷新 updatedAt 的行为不同。
 * - 安全边界：设置导入仅覆盖外观三键（language / followSystem / dark），
 *   不改动访问锁、密码哈希等其它设置。
 */
import { db } from './index.js';
import { DB_VERSION, ROOT_ID } from './schema.js';
import settingsRepository from './settings.js';
import { buildBackup, sanitizeSettings } from '../utils/backup.js';

/** 生成唯一 id（优先 crypto.randomUUID） */
function createId(prefix) {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 导入专用：归一化文件夹对象（保留原时间戳）。
 * @param {Object} [input]
 * @returns {{id: string, name: string, parentId: string, createdAt: number, updatedAt: number}}
 */
function normalizeFolder(input = {}) {
    const id = String(input.id || '') || createId('f');
    return {
        id,
        name: String(input.name ?? '').trim() || '未命名文件夹',
        parentId: String(input.parentId ?? ROOT_ID) || ROOT_ID,
        createdAt: Number(input.createdAt) || Date.now(),
        updatedAt: Number(input.updatedAt) || Date.now()
    };
}

/**
 * 导入专用：归一化笔记对象（保留原时间戳）。
 * @param {Object} [input]
 * @returns {{id: string, title: string, content: any, folderId: string, pinned: boolean, isTemplate: boolean, createdAt: number, updatedAt: number}}
 */
function normalizeNote(input = {}) {
    const id = String(input.id || '') || createId('n');
    return {
        id,
        title: String(input.title ?? '').trim() || '未命名笔记',
        content: input.content ?? '',
        folderId: String(input.folderId ?? ROOT_ID) || ROOT_ID,
        pinned: Boolean(input.pinned),
        isTemplate: Boolean(input.isTemplate),
        createdAt: Number(input.createdAt) || Date.now(),
        updatedAt: Number(input.updatedAt) || Date.now()
    };
}

/**
 * 导出全部数据为备份对象。
 * @returns {Promise<Object>} 由 utils/backup.js#buildBackup 构造的备份对象。
 */
async function exportAll() {
    const [notes, folders, settings] = await Promise.all([
        db.getAll('notes'),
        db.getAll('folders'),
        settingsRepository.all()
    ]);
    // 排除已软删除（回收站）的笔记
    const activeNotes = notes.filter((note) => note && !note.deletedAt);
    return buildBackup({ notes: activeNotes, folders, settings, dbVersion: DB_VERSION });
}

/**
 * 导入备份数据。
 *
 * @param {Object} backup 已解析的备份对象（形如 parseBackup 的返回，含 data.notes/data.folders/data.settings）。
 * @param {Object} [options]
 * @param {'merge'|'replace'} [options.mode='merge'] merge=保留现有并跳过同 id；replace=以备份覆盖。
 * @returns {Promise<{notes: number, folders: number, settings: number, skipped: number}>}
 *          实际写入的笔记数、文件夹数、设置键数，以及 merge 模式下被跳过的（笔记+文件夹）总数。
 */
async function importAll(backup, { mode = 'merge' } = {}) {
    const data = (backup && backup.data) || {};
    const inFolders = (data.folders || []).map(normalizeFolder);
    const inNotes = (data.notes || []).map(normalizeNote);

    let finalFolders;
    let finalNotes;
    /** merge 模式下实际需要写库（非冲突）的项 */
    let writeFolders;
    let writeNotes;
    let skipped = 0;

    if (mode === 'replace') {
        finalFolders = inFolders;
        finalNotes = inNotes;
        writeFolders = finalFolders;
        writeNotes = finalNotes;
    } else {
        // merge：读取现有数据，同 id 的备份项跳过，其余并入最终集合并待写入
        const [curNotes, curFolders] = await Promise.all([
            db.getAll('notes'),
            db.getAll('folders')
        ]);
        const existingNoteIds = new Set(curNotes.map((n) => String(n.id)));
        const existingFolderIds = new Set(curFolders.map((f) => String(f.id)));

        writeFolders = [];
        writeNotes = [];

        for (const folder of inFolders) {
            if (existingFolderIds.has(folder.id)) {
                skipped += 1;
                continue;
            }
            existingFolderIds.add(folder.id); // 防止同批次重复 id
            writeFolders.push(folder);
        }
        for (const note of inNotes) {
            if (existingNoteIds.has(note.id)) {
                skipped += 1;
                continue;
            }
            existingNoteIds.add(note.id);
            writeNotes.push(note);
        }

        finalFolders = curFolders.concat(writeFolders);
        finalNotes = curNotes.concat(writeNotes);
    }

    // ———— 引用完整性修复（作用于最终集合）————

    // 文件夹：至多两级。父级缺失或父级并非根级时，提升为根级。
    const finalFolderIds = new Set(finalFolders.map((f) => f.id));
    const parentOf = new Map(finalFolders.map((f) => [f.id, f.parentId]));
    for (const folder of finalFolders) {
        if (folder.parentId === ROOT_ID) continue;
        const parentExists = finalFolderIds.has(folder.parentId);
        const parentIsRoot = parentExists && parentOf.get(folder.parentId) === ROOT_ID;
        if (!parentExists || !parentIsRoot) {
            folder.parentId = ROOT_ID;
        }
    }

    // 笔记：folderId 悬空时归入未分类。
    for (const note of finalNotes) {
        if (note.folderId !== ROOT_ID && !finalFolderIds.has(note.folderId)) {
            note.folderId = ROOT_ID;
        }
    }

    // ———— 单事务写库 ————
    const safeSettings = sanitizeSettings(data.settings);
    const settingKeys = Object.keys(safeSettings);
    let settingsCount = 0;

    await db.transaction(['notes', 'folders', 'settings'], 'readwrite', async (tx) => {
        const notesStore = tx.objectStore('notes');
        const foldersStore = tx.objectStore('folders');
        const settingsStore = tx.objectStore('settings');

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

        // 设置仅覆盖外观三键，保留安全凭据等其它设置不变。
        for (const key of settingKeys) {
            settingsStore.put({ key, value: safeSettings[key], updatedAt: Date.now() });
            settingsCount += 1;
        }
    });

    return {
        notes: writeNotes.length,
        folders: writeFolders.length,
        settings: settingsCount,
        skipped
    };
}

export const backupRepository = { exportAll, importAll };

export default backupRepository;
