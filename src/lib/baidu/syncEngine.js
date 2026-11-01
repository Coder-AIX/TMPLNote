/**
 * syncEngine.js — 百度网盘双向同步引擎
 *
 * 为什么需要它：
 * - Phase 1 的自动备份只负责「本地上传」，多台设备之间仍然各存各的数据；
 * - 双向同步必须固定一条链路：列出云端最新自动备份 → 下载解密 → 三方合并 →
 *   单事务写库 → 重新上传合并结果，并把新的基线写回设置；
 * - 这条链路同时牵涉网络、加密与 IndexedDB，任何一步失败都不能污染本地数据，
 *   也不能更新「上次成功同步」的基线，因此集中在本模块处理，UI 只负责调用与展示。
 *
 * 边界：
 * - 只处理自动备份（tmplnote-auto-*.tmplenc），绝不触碰手动存档；
 * - 不依赖 Svelte / stores / DOM，便于 Node 与 Playwright 验证；
 * - 不在日志、错误或返回值中输出 token / 口令。
 */
import { db } from '../db/index.js';
import { ROOT_ID } from '../db/schema.js';
import { getDownloadLink, downloadArchive } from './client.js';
import { decryptArchive } from './archiveCrypto.js';
import { parseBackup } from '../utils/backup.js';
import { fingerprintBackupData, listAutoBackups, runAutoBackup } from './autoBackup.js';
import { mergeSnapshots, EMPTY_BASE } from './syncMerge.js';

/**
 * 安全地调用进度回调；展示层异常不得中断同步。
 *
 * @param {Function|undefined} onProgress
 * @param {{phase: string, completed: number, total: number, message?: string}} progress
 */
function emitProgress(onProgress, progress) {
    if (typeof onProgress !== 'function') return;
    try {
        onProgress(progress);
    } catch {
        // 进度回调属于展示层，失败不应影响同步结果
    }
}

/**
 * 归一化「当前时间」：缺失或非正数时回退到真实时间，避免写入 0 时间戳。
 *
 * @param {*} value
 * @returns {number}
 */
function normalizeNow(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
}

/**
 * 判断一条记录是否属于「有效笔记」（回收站中的笔记不参与合并）。
 *
 * @param {Object} note
 * @returns {boolean}
 */
function isActiveNote(note) {
    return Boolean(note) && typeof note === 'object' && !note.deletedAt;
}

/**
 * 执行一次双向同步。
 *
 * 流程：
 * 1. 读取本地全部数据并计算指纹；
 * 2. 列出云端自动备份；若与上次处理的文件一致且本地未变，直接跳过；
 * 3. 下载并解密最新自动备份，得到远端快照；
 * 4. 三方合并（local / remote / base）；
 * 5. 在单事务内应用合并计划；
 * 6. 上传合并后的新自动备份；
 * 7. 返回新的配置（含 base），由调用方持久化。
 *
 * @param {{
 *   token: string,
 *   bridgeUrl?: string,
 *   appPath: string,
 *   passphrase: string,
 *   config: Object,
 *   onProgress?: (progress: {phase: string, completed: number, total: number, message?: string}) => void,
 *   now?: number
 * }} options
 * @returns {Promise<{
 *   status: 'synced' | 'skipped',
 *   stats: {localKept: number, remoteApplied: number, conflicts: number, removed: number},
 *   conflicts: Array<{id: string, title: string, reason: string}>,
 *   nextConfig: Object,
 *   remoteName: string,
 *   applied: boolean
 * }>}
 */
