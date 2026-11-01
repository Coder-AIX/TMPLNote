/**
 * baiduAuto.js — 百度网盘自动同步/备份的状态机、口令会话与调度器
 *
 * 为什么需要这一层：
 * - 自动备份要同时满足「已配置、已启用、已解锁、在线、页面可见、访问锁未锁定、
 *   用户空闲、距上次运行足够久、没有进行中的任务」等多个条件，分散到 UI 很难保证一致；
 * - 调度还包含数据变化防抖、周期兜底、联网/回前台触发与失败退避；
 * - 口令只能在模块内存（会话）与 secrets 加密记录中出现，绝不能进入 settings、
 *   baiduAutoState 或日志。
 *
 * Phase 1 只执行自动备份（runAutoBackup），不调用 Phase 2 的双向同步引擎。
 */
import { writable, get } from 'svelte/store';
import { settings, settingsReady, updateSetting } from './settings.js';
import { DEFAULT_SETTINGS } from '../db/settings.js';
import { locked } from './security.js';
import { notesVersion, foldersVersion } from './workspace.js';
import { verifyToken } from '../baidu/client.js';
import { runAutoBackup, computeLocalFingerprint } from '../baidu/autoBackup.js';
import { assertPassword } from '../baidu/archiveCrypto.js';
import {
    saveAutoPassphrase,
    loadAutoPassphrase,
    hasStoredAutoPassphrase,
    clearAutoPassphrase,
    createPassphraseCheck,
    verifyPassphraseCheck
} from '../baidu/secretStore.js';

/** 调度器巡检间隔：30 秒 */
const CHECK_INTERVAL_MS = 30 * 1000;

/** 本地数据变化后的防抖时间：90 秒 */
const CHANGE_DEBOUNCE_MS = 90 * 1000;

/** 自动运行前的用户空闲要求：30 秒 */
const IDLE_BEFORE_AUTO_MS = 30 * 1000;

/** 两次自动运行之间的最小间隔：60 秒 */
const MIN_AUTO_GAP_MS = 60 * 1000;

/** 自动运行失败后的重试间隔下限：5 分钟 */
const RETRY_AFTER_FAIL_MS = 5 * 60 * 1000;

/** 联网、回到前台后的触发延迟：3 秒 */
const TRIGGER_DELAY_MS = 3 * 1000;

/** 应用启动后首次检查延迟：15 秒 */
const START_DELAY_MS = 15 * 1000;

/** 启用成功后首次运行延迟：5 秒 */
const ENABLE_DELAY_MS = 5 * 1000;

/** 允许的自动周期（分钟） */
const INTERVAL_OPTIONS = [15, 30, 60, 180, 1440];

/** 默认周期（分钟） */
const DEFAULT_INTERVAL = 30;

/** 默认保留份数 */
const DEFAULT_KEEP_COUNT = 7;

/** 状态初值（字段严格对应契约 §6.2） */
const INITIAL_STATE = {
    ready: false,
    configured: false,
    enabled: false,
    backupEnabled: true,
    syncEnabled: false,
    intervalMinutes: DEFAULT_INTERVAL,
    keepCount: DEFAULT_KEEP_COUNT,
    busy: false,
    phase: '',
    progressText: '',
    lastBackupAt: 0,
    lastBackupName: '',
    lastSyncAt: 0,
    lastError: '',
    authExpired: false,
    storedPassphrase: false,
    unlocked: false,
    conflicts: [],
    nextRunAt: 0
};

/** 自动同步/备份状态（只读消费；不包含 token、口令、密钥） */
export const baiduAutoState = writable({ ...INITIAL_STATE });

/* —— 以下均为模块内存状态，不进入 store / settings —— */

/** 当前会话口令（仅内存） */
let sessionPassphrase = '';

/** 当前会话口令是否来自已保存的加密记录（用于「清除已保存口令」的语义） */
let sessionPassphraseFromStore = false;

/** 最近一次键盘/指针输入时间 */
let lastInputAt = 0;

/** 最近一次自动运行（含成功、失败、指纹跳过）的时间 */
let lastAutoAt = 0;

/** 失败退避截止时间：自动模式在此之前不再尝试（手动运行不受限） */
let retryNotBefore = 0;

/** 单飞：进行中的运行 Promise */
let inflight = null;

/** 调度器是否已注册（防重复监听 / 防 HMR 重复注册） */
let schedulerStarted = false;

/** 初始化是否已启动（模块级 started） */
let started = false;

/** 初始化 Promise */
let initPromise = null;

/** 30 秒巡检定时器 */
let checkTimer = null;

