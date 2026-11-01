/**
 * autoBackup.js — 百度网盘自动加密备份的纯工具与云端操作
 *
 * 为什么单独成模块：
 * - 自动备份需要「导出 → 指纹 → 加密 → 上传 → 清理 → 下载」的固定流程；
 * - 流程中涉及文件名、指纹、保留策略等可独立测试的纯逻辑；
 * - 本模块不依赖 Svelte / stores / UI，方便被调度器与测试复用。
 *
 * 安全约束：
 * - 复用 archiveCrypto 的口令加密，不在本模块保存口令；
 * - 任何错误 / 日志都不得包含 token 或口令；
 * - 上传、下载、删除全部复用 client.js 的现有实现，避免重复分片逻辑。
 */
import {
    uploadArchive,
    listArchives,
    getDownloadLink,
    downloadArchive,
    deleteArchive
} from './client.js';
import { encryptArchive, decryptArchive, ARCHIVE_EXTENSION } from './archiveCrypto.js';
import { backupRepository } from '../db/backup.js';
import { stringifyBackup, parseBackup } from '../utils/backup.js';

/** 自动备份文件名前缀 */
export const AUTO_ARCHIVE_PREFIX = 'tmplnote-auto-';

/** 默认保留份数 */
const DEFAULT_KEEP_COUNT = 7;

/** 保留份数下限 */
const MIN_KEEP_COUNT = 1;

/** 保留份数上限 */
const MAX_KEEP_COUNT = 100;

/** 指纹字符串的格式版本，后续若调整字段可用于区分 */
const FINGERPRINT_VERSION = 'tmplnote-fingerprint-v1';

/**
 * 是否为自动备份文件名。
 * 只认本模块生成的前缀，避免把手动存档纳入自动清理范围。
 *
 * @param {string} name 云端文件名。
 * @returns {boolean}
 */
export function isAutoArchiveName(name) {
    const text = String(name || '').trim().toLowerCase();
    return text.startsWith(AUTO_ARCHIVE_PREFIX) && text.endsWith(ARCHIVE_EXTENSION);
}

/**
 * 生成 4 位小写十六进制随机串。
 * 优先使用 WebCrypto；极端环境下降级为 Math.random（仅用于避免同名，不承担安全用途）。
 *
 * @returns {string}
 */
function randomHex4() {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') {
        const bytes = new Uint8Array(2);
        c.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(16).slice(2, 6).padEnd(4, '0');
}

/**
 * 生成自动备份文件名。
 * 格式：tmplnote-auto-YYYYMMDD-HHmmss-<deviceId 前 8 位>-<4 位随机小写十六进制>.tmplenc
 *
 * @param {string} deviceId 设备标识；为空时使用 'local'。
 * @param {Date} [date=new Date()] 用于生成时间部分。
 * @returns {string}
 */
export function autoBackupFilename(deviceId, date = new Date()) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const yyyy = pad(d.getFullYear(), 4);
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const ss = pad(d.getSeconds());

    // 只保留字母数字，避免设备标识中的特殊字符污染文件名
    const rawDevice = String(deviceId || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const devicePart = rawDevice ? rawDevice.slice(0, 8) : 'local';

    return `${AUTO_ARCHIVE_PREFIX}${yyyy}${mm}${dd}-${hh}${mi}${ss}-${devicePart}-${randomHex4()}${ARCHIVE_EXTENSION}`;
}

/**
 * 取出本环境可用的 WebCrypto。
 *
 * @returns {Crypto}
 * @throws {Error} 环境不支持时抛出可操作的中文错误。
 */
function getSubtleCrypto() {
    const c = globalThis.crypto;
    if (!c || !c.subtle || typeof c.subtle.digest !== 'function') {
        throw new Error(
            '当前环境不支持 WebCrypto，无法计算数据指纹。请使用 HTTPS 或 localhost 访问。'
        );
    }
    return c;
}

/**
 * 将 ArrayBuffer 转为小写十六进制字符串。
 *
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function toHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let output = '';
    for (const byte of bytes) {
        output += byte.toString(16).padStart(2, '0');
    }
    return output;
}

/**
 * 把笔记归一化为固定顺序的稳定数组，避免对象键顺序影响指纹。
 *
 * @param {Object} note
 * @returns {Array<string|number>}
 */
function stableNoteEntry(note) {
    return [
        String(note?.id ?? ''),
        Number(note?.updatedAt) || 0,
        String(note?.folderId ?? ''),
        note?.pinned ? 1 : 0,
        note?.isTemplate ? 1 : 0,
        Number(note?.deletedAt) || 0
    ];
}

/**
 * 把文件夹归一化为固定顺序的稳定数组。
 *
 * @param {Object} folder
 * @returns {Array<string|number>}
 */
function stableFolderEntry(folder) {
    return [
        String(folder?.id ?? ''),
        Number(folder?.updatedAt) || 0,
        String(folder?.parentId ?? '')
    ];
}

