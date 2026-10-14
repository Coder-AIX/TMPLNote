/**
 * trashScheduler.js — 回收站定时清理调度器
 *
 * 应用启动时调用 startTrashPurge()：立即清理一次，之后每小时清理一次。
 * 保留天数取自设置 trashRetentionDays；0 或非法值表示永久保留（不自动删除）。
 */
import { get } from 'svelte/store';
import notesRepository from '../db/notes.js';
import { settings } from '../stores/settings.js';
import { bumpNotes } from '../stores/workspace.js';

/** 清理间隔：1 小时 */
const INTERVAL_MS = 60 * 60 * 1000;

let timer = null;

/** 依据当前设置执行一次清理，返回被删除数量 */
export async function purgeExpiredNow() {
    const days = Number(get(settings)?.trashRetentionDays ?? 30);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const removed = await notesRepository.purgeExpired(days);
    if (removed > 0) bumpNotes();
    return removed;
}

/** 注册定时清理（幂等：重复调用不会叠加定时器） */
export function startTrashPurge() {
    if (timer !== null) return;
    purgeExpiredNow().catch(() => {});
    timer = setInterval(() => {
        purgeExpiredNow().catch(() => {});
    }, INTERVAL_MS);
}

/** 停止定时清理 */
export function stopTrashPurge() {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
}
