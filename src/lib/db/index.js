/**
 * index.js — IndexedDB 工具类统一入口
 *
 * 用法示例：
 *   import db from '../../../lib/db/index.js';
 *   await db.put('notes', { id, title, updatedAt });
 *   const note = await db.get('notes', id);
 *   const list = await db.getAllByIndex('notes', 'by-updated');
 */
import { IndexedDBStore } from './IndexedDB.js';
import { DB_NAME, DB_VERSION, STORES } from './schema.js';

/** 默认单例（懒连接，首次调用时打开数据库） */
export const db = new IndexedDBStore();

export { IndexedDBStore, DB_NAME, DB_VERSION, STORES };
export default db;