/** 按字符串 id 升序排序的稳定比较器（条目第 0 位是 id） */
function compareById(a, b) {
    const left = String(a[0]);
    const right = String(b[0]);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/**
 * 根据备份数据计算指纹（SHA-256 小写十六进制）。
 * 只纳入稳定字段并按 id 排序，避免数组顺序变化导致误判。
 *
 * @param {{notes?: Array, folders?: Array}} data 备份数据（或含 data 字段的备份对象）。
 * @returns {Promise<string>}
 */
export async function fingerprintBackupData(data) {
    const crypto = getSubtleCrypto();

    // 兼容直接传 backup.data 或完整备份对象两种形式
    const payload =
        data && !Array.isArray(data.notes) && !Array.isArray(data.folders) && data.data
            ? data.data
            : data || {};
    const notes = Array.isArray(payload.notes) ? payload.notes : [];
    const folders = Array.isArray(payload.folders) ? payload.folders : [];

    const noteEntries = notes.map(stableNoteEntry).sort(compareById);
    const folderEntries = folders.map(stableFolderEntry).sort(compareById);

    const stableText = JSON.stringify({
        version: FINGERPRINT_VERSION,
        notes: noteEntries,
        folders: folderEntries
    });

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableText));
    return toHex(digest);
}

/**
 * 读取本地数据并计算指纹。
 *
 * @returns {Promise<string>}
 */
export async function computeLocalFingerprint() {
    const backup = await backupRepository.exportAll();
    return fingerprintBackupData(backup);
}

/**
 * 规范化保留份数：非法值回退 7，其余夹取到 1–100。
 *
 * @param {number} value
 * @returns {number}
 */
function normalizeKeepCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_KEEP_COUNT;
    const integer = Math.trunc(numeric);
    if (integer < MIN_KEEP_COUNT) return MIN_KEEP_COUNT;
    if (integer > MAX_KEEP_COUNT) return MAX_KEEP_COUNT;
    return integer;
}

/**
 * 安全地调用进度回调，回调异常不影响主流程。
 *
 * @param {Function|undefined} onProgress
 * @param {Object} progress
 */
function emitProgress(onProgress, progress) {
    if (typeof onProgress !== 'function') return;
    try {
        onProgress(progress);
    } catch {
        // 进度回调属于展示层，失败不应中断备份
    }
}

/**
 * 执行一次自动备份：
 * 1. exportAll → 计算指纹 → stringifyBackup → encryptArchive；
 * 2. uploadArchive 上传为自动备份文件名；
 * 3. 上传成功后按 keepCount 清理旧自动备份；
 * 4. 返回实际文件名、大小与指纹。
 *
 * @param {{
 *   token: string,
 *   bridgeUrl?: string,
 *   appPath: string,
 *   passphrase: string,
 *   deviceId: string,
 *   keepCount: number,
 *   onProgress?: (progress: {phase: string, completed: number, total: number, message?: string}) => void
 * }} options
 * @returns {Promise<{filename: string, size: number, fingerprint: string, pruned: number}>}
 */
export async function runAutoBackup({
    token,
    bridgeUrl,
    appPath,
    passphrase,
    deviceId,
    keepCount,
    onProgress
}) {
    const safeKeepCount = normalizeKeepCount(keepCount);
    const filename = autoBackupFilename(deviceId);

    // 1. 导出本地数据并计算指纹（先算指纹，便于自动调度判断是否需要上传）
    emitProgress(onProgress, { phase: 'fingerprint', completed: 0, total: 1 });
    const backup = await backupRepository.exportAll();
    const fingerprint = await fingerprintBackupData(backup);
    emitProgress(onProgress, { phase: 'fingerprint', completed: 1, total: 1 });

    // 2. 序列化并加密
    emitProgress(onProgress, { phase: 'encrypt', completed: 0, total: 1 });
    const text = stringifyBackup(backup);
    const encrypted = await encryptArchive(text, passphrase);
    const blob = new Blob([encrypted], { type: 'application/octet-stream' });
    emitProgress(onProgress, { phase: 'encrypt', completed: 1, total: 1 });

    // 3. 上传（透传 client 内部的分片进度，统一归入 upload 阶段）
    await uploadArchive({
        token,
        bridgeUrl,
        appPath,
        filename,
        blob,
        onProgress: (progress) => {
            emitProgress(onProgress, {
                phase: 'upload',
                completed: Number(progress?.completed) || 0,
                total: Number(progress?.total) || 0,
                message: String(progress?.phase || '')
            });
        }
    });

    // 4. 上传成功后再清理；清理失败不能让本次备份失败
    emitProgress(onProgress, { phase: 'prune', completed: 0, total: 1 });
    let pruned = 0;
    try {
        const result = await pruneAutoBackups({
            token,
            bridgeUrl,
            appPath,
            keepCount: safeKeepCount,
            // 刚上传的文件即使超出数量也必须保留
            protectedName: filename
        });
        pruned = result.deleted;
    } catch {
        // 清理属于维护动作；列表失败或网络抖动都不应回滚已成功的备份
        pruned = 0;
    }
    emitProgress(onProgress, { phase: 'prune', completed: 1, total: 1 });

    emitProgress(onProgress, {
        phase: 'done',
        completed: 1,
        total: 1,
        message: filename
    });

    return {
        filename,
        size: blob.size,
        fingerprint,
        pruned
    };
}

