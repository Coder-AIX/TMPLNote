/**
 * 备份/恢复数据层纯工具（纯函数，无外部依赖，兼容 SSR/构建环境）。
 *
 * 仅负责备份对象的构造、序列化、解析校验与文件名生成，
 * 不接触 IndexedDB、stores 或任何浏览器 API，方便在构建/测试环境直接引用。
 */

/** 备份文件格式标识 */
export const BACKUP_FORMAT = 'tmplnote-backup';

/** 当前应用支持的备份版本号 */
export const BACKUP_VERSION = 1;

/** 备份文件的 MIME 类型 */
export const BACKUP_MIME = 'application/json';

/** 随备份导出的设置键（外观类；显式排除安全凭据与 encryptionEnabled） */
export const BACKUP_SETTING_KEYS = ['language', 'followSystem', 'dark'];

/**
 * 将设置对象裁剪为仅包含允许导出的键。
 *
 * 仅保留 BACKUP_SETTING_KEYS 中、且在入参中真实存在的键
 * （使用 Object.prototype.hasOwnProperty 判断），值原样返回。
 *
 * @param {object} [settings={}] 原始设置对象。
 * @returns {object} 新的裁剪后设置对象；非对象入参返回 `{}`。
 */
export function sanitizeSettings(settings = {}) {
    const result = {};
    // 非对象（含 null / 数组外的原始值）按空对象处理
    if (settings === null || typeof settings !== 'object') {
        return result;
    }
    for (const key of BACKUP_SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(settings, key)) {
            result[key] = settings[key];
        }
    }
    return result;
}

/**
 * 构造备份对象。
 *
 * @param {object} [options={}] 构造参数。
 * @param {Array} [options.notes=[]] 笔记列表。
 * @param {Array} [options.folders=[]] 文件夹列表。
 * @param {object} [options.settings={}] 原始设置对象（内部会先经 sanitizeSettings 裁剪）。
 * @param {number} [options.dbVersion=0] 数据库版本号。
 * @param {number} [options.exportedAt=Date.now()] 导出时间戳（毫秒）。
 * @returns {object} 归一化的备份对象。
 */
export function buildBackup({
    notes = [],
    folders = [],
    settings = {},
    dbVersion = 0,
    exportedAt = Date.now()
} = {}) {
    // 非数组入参按空数组处理
    const safeNotes = Array.isArray(notes) ? notes : [];
    const safeFolders = Array.isArray(folders) ? folders : [];
    const safeSettings = sanitizeSettings(settings);

    return {
        app: 'TMPLNote',
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        dbVersion,
        exportedAt,
        counts: {
            notes: safeNotes.length,
            templates: safeNotes.filter((n) => n && n.isTemplate).length,
            folders: safeFolders.length
        },
        data: {
            notes: safeNotes,
            folders: safeFolders,
            settings: safeSettings
        }
    };
}

/**
 * 将备份对象序列化为字符串。
 *
 * @param {object} backup 备份对象。
 * @param {object} [options={}] 序列化参数。
 * @param {boolean} [options.pretty=true] 是否美化缩进（true 使用 2 空格，false 紧凑输出）。
 * @returns {string} JSON 字符串。
 */
export function stringifyBackup(backup, { pretty = true } = {}) {
    return JSON.stringify(backup, null, pretty ? 2 : 0);
}

/**
 * 解析并校验备份文本，返回归一化后的备份对象。
 *
 * 校验失败时抛出中文 Error；允许缺失 dbVersion/exportedAt/counts（向后兼容），
 * 但 format 必须匹配 BACKUP_FORMAT。
 *
 * @param {string} text 备份文件文本内容。
 * @returns {object} 归一化备份对象 `{ app, format, version, dbVersion, exportedAt, counts, data }`。
 * @throws {Error} 文本非法、格式不匹配、版本过高或缺少数据段时抛出。
 */
export function parseBackup(text) {
    // 1. 基本类型与非空校验 + JSON 解析
    if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('文件内容不是有效的 JSON。');
    }
    let obj;
    try {
        obj = JSON.parse(text);
    } catch {
        throw new Error('文件内容不是有效的 JSON。');
    }

    // 2. 顶层结构与格式标识校验
    if (obj === null || typeof obj !== 'object' || obj.format !== BACKUP_FORMAT) {
        throw new Error('这不是 TMPLNote 备份文件。');
    }

    // 3. 版本校验（仅当 version 为数字时校验，缺失按兼容处理）
    if (typeof obj.version === 'number' && obj.version > BACKUP_VERSION) {
        throw new Error(
            `备份版本（v${obj.version}）高于当前应用支持的版本，请先升级应用。`
        );
    }

    // 4. 数据段校验
    const data = obj.data;
    if (data === null || typeof data !== 'object') {
        throw new Error('备份文件缺少数据段。');
    }

    // 5. 归一化各字段
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const folders = Array.isArray(data.folders) ? data.folders : [];
    const settings = sanitizeSettings(data.settings);

    const derivedCounts = {
        notes: notes.length,
        templates: notes.filter((n) => n && n.isTemplate).length,
        folders: folders.length
    };
    // counts 缺失或非法时按数据重新计算
    const counts =
        obj.counts !== null && typeof obj.counts === 'object'
            ? obj.counts
            : derivedCounts;

    const dbVersion = typeof obj.dbVersion === 'number' ? obj.dbVersion : 0;
    const exportedAt = typeof obj.exportedAt === 'number' ? obj.exportedAt : 0;

    return {
        app: typeof obj.app === 'string' ? obj.app : 'TMPLNote',
        format: BACKUP_FORMAT,
        version: typeof obj.version === 'number' ? obj.version : BACKUP_VERSION,
        dbVersion,
        exportedAt,
        counts,
        data: {
            notes,
            folders,
            settings
        }
    };
}

/**
 * 生成备份文件名（本地时间）。
 *
 * @param {Date} [date=new Date()] 用于生成文件名的时间。
 * @returns {string} 形如 `tmplnote-backup-YYYYMMDD-HHmmss.json` 的文件名。
 */
export function backupFilename(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `tmplnote-backup-${year}${month}${day}-${hours}${minutes}${seconds}.json`;
}