/** 短延迟触发的单次定时器（联网、回前台、启用后首次运行等） */
let scheduledTimer = null;

/** 初始化完成信号 */
let readyResolved = false;
let resolveReady = () => {};
export const baiduAutoReady = new Promise((resolve) => {
    resolveReady = resolve;
});

/**
 * 把任意值规范为自动周期：只允许 15/30/60/180/1440，其余回退 30。
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeInterval(value) {
    const numeric = Number(value);
    return INTERVAL_OPTIONS.includes(numeric) ? numeric : DEFAULT_INTERVAL;
}

/**
 * 把任意值规范为保留份数：夹取到 1–100，非法值回退 7。
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeKeepCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_KEEP_COUNT;
    return Math.min(100, Math.max(1, Math.trunc(numeric)));
}

/**
 * 读取 settings.baiduAuto 并与默认值合并。
 * stores/settings.js 使用浅合并，旧数据可能缺少嵌套字段，因此这里必须再合并一次。
 *
 * @param {object|undefined} value
 * @returns {object}
 */
function mergeAuto(value) {
    const base = DEFAULT_SETTINGS.baiduAuto || {};
    return { ...base, ...(value && typeof value === 'object' ? value : {}) };
}

/**
 * 生成设备标识（不用于安全用途，仅用于自动备份文件名）。
 *
 * @returns {string}
 */
function generateDeviceId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 判断当前是否在线。无 navigator 的环境（Node 测试）按在线处理。
 *
 * @returns {boolean}
 */
function isOnline() {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine !== false;
}

/**
 * 判断页面是否可见。无 document 的环境（Node 测试）按可见处理。
 *
 * @returns {boolean}
 */
function isPageVisible() {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
}

/**
 * 对错误文本做脱敏：移除 token 与口令片段。
 * 任何用户可见错误、持久化错误都必须先经过这里。
 *
 * @param {unknown} error
 * @param {string} [secret] 已知的敏感原值（token / 口令），避免原文泄漏。
 * @returns {string}
 */
