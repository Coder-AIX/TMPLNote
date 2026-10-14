/**
 * cache.js — GGUF 模型缓存（Cache Storage）
 * 缓存名：ai-models；键：由 modelCacheKey(model) 统一决定（单文件 GGUF → 单条目）。
 *
 * 键规则：
 * - 推荐模型：使用其下载直链（modelUrl(model)），保持与历史缓存兼容；
 * - 自定义导入模型（无下载地址）：使用 local://${model.id} 形式的本地键。
 *   此类键不含文件名，故 deleteModel 中「按 model.file 扫描历史键」的次级清理
 *   对其为无害的 no-op。
 *
 * 说明：
 * - 应用不再以 fetch 下载模型（会受 CORS 限制），而是由用户用浏览器原生链接
 *   下载 GGUF 文件后，通过 importModel 将「本地文件」导入缓存，供后续反复载入；
 * - 仅运行于浏览器环境，依赖 caches / Response / ReadableStream / Blob.stream 等 Web API；
 * - 只缓存「所选路径」对应的单个文件，不做多文件/整仓缓存；
 * - 导入中断或失败时清理半成品条目，避免污染缓存。
 */
import { modelCacheKey } from './models.js';

/** 缓存名（与 vite.config.js / 后续可能的 SW 运行时缓存保持一致） */
export const AI_CACHE_NAME = 'ai-models';

/**
 * 是否已缓存该模型
 * @param {object} model 模型条目
 * @returns {Promise<boolean>} 缓存中存在对应条目则为 true
 */
export async function hasModel(model) {
    const key = modelCacheKey(model);
    if (!key) return false;
    const cache = await caches.open(AI_CACHE_NAME);
    const response = await cache.match(key);
    return Boolean(response);
}

/**
 * 读取已缓存模型为 Blob（供载入）
 * @param {object} model 模型条目
 * @returns {Promise<Blob|null>} 命中缓存返回 Blob，否则 null
 */
export async function getModelBlob(model) {
    const key = modelCacheKey(model);
    if (!key) return null;
    const cache = await caches.open(AI_CACHE_NAME);
    const response = await cache.match(key);
    if (!response || !response.ok) return null;
    return response.blob();
}

/** 删除模型缓存；同时清理同一文件的其它历史键（如基址变化导致的旧条目）。返回是否有删除。 */
export async function deleteModel(model) {
    const cache = await caches.open(AI_CACHE_NAME);
    let removed = false;
    const key = modelCacheKey(model);
    if (key) {
        removed = (await cache.delete(key)) || removed;
    }
    if (model?.file) {
        const keys = await cache.keys();
        for (const req of keys) {
            if (req.url.includes(model.file)) {
                await cache.delete(req);
                removed = true;
            }
        }
    }
    return removed;
}

/** 清空全部模型缓存（删除整个 ai-models 缓存）。 */
export async function clearAll() {
    return caches.delete(AI_CACHE_NAME);
}

/**
 * 将用户选择的本地 GGUF 文件导入缓存（Cache Storage），供后续反复载入。
 * 不发起任何网络请求，故无 CORS 问题。
 * @param {object} model 模型条目
 * @param {File|Blob} file 用户选择的本地文件
 * @param {object} [opts]
 * @param {(p:{loaded:number,total:number|null,percent:number|null})=>void} [opts.onProgress]
 * @returns {Promise<{size:number}>} 导入字节数
 */
export async function importModel(model, file, { onProgress } = {}) {
    // 1) 缓存键来自 modelCacheKey（推荐模型=下载直链，自定义模型=local://），未配置则无法定位条目
    const key = modelCacheKey(model);
    if (!key) throw new Error('模型地址未配置');

    // 2) 校验文件有效性
    if (!file || typeof file.size !== 'number' || file.size <= 0) {
        throw new Error('未选择有效的模型文件');
    }

    // 3) 打开缓存
    const cache = await caches.open(AI_CACHE_NAME);

    // 4) 读取本地文件流，边读边累计字节并回调进度（total 恒为 file.size）
    const total = file.size;
    let loaded = 0;

    // 包装可读流：把 file.stream() 的数据透传并累计进度
    const source = file.stream();
    const stream = new ReadableStream({
        async start(controller) {
            const reader = source.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    loaded += value.byteLength;
                    if (onProgress) {
                        onProgress({
                            loaded,
                            total,
                            percent: total ? Math.round((loaded / total) * 100) : null,
                        });
                    }
                    controller.enqueue(value);
                }
                controller.close();
            } catch (error) {
                controller.error(error);
            } finally {
                reader.releaseLock();
            }
        },
        cancel(reason) {
            // 下游取消时同步终止底层读取
            return source.cancel(reason);
        },
    });

    try {
        // 5) 写入缓存（以通用二进制类型存放，供引擎按字节载入）
        await cache.put(
            key,
            new Response(stream, {
                headers: { 'Content-Type': 'application/octet-stream' },
            }),
        );
        // 6) 返回实际导入字节数
        return { size: loaded };
    } catch (error) {
        // 失败或中断：清理半成品条目
        try {
            await cache.delete(key);
        } catch (cleanupError) {
            console.warn('清理模型缓存失败：', cleanupError);
        }
        throw error;
    }
}

export default {
    AI_CACHE_NAME,
    hasModel,
    getModelBlob,
    deleteModel,
    clearAll,
    importModel,
};