/**
 * 列出云端自动备份（仅本模块前缀的 .tmplenc，按 mtime 倒序）。
 *
 * @param {{token: string, bridgeUrl?: string, appPath: string}} options
 * @returns {Promise<Array<{fsId: string, path: string, name: string, size: number, mtime: number}>>}
 */
export async function listAutoBackups({ token, bridgeUrl, appPath }) {
    const archives = await listArchives({ token, bridgeUrl, appPath });
    return archives
        .filter((archive) => {
            const name =
                archive?.name ||
                String(archive?.path || '')
                    .split('/')
                    .pop() ||
                '';
            return isAutoArchiveName(name);
        })
        .map((archive) => ({
            fsId: String(archive.fsId ?? ''),
            path: String(archive.path || ''),
            name: String(
                archive.name ||
                    String(archive.path || '')
                        .split('/')
                        .pop() ||
                    ''
            ),
            size: Number(archive.size) || 0,
            mtime: Number(archive.mtime) || 0
        }))
        .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 清理超出 keepCount 的自动备份（按 mtime 倒序保留最新）。
 * - 只处理自动备份，手动存档永不删除；
 * - protectedName 对应文件即使超出数量也不删除；
 * - 删除失败不抛出，收集到 warnings。
 *
 * @param {{
 *   token: string, bridgeUrl?: string, appPath: string,
 *   keepCount: number, protectedName?: string
 * }} options
 * @returns {Promise<{deleted: number, kept: number, warnings: string[]}>}
 */
export async function pruneAutoBackups({
    token,
    bridgeUrl,
    appPath,
    keepCount,
    protectedName
}) {
    const safeKeepCount = normalizeKeepCount(keepCount);
    const protectedText = String(protectedName || '').trim();
    const archives = await listAutoBackups({ token, bridgeUrl, appPath });

    // 已按 mtime 倒序；前 keepCount 份直接保留
    const keepNames = new Set(archives.slice(0, safeKeepCount).map((item) => item.name));
    const warnings = [];
    let deleted = 0;
    let kept = 0;

    for (const archive of archives) {
        // 双重保险：绝不删除非自动备份（如手动 tmplnote-archive-）
        if (!isAutoArchiveName(archive.name)) continue;

        const isProtected = Boolean(protectedText) && archive.name === protectedText;
        if (keepNames.has(archive.name) || isProtected) {
            kept += 1;
            continue;
        }

        try {
            await deleteArchive({ token, bridgeUrl, path: archive.path });
            deleted += 1;
        } catch (error) {
            // 只暴露文件名与脱敏后的原因，不涉及 token / 口令
            const reason =
                error && typeof error.message === 'string' && error.message
                    ? error.message
                    : '未知错误';
            warnings.push(`删除旧自动备份失败：${archive.name}（${reason}）`);
            kept += 1;
        }
    }

    return { deleted, kept, warnings };
}

/**
 * 下载并解密最新一份自动备份。
 * 没有自动备份时返回 null。
 *
 * @param {{token: string, bridgeUrl?: string, appPath: string, passphrase: string}} options
 * @returns {Promise<null | {
 *   archive: {fsId: string, path: string, name: string, size: number, mtime: number},
 *   backup: object,
 *   text: string
 * }>}
 */
export async function downloadLatestAutoBackup({ token, bridgeUrl, appPath, passphrase }) {
    const archives = await listAutoBackups({ token, bridgeUrl, appPath });
    if (archives.length === 0) return null;

    const latest = archives[0];
    const dlink = await getDownloadLink({ token, bridgeUrl, fsId: latest.fsId });
    const bytes = await downloadArchive({ token, bridgeUrl, dlink });

    let text;
    try {
        text = await decryptArchive(bytes, passphrase);
    } catch (error) {
        // 环境能力问题应原样保留，避免误导用户去检查口令
        if (error && typeof error.message === 'string' && /WebCrypto|HTTPS|localhost/.test(error.message)) {
            throw error;
        }
        throw new Error('自动备份口令错误或云端文件已损坏。');
    }

    const backup = parseBackup(text);
    return { archive: latest, backup, text };
}

export default {
    AUTO_ARCHIVE_PREFIX,
    isAutoArchiveName,
    autoBackupFilename,
    fingerprintBackupData,
    computeLocalFingerprint,
    runAutoBackup,
    listAutoBackups,
    pruneAutoBackups,
    downloadLatestAutoBackup
};