function sanitizeError(error, secret) {
    let text = '';
    if (error && typeof error.message === 'string') {
        text = error.message;
    } else if (typeof error === 'string') {
        text = error;
    } else if (error !== undefined && error !== null) {
        text = String(error);
    }

    text = text.replace(/access_token\s*=\s*[^&\s"'<>]+/gi, 'access_token=***');
    text = text.replace(/X-Baidu-Token\s*:\s*[^\s"'<>]+/gi, 'X-Baidu-Token: ***');

    // 已知敏感值即使出现在其它位置也一并抹去，避免意外回显
    const secrets = [secret, sessionPassphrase];
    for (const item of secrets) {
        const value = typeof item === 'string' ? item.trim() : '';
        if (value) text = text.split(value).join('***');
    }

    const trimmed = text.trim();
    return trimmed || '自动备份失败，请稍后重试。';
}

/**
 * 错误分类（契约 §6.9）。
 *
 * @param {unknown} error
 * @param {string} [secret] 已知敏感原值。
 * @returns {{message: string, authExpired: boolean}}
 */
function classifyAutoError(error, secret) {
    const raw = error && typeof error.message === 'string' ? error.message : '';
    const message = sanitizeError(error, secret);
    const code = Number(error?.code);
    const authCodes = [-6, 111, 20017, 31045];

    const authByCode = Number.isFinite(code) && authCodes.includes(code);
    const authByMessage =
        /access_token/i.test(raw) && /(无效|过期|invalid|expired)/i.test(raw);

    return { message, authExpired: authByCode || authByMessage };
}

/**
 * 合并更新 state（只做浅合并，不触碰模块内存）。
 *
 * @param {object} patch
 */
function patchState(patch) {
    baiduAutoState.update((current) => ({ ...current, ...patch }));
}

/**
 * 标记初始化/首次可用完成。
 */
function markReady() {
    patchState({ ready: true });
    if (!readyResolved) {
        readyResolved = true;
        resolveReady();
    }
}

/**
 * 设置下一次运行时间，并为 30 秒内的短延迟注册一次性定时器。
 * 更远的计划交给 30 秒巡检兜底，避免长期定时器漂移。
 *
 * @param {number} at 毫秒时间戳；0 表示取消计划。
 */
function setNextRun(at) {
    const value = Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0;
    patchState({ nextRunAt: value });

    if (scheduledTimer !== null) {
        clearTimeout(scheduledTimer);
        scheduledTimer = null;
    }
    if (!value) return;

    const delay = value - Date.now();
    if (delay > 0 && delay <= CHECK_INTERVAL_MS) {
        scheduledTimer = setTimeout(() => {
            scheduledTimer = null;
            checkDue();
        }, delay + 20);
    }
}

/**
 * 若已启用，则在指定延迟后安排一次检查。
 *
 * @param {number} delay 毫秒
 */
function scheduleSoon(delay) {
    if (!get(baiduAutoState).enabled) return;
    setNextRun(Date.now() + delay);
}

/**
 * 调度巡检：到期时尝试自动运行；未到期或未启用直接返回。
 */
function checkDue() {
    const snapshot = get(baiduAutoState);
    if (!snapshot.enabled || !snapshot.configured) return;
    if (!snapshot.nextRunAt) return;
    if (Date.now() < snapshot.nextRunAt) return;

    runAuto({ manual: false, force: false }).catch(() => {
        // 自动运行失败只更新状态，不向 UI 抛错
    });
}

/**
 * 从 settings 同步状态。这里会读取持久化字段，但不会覆盖 busy / unlocked 等会话字段。
 *
 * @param {object} auto 已合并默认值的 baiduAuto 对象
 * @param {object} current 当前 settings
 * @returns {object} 需要写入 state 的补丁
 */
function buildSettingsPatch(auto, current) {
    return {
        configured: Boolean(current.baiduAccessToken && current.baiduAppPath),
        enabled: Boolean(auto.enabled),
        backupEnabled: auto.backupEnabled !== false,
        // Phase 1 强制关闭双向同步，只保留字段供 Phase 2 使用
        syncEnabled: false,
        intervalMinutes: normalizeInterval(auto.intervalMinutes),
        keepCount: normalizeKeepCount(auto.keepCount),
        lastBackupAt: Number(auto.lastBackupAt) || 0,
        lastBackupName: typeof auto.lastBackupName === 'string' ? auto.lastBackupName : '',
        lastSyncAt: Number(auto.lastSyncAt) || 0,
        lastError: typeof auto.lastError === 'string' ? auto.lastError : '',
        authExpired: Boolean(auto.authExpired)
    };
}

/**
 * 尝试从 secrets 读取已保存口令放入会话。
 *
 * @returns {Promise<boolean>} 是否成功读取。
 */
async function loadStoredPassphraseToSession() {
    try {
        const value = await loadAutoPassphrase();
        if (!value) {
            patchState({ unlocked: false });
            return false;
        }
        sessionPassphrase = value;
        sessionPassphraseFromStore = true;
        patchState({ unlocked: true, storedPassphrase: true });
        return true;
    } catch (error) {
        // 读取失败：保留「需要解锁」，并记录可读原因，绝不回显密文/口令
        sessionPassphrase = '';
        sessionPassphraseFromStore = false;
        patchState({
            // 记录存在但无法解密时，UI 应引导用户重新输入口令，而不是声称「已保存可用」
            storedPassphrase: false,
            unlocked: false,
            lastError: sanitizeError(error)
        });
        return false;
    }
}

/**
 * 初始化调度的数据与状态。
 *
 * 规则：
 * - 访问锁处于锁定态时不读取已保存口令，等解锁后再读取；
 * - 已保存口令读取失败只记录错误，不抛出；
 * - 启用时按启动延迟 15 秒安排首次检查。
 */
async function hydrateFromSettings() {
    await settingsReady;
    const current = get(settings);
    const auto = mergeAuto(current.baiduAuto);

    let storedPassphrase = false;
    try {
        storedPassphrase = await hasStoredAutoPassphrase();
    } catch {
        storedPassphrase = false;
    }

    patchState({
        ...buildSettingsPatch(auto, current),
        storedPassphrase
    });

    if (sessionPassphrase) {
        patchState({ unlocked: true });
    } else if (storedPassphrase && !get(locked)) {
        await loadStoredPassphraseToSession();
    } else {
        // 已锁定：保持未解锁，等待 locked 订阅在解锁后加载
        patchState({ unlocked: false });
    }

    const snapshot = get(baiduAutoState);
    if (snapshot.enabled && snapshot.configured) {
        if (!snapshot.nextRunAt) setNextRun(Date.now() + START_DELAY_MS);
    } else {
        setNextRun(0);
    }
}

/**
 * 记录用户输入时间（用于自动运行前 30 秒空闲判断）。
 */
function markUserInput() {
    lastInputAt = Date.now();
}

/**
 * 本地数据变化后做 90 秒防抖。
 */
function onDataChanged() {
    const snapshot = get(baiduAutoState);
    if (!snapshot.enabled) return;
    setNextRun(Date.now() + CHANGE_DEBOUNCE_MS);
}

/**
 * 联网后 3 秒安排运行。
 */
function onOnline() {
    scheduleSoon(TRIGGER_DELAY_MS);
}

/**
 * 页面回到前台后 3 秒安排运行。
 */
function onVisibilityChange() {
    if (!isPageVisible()) return;
    scheduleSoon(TRIGGER_DELAY_MS);
}

/**
 * 注册调度器（幂等）。只在浏览器环境注册 DOM/窗口监听。
 */
function startScheduler() {
    if (schedulerStarted) return;
    schedulerStarted = true;

    // 数据变化：忽略订阅时的首次回调，之后才进入防抖
    let firstNotes = true;
    notesVersion.subscribe(() => {
        if (firstNotes) {
            firstNotes = false;
            return;
        }
        onDataChanged();
    });

    let firstFolders = true;
    foldersVersion.subscribe(() => {
        if (firstFolders) {
            firstFolders = false;
            return;
        }
        onDataChanged();
    });

    // settings 变化时同步「已配置 / 启用 / 周期」等公开字段。
    // 这样用户在设置页保存 token 后，自动区块门禁能立即解除；
    // 不在此处同步 lastError 等会话字段，也不触碰 busy / unlocked / nextRunAt 的语义。
    let firstSettings = true;
    let lastConfigSignature = '';
    settings.subscribe((value) => {
        const auto = mergeAuto(value.baiduAuto);
        const configured = Boolean(value.baiduAccessToken && value.baiduAppPath);
        const enabled = Boolean(auto.enabled);
        const backupEnabled = auto.backupEnabled !== false;
        const intervalMinutes = normalizeInterval(auto.intervalMinutes);
        const keepCount = normalizeKeepCount(auto.keepCount);
        const signature = [configured, enabled, backupEnabled, intervalMinutes, keepCount].join('|');

        if (firstSettings) {
            firstSettings = false;
            lastConfigSignature = signature;
            return;
        }
        if (signature === lastConfigSignature) return;
        lastConfigSignature = signature;

        const before = get(baiduAutoState);
        patchState({
            configured,
            enabled,
            backupEnabled,
            syncEnabled: false,
            intervalMinutes,
            keepCount
        });

        if (!enabled) {
            if (before.nextRunAt) setNextRun(0);
        } else if (!before.enabled && !before.nextRunAt) {
            setNextRun(Date.now() + START_DELAY_MS);
        }
    });

    // 访问锁解锁后，若存在已保存口令且当前会话没有口令，再尝试读取。
    // 锁定期间绝不读取，避免在锁屏状态解密口令。
    locked.subscribe((isLocked) => {
        if (isLocked) return;
        if (sessionPassphrase) return;
        if (!get(baiduAutoState).storedPassphrase) return;
        loadStoredPassphraseToSession().then((loaded) => {
            if (loaded) scheduleSoon(TRIGGER_DELAY_MS);
        });
    });

    if (checkTimer === null) {
        checkTimer = setInterval(checkDue, CHECK_INTERVAL_MS);
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('online', onOnline);
        window.addEventListener('pointerdown', markUserInput, { passive: true });
        window.addEventListener('keydown', markUserInput, { passive: true });
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange);
    }
}

/**
 * 把 runAutoBackup 的进度映射为中文阶段文案。
 *
 * @param {{phase?: string, completed?: number, total?: number, message?: string}} progress
 */
function applyProgress(progress) {
    const phase = typeof progress?.phase === 'string' ? progress.phase : '';
    const completed = Number(progress?.completed) || 0;
    const total = Number(progress?.total) || 0;
    const detail = typeof progress?.message === 'string' ? progress.message : '';

    let progressText = '';
    if (phase === 'fingerprint') {
        progressText = '正在计算数据指纹…';
    } else if (phase === 'encrypt') {
        progressText = '正在加密本地数据…';
    } else if (phase === 'upload') {
        if (detail === 'precreate') {
            progressText = '正在准备上传…';
        } else if (detail === 'create') {
            progressText = '正在完成上传…';
        } else {
            progressText = total > 0 ? `正在上传（${completed}/${total}）…` : '正在上传…';
        }
    } else if (phase === 'prune') {
        progressText = '正在清理旧自动备份…';
    } else if (phase === 'sync') {
        // Phase 2 预留阶段，Phase 1 不会出现
        progressText = '正在同步…';
    } else if (phase === 'done') {
        progressText = '备份完成';
    }

    if (phase || progressText) {
        patchState({ phase, progressText });
    }
}

/**
 * 执行一次自动备份（内部实现，已被单飞包装）。
 *
 * @param {{manual: boolean, force: boolean}} options
 * @returns {Promise<{status: string, result?: object, message?: string, reason?: string}>}
 */
async function executeAuto({ manual, force }) {
    const current = get(settings);
    const snapshot = get(baiduAutoState);
    const auto = mergeAuto(current.baiduAuto);
    const intervalMs = normalizeInterval(auto.intervalMinutes) * 60 * 1000;
    const token = String(current.baiduAccessToken || '').trim();
    const appPath = String(current.baiduAppPath || '').trim();
    const bridgeUrl = String(current.baiduBridgeUrl || '').trim() || undefined;

    // 前置条件：手动运行抛出明确错误，自动运行静默跳过并安排下一次
    if (!snapshot.configured) {
        if (manual) throw new Error('请先完成百度网盘连接（验证并保存）。');
        setNextRun(0);
        return { status: 'skipped', reason: 'unconfigured' };
    }
    if (!snapshot.enabled) {
        if (manual) throw new Error('自动备份尚未启用。');
        setNextRun(0);
        return { status: 'skipped', reason: 'disabled' };
    }
    if (!snapshot.unlocked || !sessionPassphrase) {
        if (manual) throw new Error('请先解锁自动同步。');
        setNextRun(Date.now() + intervalMs);
        return { status: 'skipped', reason: 'locked' };
    }
    if (!isOnline()) {
        if (manual) throw new Error('当前处于离线状态，请联网后再试。');
        setNextRun(Date.now() + intervalMs);
        return { status: 'skipped', reason: 'offline' };
    }
    if (snapshot.busy) {
        if (manual) throw new Error('正在进行自动备份，请稍候。');
        return { status: 'skipped', reason: 'busy' };
    }

    if (!manual) {
        if (!isPageVisible()) {
            setNextRun(Date.now() + intervalMs);
            return { status: 'skipped', reason: 'hidden' };
        }
        if (get(locked)) {
            setNextRun(Date.now() + intervalMs);
            return { status: 'skipped', reason: 'locked-screen' };
        }
        if (snapshot.authExpired) {
            setNextRun(0);
            return { status: 'skipped', reason: 'auth-expired' };
        }

        const now = Date.now();
        if (now < retryNotBefore) {
            // 失败退避：联网/回前台/数据变化等触发不能绕过至少 5 分钟的重试间隔
            setNextRun(retryNotBefore);
            return { status: 'skipped', reason: 'backoff' };
        }
        if (now - lastInputAt < IDLE_BEFORE_AUTO_MS) {
            setNextRun(lastInputAt + IDLE_BEFORE_AUTO_MS);
            return { status: 'skipped', reason: 'recent-input' };
        }
        if (now - lastAutoAt < MIN_AUTO_GAP_MS) {
            setNextRun(lastAutoAt + MIN_AUTO_GAP_MS);
            return { status: 'skipped', reason: 'too-soon' };
        }

        // 真正开始一次自动运行，记录起点，失败重试至少 5 分钟
        lastAutoAt = now;
    }

    patchState({
        busy: true,
        phase: 'fingerprint',
        progressText: '正在计算数据指纹…'
    });

    try {
        // 自动备份且未启用双向同步时，先判断指纹是否变化；手动运行强制上传
        if (!manual && auto.backupEnabled && !auto.syncEnabled) {
            const fingerprint = await computeLocalFingerprint();
            if (!force && fingerprint && fingerprint === auto.lastFingerprint) {
                retryNotBefore = 0;
                patchState({
                    busy: false,
                    phase: '',
                    progressText: '数据无变化，已跳过本次自动备份'
                });
                setNextRun(Date.now() + intervalMs);
                return { status: 'skipped', reason: 'unchanged' };
            }
        }

        const result = await runAutoBackup({
            token,
            bridgeUrl,
            appPath,
            passphrase: sessionPassphrase,
            deviceId: typeof auto.deviceId === 'string' ? auto.deviceId : '',
            keepCount: normalizeKeepCount(auto.keepCount),
            onProgress: applyProgress
        });

        const finishedAt = Date.now();
        const latestAuto = mergeAuto(get(settings).baiduAuto);
        const nextAuto = {
            ...latestAuto,
            lastBackupAt: finishedAt,
            lastBackupName: result.filename,
            lastFingerprint: result.fingerprint,
            lastError: '',
            authExpired: false
        };
        await updateSetting('baiduAuto', nextAuto);

        lastAutoAt = finishedAt;
        retryNotBefore = 0;
        patchState({
            busy: false,
            phase: 'done',
            progressText: '备份完成',
            lastBackupAt: finishedAt,
            lastBackupName: result.filename,
            lastError: '',
            authExpired: false,
            intervalMinutes: normalizeInterval(nextAuto.intervalMinutes),
            keepCount: normalizeKeepCount(nextAuto.keepCount)
        });
        setNextRun(finishedAt + normalizeInterval(nextAuto.intervalMinutes) * 60 * 1000);

        return { status: 'done', result };
    } catch (error) {
        const classified = classifyAutoError(error, token);
        const failedAt = Date.now();
        lastAutoAt = failedAt;

        // 失败只持久化 lastError / authExpired，不改变上次成功时间与指纹
        const latestAuto = mergeAuto(get(settings).baiduAuto);
        const nextAuto = {
            ...latestAuto,
            lastError: classified.message,
            authExpired: classified.authExpired
        };
        try {
            await updateSetting('baiduAuto', nextAuto);
        } catch {
            // 持久化失败不应掩盖原始备份错误
        }

        if (classified.authExpired) {
            // token 失效后停止自动尝试，等待用户重新粘贴并验证
            retryNotBefore = 0;
            setNextRun(0);
        } else {
            // 网络 / 桥接 / 其它错误保留自动重试，至少 5 分钟后
            retryNotBefore = failedAt + Math.max(RETRY_AFTER_FAIL_MS, intervalMs);
            setNextRun(retryNotBefore);
        }

        patchState({
            busy: false,
            phase: '',
            progressText: '',
            lastError: classified.message,
            authExpired: classified.authExpired
        });

        if (manual) throw new Error(classified.message);
        return {
            status: 'failed',
            message: classified.message,
            authExpired: classified.authExpired
        };
    } finally {
        patchState({ busy: false });
    }
}

/**
 * 运行自动备份（单飞）。
 * 自动模式还要求：页面可见、未锁定、最近 30 秒无输入、距上次自动运行 ≥ 60 秒。
 *
 * @param {{manual?: boolean, force?: boolean}} [options]
 * @returns {Promise<object>}
 */
function runAuto({ manual = false, force = false } = {}) {
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            return await executeAuto({ manual, force });
        } finally {
            inflight = null;
        }
    })();

    return inflight;
}

