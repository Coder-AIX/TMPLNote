/**
 * notes.js — 笔记领域仓储（基于 IndexedDBStore 封装）
 *
 * 在通用工具类（./IndexedDB.js）之上沉淀「笔记」业务约定：
 * - id 自动生成（优先 crypto.randomUUID）；
 * - createdAt / updatedAt 时间戳自动维护；
 * - folderId 表示所属文件夹，空串（ROOT_ID）表示未分类；
 * - 查询支持按文件夹过滤、关键词搜索与排序。
 */
import { db } from './index.js';
import { ROOT_ID } from './schema.js';

const STORE = 'notes';

/** 生成唯一 id */
function createId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 归一化笔记对象，补齐 id、folderId 与时间戳 */
function normalize(input = {}) {
    const now = Date.now();
    return {
        id: input.id || createId(),
        title: String(input.title ?? '').trim() || '未命名笔记',
        content: input.content ?? '',
        folderId: String(input.folderId ?? ROOT_ID) || ROOT_ID,
        pinned: Boolean(input.pinned),
        isTemplate: Boolean(input.isTemplate),
        deletedAt: input.deletedAt ? Number(input.deletedAt) : null,
        createdAt: Number(input.createdAt) || now,
        updatedAt: now
    };
}

/** 排序比较器 */
const SORTERS = {
    createdAt: (a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0),
    updatedAt: (a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0),
    title: (a, b) =>
        String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-Hans-CN')
};

export const notesRepository = {
    /**
     * 查询笔记。
     * @param {Object} [options]
     * @param {string} [options.folderId] 省略=全部；''=未分类；其它=指定文件夹
     * @param {string} [options.search]   关键词（匹配标题或内容，忽略大小写）
     * @param {'createdAt'|'updatedAt'|'title'} [options.sortBy='createdAt']
     * @param {boolean} [options.ascending=false] 默认倒序（最新在前）
     * @param {boolean} [options.includeTemplates=false] 是否包含模板笔记
     * @returns {Promise<Array<Object>>}
     */
    async list({ folderId, search = '', sortBy = 'createdAt', ascending = false, includeTemplates = false } = {}) {
        const all = await db.getAll(STORE);
        const kw = String(search).trim().toLowerCase();
        const rows = all.filter((n) => {
            if (n.deletedAt) return false;
            if (!includeTemplates && n.isTemplate) return false;
            if (folderId !== undefined && (n.folderId ?? ROOT_ID) !== folderId) {
                return false;
            }
            if (kw) {
                const title = String(n.title ?? '').toLowerCase();
                const content = String(n.content ?? '').toLowerCase();
                if (!title.includes(kw) && !content.includes(kw)) return false;
            }
            return true;
        });
        const cmp = SORTERS[sortBy] || SORTERS.createdAt;
        rows.sort((a, b) => (ascending ? 1 : -1) * cmp(a, b));
        // 置顶优先：稳定重排，使 pinned 为 true 的笔记整体排在最前，
        // 置顶组内部与其余笔记各自保持上一步的排序结果（现代引擎 sort 为稳定排序）。
        rows.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
        return rows;
    },

    /** 列出全部模板（按更新时间倒序） */
    async listTemplates() {
        const all = await db.getAll(STORE);
        const rows = all.filter((n) => Boolean(n.isTemplate) && !n.deletedAt);
        rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
        return rows;
    },

    /** 读取单条笔记 */
    get(id) {
        return db.get(STORE, id);
    },

    /** 新建笔记 */
    async create(input) {
        const note = normalize(input);
        await db.put(STORE, note);
        return note;
    },

    /** 新建模板笔记 */
    createTemplate(input = {}) {
        return this.create({ title: '未命名模板', content: '', ...input, isTemplate: true });
    },

    /** 更新笔记（合并 patch，并刷新 updatedAt） */
    async update(id, patch = {}) {
        return db.update(STORE, id, (current) =>
            normalize({ ...current, ...patch, id })
        );
    },

    /** 移动笔记到指定文件夹（folderId 省略则移到未分类） */
    move(id, folderId) {
        return this.update(id, { folderId: folderId ?? ROOT_ID });
    },

    /** 删除笔记 */
    remove(id) {
        return db.delete(STORE, id);
    },

    /** 软删除：标记 deletedAt，笔记进入「最近删除」 */
    async softDelete(id) {
        return this.update(id, { deletedAt: Date.now() });
    },

    /** 回收站列表（按删除时间倒序） */
    async listTrash() {
        const all = await db.getAll(STORE);
        const rows = all.filter((n) => Boolean(n.deletedAt));
        rows.sort((a, b) => (Number(b.deletedAt) || 0) - (Number(a.deletedAt) || 0));
        return rows;
    },

    /** 从回收站恢复 */
    async restore(id) {
        return this.update(id, { deletedAt: null });
    },

    /** 彻底删除单条 */
    removePermanent(id) {
        return db.delete(STORE, id);
    },

    /** 清空回收站，返回删除数量 */
    async emptyTrash() {
        const all = await db.getAll(STORE);
        const deleted = all.filter((n) => Boolean(n.deletedAt));
        await Promise.all(deleted.map((n) => db.delete(STORE, n.id)));
        return deleted.length;
    },

    /**
     * 清理超过保留天数的已删除笔记。
     * @param {number} days 保留天数；<=0 或非法表示永久保留 → 不删除，返回 0。
     * @returns {Promise<number>} 被删除数量
     */
    async purgeExpired(days) {
        const n = Number(days);
        if (!Number.isFinite(n) || n <= 0) return 0;
        const cutoff = Date.now() - n * 24 * 60 * 60 * 1000;
        const all = await db.getAll(STORE);
        const expired = all.filter((note) => note.deletedAt && Number(note.deletedAt) < cutoff);
        await Promise.all(expired.map((note) => db.delete(STORE, note.id)));
        return expired.length;
    },

    /** 清空全部笔记 */
    clear() {
        return db.clear(STORE);
    }
};

export default notesRepository;
