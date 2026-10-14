/**
 * folders.js — 文件夹领域仓储（基于 IndexedDBStore 封装）
 *
 * 约束：至多两级文件夹（根文件夹 + 其直属子文件夹）。
 * - parentId === ROOT_ID('') 表示根级文件夹；
 * - 不允许在子文件夹下再建子文件夹（create 时校验并抛错）。
 */
import { db } from './index.js';
import { ROOT_ID } from './schema.js';

const STORE = 'folders';
const NOTES = 'notes';

/** 生成唯一 id */
function createId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 归一化文件夹对象，补齐 id / parentId / 时间戳 */
function normalize(input = {}) {
    const now = Date.now();
    return {
        id: input.id || createId(),
        name: String(input.name ?? '').trim() || '未命名文件夹',
        parentId: String(input.parentId ?? ROOT_ID) || ROOT_ID,
        createdAt: Number(input.createdAt) || now,
        updatedAt: now
    };
}

export const foldersRepository = {
    /**
     * 列出全部文件夹（默认按创建时间升序）。
     * @param {{ascending?: boolean}} [options]
     * @returns {Promise<Array<Object>>}
     */
    async list({ ascending = true } = {}) {
        const rows = await db.getAll(STORE);
        rows.sort(
            (a, b) =>
                (ascending ? 1 : -1) *
                ((Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
        );
        return rows;
    },

    /** 读取单个文件夹 */
    get(id) {
        return db.get(STORE, id);
    },

    /**
     * 组装两级树：返回根文件夹数组，每项含 children。
     * @returns {Promise<Array<Object>>}
     */
    async tree() {
        const rows = await this.list({ ascending: true });
        const byId = new Map(rows.map((f) => [f.id, { ...f, children: [] }]));
        const roots = [];
        for (const f of rows) {
            const node = byId.get(f.id);
            if (f.parentId && byId.has(f.parentId)) {
                byId.get(f.parentId).children.push(node);
            } else {
                roots.push(node);
            }
        }
        return roots;
    },

    /**
     * 新建文件夹。
     * @param {{name?: string, parentId?: string}} [input]
     * @returns {Promise<Object>}
     * @throws 当父级不存在、或父级不是根级（会形成三级）时抛错
     */
    async create(input = {}) {
        const parentId = String(input.parentId ?? ROOT_ID) || ROOT_ID;
        if (parentId !== ROOT_ID) {
            const parent = await db.get(STORE, parentId);
            if (!parent) throw new Error('父文件夹不存在');
            if (parent.parentId !== ROOT_ID) throw new Error('仅支持两级文件夹');
        }
        const folder = normalize({ ...input, parentId });
        await db.put(STORE, folder);
        return folder;
    },

    /** 更新文件夹（合并 patch 且刷新 updatedAt） */
    update(id, patch = {}) {
        return db.update(STORE, id, (current) =>
            normalize({ ...current, ...patch, id })
        );
    },

    /** 重命名 */
    rename(id, name) {
        return this.update(id, { name });
    },

    /** 是否可在该文件夹下继续创建子文件夹（仅根级文件夹可）。 */
    async canHaveChildren(id) {
        const folder = await db.get(STORE, id);
        return Boolean(folder) && folder.parentId === ROOT_ID;
    },

    /**
     * 删除文件夹：级联删除其所有子文件夹，并把受影响笔记迁移到未分类（ROOT_ID）。
     * @param {string} id
     */
    async remove(id) {
        const all = await db.getAll(STORE);
        const affected = new Set([id]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const f of all) {
                if (!affected.has(f.id) && affected.has(f.parentId)) {
                    affected.add(f.id);
                    grew = true;
                }
            }
        }
        const notes = await db.getAll(NOTES);
        await db.transaction([STORE, NOTES], 'readwrite', async (tx) => {
            const foldersStore = tx.objectStore(STORE);
            const notesStore = tx.objectStore(NOTES);
            for (const fid of affected) {
                foldersStore.delete(fid);
            }
            for (const n of notes) {
                if (affected.has(String(n.folderId ?? ROOT_ID) || ROOT_ID)) {
                    notesStore.put({ ...n, folderId: ROOT_ID, updatedAt: Date.now() });
                }
            }
        });
    }
};

export default foldersRepository;