/**
 * 应用启动时调用一次；幂等。
 * 初始化失败只记录可读状态，不向 App 抛出。
 *
 * @returns {Promise<void>}
 */
export function initBaiduAutoSync() {
    if (started && initPromise) return initPromise;
    started = true;

    initPromise = (async () => {
        try {
            await settingsReady;
            await hydrateFromSettings();
        } catch (error) {
            patchState({ lastError: sanitizeError(error) });
        } finally {
            startScheduler();
            markReady();
        }
    })();

    return initPromise;
}

/**
 * 启用自动备份并保存配置。
 *
 * 流程：等待设置 → 校验 token/appPath → verifyToken → 口令校验 →
 * 保存口令/校验值 → 生成 deviceId → 整体持久化 baiduAuto → 5 秒后首次运行。
 *
 * @param {{
 *   passphrase?: string,
 *   savePassphrase?: boolean,
 *   backupEnabled?: boolean,
 *   syncEnabled?: boolean,
 *   intervalMinutes?: number,
 *   keepCount?: number
 * }} [options]
 * @returns {Promise<object>} 持久化后的 baiduAuto 对象
 */
export async function enableAutoSync(options = {}) {
    await settingsReady;
    const current = get(settings);
    const token = String(current.baiduAccessToken || '').trim();
    const appPath = String(current.baiduAppPath || '').trim();
    const bridgeUrl = String(current.baiduBridgeUrl || '').trim() || undefined;

    if (!token) {
        throw new Error('请先粘贴百度网盘 access_token 并点击验证保存。');
    }
    if (!appPath) {
        throw new Error('请先设置百度网盘应用目录（例如 /apps/TMPLNote）。');
    }

    // 必须验证 token 成功后才落库
    try {
        await verifyToken({ token, bridgeUrl });
    } catch (error) {
        throw new Error(sanitizeError(error, token));
    }

    const auto = mergeAuto(current.baiduAuto);

    // 口令来源：本次输入优先；未提供时尝试已保存口令
    const provided = typeof options.passphrase === 'string' ? options.passphrase : '';
    let passphrase = provided;
    let fromStore = false;

    if (!passphrase) {
        try {
            passphrase = (await loadAutoPassphrase()) || '';
        } catch (error) {
            throw new Error(
                `无法读取已保存的自动同步口令，请重新输入口令。（${sanitizeError(error)}）`
            );
        }
        fromStore = Boolean(passphrase);
    }
    if (!passphrase) {
        throw new Error('请先设置自动同步口令。');
    }

    assertPassword(passphrase);

    if (fromStore) {
        // 已保存口令也需通过校验值，避免旧记录与校验值不一致
        if (auto.passphraseCheck) {
            const ok = await verifyPassphraseCheck(passphrase, auto.passphraseCheck);
            if (!ok) {
                throw new Error('已保存的自动同步口令无法通过校验，请清除后重新设置。');
            }
        }
    } else if (auto.passphraseCheck) {
        const ok = await verifyPassphraseCheck(passphrase, auto.passphraseCheck);
        if (!ok) {
            throw new Error('自动同步口令错误');
        }
    }

    // 新口令首次启用时生成并持久化校验值
    let passphraseCheck = auto.passphraseCheck;
    if (!passphraseCheck) {
        passphraseCheck = await createPassphraseCheck(passphrase);
    }

    const savePassphrase = options.savePassphrase !== false;
    let storedPassphrase = false;
    try {
        storedPassphrase = await hasStoredAutoPassphrase();
    } catch {
        storedPassphrase = false;
    }

    if (savePassphrase) {
        // 口令来自 secrets 时无需重复写入
        if (!fromStore) {
            await saveAutoPassphrase(passphrase);
        }
        storedPassphrase = true;
    } else if (storedPassphrase) {
        // 明确选择「仅本次会话」时清除旧记录，确保口令只留在模块内存，
        // 同时避免下次启动读到与本会话不一致的旧口令。
        try {
            await clearAutoPassphrase();
        } catch {
            // 清理失败不阻塞启用，但不能声称已保存
        }
        storedPassphrase = false;
    }

    const deviceId =
        typeof auto.deviceId === 'string' && auto.deviceId ? auto.deviceId : generateDeviceId();
    const intervalMinutes = normalizeInterval(options.intervalMinutes ?? auto.intervalMinutes);
    const keepCount = normalizeKeepCount(options.keepCount ?? auto.keepCount);
    const backupEnabled = options.backupEnabled !== false;

    const nextAuto = {
        ...auto,
        enabled: true,
        backupEnabled,
        // Phase 1 固定关闭双向同步，忽略传入值
        syncEnabled: false,
        intervalMinutes,
        keepCount,
        deviceId,
        lastError: '',
        authExpired: false,
        passphraseCheck
    };
    await updateSetting('baiduAuto', nextAuto);

    sessionPassphrase = passphrase;
    // 未保存到 secrets 时，会话口令不应再被「清除已保存口令」联动清除
    sessionPassphraseFromStore = savePassphrase ? fromStore : false;
    lastAutoAt = 0;
    retryNotBefore = 0;

    patchState({
        ...buildSettingsPatch(nextAuto, current),
        storedPassphrase,
        unlocked: true,
        busy: false,
        phase: '',
        progressText: '',
        lastError: '',
        authExpired: false
    });
    startScheduler();
    markReady();

    // 启用成功后安排一次自动运行，不阻塞 UI
    setNextRun(Date.now() + ENABLE_DELAY_MS);

    return nextAuto;
}

