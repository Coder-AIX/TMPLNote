/**
 * models.js — 本地模型注册表（纯数据 + 纯函数，无副作用、无推理库依赖）
 *
 * 职责：
 * - 声明「推荐模型」的 GGUF 元数据（id / 仓库 / 文件名 / 量化 / 上下文长度等）；
 * - 支持由用户本地文件构造「自定义模型」描述符；
 * - 提供按 id 查询、组装下载直链、统一缓存键、探测 WebGPU 支持等纯函数工具。
 *
 * 约定：
 * - 本文件严禁 import 任何推理运行时（WebLLM / wllama 等），运行时在后续阶段引入；
 * - 下载直链采用「镜像 + 仓库 + resolve/main + 文件名」形式，mirror 末尾斜杠容错；
 * - mirror 为普通镜像基址（默认 https://hf-mirror.com）；交由浏览器原生下载，
 *   由用户选择本地文件导入，不再经同源代理。
 */

/** 默认下载镜像（国内加速） */
export const DEFAULT_MIRROR = 'https://hf-mirror.com';

/** 默认模型 id（首次运行 / 未配置时使用） */
export const DEFAULT_MODEL_ID = 'qwen3.5-0.8b-q8_0';

/**
 * 模型条目描述符
 * @typedef {Object} ModelDescriptor
 * @property {string}  id                   唯一标识（用于持久化与查找）
 * @property {string}  label                展示名称
 * @property {string}  format               模型格式，如 'gguf'
 * @property {string}  repo                 Hugging Face 仓库（owner/name）
 * @property {string}  mirror               下载镜像基址（如 https://hf-mirror.com；不含末尾斜杠亦可）
 * @property {string}  file                 仓库内模型文件名
 * @property {number}  sizeMB               文件体积（MB，约数）
 * @property {number}  nativeContextLength  模型原生上下文长度（token）
 * @property {string}  quantization         量化方案，如 'Q4_K_M'
 * @property {boolean} chatTemplate         是否内置对话模板
 * @property {boolean} multimodal           是否多模态（当前仅使用文本能力）
 * @property {string}  note                 备注说明
 * @property {string}  platform             目标平台（'pc' | 'mobile'）
 * @property {string}  tier                 性能档位（'pc' | 'mobile'）
 * @property {boolean} [local]              是否为本地导入的自定义模型
 */

/**
 * 推荐模型列表（仅保留 Qwen3.5 系列：PC 推荐 Q8_0、移动端推荐 Q4_0）
 * @type {ModelDescriptor[]}
 */
export const RECOMMENDED_MODELS = [
    {
        id: 'qwen3.5-0.8b-q8_0',
        label: 'Qwen3.5 0.8B (Q8_0)',
        format: 'gguf',
        repo: 'unsloth/Qwen3.5-0.8B-GGUF',
        mirror: DEFAULT_MIRROR,
        file: 'Qwen3.5-0.8B-Q8_0.gguf',
        sizeMB: 850,
        nativeContextLength: 32768,
        quantization: 'Q8_0',
        chatTemplate: true,
        multimodal: false,
        note: 'PC 推荐',
        platform: 'pc',
        tier: 'pc'
    },
    {
        id: 'qwen3.5-0.8b-q4_0',
        label: 'Qwen3.5 0.8B (Q4_0)',
        format: 'gguf',
        repo: 'unsloth/Qwen3.5-0.8B-GGUF',
        mirror: DEFAULT_MIRROR,
        file: 'Qwen3.5-0.8B-Q4_0.gguf',
        sizeMB: 450,
        nativeContextLength: 32768,
        quantization: 'Q4_0',
        chatTemplate: true,
        multimodal: false,
        note: '移动端推荐',
        platform: 'mobile',
        tier: 'mobile'
    }
];

/**
 * 兼容别名：旧代码仍 import { MODELS } 使用推荐列表。
 * @type {ModelDescriptor[]}
 */
export const MODELS = RECOMMENDED_MODELS;

/**
 * 按 id 查找推荐模型
 * @param {string} id 模型标识
 * @returns {ModelDescriptor|undefined} 命中则返回条目，否则 undefined
 */
export function getModel(id) {
    return RECOMMENDED_MODELS.find((model) => model.id === id);
}

/**
 * 简单稳定的 32 位 djb2 哈希（纯函数、同步，不依赖 crypto）。
 * @param {string} str 待哈希字符串
 * @returns {string} 36 进制短哈希（定长 7 位）
 */
function djb2ShortHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36).padStart(7, '0');
}

/**
 * 由用户选择的本地 GGUF 文件构造「自定义模型」描述符。
 * id 由文件名 + 文件大小派生（同一文件重复导入得到同一 id，便于去重/持久化）。
 * @param {File} file 本地文件（或形如 { name, size } 的对象）
 * @returns {object} 描述符（local:true）
 */
export function createLocalModel(file) {
    const name = (file && file.name) || '';
    const size = (file && file.size) || 0;

    // 去掉结尾的 .gguf（不区分大小写）
    const base = name.replace(/\.gguf$/i, '');

    const label = base || '本地模型';

    // slug：小写后保留字母/数字（含中文），其余替换为 '-'，再压缩/去首尾
    const slug = (base.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join('-') || 'model';

    const shortHash = djb2ShortHash(`${name}:${size}`);
    const id = `local-${slug}-${shortHash}`;

    return {
        id,
        label,
        format: 'gguf',
        local: true,
        file: name,
        sizeMB: Math.max(1, Math.round(size / 1048576)),
        nativeContextLength: 32768,
        quantization: '',
        multimodal: false,
        chatTemplate: true,
        note: '本地导入'
    };
}

/**
 * 模型在其缓存(Cache Storage)中的键。
 * - 推荐模型：沿用下载直链 modelUrl(model)（保持既有缓存兼容）；
 * - 自定义模型：使用 `local://${model.id}`（无下载地址）。
 * @param {object|null|undefined} model
 * @returns {string}
 */
export function modelCacheKey(model) {
    if (!model) return '';
    if (model.local) return `local://${model.id}`;
    return modelUrl(model);
}

/**
 * 组装模型文件的下载直链
 * 形式：`${mirror}/${repo}/resolve/main/${file}`；mirror 末尾斜杠会先行去除。
 * @param {ModelDescriptor|undefined|null} model 模型条目
 * @returns {string} 直链；model/mirror/repo/file 任一缺失时返回空串
 */
export function modelUrl(model) {
    if (!model || !model.mirror || !model.repo || !model.file) return '';
    const mirror = String(model.mirror).replace(/\/$/, '');
    return `${mirror}/${model.repo}/resolve/main/${model.file}`;
}

/**
 * 生成供浏览器原生下载的绝对链接（触发另存为，不经 CORS）。
 * 与 modelUrl 的区别：额外带 ?download=true，且始终为绝对地址。
 * @param {ModelDescriptor|undefined|null} model 模型条目
 * @returns {string} 下载链接；字段缺失时返回空串
 */
export function downloadUrl(model) {
    const url = modelUrl(model);
    return url ? `${url}?download=true` : '';
}

/**
 * 检测当前环境是否支持 WebGPU
 * @returns {boolean} navigator.gpu 是否可用
 */
export function isWebGPUSupported() {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export default { DEFAULT_MIRROR, DEFAULT_MODEL_ID, MODELS, RECOMMENDED_MODELS, getModel, createLocalModel, modelCacheKey, modelUrl, downloadUrl, isWebGPUSupported };
