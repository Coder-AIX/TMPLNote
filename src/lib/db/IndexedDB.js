/**
 * IndexedDB.js — 基础 IndexedDB 工具类
 *
 * 基于 idb（Jake Archibald）对原生 IndexedDB 的 Promise 薄封装，
 * 提供连接管理、通用 CRUD、索引查询、批量操作与事务封装。
 *
 * 设计要点：
 * - 连接懒加载并复用：open() 始终返回同一个 Promise，避免重复打开数据库。
 * - 所有方法第一个参数为对象仓库名（store），面向多 store 通用。
 * - 结构（对象仓库 / 索引）由 ./schema.js 描述，升级时自动创建。
 */
import { openDB, deleteDB } from 'idb';
import { DB_NAME, DB_VERSION, STORES } from './schema.js';

export class IndexedDBStore {
    /**
     * @param {Object} [options]
     * @param {string} [options.name=DB_NAME]        数据库名
     * @param {number} [options.version=DB_VERSION]  数据库版本
     * @param {Object} [options.stores=STORES]       对象仓库描述符
     */
    constructor({ name = DB_NAME, version = DB_VERSION, stores = STORES } = {}) {
        this.name = name;
        this.version = version;
        this.stores = stores;
        /** @type {Promise<any>|null} 连接缓存的 Promise */
        this._dbPromise = null;
    }

    /** 打开（或复用）数据库连接 */
    open() {
        if (!this._dbPromise) {
            this._dbPromise = openDB(this.name, this.version, {
                upgrade: (db, oldVersion, newVersion, transaction) => {
                    this._upgrade(db, oldVersion, newVersion, transaction);
                },
                terminated: () => {
                    // 浏览器强制终止连接后，丢弃缓存以便下次重新打开
                    this._dbPromise = null;
                }
            });
        }
        return this._dbPromise;
    }

    /** 内部：依据 schema 创建对象仓库与索引（幂等） */
    _upgrade(db, oldVersion, newVersion, transaction) {
        for (const [storeName, desc] of Object.entries(this.stores)) {
            let store;
            if (!db.objectStoreNames.contains(storeName)) {
                store = db.createObjectStore(storeName, {
                    keyPath: desc.keyPath || undefined,
                    autoIncrement: Boolean(desc.autoIncrement)
                });
            } else {
                store = transaction.objectStore(storeName);
            }
            for (const index of desc.indexes || []) {
                if (!store.indexNames.contains(index.name)) {
                    store.createIndex(index.name, index.keyPath, {
                        unique: Boolean(index.unique),
                        multiEntry: Boolean(index.multiEntry)
                    });
                }
            }
        }
    }

    /** 关闭数据库连接并重置缓存 */
    async close() {
        if (this._dbPromise) {
            const db = await this._dbPromise;
            db.close();
            this._dbPromise = null;
        }
    }

    /** 删除整个数据库并重置连接 */
    async destroy() {
        await this.close();
        await deleteDB(this.name);
    }

    // ———————————————— 通用 CRUD ————————————————

    /** 新增一条记录（主键已存在则抛错），返回主键 */
    async add(store, value, key) {
        return (await this.open()).add(store, value, key);
    }

    /** 新增或覆盖一条记录，返回主键 */
    async put(store, value, key) {
        return (await this.open()).put(store, value, key);
    }

    /** 按主键读取 */
    async get(store, key) {
        return (await this.open()).get(store, key);
    }

    /** 读取全部（可传主键范围 query 与数量 count） */
    async getAll(store, query, count) {
        return (await this.open()).getAll(store, query, count);
    }

    /** 读取全部主键 */
    async getAllKeys(store, query, count) {
        return (await this.open()).getAllKeys(store, query, count);
    }

    /** 计数 */
    async count(store, query) {
        return (await this.open()).count(store, query);
    }

    /** 是否存在指定主键 */
    async has(store, key) {
        const found = await (await this.open()).getKey(store, key);
        return found !== undefined;
    }

    /** 按主键删除 */
    async delete(store, key) {
        return (await this.open()).delete(store, key);
    }

    /** 清空仓库 */
    async clear(store) {
        return (await this.open()).clear(store);
    }

    /**
     * 读-改-写：在同一事务内读取当前值，由 updater 计算新值后写回。
     * @param {string} store
     * @param {IDBValidKey} key
     * @param {(current: any) => any} updater 传入当前记录，返回新记录
     * @returns {Promise<any|undefined>} 新值；记录不存在时返回 undefined
     */
    async update(store, key, updater) {
        const db = await this.open();
        const tx = db.transaction(store, 'readwrite');
        const current = await tx.store.get(key);
        if (current === undefined) {
            await tx.done;
            return undefined;
        }
        const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
        await tx.store.put(next);
        await tx.done;
        return next;
    }

    // ———————————————— 索引查询 ————————————————

    /** 按索引取单值 */
    async getByIndex(store, index, query) {
        return (await this.open()).getFromIndex(store, index, query);
    }

    /** 按索引取列表 */
    async getAllByIndex(store, index, query, count) {
        return (await this.open()).getAllFromIndex(store, index, query, count);
    }

    // ———————————————— 批量操作（单事务）————————————————

    /** 批量写入，返回传入的值数组 */
    async bulkPut(store, values) {
        const db = await this.open();
        const tx = db.transaction(store, 'readwrite');
        for (const value of values) {
            tx.store.put(value);
        }
        await tx.done;
        return values;
    }

    /** 批量新增，返回主键数组 */
    async bulkAdd(store, values) {
        const db = await this.open();
        const tx = db.transaction(store, 'readwrite');
        const keys = [];
        for (const value of values) {
            keys.push(await tx.store.add(value));
        }
        await tx.done;
        return keys;
    }

    /** 批量删除 */
    async bulkDelete(store, keys) {
        const db = await this.open();
        const tx = db.transaction(store, 'readwrite');
        for (const key of keys) {
            tx.store.delete(key);
        }
        await tx.done;
    }

    // ———————————————— 自定义事务 ————————————————

    /**
     * 自定义事务：在回调中对多个 store 执行读写，事务随回调完成而结束。
     * @param {string|string[]} storeNames
     * @param {'readonly'|'readwrite'} mode
     * @param {(tx: any) => any} fn 事务回调
     */
    async transaction(storeNames, mode, fn) {
        const db = await this.open();
        const tx = db.transaction(storeNames, mode);
        const result = await fn(tx);
        await tx.done;
        return result;
    }
}

export default IndexedDBStore;
