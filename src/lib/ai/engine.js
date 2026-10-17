/**
 * engine.js — 推理引擎（封装 @wllama/wllama，GGUF + WebGPU）
 * 说明：wllama 内部自带 Worker，推理不阻塞主线程。
 * 模型字节由调用方传入（来自浏览器缓存 A1 或本次会话选择的内存文件 A2），
 * 引擎不负责读取/持久化模型，仅接收显式 Blob 并交给 wllama 推理。
 *
 * ── 勘察结论（依赖 wllama@3.8.1 的类型声明，务必保留）──
 * 1. 裸导入 `@wllama/wllama` 会解析失败：其 package.json 的 main 指向并不存在的 index.js，
 *    且没有 `exports` 字段；必须使用显式子路径：
 *        import { Wllama } from '@wllama/wllama/esm/index.js';
 * 2. wasm 文件位于 `@wllama/wllama/esm/wasm/wllama.wasm`（约 8.4 MiB），用 Vite 的 ?url 引用，
 *    并放入 AssetsPathConfig，键名必须为 "default"（见 wllama.d.ts 的 AssetsPathConfig）。
 * 3. worker 无需配置：wllama 内部以 Blob 内联创建 worker，不需要 `new Worker(new URL(...))` 或 ?url。
 * 4. 离线优先：构造后调用 `wllama.setCompat(null)`，避免走 jsDelivr CDN 的 compat 资源
 *    （见 wllama.d.ts 的 setCompat 注释：compat 默认指向 CDN，需联网；Safari/Firefox 兼容模式才需要）。
 *    本项目以单线程 WebGPU 为主，不启用 compat，保证纯离线可用。
 * 5. 持久化：wllama 自带 CacheManager / ModelManager（默认 OPFS 后端），但仅在
 *    `loadModelFromUrl` / `downloadModel` / `getModelOrDownload` 路径写缓存。
 *    本文件走 `loadModel(Blob[])`（见 wllama.d.ts 第 313 行签名），源码确认该路径不接触
 *    cacheManager/modelManager，只把内存中的 Blob 交给 wasm，因此不会产生重复存储。
 *
 * ── 性能模式与自动降级 ──
 * high（GPU 全层）在缺少 WebGPU / 显存不足 / 移动端驱动异常时会载入失败，因此载入按模式自动降级：
 *   high     → high → balanced → low → compat
 *   balanced → balanced → low → compat
 *   low      → low → compat
 * compat 为极低内存回退（单线程、上下文最多 2048、最小批/微批、关闭预热），只作内部兜底。
 * iOS 上 low 模式强制单线程，避免 shared WebAssembly.Memory 分配失败。
 * 每次尝试使用全新的 Wllama 实例，失败实例立即 exit()，避免残留 Worker / wasm 内存。
 * 实际生效的模式通过 `perfMode` getter 暴露（未载入为 null）。
 * 移动端（无 WebGPU 或未跨域隔离）建议直接使用 balanced / low 的 CPU 兼容模式。
 */
import { Wllama } from '@wllama/wllama/esm/index.js';
import wllamaWasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';

/** wllama 资源路径：键名必须为 "default"（AssetsPathConfig 约定） */
const CONFIG_PATHS = { default: wllamaWasmUrl };

/** 是否 iOS / iPadOS（iPadOS 13+ 可能伪装成 Macintosh） */
function isIOSDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return (
        /iPhone|iPad|iPod/i.test(ua) ||
        (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints) > 1)
    );
}

export class AiEngine {
    constructor() {
        /** @type {Wllama|null} 当前 wllama 实例 */
        this._wllama = null;
        /** @type {string|null} 当前已载入模型的 id */
        this._modelId = null;
        /** @type {object|null} 当前载入配置快照 */
        this._config = null;
        /** @type {('high'|'balanced'|'low'|null)} 实际生效的性能模式（可能因降级与请求值不同） */
        this._perfMode = null;
    }

