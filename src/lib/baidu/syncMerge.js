/**
 * syncMerge.js — 百度网盘双向同步的三方合并纯函数
 *
 * 为什么需要它：
 * - 云端只把「最新一份自动备份」当作远端状态，单靠 local / remote 无法区分
 *   「新增」「修改」「删除」，必须借助 base（上次成功同步基线）做三方比较，
 *   才能让单侧删除安全地传播到另一侧。
 * - 合并必须发生在写库之前，且不能依赖 Svelte / IndexedDB / DOM，
 *   这样同步引擎、Node 验证脚本与未来的测试可以复用同一套确定性规则。
 *
 * 设计要点：
 * - 输入先归一化，保留未知字段以便未来扩展，但比较只依赖契约字段；
 * - base 只保存 id → updatedAt，不保存内容，避免基线体积膨胀；
 * - 两侧都改且内容不同时，较新者作为主记录，较旧者生成新 id 的冲突副本，
 *   冲突副本同样进入最终结果与新的 base；
 * - plan.putNotes 是最终全部有效笔记（含冲突副本），不是增量列表。
 */
import { ROOT_ID } from '../db/schema.js';

/** 空基线（调用方可以安全共享，normalizeBase 不会修改入参） */
export const EMPTY_BASE = { notes: {}, folders: {} };

/**
 * 把时间戳归一化为非负数值；缺失、非法或负数按 0 处理。
 * @param {*} value
 * @returns {number}
 */