/**
 * 暂停自动备份（enabled=false）。
 * 保留已保存口令、deviceId 与会话解锁状态，便于再次启用。
 *
 * @returns {Promise<object>} 持久化后的 baiduAuto 对象
 */
export async function disableAutoSync() {
    await settingsReady;
    const auto = mergeAuto(get(settings).baiduAuto);
    const nextAuto = { ...auto, enabled: false };
    await updateSetting('baiduAuto', nextAuto);

    setNextRun(0);
    patchState({
        enabled: false,
        phase: '',
        progressText: ''
    });

    return nextAuto;
}

/**
 * 修改自动备份选项。
 * Phase 1 只接受 backupEnabled / syncEnabled / intervalMinutes / keepCount；
 * syncEnabled 保留字段但强制 false，不产生任何同步行为。
 *
 * @param {{backupEnabled?: boolean, syncEnabled?: boolean, intervalMinutes?: number, keepCount?: number}} [options]
 * @returns {Promise<object>} 持久化后的 baiduAuto 对象
 */
export async function saveAutoOptions(options = {}) {
    await settingsReady;
    const auto = mergeAuto(get(settings).baiduAuto);
    const nextAuto = { ...auto };

    if (typeof options.backupEnabled === 'boolean') {
        nextAuto.backupEnabled = options.backupEnabled;
    }
    // Phase 1 强制关闭双向同步
    nextAuto.syncEnabled = false;
    nextAuto.intervalMinutes = normalizeInterval(
        options.intervalMinutes === undefined ? auto.intervalMinutes : options.intervalMinutes
    );
    nextAuto.keepCount = normalizeKeepCount(
        options.keepCount === undefined ? auto.keepCount : options.keepCount
    );

    await updateSetting('baiduAuto', nextAuto);

    patchState({
        backupEnabled: nextAuto.backupEnabled !== false,
        syncEnabled: false,
        intervalMinutes: nextAuto.intervalMinutes,
        keepCount: nextAuto.keepCount
    });

    if (get(baiduAutoState).enabled) {
        setNextRun(Date.now() + nextAuto.intervalMinutes * 60 * 1000);
    } else {
        setNextRun(0);
    }

    return nextAuto;
}