    /**
     * 载入模型：接收调用方显式传入的 Blob → 交给 wllama（引擎不读取/持久化模型）
     * @param {object} model 模型条目（提供 id / file）
     * @param {object} opts 选项
     * @param {Blob|File} opts.blob 模型字节（由调用方从缓存或会话文件提供）
     * @param {(p:{loaded:number,total:number|null,percent:number|null})=>void} [opts.onProgress] 进度回调
     * @param {('high'|'balanced'|'low')} [opts.perfMode='high'] 性能模式：high=GPU 全层（失败自动降级到 CPU）；balanced=CPU 全速（失败降级 low）；low=CPU 省电（限制线程数）
     * @param {number} [opts.contextLength] 上下文长度（token）；由调用方（设置）传入，缺省 4096
     * @returns {Promise<void>}
     */
    async load(model, { blob, onProgress, perfMode = 'high', contextLength } = {}) {
        // 已载入同一模型：直接返回，避免重复载入
        if (this._wllama && this._modelId === model.id) return;

        // 切换模型：先卸载旧实例
        if (this._wllama) await this.unload();

        if (!blob) {
            throw new Error('未提供模型文件');
        }

        // 请求模式非法时回退 high（与旧实现“非 low/balanced 即 GPU”保持一致）
        const requested =
            perfMode === 'high' || perfMode === 'balanced' || perfMode === 'low' ? perfMode : 'high';
        // 降级顺序：GPU 失败会自动回退到 CPU 兼容模式，最终回退到 compat 极低内存模式
        const attempts =
            requested === 'high'
                ? ['high', 'balanced', 'low', 'compat']
                : requested === 'balanced'
                  ? ['balanced', 'low', 'compat']
                  : requested === 'low'
                    ? ['low', 'compat']
                    : ['compat'];

        // 与模式无关：关闭思考链（避免思考占满预算导致空回复/长时间满载）
        const base = {
            reasoning: false,
            default_template_kwargs: { enable_thinking: false },
            // ── 性能与内存：KV 量化 + FlashAttention + 预热 + 分批；移动端 CPU 可显著降低内存与首 token 延迟 ──
            // KV cache 量化：把 K/V 缓存压到 q8_0（8bit），显著降低长上下文的内存占用（约省一半显存/内存）。
            cache_type_k: 'q8_0',
            // KV cache 量化（V）。注意：llama.cpp 要求量化 V cache 必须搭配 flash_attn:true 才能启用，
            // 二者存在依赖关系，必须同时存在，否则量化 V cache 不会生效（甚至可能报错）。
            cache_type_v: 'q8_0',
            // 加速注意力计算（flash attention），降低注意力阶段的内存占用并提升速度；也是量化 V cache 生效的前提。
            flash_attn: true,
            // 预热：载入后先跑一次空推理，把算子/缓冲/KV 预分配好，消除首次真实推理的“冷启动”卡顿
            // （移动端首 token 需 30-60s 的主因之一，预热后首次真实输出即快）。
            warmup: true,
            // 预填充（prompt 处理）批大小：n_batch 越大吞吐越高但峰值内存越高；512 是速度与内存的折中。
            n_batch: 512,
            // 微批（ubatch）大小：实际计算粒度，128 可在移动端进一步压低峰值内存，避免大批次爆内存。
            n_ubatch: 128,
            // 并行序列数：应用一次只处理一个对话，wllama 默认的 4 会预分配多份 KV/计算缓冲，
            // 设为 1 可显著降低内存占用（移动端尤其重要）。
            n_parallel: 1,
        };
        const cores =
            (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        // 上下文长度由调用方（设置）传入；非法时回退 4096（模型描述符不再自带 contextLength）
        const ctx = Number.isFinite(contextLength) && contextLength > 0 ? Math.floor(contextLength) : 4096;
        /** 按模式构造 loadModel 配置 */
        const buildConfig = (mode) => {
            if (mode === 'compat') {
                // 极低内存回退：单线程 + 最小批/微批 + 关闭预热，并压低上下文，优先保证能载入
                return {
                    ...base,
                    n_gpu_layers: 0,
                    n_ctx: Math.min(ctx, 2048),
                    n_threads: 1,
                    n_parallel: 1,
                    n_batch: 32,
                    n_ubatch: 16,
                    warmup: false,
                };
            }
            if (mode === 'low') {
                // 低功耗：CPU 推理（GPU 让给系统 UI）、限制线程数；上下文不再被性能模式压低。
                // iOS 上强制单线程：多线程会尝试分配 shared WebAssembly.Memory，iOS 可能直接拒绝
                // （表现为 cannot allocate WebAssembly memory）。
                return {
                    ...base,
                    n_gpu_layers: 0,
                    n_ctx: ctx,
                    n_threads: isIOSDevice() ? 1 : Math.max(1, Math.floor(cores / 2)),
                    // 保守分批：更小的批/微批 + 关闭预热，尽量压低移动端峰值内存与载入耗时
                    n_batch: 128,
                    n_ubatch: 64,
                    warmup: false,
                };
            }
            if (mode === 'balanced') {
                // 均衡：仍用 CPU 推理（部分层上 GPU 在移动端 WebGPU 可能算错），线程数接近全速
                return {
                    ...base,
                    n_gpu_layers: 0,
                    n_ctx: ctx,
                    n_threads: Math.max(1, cores - 1),
                };
            }
            // 性能优先：全部层上 GPU
            return {
                ...base,
                n_gpu_layers: -1,
                n_ctx: ctx,
            };
        };

        // loadModel 只支持 Blob[]/Model，不接受进度回调（LoadModelParams 无 progressCallback），
        // 因此对 Blob 直传路径给出合成进度：开始 0%、完成 100%（重试期间不重复上报 100%）。
        if (onProgress) onProgress({ loaded: 0, total: blob.size, percent: 0 });

        const tried = [];
        let lastError = null;

        for (const mode of attempts) {
            tried.push(mode);
            // 每次尝试都必须新建实例：失败实例的内部状态不可复用
            const wllama = new Wllama(CONFIG_PATHS);
            // 关闭 compat（否则会走 CDN），保证离线可用；见文件顶部结论 4
            wllama.setCompat(null);
            const config = buildConfig(mode);

            try {
                // Blob 直传：不落 wllama 自带缓存，避免重复持久化（见文件顶部结论 5）
                await wllama.loadModel([blob], config);
            } catch (error) {
                // 该模式载入失败：清理实例后继续降级，避免残留 Worker / wasm 内存
                lastError = error;
                try {
                    await wllama.exit();
                } catch (_) {
                    /* 忽略清理异常 */
                }
                continue;
            }

            // 成功：记录实际生效的实例与模式
            this._wllama = wllama;
            this._modelId = model.id;
            this._config = config;
            this._perfMode = mode;

            if (onProgress) onProgress({ loaded: blob.size, total: blob.size, percent: 100 });
            return;
        }

        // 全部模式失败：拼接错误信息（先算 detail，避免 ?. 与 + 的优先级陷阱）
        const detail = lastError?.message || String(lastError);
        throw new Error(
            '模型载入失败（已尝试 ' +
                tried.join('/') +
                '）：' +
                detail +
                '。如果仍失败，可能是设备内存不足，请尝试更小的模型或降低上下文。'
        );
    }

    /**
     * 卸载实例
     * @returns {Promise<void>}
     */
    async unload() {
        const wllama = this._wllama;
        this._wllama = null;
        this._modelId = null;
        this._config = null;
        this._perfMode = null;
        if (wllama) {
            try {
                // 方法名依据 wllama.d.ts 第 380 行的 exit()
                await wllama.exit();
            } catch (_) {
                /* 吞掉卸载异常 */
            }
        }
    }

    /**
     * 释放（页面卸载时）：等同 unload
     * @returns {Promise<void>}
     */
    async dispose() {
        await this.unload();
    }

    /**
     * 原始流式补全：把 wllama 的 OpenAI 风格流式 chunk 原样透传给 onChunk（不做任何归一化/清洗）。
     * 供 AI SDK provider 桥接使用。
     * @param {object} params OpenAI 风格请求体：{ messages, tools?, max_tokens?, temperature?, top_k?, top_p?, chat_template_kwargs? }
     * @param {(chunk:object)=>void} onChunk 每收到一个流式 chunk（ChatCompletionChunk）回调一次
     * @param {AbortSignal} [signal] 外部中止信号
     * @returns {Promise<void>} 正常完成或中止时 resolve；底层异常抛出
     */
    async createChatCompletionStream(params, onChunk, signal) {
        if (!this._wllama) {
            throw new Error('模型尚未载入，请先载入模型');
        }

        try {
            // 强制 stream:true，并把每个原始 chunk 直接交给 onChunk（透传，不归一化）。
            // abortSignal 由 wllama 原生支持（oai-compat.d.ts ChatCompletionParams.abortSignal），
            // 触发时 wllama 抛 WllamaAbortError（name 实际为 "AbortError"）。
            await this._wllama.createChatCompletion({
                ...params,
                stream: true,
                abortSignal: signal,
                onData: onChunk,
            });
        } catch (error) {
            // 主动中止（外部 signal 或内部 abort）视为正常结束，静默返回；其它异常原样抛出。
            if (error?.name === 'AbortError' || signal?.aborted) return;
            throw error;
        }
    }

    /** 是否已就绪 */
    get ready() {
        return Boolean(this._wllama);
    }

    /** 实际生效的性能模式：'high'|'balanced'|'low'|'compat'；未载入为 null */
    get perfMode() {
        return this._perfMode;
    }

    /** 当前推理线程数；未载入模型返回 0 */
    get threads() {
        try {
            return this._wllama ? this._wllama.getNumThreads() : 0;
        } catch (_) {
            return 0;
        }
    }

    /** 当前上下文长度（token）；未载入默认 0 */
    get contextLength() {
        return this._wllama && this._config && Number.isFinite(this._config.n_ctx) ? this._config.n_ctx : 0;
    }
}

export const aiEngine = new AiEngine();
export default aiEngine;
