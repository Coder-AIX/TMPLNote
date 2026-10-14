/**
 * schema.js — IndexedDB 数据库结构与版本定义（纯数据，无副作用）
 *
 * 约定：
 * - 每个对象仓库（store）以描述符声明：keyPath / autoIncrement / indexes。
 * - 首次创建与版本升级由 IndexedDBStore 依据本描述符自动完成。
 * - 结构变更遵循「只增不改」并提升 DB_VERSION，避免破坏已存在的用户数据。
 */

/** 数据库名称 */
export const DB_NAME = 'tmplnote';

/** 数据库版本（结构变更时 +1；v2：新增 folders 仓库与 notes.by-folder 索引） */
export const DB_VERSION = 2;

/**
 * 根级哨兵：表示「根文件夹的父级」与「未分类笔记的所属」。
 * 用空字符串而非 null，因为 IndexedDB 索引不收录 null/undefined 键。
 */
export const ROOT_ID = '';

/**
 * 对象仓库描述符
 * @typedef {Object} StoreDescriptor
 * @property {string}        keyPath                主键路径（空串表示使用外部键）
 * @property {boolean}       [autoIncrement]        主键是否自增
 * @property {Array<Object>} [indexes]              索引定义 { name, keyPath, unique?, multiEntry? }
 */

/** 全部对象仓库定义 */
export const STORES = {
    /** 笔记（folderId 为空串表示未分类） */
    notes: {
        keyPath: 'id',
        autoIncrement: false,
        indexes: [
            { name: 'by-updated', keyPath: 'updatedAt' },
            { name: 'by-created', keyPath: 'createdAt' },
            { name: 'by-title', keyPath: 'title' },
            { name: 'by-folder', keyPath: 'folderId' }
        ]
    },
    /** 文件夹（至多两级；parentId 为空串表示根级） */
    folders: {
        keyPath: 'id',
        autoIncrement: false,
        indexes: [
            { name: 'by-parent', keyPath: 'parentId' },
            { name: 'by-created', keyPath: 'createdAt' },
            { name: 'by-name', keyPath: 'name' }
        ]
    },
    /** 应用设置（键值对，key 为主键） */
    settings: {
        keyPath: 'key',
        autoIncrement: false,
        indexes: []
    }
};

export default { DB_NAME, DB_VERSION, ROOT_ID, STORES };
