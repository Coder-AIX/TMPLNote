/**
 * appUpdate.js — 应用主动更新检查与刷新
 *
 * 职责：
 *  - checkForAppUpdate()：主动调用 Service Worker 的 registration.update()，
 *    检测是否有新版本正在安装，并返回「已更新 / 已是最新 / 不支持」三种结果。
 *  - applyAppUpdate()：让等待中的新 SW 跳过等待（SKIP_WAITING），随后刷新页面以应用新版本。
 *
 * 为什么需要手动更新？
 *  - 构建产物只注入了一次性的 navigator.serviceWorker.register(...)（见 dist/registerSW.js），
 *    浏览器不会在页面运行期间主动轮询新 SW；设置页的「检查更新」按钮需要主动触发。
 *  - 这里只做「检查 + 刷新」，绝不清空 Cache Storage（其中包含 ai-models 本地模型缓存），
 *    也绝不注销 Service Worker。
 *
 * 与 skipWaiting 的关系：
 *  - src/service-worker.js 已调用 self.skipWaiting() + clientsClaim()，新 SW 安装完成后会自动激活；
 *  - 但页面仍停留在旧版本，必须 reload 才能拿到新资源，因此 applyAppUpdate() 负责刷新。
 */

export const UPDATE_STATUS = Object.freeze({
    UPDATED: 'updated',
    LATEST: 'latest',
    UNSUPPORTED: 'unsupported'
});

/** 等待新 worker 进入终态的默认超时 */
const DEFAULT_TIMEOUT_MS = 6000;
/** update() 已 resolve 但 updatefound 尚未派发时的额外等待（避免漏掉晚到的事件） */
const DISCOVERY_FALLBACK_MS = 1500;
/** controllerchange 不触发时的兜底刷新延迟 */
const RELOAD_FALLBACK_MS = 800;

/** worker 的终态集合：进入这些状态后无需继续监听 */
const TERMINAL_STATES = new Set(['installed', 'activated', 'redundant']);

/** 模块内单次刷新标志：避免重复调用导致反复 reload */
let reloadScheduled = false;

/** 读取当前处于 installing / waiting 的 worker（新版本候选） */
function getPendingWorker(registration) {
    return registration.installing || registration.waiting || null;
}

/**
 * 在 timeoutMs 内等待 registration 出现新 worker。
 * 先立即检查一次，再监听 updatefound，最后用定时器兜底——
 * 这样既覆盖「worker 已存在」的同步场景，也覆盖事件晚于 update() resolve 的异步场景。
 */
function waitForNewWorker(registration, timeoutMs) {
    const existing = getPendingWorker(registration);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
        let timer = null;

        const cleanup = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            registration.removeEventListener?.('updatefound', onUpdateFound);
        };

        const finish = (worker) => {
            cleanup();
            resolve(worker || null);
        };

        const onUpdateFound = () => {
            const worker = getPendingWorker(registration);
            if (worker) finish(worker);
        };

        registration.addEventListener('updatefound', onUpdateFound);
        timer = setTimeout(() => finish(getPendingWorker(registration)), timeoutMs);
        // 监听挂载后立即再查一次，避免 updatefound 在挂载前已派发而漏掉
        onUpdateFound();
    });
}

/**
 * 等待 worker 进入 installed / activated / redundant。
 * 已处于终态时立即返回；否则监听 statechange，并用 timeoutMs 兜底，保证不会永久挂起。
 */
function waitForWorkerState(worker, timeoutMs) {
    if (TERMINAL_STATES.has(worker.state)) return Promise.resolve(worker.state);

    return new Promise((resolve) => {
        let timer = null;

        const cleanup = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            worker.removeEventListener?.('statechange', onStateChange);
        };

        const finish = (state) => {
            cleanup();
            resolve(state);
        };

        const onStateChange = () => {
            if (TERMINAL_STATES.has(worker.state)) finish(worker.state);
        };

        worker.addEventListener('statechange', onStateChange);
        timer = setTimeout(() => finish(worker.state), timeoutMs);
    });
}

/**
 * 主动检查是否有新版本。
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ status: string, registration?: ServiceWorkerRegistration }>}
 */
export async function checkForAppUpdate(options = {}) {
    // 不在模块顶层读取 navigator：SSR / 测试环境可能没有该对象
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
        return { status: UPDATE_STATUS.UNSUPPORTED };
    }

    // 不传参数：只取当前页面 scope 对应的注册
    let registration;
    try {
        registration = await navigator.serviceWorker.getRegistration();
    } catch {
        return { status: UPDATE_STATUS.UNSUPPORTED };
    }
    if (!registration) {
        return { status: UPDATE_STATUS.UNSUPPORTED };
    }

    // 已有一个等待中的新版本（例如上次检查后用户未刷新）
    if (registration.waiting) {
        return { status: UPDATE_STATUS.UPDATED, registration };
    }

    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Number(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    // 在 update() 之前挂监听：updatefound 可能在 update() resolve 之前派发
    let discovered = null;
    const onUpdateFound = () => {
        const worker = getPendingWorker(registration);
        if (worker) discovered = worker;
    };
    registration.addEventListener?.('updatefound', onUpdateFound);

    try {
        await registration.update();
    } catch (err) {
        // 更新失败（如离线）原样抛出，由调用方决定如何提示
        registration.removeEventListener?.('updatefound', onUpdateFound);
        throw err;
    }

    let worker = discovered || getPendingWorker(registration);

    if (!worker) {
        // update() 已 resolve 但新 worker 可能还没生成，再等一小段时间
        worker = await waitForNewWorker(registration, DISCOVERY_FALLBACK_MS);
    }

    registration.removeEventListener?.('updatefound', onUpdateFound);

    if (!worker) {
        return { status: UPDATE_STATUS.LATEST };
    }

    const state = await waitForWorkerState(worker, timeoutMs);
    if (state === 'redundant') {
        return { status: UPDATE_STATUS.LATEST };
    }
    return { status: UPDATE_STATUS.UPDATED, registration };
}

/**
 * 应用新版本：通知等待中的 SW 跳过等待，并刷新页面。
 * 只刷新一次；即使 controllerchange 未触发，也会在 800ms 后兜底刷新。
 */
export function applyAppUpdate(registration) {
    if (typeof window === 'undefined') return;
    if (reloadScheduled) return;
    reloadScheduled = true;

    let timer = null;
    let reloaded = false;

    const reload = () => {
        if (reloaded) return;
        reloaded = true;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        window.location.reload();
    };

    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.addEventListener) {
        try {
            // 新 SW 接管后触发 controllerchange，此时刷新可拿到新版本资源
            navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
        } catch {
            // 少数环境不支持 options，忽略后由下面的定时器兜底
        }
    }

    if (registration?.waiting) {
        try {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        } catch {
            // 当前 SW 未监听该消息也无害；失败的刷新仍由 controllerchange / 定时器完成
        }
    }

    // 兜底：部分场景 controllerchange 不一定触发（例如新 SW 未接管），仍要刷新
    timer = setTimeout(reload, RELOAD_FALLBACK_MS);
}
