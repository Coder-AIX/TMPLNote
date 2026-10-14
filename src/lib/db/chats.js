/**
 * chats.js — 对话会话仓储（独立 IndexedDB：tmplnote-chat）
 *
 * 会话模型：
 *   session = { id, title, createdAt, updatedAt, messages: Message[] }
 *   Message = { id, role: 'system'|'user'|'assistant', content, createdAt }
 *
 * 设计：一个会话为一条记录，消息内嵌其中（避免多 store 事务复杂度）。
 * 独立数据库，不改动主库 schema.js / DB_VERSION。
 */
import { IndexedDBStore } from './IndexedDB.js';

const DB = 'tmplnote-chat';
const STORE = 'sessions';

const stores = {
    sessions: {
        keyPath: 'id',
        autoIncrement: false,
        indexes: [{ name: 'by-updated', keyPath: 'updatedAt' }]
    }
};

const store = new IndexedDBStore({ name: DB, version: 1, stores });

const ROLES = ['system', 'user', 'assistant'];

/** 生成唯一 id（优先 crypto.randomUUID） */
function createId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 归一化消息对象，补齐 id、role、content 与 createdAt */
function normalizeMessage(input = {}) {
    const role = ROLES.includes(input.role) ? input.role : 'user';
    return {
        id: input.id || createId(),
        role,
        content: input.content ?? '',
        createdAt: Number(input.createdAt) || Date.now()
    };
}

export const chatRepository = {
    /**
     * 会话摘要列表（按 updatedAt 倒序），不含 messages。
     * @returns {Promise<Array<{id:string,title:string,createdAt:number,updatedAt:number}>>}
     */
    async list() {
        const all = await store.getAll(STORE);
        const rows = all.map((s) => ({
            id: s.id,
            title: s.title,
            createdAt: Number(s.createdAt) || 0,
            updatedAt: Number(s.updatedAt) || 0
        }));
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        return rows;
    },

    /** 读取单个会话（含 messages）；不存在返回 undefined */
    get(id) {
        return store.get(STORE, id);
    },

    /** 新建会话（返回完整会话对象） */
    async create({ title = '新对话', messages = [] } = {}) {
        const now = Date.now();
        const session = {
            id: createId(),
            title,
            createdAt: now,
            updatedAt: now,
            messages: (Array.isArray(messages) ? messages : []).map(normalizeMessage)
        };
        await store.put(STORE, session);
        return session;
    },

    /** 覆盖保存会话（刷新 updatedAt 后 put），返回保存后的对象 */
    async save(session) {
        const next = { ...session, updatedAt: Date.now() };
        await store.put(STORE, next);
        return next;
    },

    /** 追加一条消息（读-改-写）；message 缺 id/createdAt 时补齐 */
    async appendMessage(id, message) {
        const norm = normalizeMessage(message);
        return store.update(STORE, id, (cur) => ({
            ...cur,
            messages: [...(cur.messages || []), norm],
            updatedAt: Date.now()
        }));
    },

    /** 删除单个会话 */
    remove(id) {
        return store.delete(STORE, id);
    },

    /** 清空全部会话 */
    clear() {
        return store.clear(STORE);
    }
};

export default chatRepository;
