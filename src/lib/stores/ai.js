/**
 * ai.js — AI 运行态 store（P3：本地导入 GGUF 与推理引擎接入）
 *
 * 职责：
 * - 持有本地 GGUF + WebGPU 模型对话功能的「运行态」数据，供设置页 / 对话页订阅；
 * - 模型不再由应用联网下载：用户在设置页用浏览器原生链接下载 GGUF，再在应用内
 *   「选择本地文件导入」。本 store 负责按存储模式把文件交给 cache.js / engine.js。
 *
 * ── 模型来源（推荐模型 + 自定义模型 双来源）──
 * - 推荐模型：models.js 的 RECOMMENDED_MODELS（getModel 可查），带下载直链；
 * - 自定义模型：用户本地任意 GGUF 文件经 createLocalModel 生成的描述符（local:true），
 *   持久化在 settings.aiCustomModels 中，并同步到运行态 ai.customModels；
 * - 统一解析：resolveModel(id) 先查推荐列表、再查自定义列表，供各函数按 id 取描述符。
 *
 * ── A1 / A2 双存储模式（由设置 aiModelStorageMode 决定）──
 * - A1 'cache'（默认）：导入时把本地文件写入 Cache Storage（ai-models），可持久化、
 *   刷新后仍可反复载入；导入成功会把 id 并入 settings.aiDownloadedModelIds。
 * - A2 'session'：文件仅保留在内存（模块级 sessionFile），不持久化；刷新后需重新选择。
 *   sessionModelId 记录本次会话已导入的模型 id（无则为 null）。
 *
 * 运行态字段说明：
 * - supported      {boolean}   当前环境是否支持 WebGPU（navigator.gpu 是否可用）
 * - state          {AiState}   状态机当前取值，见下方 AiState 枚举
 * - modelId        {string}    当前选中的模型 id（默认取 DEFAULT_MODEL_ID，随设置同步）
 * - modelLabel     {string}    当前 modelId 对应的展示名（推荐 / 自定义通吃；供 UI 使用）
 * - progress       {?{percent:number, file:string}} 导入 / 载入进度；无进行中任务时为 null
 * - error          {string}    最近一次错误信息；空串表示无错误
 * - downloaded     {string[]}  A1：已缓存模型的 id 列表（由设置 aiDownloadedModelIds 同步）
 * - customModels   {object[]}  自定义导入的模型描述符数组（同步自 settings.aiCustomModels）
 * - sessionModelId {?string}   A2：本次会话已导入的模型 id；无则为 null
 * - disabled       {boolean}   移动端硬件门槛不满足时为 true，表示已关闭 AI
 * - disabledReason {string}    关闭 AI 的原因文案；空串表示未关闭
 *
 * 移动端硬件门槛（仅对移动端生效，PC 不做限制）：
 * - 要求「已开启跨域隔离」（crossOriginIsolated，可启用多线程）且 CPU 核心数 >= MIN_THREADS；
 * - 不满足（未跨域隔离 / 核心数不足）时，初始化即关闭 AI 并给出 disabledReason；
 * - 此外在 loadModel 载入成功后二次校验实测推理线程数，移动端低于门槛时卸载模型并关闭 AI。
 *
 * 状态机（state）取值：
 * - 'idle'        空闲：未载入任何模型
 * - 'downloaded'  已就绪：模型文件可用（已缓存或本次会话已导入）但尚未载入显存
 * - 'loading'     载入中：正在把模型载入显存
 * - 'ready'       就绪：模型已载入，可发起对话
 * - 'generating'  生成中：正在生成回复
 * - 'error'       错误：导入 / 载入 / 推理失败，详情见 error 字段
 *
 * 与设置的同步：
 * - 订阅 settings store：把 `aiDownloadedModelIds` 同步到 `downloaded`、把 `aiModelId`
 *   同步到 `modelId`、把 `aiCustomModels` 同步到 `customModels`；并据此重算 `modelLabel`。
 * - 导入成功 / 载入成功 / 删除时，也会反向写回设置（updateSetting）。
 *
 * 启动自动载入：
 * - autoLoadCachedModel()：应用启动时调用；若 WebGPU 可用且当前模型已存在于浏览器
 *   缓存（A1）中，则自动触发 loadModel，无需用户手点。
 */