/**
 * 解锁自动同步：校验口令并放入会话。
 * passphraseCheck 为空（旧配置）时接受该口令并生成校验值。
 * 口令只保存在模块内存，不写入 state / settings / localStorage。
 *
 * @param {string} passphrase
 * @returns {Promise<boolean>}
 */
export async function unlockAutoSync(passphrase) {
    await settingsReady;
    const text = typeof passphrase === 'string' ? passphrase : '';
    if (!text) {
        throw new Error('请输入自动同步口令。');
    }

    const auto = mergeAuto(get(settings).baiduAuto);
    if (auto.passphraseCheck) {
        const ok = await verifyPassphraseCheck(text, auto.passphraseCheck);
        if (!ok) {
            throw new Error('自动同步口令错误');
        }
    } else {
        // 旧配置没有校验值：接受该口令并写入校验值
        const check = await createPassphraseCheck(text);
        await updateSetting('baiduAuto', { ...auto, passphraseCheck: check });
    }

    sessionPassphrase = text;
    sessionPassphraseFromStore = false;
    patchState({ unlocked: true });

    if (get(baiduAutoState).enabled) {
        scheduleSoon(TRIGGER_DELAY_MS);
    }

    return true;
}

/**
 * 锁定自动同步：清空会话口令。
 * 不删除 secrets 中的加密记录，也不修改 settings。
 */
