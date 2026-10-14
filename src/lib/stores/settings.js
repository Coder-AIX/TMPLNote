/**
 * settings.js — 应用设置 store
 *
 * 职责：
 * 1. 持有设置状态（响应式）；
 * 2. 解析「暗色」结果（跟随系统 or 手动）并应用到 <html>.dark；
 * 3. 读写持久化（IndexedDB settings 仓库）；
 * 4. 维护 localStorage 镜像，供 index.html 内联脚本首绘前应用主题（防闪烁）；
 * 5. 上下文长度范围常量与「按设备推荐默认值」的解析。
 */
import { writable, derived, get } from 'svelte/store';
import settingsRepository, { DEFAULT_SETTINGS } from '../db/settings.js';
import { RECOMMENDED_MODELS } from '../ai/models.js';

/** localStorage 镜像键（须与 index.html 内联脚本保持一致） */
export const THEME_MIRROR_KEY = 'tmplnote:theme';

/** 上下文长度可调范围与步进（token） */
export const CONTEXT_MIN = 4096;
export const CONTEXT_MAX = 51200;
export const CONTEXT_STEP = 1024;

/** 粗略判断当前是否为移动设备（用于选择默认上下文推荐值） */
export function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    const uaData = navigator.userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
    const ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
}

/** 把任意输入夹取到 [CONTEXT_MIN, CONTEXT_MAX]；非法值回退 CONTEXT_MIN */
export function clampContextLength(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v <= 0) return CONTEXT_MIN;
    return Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, v));
}

/** 取「生效的上下文长度」（夹取后）；默认读取当前 settings store */
export function resolveContextLength(value = get(settings)) {
    const s = value || DEFAULT_SETTINGS;
    return clampContextLength(s.aiContextLength);
}

/**
 * 按设备选择默认模型 id：移动端 -> platform 'mobile' 的推荐；否则 -> 'pc' 的推荐。
 * 找不到时回退 RECOMMENDED_MODELS 第一项。
 * @returns {string}
 */
export function defaultModelIdForDevice() {
    const want = isMobileDevice() ? 'mobile' : 'pc';
    const hit = RECOMMENDED_MODELS.find((m) => m.platform === want);
    return hit?.id ?? RECOMMENDED_MODELS[0]?.id ?? '';
}

const mql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

/** 系统当前是否偏好深色 */
export const systemDark = writable(mql ? mql.matches : false);

/** 全部设置（含默认值） */
export const settings = writable({ ...DEFAULT_SETTINGS });

/** 最终是否深色：跟随系统时取系统值，否则取手动值 */
export const resolvedDark = derived([settings, systemDark], ([$settings, $systemDark]) =>
    $settings.followSystem ? $systemDark : Boolean($settings.dark)
);

/** 语义别名，便于 UI 直接引用 */
export const isDark = resolvedDark;

/** 设置加载完成信号（App 在决定是否锁屏前 await 它） */
let markReady;
export const settingsReady = new Promise((resolve) => {
    markReady = resolve;
});

if (typeof document !== 'undefined') {
    // 应用主题类名
    resolvedDark.subscribe((dark) => {
        document.documentElement.classList.toggle('dark', dark);
    });
    // 写入镜像（仅主题相关字段）
    settings.subscribe((value) => {
        try {
            localStorage.setItem(
                THEME_MIRROR_KEY,
                JSON.stringify({ followSystem: value.followSystem, dark: value.dark })
            );
        } catch (_) {
            /* 忽略：隐私模式等场景下不可写不影响功能 */
        }
    });
}

if (mql && typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', (event) => systemDark.set(event.matches));
}

/** 从 IndexedDB 载入设置并与默认值合并（幂等；应用启动时调用一次） */
export async function loadSettings() {
    try {
        const stored = await settingsRepository.all();
        const merged = { ...DEFAULT_SETTINGS, ...stored };
        if (stored.aiContextLength === undefined) {
            merged.aiContextLength = clampContextLength(
                isMobileDevice() ? merged.aiContextLengthMobile : merged.aiContextLengthPc
            );
        }

        // 模型 id：首跑或持久化的 id 已失效（如旧的 functiongemma）时，按设备改为对应推荐
        const knownIds = new Set(RECOMMENDED_MODELS.map((m) => m.id));
        const customIds = new Set((merged.aiCustomModels ?? []).map((m) => m.id));
        if (!merged.aiModelId || (!knownIds.has(merged.aiModelId) && !customIds.has(merged.aiModelId))) {
            merged.aiModelId = defaultModelIdForDevice();
        }
        settings.set(merged);
    } catch (error) {
        console.warn('加载设置失败，使用默认值：', error);
    } finally {
        markReady();
    }
}

/** 更新单个设置项（先更新内存，再持久化） */
export async function updateSetting(key, value) {
    settings.update((current) => ({ ...current, [key]: value }));
    try {
        await settingsRepository.set(key, value);
    } catch (error) {
        console.warn(`保存设置「${key}」失败：`, error);
    }
}

export default settings;