function toTime(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * 生成唯一 id：优先 crypto.randomUUID，否则退回带前缀的随机串。
 * @param {string} prefix
 * @returns {string}
 */
function createId(prefix) {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 默认 makeId：冲突副本使用 n_ 前缀的随机串作为兜底 */
function defaultMakeId() {
    return createId('n');
}

/**
 * 稳定序列化：对象键排序、数组保持顺序，避免引用不同或键顺序不同导致误判。
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
    if (value === undefined) {
        return 'undefined';
    }
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }
    const keys = Object.keys(value).sort();
    return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`;
}

/**
 * 本地时间格式化为 YYYY-MM-DD HH:mm（用于冲突副本标题）。
 * @param {number} timestamp
 * @returns {string}
 */
function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours()
    )}:${pad(date.getMinutes())}`;
}

/**
 * 归一化单条笔记：保留未知字段，补齐契约字段。
 * 时间戳缺失按 0，避免归一化引入非确定性。
 * @param {Object} [note]
 * @returns {Object}
 */
export function normalizeSyncNote(note) {
    const input = note && typeof note === 'object' ? note : {};
    return {
        ...input,
        id: String(input.id ?? '') || createId('n'),
        title: String(input.title ?? '').trim() || '未命名笔记',
        content: input.content ?? '',
        folderId: String(input.folderId ?? ROOT_ID) || ROOT_ID,
        pinned: Boolean(input.pinned),
        isTemplate: Boolean(input.isTemplate),
        createdAt: toTime(input.createdAt),
        updatedAt: toTime(input.updatedAt),
        deletedAt: input.deletedAt ?? null
    };
}

/**
 * 归一化单个文件夹：保留未知字段，补齐契约字段。
 * @param {Object} [folder]
 * @returns {Object}
 */
export function normalizeSyncFolder(folder) {
    const input = folder && typeof folder === 'object' ? folder : {};
    return {
        ...input,
        id: String(input.id ?? '') || createId('f'),
        name: String(input.name ?? '').trim() || '未命名文件夹',
        parentId: String(input.parentId ?? ROOT_ID) || ROOT_ID,
        createdAt: toTime(input.createdAt),
        updatedAt: toTime(input.updatedAt)
    };
}

/**
 * 把任意 base 归一化为 { notes: {id: number}, folders: {id: number} }。
 * 同时兼容「对象映射」与「数组」两种历史形态，方便旧配置平滑升级。
 * @param {Object} [base]
 * @returns {{notes: Object<string, number>, folders: Object<string, number>}}
 */
export function normalizeBase(base) {
    const input = base && typeof base === 'object' ? base : EMPTY_BASE;
    return {
        notes: normalizeTimeMap(input.notes),
        folders: normalizeTimeMap(input.folders)
    };
}

/**
 * @param {*} source
 * @returns {Object<string, number>}
 */
function normalizeTimeMap(source) {
    const result = {};
    if (!source) {
        return result;
    }
    if (Array.isArray(source)) {
        for (const item of source) {
            const id = String(item && item.id != null ? item.id : '');
            if (!id) {
                continue;
            }
            result[id] = toTime(item.updatedAt);
        }
        return result;
    }
    if (typeof source !== 'object') {
        return result;
    }
    for (const [id, value] of Object.entries(source)) {
        if (!id) {
            continue;
        }
        if (value && typeof value === 'object') {
            result[id] = toTime(value.updatedAt);
        } else {
            result[id] = toTime(value);
        }
    }
    return result;
}

/**
 * 判断两条笔记除 updatedAt 外是否内容一致。
 * content 可能是字符串、数组或对象，统一使用稳定序列化比较。
 * @param {Object} a
 * @param {Object} b
 * @returns {boolean}
 */
export function sameNoteRecord(a, b) {
    const left = a || {};
    const right = b || {};
    if (String(left.id ?? '') !== String(right.id ?? '')) {
        return false;
    }
    if (String(left.title ?? '') !== String(right.title ?? '')) {
        return false;
    }
    if (stableStringify(left.content ?? '') !== stableStringify(right.content ?? '')) {
        return false;
    }
    const leftFolderId = String(left.folderId ?? ROOT_ID) || ROOT_ID;
    const rightFolderId = String(right.folderId ?? ROOT_ID) || ROOT_ID;
    if (leftFolderId !== rightFolderId) {
        return false;
    }
    if (Boolean(left.pinned) !== Boolean(right.pinned)) {
        return false;
    }
    if (Boolean(left.isTemplate) !== Boolean(right.isTemplate)) {
        return false;
    }
    if (toTime(left.createdAt) !== toTime(right.createdAt)) {
        return false;
    }
    return true;
}

/**
 * 按 id 建立索引；重复 id 以最后一条为准。
 * @param {Array} items
 * @param {(item: Object) => Object} normalize
 * @returns {Map<string, Object>}
 */
function indexById(items, normalize) {
    const map = new Map();
    if (!Array.isArray(items)) {
        return map;
    }
    for (const item of items) {
        const record = normalize(item);
        map.set(record.id, record);
    }
    return map;
}

/**
 * 分配一个不与现有集合冲突的新 id。
 * @param {() => string} makeId
 * @param {Set<string>} usedIds
 * @returns {string}
 */
function allocateId(makeId, usedIds) {
    let id = '';
    for (let i = 0; i < 100; i += 1) {
        const candidate = String(makeId() ?? '');
        if (candidate && !usedIds.has(candidate)) {
            id = candidate;
            break;
        }
    }
    if (!id) {
        id = createId('n');
        while (usedIds.has(id)) {
            id = createId('n');
        }
    }
    usedIds.add(id);
    return id;
}

/**
 * 由较旧记录生成冲突副本。
 * @param {Object} source 较旧记录
 * @param {number} now
 * @param {() => string} makeId
 * @param {Set<string>} usedIds
 * @returns {Object}
 */
function createConflictCopy(source, now, makeId, usedIds) {
    return {
        ...source,
        id: allocateId(makeId, usedIds),
        title: `${source.title} · 冲突副本 ${formatDateTime(now)}`,
        folderId: source.folderId,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
    };
}

/**
 * 三方合并笔记与文件夹。
 *
 * @param {{
 *   local: { notes: Array, folders: Array },
 *   remote: { notes: Array, folders: Array },
 *   base: Object,
 *   now?: number,
 *   makeId?: () => string
 * }} options
 * @returns {{
 *   notes: Array,
 *   folders: Array,
 *   base: {notes: Object<string, number>, folders: Object<string, number>},
 *   plan: {
 *     putNotes: Array,
 *     softDeleteNoteIds: string[],
 *     putFolders: Array,
 *     deleteFolderIds: string[],
 *     moveNotesToRoot: string[]
 *   },
 *   conflicts: Array<{id: string, title: string, reason: string}>,
 *   stats: {localKept: number, remoteApplied: number, conflicts: number, removed: number}
 * }}
 */
export function mergeSnapshots({ local, remote, base, now = Date.now(), makeId } = {}) {
    const localSnapshot = local && typeof local === 'object' ? local : {};
    const remoteSnapshot = remote && typeof remote === 'object' ? remote : {};
    const baseSnapshot = normalizeBase(base);
    const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const generateId = typeof makeId === 'function' ? makeId : defaultMakeId;

    const localNotes = indexById(localSnapshot.notes, normalizeSyncNote);
    const remoteNotes = indexById(remoteSnapshot.notes, normalizeSyncNote);
    const localFolders = indexById(localSnapshot.folders, normalizeSyncFolder);
    const remoteFolders = indexById(remoteSnapshot.folders, normalizeSyncFolder);

    /* ———————————— 笔记合并 ———————————— */

    const noteIds = new Set([
        ...localNotes.keys(),
        ...remoteNotes.keys(),
        ...Object.keys(baseSnapshot.notes)
    ]);
    const usedNoteIds = new Set([
        ...localNotes.keys(),
        ...remoteNotes.keys(),
        ...Object.keys(baseSnapshot.notes)
    ]);

    const notes = [];
    const finalNoteIds = new Set();
    const conflicts = [];
    let localKept = 0;
    let remoteApplied = 0;

    /**
     * 保留一条主记录并统计来源。
     * @param {Object} note
     * @param {'local'|'remote'} source
     */
    const keepNote = (note, source) => {
        notes.push(note);
        finalNoteIds.add(note.id);
        if (source === 'local') {
            localKept += 1;
        } else {
            remoteApplied += 1;
        }
    };

    for (const id of noteIds) {
        const localNote = localNotes.get(id);
        const remoteNote = remoteNotes.get(id);
        const hasBase = Object.prototype.hasOwnProperty.call(baseSnapshot.notes, id);
        const baseTime = hasBase ? baseSnapshot.notes[id] : 0;
        const localTime = localNote ? localNote.updatedAt : 0;
        const remoteTime = remoteNote ? remoteNote.updatedAt : 0;
        // 基线无 id 时：只要本地存在就算新增/变化；基线有 id 时按时间比较，
        // 本地缺失则视为本地删除（同样属于变化）。
        const localChanged = hasBase ? !localNote || localTime > baseTime : Boolean(localNote);
        const remoteChanged = hasBase ? !remoteNote || remoteTime > baseTime : Boolean(remoteNote);

        if (localNote && remoteNote) {
            if (localChanged && remoteChanged) {
                if (sameNoteRecord(localNote, remoteNote)) {
                    // 内容一致：只保留较新一条，时间相同取本地。
                    if (localTime >= remoteTime) {
                        keepNote(localNote, 'local');
                    } else {
                        keepNote(remoteNote, 'remote');
                    }
                } else {
                    // 两侧都改且内容不同：较新者为主，较旧者生成冲突副本。
                    const localIsMain = localTime >= remoteTime;
                    const mainNote = localIsMain ? localNote : remoteNote;
                    const olderNote = localIsMain ? remoteNote : localNote;
                    keepNote(mainNote, localIsMain ? 'local' : 'remote');
                    const copy = createConflictCopy(olderNote, timestamp, generateId, usedNoteIds);
                    // 冲突副本不是主记录，不计入 localKept / remoteApplied。
                    notes.push(copy);
                    finalNoteIds.add(copy.id);
                    conflicts.push({ id, title: mainNote.title, reason: 'both-modified' });
                }
            } else if (localChanged) {
                keepNote(localNote, 'local');
            } else if (remoteChanged) {
                keepNote(remoteNote, 'remote');
            } else {
                // 两侧都未变：沿用本地，保持结果稳定。
                keepNote(localNote, 'local');
            }
        } else if (localNote) {
            // 远端缺失。
            if (!hasBase) {
                // 新本地记录。
                keepNote(localNote, 'local');
            } else if (localChanged) {
                // 远端删除 vs 本地编辑：保留编辑内容，不生成副本，但计入冲突。
                keepNote(localNote, 'local');
                conflicts.push({
                    id,
                    title: localNote.title,
                    reason: 'remote-deleted-local-edited'
                });
            }
            // 否则本地未变：丢弃，远端删除向本地传播。
        } else if (remoteNote) {
            // 本地缺失。
            if (!hasBase) {
                // 新远端记录。
                keepNote(remoteNote, 'remote');
            } else if (remoteChanged) {
                // 本地删除 vs 远端编辑：采用远端编辑内容，不生成副本，但计入冲突。
                keepNote(remoteNote, 'remote');
                conflicts.push({
                    id,
                    title: remoteNote.title,
                    reason: 'local-deleted-remote-edited'
                });
            }
            // 否则远端未变：丢弃，本地删除向远端传播。
        }
        // 两侧都不存在：丢弃。
    }

    /* ———————————— 文件夹合并 ———————————— */

    const folderIds = new Set([
        ...localFolders.keys(),
        ...remoteFolders.keys(),
        ...Object.keys(baseSnapshot.folders)
    ]);

    const folders = [];
    const finalFolderIds = new Set();

    for (const id of folderIds) {
        const localFolder = localFolders.get(id);
        const remoteFolder = remoteFolders.get(id);
        const hasBase = Object.prototype.hasOwnProperty.call(baseSnapshot.folders, id);
        const baseTime = hasBase ? baseSnapshot.folders[id] : 0;
        const localChanged = hasBase
            ? !localFolder || localFolder.updatedAt > baseTime
            : Boolean(localFolder);
        const remoteChanged = hasBase
            ? !remoteFolder || remoteFolder.updatedAt > baseTime
            : Boolean(remoteFolder);

        let chosen = null;
        if (localFolder && remoteFolder) {
            if (localChanged && remoteChanged) {
                // 两侧都变：取较新，时间相同取本地。
                chosen =
                    localFolder.updatedAt >= remoteFolder.updatedAt ? localFolder : remoteFolder;
            } else if (localChanged) {
                chosen = localFolder;
            } else if (remoteChanged) {
                chosen = remoteFolder;
            } else {
                chosen = localFolder;
            }
        } else if (localFolder) {
            if (!hasBase || localChanged) {
                chosen = localFolder;
            }
        } else if (remoteFolder) {
            if (!hasBase || remoteChanged) {
                chosen = remoteFolder;
            }
        }

        if (chosen) {
            folders.push(chosen);
            finalFolderIds.add(chosen.id);
        }
    }

    /* ———————————— 引用完整性修复 ———————————— */

    // folders 已在合并时归一化为独立对象，可以安全就地修改。
    const parentOf = new Map(folders.map((folder) => [folder.id, folder.parentId]));
    for (const folder of folders) {
        if (folder.parentId === ROOT_ID) {
            continue;
        }
        const parentExists = finalFolderIds.has(folder.parentId);
        const parentIsRoot = parentExists && parentOf.get(folder.parentId) === ROOT_ID;
        // 自引用、父级不存在、父级不是根级 → 提升为根级，保证至多两级。
        if (folder.parentId === folder.id || !parentExists || !parentIsRoot) {
            folder.parentId = ROOT_ID;
        }
    }

    const moveNotesToRoot = [];
    for (const note of notes) {
        if (note.folderId !== ROOT_ID && !finalFolderIds.has(note.folderId)) {
            note.folderId = ROOT_ID;
            moveNotesToRoot.push(note.id);
        }
    }

    /* ———————————— plan 与 base ———————————— */

    const softDeleteNoteIds = [];
    for (const id of localNotes.keys()) {
        if (!finalNoteIds.has(id)) {
            softDeleteNoteIds.push(id);
        }
    }

    const deleteFolderIds = [];
    for (const id of localFolders.keys()) {
        if (!finalFolderIds.has(id)) {
            deleteFolderIds.push(id);
        }
    }

    const nextBase = { notes: {}, folders: {} };
    for (const note of notes) {
        nextBase.notes[note.id] = note.updatedAt;
    }
    for (const folder of folders) {
        nextBase.folders[folder.id] = folder.updatedAt;
    }

    return {
        notes,
        folders,
        base: nextBase,
        plan: {
            putNotes: notes,
            softDeleteNoteIds,
            putFolders: folders,
            deleteFolderIds,
            moveNotesToRoot
        },
        conflicts,
        stats: {
            localKept,
            remoteApplied,
            conflicts: conflicts.length,
            removed: softDeleteNoteIds.length
        }
    };
}