import { writable, get } from 'svelte/store';
import * as modelCache from '../ai/cache.js';
import aiEngine from '../ai/engine.js';
import { getModel, createLocalModel, isWebGPUSupported, DEFAULT_MODEL_ID } from '../ai/models.js';
import {
    settings,
    updateSetting,
    resolveContextLength,
    isMobileDevice
} from './settings.js';

/** 移动端流畅运行本地模型所需的最少推理线程数 */
export const MIN_THREADS = 6;

/**
 * 计算硬件能力门槛（仅对移动端生效，PC 不做限制）。
 * 触发关闭：未跨域隔离（无法多线程）或 CPU 核心数 < MIN_THREADS。
 * @returns {{disabled: boolean, reason: string}}
 */
function computeCapability() {
    // PC 不做限制
    if (!isMobileDevice()) return { disabled: false, reason: '' };
    const isolated = typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false;
    if (!isolated) {
        return {
            disabled: true,
            reason: '当前环境未开启跨域隔离，无法启用多线程，移动端推理会非常慢，已关闭 AI。'
        };
    }
    const cores = Number((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0);
    if (cores < MIN_THREADS) {
        return {
            disabled: true,
            reason: `CPU 核心数不足（${cores} < ${MIN_THREADS}），无法流畅运行本地模型，已关闭 AI。`
        };
    }
    return { disabled: false, reason: '' };
}

/** 模块初始化时计算一次的硬件门槛结果（供 store 初始值使用，避免重复调用） */
const initialCapability = computeCapability();

export const ai = writable({
    supported: isWebGPUSupported(), // WebGPU 是否可用
    state: 'idle', // 'idle'|'downloaded'|'loading'|'ready'|'generating'|'error'
    modelId: DEFAULT_MODEL_ID, // 当前模型 id
    modelLabel: getModel(DEFAULT_MODEL_ID)?.label ?? '', // 当前模型展示名（推荐 / 自定义通吃）
    progress: null, // { percent, file } | null
    error: '', // 错误信息
    disabled: initialCapability.disabled, // 移动端硬件门槛不满足时为 true（关闭 AI）
    disabledReason: initialCapability.reason, // 关闭 AI 的原因文案；空串表示未关闭
    downloaded: [], // A1：已缓存模型 id 列表
    customModels: [], // 自定义导入的模型描述符数组（同步自 settings.aiCustomModels）
    sessionModelId: null // A2：本次会话已导入的模型 id
});

/** A2 内存文件：本次会话导入的本地文件（不持久化；仅当 sessionModelId 对应时有效） */
let sessionFile = null;

/**
 * 解析 id → 模型描述符：先查推荐列表，再查自定义列表。
 * @param {string} id 模型 id
 * @returns {object|undefined} 命中则返回描述符，否则 undefined
 */
export function resolveModel(id) {
    return getModel(id) || get(ai).customModels.find((m) => m.id === id);
}

// 与设置同步：设置（异步从 IndexedDB）载入 / 变更后，回填运行态，保证 UI 一致。
settings.subscribe((value) => {
    if (!value) return;
    if (Array.isArray(value.aiDownloadedModelIds)) {
        ai.update((a) => ({ ...a, downloaded: [...value.aiDownloadedModelIds] }));
    }
    if (Array.isArray(value.aiCustomModels)) {
        // 先同步自定义模型列表
        ai.update((a) => ({ ...a, customModels: [...value.aiCustomModels] }));
        // 同步后再重算展示名（此时 resolveModel 能读到最新的 customModels）
        ai.update((a) => ({ ...a, modelLabel: resolveModel(a.modelId)?.label ?? '' }));
    }
    if (value.aiModelId) {
        ai.update((a) => ({
            ...a,
            modelId: value.aiModelId,
            modelLabel: resolveModel(value.aiModelId)?.label ?? ''
        }));
    }
});

/**
 * 导入本地模型文件（替换旧的 downloadModel）。
 * 按设置 aiModelStorageMode 分流：
 * - 'cache'  → 写入 Cache Storage（持久化），并把 id 并入 aiDownloadedModelIds；
 * - 'session'→ 仅保留在内存（sessionFile），记录 sessionModelId。
 * 失败不抛出，改为 error 状态。
 * 导入成功后会同时把该模型设为「当前模型」（写入 settings.aiModelId），
 * 以便底部通用操作栏作用于刚导入的模型。
 * @param {string} id 模型 id（推荐模型或自定义模型均可）
 * @param {File|Blob} file 用户选择的本地 GGUF 文件
 */
export async function importModel(id, file) {
    const model = resolveModel(id);
    if (!model) return;

    ai.update((a) => ({ ...a, progress: { percent: 0, file: model.file }, error: '' }));

    /** A1 / A2 模式（默认 A1 缓存） */
    const mode = get(settings).aiModelStorageMode ?? 'cache';

    try {
        if (mode === 'cache') {
            // A1：写入 Cache Storage，进度经 onProgress 回填
            await modelCache.importModel(model, file, {
                onProgress: (p) =>
                    ai.update((a) => ({
                        ...a,
                        progress: { percent: p?.percent ?? null, file: model.file }
                    }))
            });

            // 反向写回设置：把该 id 并入已缓存列表（去重）
            const current = get(settings);
            const list = Array.isArray(current.aiDownloadedModelIds)
                ? current.aiDownloadedModelIds
                : [];
            const next = list.includes(id) ? list : [...list, id];
            await updateSetting('aiDownloadedModelIds', next);
        } else {
            // A2：仅内存保留，不持久化（刷新后需重新选择文件）
            sessionFile = file;
            ai.update((a) => ({ ...a, sessionModelId: id }));
        }

        ai.update((a) => ({ ...a, state: 'downloaded', progress: null }));

        // 导入即视为选中：更新「当前模型」，使底部通用操作栏作用于刚导入的模型
        await updateSetting('aiModelId', id);
        ai.update((a) => ({ ...a, modelId: id }));
    } catch (e) {
        // 不抛出：避免调用方（UI 事件）产生未捕获的 Promise 拒绝
        ai.update((a) => ({
            ...a,
            state: 'error',
            progress: null,
            error: e?.message || String(e)
        }));
    }
}

/**
 * 导入用户选择的任意本地 GGUF 文件为「自定义模型」。
 * 1) 由 createLocalModel(file) 生成描述符；
 * 2) 去重写入 settings.aiCustomModels（同 id 覆盖，保持顺序）；
 * 3) 复用 importModel 的 cache/session 分流逻辑执行导入。
 * 失败不抛出（importModel 内部已把错误写入 error 状态）。
 * @param {File} file 用户选择的本地 GGUF 文件
 * @returns {Promise<string>} 新模型 id
 */
export async function importCustomModel(file) {
    const model = createLocalModel(file);

    // 去重写入：同 id 原地覆盖以保持既有顺序；否则追加到末尾
    const current = get(settings);
    const list = Array.isArray(current.aiCustomModels) ? current.aiCustomModels : [];
    const next = list.some((item) => item.id === model.id)
        ? list.map((item) => (item.id === model.id ? model : item))
        : [...list, model];

    // 先落库并同步运行态，确保随后的 importModel 能通过 resolveModel 解析到它
    await updateSetting('aiCustomModels', next);
    ai.update((a) => ({ ...a, customModels: next }));

    // 复用既有分流逻辑执行导入（内部已吞掉错误并写入 error 状态）
    await importModel(model.id, file);

    return model.id;
}

/**
 * 载入模型（接通 ai/engine.js）。按当前模式取得模型字节：
 * - 'cache'  → 从 Cache Storage 读 Blob；
 * - 'session'→ 取本次会话内存中的 sessionFile（须与 id 对应）。
 * 成功后写回设置并进入 ready，失败进入 error。
 * 性能模式由设置 `aiPerfMode` 决定（high/balanced/low），切换后需重新载入模型生效。
 * 上下文长度取自设置（resolveContextLength()，范围 4096–51200），切换设置后需重新载入模型生效。
 * @param {string} id 模型 id（推荐模型或自定义模型均可）
 */
export async function loadModel(id) {
    // 移动端硬件门槛不满足（未跨域隔离 / 线程不足）时，直接拦截并提示
    if (get(ai).disabled) {
        ai.update((a) => ({ ...a, state: 'error', error: get(ai).disabledReason }));
        return;
    }

    const model = resolveModel(id);
    if (!model) return;

    /** A1 / A2 模式（默认 A1 缓存） */
    const mode = get(settings).aiModelStorageMode ?? 'cache';

    // 按模式取模型字节（引擎要求显式传入 blob）
    let blob = null;
    if (mode === 'cache') {
        blob = await modelCache.getModelBlob(model);
    } else {
        blob = get(ai).sessionModelId === id ? sessionFile : null;
    }

    if (!blob) {
        ai.update((a) => ({ ...a, state: 'error', error: '请先下载并导入模型文件' }));
        return;
    }

    ai.update((a) => ({
        ...a,
        state: 'loading',
        error: '',
        progress: { percent: 0, file: model.file }
    }));

    try {
        await aiEngine.load(model, {
            blob,
            perfMode: get(settings).aiPerfMode ?? 'high',
            contextLength: resolveContextLength(),
            onProgress: (p) =>
                ai.update((a) => ({
                    ...a,
                    progress: { percent: p?.percent ?? null, file: model.file }
                }))
        });

        await updateSetting('aiModelId', id);
        ai.update((a) => ({ ...a, modelId: id, state: 'ready', progress: null }));

        // 载入后实测线程数：移动端低于门槛则关闭 AI 并卸载，避免不可用状态
        const caps = computeCapability();
        const threads = aiEngine.threads;
        if (!caps.disabled && isMobileDevice() && threads > 0 && threads < MIN_THREADS) {
            await aiEngine.unload();
            ai.update((a) => ({
                ...a,
                state: 'idle',
                progress: null,
                modelId: null,
                disabled: true,
                disabledReason: `实际推理线程数不足（${threads} < ${MIN_THREADS}），已关闭 AI。`
            }));
            return;
        }
    } catch (e) {
        ai.update((a) => ({
            ...a,
            state: 'error',
            progress: null,
            error: e?.message || String(e)
        }));
    }
}

/** 是否已尝试过自动载入（避免重复触发） */
let autoLoadTried = false;

/**
 * 启动时自动载入：仅当「WebGPU 可用」且「当前模型已存在于浏览器缓存（A1）」时触发 loadModel。
 * 不阻塞调用方（内部 await，但错误已被 loadModel 吞掉并写入 error 状态）。
 * @returns {Promise<boolean>} 是否发起了自动载入
 */
export async function autoLoadCachedModel() {
    if (autoLoadTried) return false;
    autoLoadTried = true;

    // 环境不支持则不尝试
    if (!get(ai).supported) return false;
    // 已载入则跳过
    if (aiEngine.ready) return false;

    const id = get(settings)?.aiModelId ?? DEFAULT_MODEL_ID;
    const model = resolveModel(id) ?? resolveModel(DEFAULT_MODEL_ID);
    if (!model) return false;

    // 仅当浏览器缓存中确有该模型时自动载入（A2 会话模式不会命中）
    let cached = false;
    try {
        cached = await modelCache.hasModel(model);
    } catch (_) {
        cached = false;
    }
    if (!cached) return false;

    // loadModel 内部已 try/catch（失败写入 error，不抛出）
    await loadModel(model.id);
    return true;
}

/**
 * 卸载模型（保留本地副本）。状态回落到「已就绪」或「空闲」：
 * 当前模型在 A1 缓存或 A2 会话中仍可用则为 'downloaded'，否则 'idle'。
 */
export async function unloadModel() {
    await aiEngine.unload();
    const s = get(ai);
    // 双模式可用性判定：A1 已缓存 或 A2 本次会话已导入
    const available = s.downloaded.includes(s.modelId) || s.sessionModelId === s.modelId;
    ai.update((a) => ({
        ...a,
        state: available ? 'downloaded' : 'idle',
        progress: null
    }));
}

/**
 * 删除模型的所有本地副本（缓存 + 会话）。
 * 删除的是当前模型时回落到 'idle'；同时清空 progress / error。
 * 若为自定义模型，还额外从 settings.aiCustomModels 中移除其描述符。
 * @param {string} id 模型 id（推荐模型或自定义模型均可）
 */
export async function deleteModel(id) {
    const model = resolveModel(id);
    if (!model) return;

    const isCurrent = get(ai).modelId === id;

    // 当前已载入的正是待删模型：先卸载，释放显存后再删文件
    if (isCurrent && aiEngine.ready) {
        await aiEngine.unload();
    }

    // A1：删除缓存副本（不存在时无害）
    await modelCache.deleteModel(model);

    // 反向写回设置：从已缓存列表移除该 id
    const current = get(settings);
    const list = Array.isArray(current.aiDownloadedModelIds) ? current.aiDownloadedModelIds : [];
    const next = list.filter((item) => item !== id);
    await updateSetting('aiDownloadedModelIds', next);

    // 自定义模型：额外从 settings.aiCustomModels 中移除该描述符并同步运行态
    if (!getModel(id) || model.local) {
        const customList = Array.isArray(current.aiCustomModels) ? current.aiCustomModels : [];
        const nextCustom = customList.filter((item) => item.id !== id);
        await updateSetting('aiCustomModels', nextCustom);
        ai.update((a) => ({ ...a, customModels: nextCustom }));
    }

    // A2：若会话中导入的正是该模型，清空内存副本与 sessionModelId
    if (get(ai).sessionModelId === id) {
        sessionFile = null;
        ai.update((a) => ({ ...a, sessionModelId: null }));
    }

    ai.update((a) => ({
        ...a,
        // 删除的是当前载入 / 选中模型时回落 idle，否则保持原状态
        state: isCurrent ? 'idle' : a.state,
        progress: null,
        error: ''
    }));
}

/**
 * 清除模型缓存：卸载已载入模型、清空 ai-models 缓存、重置已下载列表、所选模型、
 * 自定义模型列表与状态。用于「删除/卸载仍无法移除浏览器缓存」时彻底清理。
 * @returns {Promise<boolean>} 是否成功清空缓存
 */
export async function clearCache() {
    // 先卸载，避免仍在使用缓存
    try {
        if (aiEngine.ready) await aiEngine.unload();
    } catch (_) {
        /* 忽略卸载失败 */
    }

    let ok = false;
    try {
        ok = await modelCache.clearAll();
    } catch (_) {
        ok = false;
    }

    // 重置已下载列表、所选模型、自定义模型与运行态
    try {
        await updateSetting('aiDownloadedModelIds', []);
        await updateSetting('aiModelId', DEFAULT_MODEL_ID);
        await updateSetting('aiCustomModels', []);
    } catch (_) {
        /* 忽略写入失败 */
    }
    ai.update((a) => ({
        ...a,
        state: 'idle',
        progress: null,
        error: '',
        downloaded: [],
        modelId: DEFAULT_MODEL_ID,
        customModels: [],
        modelLabel: getModel(DEFAULT_MODEL_ID)?.label ?? ''
    }));

    return ok;
}

export default ai;
