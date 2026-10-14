/**
 * aiPermission.js — AI 写操作授权网关
 *
 * 约束：AI 任何会「修改 IndexedDB」的动作，必须先经用户确认（允许 / 拒绝）。
 * 流程：调用方 await requestAiPermission({...}) → 全局弹窗展示 → 用户决定 → Promise 以 boolean 兑现。
 * 展示组件：src/lib/components/AiPermissionDialog.svelte（全局挂载）。
 */
import { writable } from 'svelte/store';

/** 当前待处理的授权请求：{ id, title, detail } | null（null 表示无请求，弹窗关闭） */
export const permissionRequest = writable(null);

/** 当前请求的 Promise 兑现函数（同一时刻仅一个请求） */
let resolver = null;

/**
 * 请求用户授权。返回 Promise：用户「允许」→ true；「拒绝」/关闭 → false。
 * @param {object} req
 * @param {string} req.title   动作标题（如「创建笔记」）
 * @param {string} [req.detail] 说明（如将执行的操作与影响）
 * @returns {Promise<boolean>}
 */
export function requestAiPermission({ title, detail = '' } = {}) {
    // 若已有未决请求：先以拒绝兑现旧的，避免悬挂
    if (resolver) {
        const prev = resolver;
        resolver = null;
        prev(false);
    }
    return new Promise((resolve) => {
        resolver = resolve;
        permissionRequest.set({
            id: (globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}`),
            title: String(title ?? ''),
            detail: String(detail ?? '')
        });
    });
}

/** 用户「允许」：兑现 true 并关闭弹窗 */
export function allowPermission() {
    const resolve = resolver;
    resolver = null;
    permissionRequest.set(null);
    if (resolve) resolve(true);
}

/** 用户「拒绝」/关闭弹窗：兑现 false */
export function denyPermission() {
    const resolve = resolver;
    resolver = null;
    permissionRequest.set(null);
    if (resolve) resolve(false);
}

/** 是否存在待处理请求 */
export function hasPendingPermission() {
    return Boolean(resolver);
}

export default { permissionRequest, requestAiPermission, allowPermission, denyPermission, hasPendingPermission };