export async function runAutoSync({
    token,
    bridgeUrl,
    appPath,
    passphrase,
    config,
    onProgress,
    now = Date.now()
} = {}) {
    const currentConfig = config && typeof config === 'object' ? config : {};
    const syncTime = normalizeNow(now);

    /* ———————————— 1. 读取本地 + 计算指纹 + 列出云端 ———————————— */

    emitProgress(onProgress, { phase: 'list', completed: 0, total: 1 });

    const [allNotesRaw, foldersRaw] = await Promise.all([
        db.getAll('notes'),
        db.getAll('folders')
    ]);
    // 回收站中的笔记不参与合并，但仍保留下来修复文件夹引用
    const allNotes = Array.isArray(allNotesRaw)
        ? allNotesRaw.filter((note) => note && typeof note === 'object')
        : [];
    const folders = Array.isArray(foldersRaw)
        ? foldersRaw.filter((folder) => folder && typeof folder === 'object')
        : [];
    const notes = allNotes.filter(isActiveNote);

    const localFingerprint = await fingerprintBackupData({ notes, folders });

    const archives = await listAutoBackups({ token, bridgeUrl, appPath });
    const latest = Array.isArray(archives) && archives.length > 0 ? archives[0] : null;

    emitProgress(onProgress, { phase: 'list', completed: 1, total: 1 });

    /* ———————————— 2. 跳过判断：远端未变且本地未变 ———————————— */

    const lastSyncAt = Number(currentConfig.lastSyncAt) || 0;
    if (
        latest &&
        latest.name &&
        latest.name === currentConfig.lastRemoteName &&
        localFingerprint === currentConfig.lastFingerprint &&
        lastSyncAt > 0
    ) {
        // 上一轮成功同步后没有任何变化：既没有新远端数据，也没有新的本地上传需求
        emitProgress(onProgress, {
            phase: 'done',
            completed: 1,
            total: 1,
            message: latest.name
        });
        return {
            status: 'skipped',
            stats: { localKept: 0, remoteApplied: 0, conflicts: 0, removed: 0 },
            conflicts: [],
            // 原样返回配置（浅拷贝，避免调用方误改原对象）
            nextConfig: { ...currentConfig },
            remoteName: latest.name,
            applied: false
        };
    }

    /* ———————————— 3. 下载并解密最新自动备份 ———————————— */

    let remote = { notes: [], folders: [] };
    let remoteName = '';

    if (latest) {
        remoteName = latest.name;
        emitProgress(onProgress, { phase: 'download', completed: 0, total: 1 });

        const dlink = await getDownloadLink({
            token,
            bridgeUrl,
            fsId: latest.fsId
        });
        const bytes = await downloadArchive({ token, bridgeUrl, dlink });
        const text = await decryptArchive(bytes, passphrase);
        const backup = parseBackup(text);
        const data = backup && backup.data && typeof backup.data === 'object' ? backup.data : {};

        remote = {
            notes: (Array.isArray(data.notes) ? data.notes : []).filter(isActiveNote),
            folders: Array.isArray(data.folders)
                ? data.folders.filter((folder) => folder && typeof folder === 'object')
                : []
        };

        emitProgress(onProgress, { phase: 'download', completed: 1, total: 1 });
    }

    /* ———————————— 4. 三方合并 ———————————— */

    emitProgress(onProgress, { phase: 'merge', completed: 0, total: 1 });

    // 云端自动备份被手动删除（latest 不存在）不等于「远端删除了所有笔记」：
    // 这只是远端缺失/需要重建，旧的 config.base 已不再代表真实远端状态。
    // 若仍把它当作删除基线，merge 会判定「远端缺失 = 远端删除了所有记录」，
    // 从而生成 softDeleteNoteIds，把本地全部笔记误删。
    // 因此 latest 不存在时改用空 base：本地记录都按新增处理，结果以本地数据为准，
    // 随后仍按原流程上传本地数据，并在 nextConfig.base 中重建新的同步基线。
    const base = latest ? currentConfig.base : EMPTY_BASE;

    const merge = mergeSnapshots({
        local: { notes, folders },
        remote,
        base,
        now: syncTime
    });

    emitProgress(onProgress, { phase: 'merge', completed: 1, total: 1 });

    /* ———————————— 5. 单事务应用合并计划 ———————————— */

    // 被删除文件夹的引用需要修复：活跃笔记由 merge 计算，回收站笔记单独补充
    const deleteFolderIdSet = new Set(
        (merge.plan.deleteFolderIds || []).map((id) => String(id))
    );
    const trashMoveIds = allNotes
        .filter(
            (note) =>
                note.deletedAt &&
                note.folderId &&
                deleteFolderIdSet.has(String(note.folderId))
        )
        .map((note) => String(note.id));
    const moveToRootIdSet = new Set(
        (merge.plan.moveNotesToRoot || []).map((id) => String(id))
    );

    emitProgress(onProgress, { phase: 'apply', completed: 0, total: 1 });

    await db.transaction(['notes', 'folders'], 'readwrite', async (tx) => {
        const notesStore = tx.objectStore('notes');
        const foldersStore = tx.objectStore('folders');

        try {
            // 5.1 先写入最终文件夹，再删除被合并掉的本地文件夹
            for (const folder of merge.plan.putFolders || []) {
                await foldersStore.put(folder);
            }
            for (const id of merge.plan.deleteFolderIds || []) {
                await foldersStore.delete(id);
            }

            // 5.2 远端删除传播：软删除本地笔记（进入最近删除，不物理删除）
            for (const id of merge.plan.softDeleteNoteIds || []) {
                const current = await notesStore.get(id);
                if (!current) continue;
                await notesStore.put({
                    ...current,
                    deletedAt: syncTime,
                    updatedAt: syncTime
                });
            }

            // 5.3 写入最终笔记（含冲突副本，folderId 已由合并修复）
            for (const note of merge.plan.putNotes || []) {
                await notesStore.put(note);
            }

            // 5.4 文件夹被删除后，悬空引用统一归入未分类
            for (const id of moveToRootIdSet) {
                const current = await notesStore.get(id);
                if (!current || current.folderId === ROOT_ID) continue;
                await notesStore.put({ ...current, folderId: ROOT_ID });
            }
            // 回收站笔记不参与合并，但其 folderId 也不能指向已删除文件夹
            for (const id of trashMoveIds) {
                if (moveToRootIdSet.has(id)) continue;
                const current = await notesStore.get(id);
                if (!current || current.folderId === ROOT_ID) continue;
                await notesStore.put({ ...current, folderId: ROOT_ID });
            }
        } catch (error) {
            // 任一步失败都回滚整个事务，避免半套数据落库
            try {
                tx.abort();
            } catch {
                // 事务可能已因底层错误自动中止
            }
            if (tx.done && typeof tx.done.catch === 'function') {
                tx.done.catch(() => {});
            }
            throw error;
        }
    });

    emitProgress(onProgress, { phase: 'apply', completed: 1, total: 1 });

    /* ———————————— 6. 上传合并后的新自动备份 ———————————— */

    emitProgress(onProgress, { phase: 'upload', completed: 0, total: 1 });

    const uploadResult = await runAutoBackup({
        token,
        bridgeUrl,
        appPath,
        passphrase,
        deviceId: currentConfig.deviceId,
        keepCount: currentConfig.keepCount,
        // runAutoBackup 的细分阶段统一映射到同步的 upload / prune
        onProgress: (progress) => {
            const phase = progress && progress.phase === 'prune' ? 'prune' : 'upload';
            emitProgress(onProgress, {
                phase,
                completed: Number(progress?.completed) || 0,
                total: Number(progress?.total) || 0,
                message: String(progress?.phase || '')
            });
        }
    });

    emitProgress(onProgress, { phase: 'upload', completed: 1, total: 1 });

    /* ———————————— 7. 构造 nextConfig ———————————— */
    // 只有上传成功才会走到这里；失败时直接抛出，调用方不会持久化任何基线
    const nextConfig = {
        ...currentConfig,
        lastSyncAt: syncTime,
        lastRemoteName: uploadResult.filename,
        lastBackupAt: Date.now(),
        lastBackupName: uploadResult.filename,
        lastFingerprint: uploadResult.fingerprint,
        base: merge.base,
        lastError: '',
        authExpired: false
    };

    /* ———————————— 8. 完成 ———————————— */

    emitProgress(onProgress, {
        phase: 'done',
        completed: 1,
        total: 1,
        message: uploadResult.filename
    });

    // 仅当确有远端数据写入本地时才需要刷新列表，避免无意义的 UI 重排
    const applied =
        merge.stats.remoteApplied > 0 ||
        merge.stats.removed > 0 ||
        merge.conflicts.length > 0 ||
        (merge.plan.deleteFolderIds || []).length > 0 ||
        (merge.plan.moveNotesToRoot || []).length > 0 ||
        trashMoveIds.length > 0;

    return {
        status: 'synced',
        stats: merge.stats,
        conflicts: merge.conflicts,
        nextConfig,
        remoteName,
        applied
    };
}

export default { runAutoSync };