export function lockAutoSync() {
    sessionPassphrase = '';
    sessionPassphraseFromStore = false;
    setNextRun(0);
    patchState({ unlocked: false });
}

/**
 * 删除 secrets 中已保存的自动同步口令。
 *
 * 语义说明：
 * - 若当前会话口令来自已保存记录，同时清空会话并设为未解锁；
 * - 若当前会话口令是本次输入/启用时提供的，保留会话，避免打断正在进行的自动备份。
 *
 * @returns {Promise<void>}
 */
export async function clearStoredAutoPassphrase() {
    await settingsReady;

    try {
        await clearAutoPassphrase();
    } catch (error) {
        throw new Error(`清除已保存的自动同步口令失败：${sanitizeError(error)}`);
    }

    patchState({ storedPassphrase: false });

    if (sessionPassphraseFromStore) {
        sessionPassphrase = '';
        sessionPassphraseFromStore = false;
        setNextRun(0);
        patchState({ unlocked: false });
    }
}

/**
 * 手动立即备份。
 * 需要已配置、已启用、在线、未 busy、已解锁；不受 30 秒空闲与 60 秒间隔限制。
 *
 * @returns {Promise<object>}
 */
export async function runAutoSyncNow() {
    await settingsReady;
    const snapshot = get(baiduAutoState);
    if (!snapshot.configured) {
        throw new Error('请先完成百度网盘连接（验证并保存）。');
    }
    if (!snapshot.enabled) {
        throw new Error('自动备份尚未启用。');
    }
    if (!snapshot.unlocked || !sessionPassphrase) {
        throw new Error('请先解锁自动同步。');
    }
    if (!isOnline()) {
        throw new Error('当前处于离线状态，请联网后再试。');
    }

    return runAuto({ manual: true, force: true });
}

/**
 * 外部刷新：从 settings 重新同步状态。
 * 不覆盖 busy / unlocked / phase / progressText / conflicts 等会话字段。
 *
 * @returns {Promise<object>} 刷新后的状态快照
 */
export async function refreshAutoState() {
    await settingsReady;
    const current = get(settings);
    const auto = mergeAuto(current.baiduAuto);

    let storedPassphrase = get(baiduAutoState).storedPassphrase;
    try {
        storedPassphrase = await hasStoredAutoPassphrase();
    } catch {
        // 读取失败时保留原值，避免误报「没有已保存口令」
    }

    patchState({
        ...buildSettingsPatch(auto, current),
        storedPassphrase
    });

    const snapshot = get(baiduAutoState);
    if (!snapshot.enabled) {
        setNextRun(0);
    } else if (!snapshot.nextRunAt) {
        setNextRun(Date.now() + normalizeInterval(auto.intervalMinutes) * 60 * 1000);
    }

    startScheduler();
    markReady();

    return get(baiduAutoState);
}
