/**
 * settings.js — 应用设置领域仓储（基于 IndexedDBStore）
 *
 * 存储形态：每个键一条记录 { key, value, updatedAt }。
 * 读取时由上层（stores/settings.js）与 DEFAULT_SETTINGS 合并。
 */
import { db } from './index.js';

const STORE = 'settings';

/** 全部设置的默认值（首次运行 / 缺项时使用） */
export const DEFAULT_SETTINGS = {
    language: 'zh-CN',        // 'zh-CN' | 'en'
    followSystem: true,       // 主题是否跟随系统
    dark: false,              // 手动暗色（仅 followSystem=false 时生效）
    trashRetentionDays: 30,   // 「最近删除」保留天数；0 = 永久保留（不自动删除）
    encryptionEnabled: false, // 是否启用访问锁
    passwordHash: '',         // PBKDF2 派生哈希（Base64）
    passwordSalt: '',         // 随机盐（Base64）
    passwordIterations: 100000,
    aiModelId: 'qwen3.5-0.8b-q8_0', // 当前选中/载入的模型 id（首次运行会按设备改写为对应推荐：PC=Q8_0 / 移动端=Q4_0）
    aiUseNotesContext: true,            // 对话时是否自动检索本地笔记作为上下文
    aiDownloadedModelIds: [],           // 已完成下载的模型 id 列表（供 UI 显示状态）
    aiCustomModels: [],                 // 自定义导入的本地 GGUF 模型描述符数组（见 ai/models.js 的 createLocalModel）
    aiModelStorageMode: 'cache', // 模型存储方式：'cache'=缓存到浏览器（可反复载入）；'session'=仅本次会话（不持久化）
    aiPerfMode: 'high', // 性能模式：'high'=GPU 全层加速(最快) | 'balanced'=约半数层上 GPU | 'low'=CPU 推理(最流畅但最慢)；切换后需重新载入模型
    aiContextLength: 16384,      // 生效的上下文长度（token），范围 4096–51200；16384 是保证工具定义不被截断的下限；首次运行按设备推荐覆盖
    aiContextLengthPc: 16384,    // PC 推荐上下文长度；16384 是保证工具定义不被截断的下限
    aiContextLengthMobile: 16384, // 移动端推荐上下文长度；16384 是保证工具定义不被截断的下限（8192 会截断提示导致工具定义丢失）
};

export const settingsRepository = {
    /** 读取单个设置项，不存在时返回 fallback */
    async get(key, fallback) {
        const row = await db.get(STORE, key);
        return row === undefined ? fallback : row.value;
    },

    /** 写入单个设置项（覆盖） */
    async set(key, value) {
        await db.put(STORE, { key, value, updatedAt: Date.now() });
        return value;
    },

    /** 读取全部设置，返回普通对象 { key: value } */
    async all() {
        const rows = await db.getAll(STORE);
        const out = {};
        for (const row of rows) out[row.key] = row.value;
        return out;
    },

    /** 删除单个设置项 */
    remove(key) {
        return db.delete(STORE, key);
    },

    /** 清空全部设置 */
    clear() {
        return db.clear(STORE);
    }
};

export default settingsRepository;
