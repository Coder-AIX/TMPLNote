<script>
    // AiSection —— 设置页「AI」分区
    // 本地 GGUF：上方「下载列表」纯展示推荐模型（仅提供复制下载链接），
    // 下方「模型操作」通用区统一作用于「当前模型」；A1/A2 存储模式。
    // 推荐模型：复制下载链接后，在浏览器地址栏粘贴打开即可下载 GGUF，再回到此处「选择文件导入」；
    // 存储方式由设置 aiModelStorageMode 决定（cache=A1 持久缓存 / session=A2 仅本次会话）。
    // 仅在真正不可用时（$ai.disabled，如无 WebAssembly）显示提示并禁用选择文件 / 载入 / 去对话；
    // 无 WebGPU / 未跨域隔离不再阻止载入，而是走 CPU 单线程兼容模式（速度较慢但可用）。
    import { onMount } from 'svelte';
    import { Button, Heading, P, Label } from 'flowbite-svelte';
    import SelectMenu from './SelectMenu.svelte';
    import Switch from './Switch.svelte';
    import { push } from 'svelte-spa-router';
    import { RECOMMENDED_MODELS, downloadUrl } from '../ai/models.js';
    import aiEngine from '../ai/engine.js';
    import {
        ai,
        importModel,
        importCustomModel,
        loadModel,
        deleteModel,
        clearCache
    } from '../stores/ai.js';
    import {
        settings,
        updateSetting,
        CONTEXT_MIN,
        CONTEXT_MAX,
        CONTEXT_STEP,
        clampContextLength
    } from '../stores/settings.js';

    /** 存储估算 { usage, quota }；读取失败或不可用时为 null */
    let storage = $state(null);
    /** 是否正在申请持久化存储 */
    let requestingPersist = $state(false);
    /** 是否已获得持久化存储授权 */
    let persisted = $state(false);
    /** 对话上下文开关镜像：配合 Switch 使用，保证控件与设置一致 */
    let useNotesContext = $state($settings.aiUseNotesContext);
    /** 性能模式镜像（切换后需重新载入模型生效） */
    let perfMode = $state($settings.aiPerfMode ?? 'high');
    /** 性能模式说明 */
    const perfModeHint = $derived(
        perfMode === 'low'
            ? 'CPU 推理并限制线程数；iOS 上强制单线程，避免共享内存分配失败。最流畅但最慢。'
            : perfMode === 'balanced'
              ? 'CPU 推理，占用较多 CPU 核心；不占用 GPU，速度尚可、更少卡顿。'
              : 'GPU 全部层加速，速度最快；设备可能发热或卡顿。移动端若出现卡顿或载入失败，建议改用“均衡”或“低功耗”。'
    );
    /** 模型存储方式镜像：'cache'=缓存到浏览器（A1）/ 'session'=仅本次会话（A2） */
    let storageMode = $state($settings.aiModelStorageMode ?? 'cache');
    /** 生效上下文长度镜像（token；切换后需重新载入模型生效） */
    let contextLength = $state(clampContextLength($settings.aiContextLength));
    /** PC 推荐上下文长度镜像 */
    let contextPc = $state(clampContextLength($settings.aiContextLengthPc));
    /** 移动端推荐上下文长度镜像 */
    let contextMobile = $state(clampContextLength($settings.aiContextLengthMobile));
    /** 最近一次复制成功的模型 id（用于按钮文案/图标的短暂反馈） */
    let copiedId = $state('');

    // 当前模型 = resolveModel($ai.modelId)：推荐模型或本地导入的自定义模型。
    // 显式读取 $ai.customModels，保证自定义模型列表变化时 $derived 会重算。
    const currentModel = $derived.by(() => {
        const id = $ai.modelId;
        const customs = $ai.customModels; // 显式依赖，便于自定义模型变化时重算
        if (!id) return undefined;
        return RECOMMENDED_MODELS.find((m) => m.id === id) ?? customs.find((m) => m.id === id);
    });

    /**
     * 运行诊断信息：跨域隔离 / CPU 核心数 / 推理线程数 / 上下文长度 / 推理模式 / 线程模式 / 兼容提示。
     * 依赖 $ai.state，模型载入（ready）或卸载后就绪状态变化时自动重新读取线程数与上下文；
     * window/navigator 访问做非浏览器环境防御，避免构建或运行时报错。
     */
    const diagnostics = $derived.by(() => {
        // 显式依赖：$ai.state 变化（载入/卸载/就绪）时重算，刷新下方的线程数与上下文
        const aiState = $ai.state;
        const hasWindow = typeof window !== 'undefined';
        const hasNavigator = typeof navigator !== 'undefined';
        const crossOriginIsolated = hasWindow ? Boolean(window.crossOriginIsolated) : false;
        const cores =
            hasNavigator && Number.isFinite(navigator.hardwareConcurrency)
                ? navigator.hardwareConcurrency
                : null;
        // 未载入模型时 engine 返回 0，展示时按 0 处理为「—」
        const threads = aiEngine.threads;
        const contextLength = aiEngine.contextLength;
        // 优先 engine 实际生效值；未载入时回退到 store（设置项 / 载入后写入的实际值）
        const perfMode = aiEngine.perfMode || $ai.perfMode || '';
        const singleThread = Boolean($ai.singleThread);
        const perfWarning = String($ai.perfWarning || '');
        return {
            aiState,
            crossOriginIsolated,
            cores,
            threads,
            contextLength,
            perfMode,
            singleThread,
            perfWarning
        };
    });

    /** 当前模型共用的隐藏文件选择框引用（供「选择文件导入」按钮触发） */
    let fileInput = $state(null);

    // 外部设置变化（如异步载入）时同步镜像
    $effect(() => {
        useNotesContext = $settings.aiUseNotesContext;
    });

    // 外部设置变化时同步性能模式镜像
    $effect(() => {
        perfMode = $settings.aiPerfMode ?? 'high';
    });

    // 外部设置变化时同步存储方式镜像
    $effect(() => {
        storageMode = $settings.aiModelStorageMode ?? 'cache';
    });

    // 外部设置变化时同步生效上下文长度镜像
    $effect(() => {
        contextLength = clampContextLength($settings.aiContextLength);
    });

    // 外部设置变化时同步 PC 推荐上下文长度镜像
    $effect(() => {
        contextPc = clampContextLength($settings.aiContextLengthPc);
    });

    // 外部设置变化时同步移动端推荐上下文长度镜像
    $effect(() => {
        contextMobile = clampContextLength($settings.aiContextLengthMobile);
    });

    /** 字节数格式化为 B/KB/MB/GB/TB 字符串；非法值返回「—」 */
    function formatBytes(bytes) {
        if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
        if (bytes < 1024) return `${Math.round(bytes)} B`;
        const units = ['KB', 'MB', 'GB', 'TB'];
        let value = bytes / 1024;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index += 1;
        }
        const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
        return `${value.toFixed(digits)} ${units[index]}`;
    }

    /** 读取存储用量估算；失败静默，显示为「—」 */
    async function loadStorage() {
        try {
            if (!navigator?.storage?.estimate) return;
            const estimate = await navigator.storage.estimate();
            storage = { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
        } catch (_) {
            storage = null;
        }
    }

    /** 申请持久化存储（可选能力）；失败静默 */
    async function requestPersist() {
        if (!navigator?.storage?.persist) return;
        requestingPersist = true;
        try {
            persisted = await navigator.storage.persist();
            if (navigator.storage.persisted) persisted = await navigator.storage.persisted();
        } catch (_) {
            /* 忽略：申请失败不影响功能 */
        } finally {
            requestingPersist = false;
        }
    }

    onMount(() => {
        loadStorage();
        if (navigator?.storage?.persisted) {
            navigator.storage
                .persisted()
                .then((value) => (persisted = value))
                .catch(() => {});
        }
    });

    /** 该模型文件是否可用：A1 已缓存 或 A2 本次会话已导入 */
    function isAvailable(model) {
        return Boolean(model) && ($ai.downloaded.includes(model.id) || $ai.sessionModelId === model.id);
    }

    /** 该模型是否已载入可对话 */
    function isLoaded(model) {
        return Boolean(model) && $ai.state === 'ready' && $ai.modelId === model.id;
    }

    /**
     * 选择本地 GGUF 文件后导入：按文件名自动匹配推荐模型，未匹配则注册为本地自定义模型；
     * 结束后清空 value 以允许重复选择同一文件。
     */
    async function onFileChange(event) {
        const input = event?.currentTarget;
        const file = input?.files?.[0];
        try {
            if (file) {
                const name = String(file.name || '').toLowerCase();
                const hit = RECOMMENDED_MODELS.find(
                    (m) => String(m.file).toLowerCase() === name
                );
                if (hit) await importModel(hit.id, file);
                else await importCustomModel(file);
            }
        } finally {
            if (input) input.value = '';
        }
    }

    /** 删除模型（二次确认） */
    async function confirmDelete(id) {
        if (typeof window !== 'undefined' && !window.confirm('确定删除该模型的本地副本吗？')) {
            return;
        }
        await deleteModel(id);
    }

    /** 清除全部模型缓存（卸载已载入模型并清空浏览器缓存） */
    async function onClearCache() {
        if (!window.confirm('确定清除全部模型缓存？已载入的模型会被卸载，需重新导入。')) return;
        await clearCache();
    }

    /** 复制模型的浏览器下载链接到剪贴板（无下载链接时直接返回） */
    async function copyLink(model) {
        const url = downloadUrl(model);
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
        } catch (_) {
            /* 剪贴板不可用时忽略 */
        }
        copiedId = model.id;
        setTimeout(() => {
            if (copiedId === model.id) copiedId = '';
        }, 2000);
    }

    /** 提交生效上下文长度：夹取后写入设置并回写镜像与输入框（避免越界坏值） */
    function onContextLengthChange(event) {
        const value = clampContextLength(event?.currentTarget?.value);
        contextLength = value;
        if (event?.currentTarget) event.currentTarget.value = String(value);
        updateSetting('aiContextLength', value);
    }

    /** 一键应用某个推荐上下文长度（夹取后写入生效值） */
    function applyRecommendedContext(value) {
        const v = clampContextLength(value);
        contextLength = v;
        updateSetting('aiContextLength', v);
    }

    /** 提交 PC 推荐上下文长度：夹取后写入设置并回写镜像与输入框 */
    function onContextPcChange(event) {
        const value = clampContextLength(event?.currentTarget?.value);
        contextPc = value;
        if (event?.currentTarget) event.currentTarget.value = String(value);
        updateSetting('aiContextLengthPc', value);
    }

    /** 提交移动端推荐上下文长度：夹取后写入设置并回写镜像与输入框 */
    function onContextMobileChange(event) {
        const value = clampContextLength(event?.currentTarget?.value);
        contextMobile = value;
        if (event?.currentTarget) event.currentTarget.value = String(value);
        updateSetting('aiContextLengthMobile', value);
    }
</script>

<div class="flex w-full min-w-0 flex-col gap-4">
    <div class="flex flex-col gap-1">
        <Heading tag="h2" class="text-lg font-semibold text-[var(--fg)]">AI</Heading>
        <P size="sm" class="text-[var(--fg-muted)]">
            本地运行 GGUF 模型，数据不出设备。
        </P>
    </div>

    <!-- 环境能力 -->
    <div class="flex flex-col divide-y divide-[var(--divider)]">
        <!-- WebGPU 支持 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">WebGPU 支持</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    {#if $ai.supported}
                        当前浏览器支持在本机运行模型。
                    {:else}
                        当前浏览器不支持 WebGPU，将使用 CPU 兼容模式（速度较慢）。
                    {/if}
                </P>
            </div>
            <div
                class="flex flex-none items-center gap-1.5 {$ai.supported
                    ? 'text-primary-500'
                    : 'text-amber-600'}"
            >
                <ha-icon
                    name={$ai.supported ? 'check' : 'info'}
                    collection="lucide"
                    size="18"
                ></ha-icon>
                <span class="text-sm font-medium">{$ai.supported ? '支持' : 'CPU 兼容'}</span>
            </div>
        </div>

        <!-- 存储占用 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">存储占用</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    {#if storage}
                        已用 {formatBytes(storage.usage)} / 配额 {formatBytes(storage.quota)}
                    {:else}
                        —
                    {/if}
                </P>
            </div>
            <Button
                color="light"
                size="sm"
                disabled={requestingPersist || persisted}
                onclick={requestPersist}
                class="w-full sm:w-auto sm:flex-none"
            >
                {persisted ? '已持久化' : requestingPersist ? '申请中…' : '申请持久化'}
            </Button>
        </div>

        <!-- 清除模型缓存 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">清除模型缓存</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    卸载已载入的模型并清空浏览器中缓存的全部模型文件。
                </P>
            </div>
            <Button
                color="light"
                size="sm"
                onclick={onClearCache}
                class="inline-flex w-full items-center justify-center gap-2 sm:w-auto"
            >
                <ha-icon name="trash-2" collection="lucide" size="16"></ha-icon>
                <span>清除模型缓存</span>
            </Button>
        </div>
    </div>

    <!-- 运行诊断：确认跨域隔离 / 线程数等运行环境信息，便于移动端定位推理性能问题 -->
    <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-0.5">
            <Label class="text-[15px] text-[var(--fg)]">运行诊断</Label>
            <P size="sm" class="text-[var(--fg-muted)]">
                用于确认推理运行环境；未开启跨域隔离时将使用单线程兼容模式。
            </P>
        </div>
        <div class="flex flex-col divide-y divide-[var(--divider)]">
            <!-- 跨域隔离 -->
            <div class="flex items-center justify-between gap-4 py-3 first:pt-0">
                <span class="text-[13px] text-[var(--fg-muted)]">跨域隔离</span>
                <span
                    class="flex flex-none items-center gap-1.5 text-[13px] font-medium {diagnostics.crossOriginIsolated
                        ? 'text-primary-500'
                        : 'text-amber-600'}"
                >
                    <ha-icon
                        name={diagnostics.crossOriginIsolated ? 'check' : 'info'}
                        collection="lucide"
                        size="16"
                    ></ha-icon>
                    <span>{diagnostics.crossOriginIsolated ? '是' : '否'}</span>
                </span>
            </div>

            <!-- CPU 核心数 -->
            <div class="flex items-center justify-between gap-4 py-3">
                <span class="text-[13px] text-[var(--fg-muted)]">CPU 核心数</span>
                <span class="flex-none text-[13px] font-medium text-[var(--fg)]">
                    {diagnostics.cores ?? '未知'}
                </span>
            </div>

            <!-- 推理线程数 -->
            <div class="flex items-center justify-between gap-4 py-3">
                <span class="text-[13px] text-[var(--fg-muted)]">推理线程数</span>
                <span class="flex-none text-[13px] font-medium text-[var(--fg)]">
                    {diagnostics.threads > 0 ? diagnostics.threads : '—'}
                </span>
            </div>

            <!-- 上下文（n_ctx） -->
            <div class="flex items-center justify-between gap-4 py-3">
                <span class="text-[13px] text-[var(--fg-muted)]">上下文（n_ctx）</span>
                <span class="flex-none text-[13px] font-medium text-[var(--fg)]">
                    {diagnostics.contextLength > 0 ? diagnostics.contextLength : '—'}
                </span>
            </div>

            <!-- 推理模式（实际生效值；未载入或未知显示「—」） -->
            <div class="flex items-center justify-between gap-4 py-3">
                <span class="text-[13px] text-[var(--fg-muted)]">推理模式</span>
                <span class="flex-none text-[13px] font-medium text-[var(--fg)]">
                    {diagnostics.perfMode === 'high'
                        ? 'GPU（high）'
                        : diagnostics.perfMode === 'balanced'
                          ? 'CPU（balanced）'
                          : diagnostics.perfMode === 'low'
                            ? 'CPU（low）'
                            : diagnostics.perfMode === 'compat'
                              ? 'CPU（compat / 极低内存）'
                              : '—'}
                </span>
            </div>

            <!-- 线程模式 -->
            <div class="flex items-center justify-between gap-4 py-3">
                <span class="text-[13px] text-[var(--fg-muted)]">线程模式</span>
                <span
                    class="flex-none text-[13px] font-medium {diagnostics.aiState === 'ready' &&
                    diagnostics.singleThread
                        ? 'text-amber-600'
                        : 'text-[var(--fg)]'}"
                >
                    {diagnostics.aiState === 'ready'
                        ? diagnostics.singleThread
                            ? '单线程兼容'
                            : '多线程'
                        : '—'}
                </span>
            </div>

            <!-- 兼容提示（可能较长，允许换行且窄屏不溢出） -->
            <div class="flex items-start justify-between gap-4 py-3 last:pb-0">
                <span class="flex-none text-[13px] text-[var(--fg-muted)]">兼容提示</span>
                <span
                    class="min-w-0 flex-1 break-words text-right text-[13px] font-medium text-[var(--fg)]"
                >
                    {diagnostics.perfWarning || '—'}
                </span>
            </div>
        </div>

        <!-- 跨域隔离未开启时的兼容提示（中性/amber，不影响基本对话） -->
        {#if !diagnostics.crossOriginIsolated}
            <div class="flex items-start gap-2" role="status">
                <span class="mt-0.5 flex-none text-amber-600">
                    <ha-icon name="info" collection="lucide" size="16"></ha-icon>
                </span>
                <P size="sm" class="text-[var(--fg-muted)]">
                    未开启跨域隔离，将使用单线程兼容模式，速度较慢；不影响基本对话。
                </P>
            </div>
        {/if}

        <!-- 已启用 compat 极低内存模式时的提示（中性/amber，不影响基本对话） -->
        {#if diagnostics.perfMode === 'compat'}
            <div class="flex items-start gap-2" role="status">
                <span class="mt-0.5 flex-none text-amber-600">
                    <ha-icon name="info" collection="lucide" size="16"></ha-icon>
                </span>
                <P size="sm" class="text-[var(--fg-muted)]">
                    已启用极低内存模式（上下文最多 2048），优先保证能载入。
                </P>
            </div>
        {/if}
    </div>

    <!-- 存储方式（A1 缓存 / A2 会话） -->
    <div class="flex flex-col divide-y divide-[var(--divider)]">
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">模型存储方式</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    {#if storageMode === 'session'}
                        不保存到浏览器，仅本次使用；刷新或重开应用后需重新选择文件；不占用额外存储。
                    {:else}
                        导入后在浏览器保存一份，之后可直接载入，无需再次选择文件；会占用约 500MB 浏览器存储。
                    {/if}
                </P>
            </div>
            <SelectMenu
                value={storageMode}
                options={[
                    { value: 'cache', label: '缓存到浏览器（推荐）' },
                    { value: 'session', label: '仅本次会话' }
                ]}
                ariaLabel="模型存储方式"
                class="w-full sm:w-56 sm:flex-none"
                onchange={(v) => {
                    storageMode = v;
                    updateSetting('aiModelStorageMode', v);
                }}
            />
        </div>
    </div>

    <!-- 移动端硬件门槛不满足（已关闭 AI）：醒目提示 -->
    {#if $ai.disabled}
        <div
            class="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2"
            role="alert"
        >
            <span class="mt-0.5 flex-none text-red-500">
                <ha-icon name="alert-triangle" collection="lucide" size="18"></ha-icon>
            </span>
            <div class="flex min-w-0 flex-col gap-0.5">
                <span class="text-sm font-medium text-red-500">已关闭 AI</span>
                <P size="sm" class="text-red-500">
                    {$ai.disabledReason || '当前设备不满足本地推理的硬件要求，已关闭 AI。'}
                </P>
            </div>
        </div>
    {/if}

    <!-- AI 模型：下载列表（纯展示）+ 通用「模型操作」区（统一作用于当前模型） -->
    <div class="flex flex-col gap-3">
        <Heading tag="h3" class="text-base font-semibold text-[var(--fg)]">AI模型</Heading>

        <!-- 下载导入说明（区块顶部） -->
        <P size="sm" class="text-[var(--fg-muted)]">
            复制下载链接后，在浏览器地址栏粘贴打开即可下载；下载完成后在下方选择文件导入。
        </P>

        <!-- 下载列表（纯展示）：遍历推荐模型，仅提供复制下载链接 -->
        <div class="flex flex-col gap-2">
            {#each RECOMMENDED_MODELS as m (m.id)}
                <div
                    class="flex flex-col gap-3 rounded-lg border border-[var(--divider)] px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="text-[15px] font-medium text-[var(--fg)]">{m.label}</span>
                        <span class="text-sm text-[var(--fg-muted)]">
                            {m.note} · {m.quantization} · {m.sizeMB} MB
                        </span>
                    </span>

                    {#if downloadUrl(m)}
                        <Button
                            color="light"
                            size="sm"
                            onclick={() => copyLink(m)}
                            class="w-full sm:w-auto sm:flex-none"
                        >
                            <span class="inline-flex items-center gap-2">
                                <ha-icon
                                    name={copiedId === m.id ? 'check' : 'link'}
                                    collection="lucide"
                                    size="16"
                                ></ha-icon>
                                <span>{copiedId === m.id ? '已复制链接' : '复制下载链接'}</span>
                            </span>
                        </Button>
                    {/if}
                </div>
            {/each}
        </div>

        <!-- 模型操作：一组通用操作，统一作用于「当前模型」 -->
        <div class="flex flex-col gap-3">
            {#if currentModel && isAvailable(currentModel)}
                <P size="sm" class="text-[var(--fg-muted)]">
                    当前模型：{currentModel.label} · {isLoaded(currentModel) ? '已载入' : '已就绪'}
                </P>
            {/if}

            <div class="flex flex-wrap gap-2">
                <!-- 选择文件导入（$ai.disabled 时禁用；按文件名自动匹配推荐模型） -->
                <Button
                    color="light"
                    size="sm"
                    disabled={$ai.disabled}
                    onclick={() => fileInput?.click()}
                    class="w-full sm:w-auto"
                >
                    <span class="inline-flex items-center gap-2">
                        <ha-icon name="upload" collection="lucide" size="16"></ha-icon>
                        <span>选择文件导入</span>
                    </span>
                </Button>

                <!-- 载入（作用于当前模型） -->
                <Button
                    color="light"
                    size="sm"
                    disabled={!isAvailable(currentModel) ||
                        $ai.state === 'loading' ||
                        $ai.disabled}
                    onclick={() => currentModel && loadModel(currentModel.id)}
                    class="w-full sm:w-auto"
                >
                    <span class="inline-flex items-center gap-2">
                        <ha-icon name="play" collection="lucide" size="16"></ha-icon>
                        <span>载入</span>
                    </span>
                </Button>

                <!-- 删除（当前模型本地副本可用时） -->
                <Button
                    color="light"
                    size="sm"
                    disabled={!isAvailable(currentModel)}
                    onclick={() => currentModel && confirmDelete(currentModel.id)}
                    class="w-full sm:w-auto"
                >
                    <span class="inline-flex items-center gap-2">
                        <ha-icon name="trash-2" collection="lucide" size="16"></ha-icon>
                        <span>删除</span>
                    </span>
                </Button>

                <!-- 去对话（当前模型已载入且未关闭 AI 时可用） -->
                <Button
                    size="sm"
                    disabled={!isLoaded(currentModel) || $ai.disabled}
                    onclick={() => push('/chat')}
                    class="w-full sm:w-auto"
                >
                    <span class="inline-flex items-center gap-2">
                        <ha-icon name="message-circle" collection="lucide" size="16"></ha-icon>
                        <span>去对话</span>
                    </span>
                </Button>
            </div>

            <!-- 导入进度（$ai.progress 存在时显示） -->
            {#if $ai.progress}
                <div class="flex flex-col gap-1">
                    <div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--row-active)]">
                        {#if typeof $ai.progress.percent === 'number'}
                            <div
                                class="h-full rounded-full bg-primary-500 transition-all"
                                style="width: {Math.min(100, Math.max(0, $ai.progress.percent))}%"
                            ></div>
                        {:else}
                            <div class="h-full w-1/3 animate-pulse rounded-full bg-primary-500"></div>
                        {/if}
                    </div>
                    <P size="sm" class="text-[var(--fg-subtle)]">
                        {#if typeof $ai.progress.percent === 'number'}
                            处理中… {$ai.progress.percent}%
                        {:else}
                            处理中…
                        {/if}
                        {#if $ai.progress.file}
                            · {$ai.progress.file}
                        {/if}
                    </P>
                </div>
            {/if}

            <!-- 当前模型共用的隐藏文件选择框 -->
            <input
                type="file"
                accept=".gguf"
                bind:this={fileInput}
                onchange={onFileChange}
                disabled={$ai.disabled}
                class="hidden"
            />
        </div>
    </div>

    {#if !$ai.supported}
        <P size="sm" class="text-amber-600" role="status">
            当前浏览器不支持 WebGPU，载入后将使用 CPU 兼容模式，速度较慢。
        </P>
    {/if}
    {#if $ai.error}
        <P size="sm" class="text-red-500" role="alert">{$ai.error}</P>
    {/if}

    <!-- 对话设置 -->
    <div class="flex flex-col divide-y divide-[var(--divider)]">
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">对话时自动检索本地笔记作为上下文</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    开启后，对话会自动检索相关笔记并加入上下文。
                </P>
            </div>
            <Switch
                checked={useNotesContext}
                ariaLabel="对话时自动检索本地笔记作为上下文"
                onchange={(v) => {
                    useNotesContext = v;
                    updateSetting('aiUseNotesContext', v);
                }}
            />
        </div>

        <!-- 性能模式：按设备能力选择 GPU 卸载档位 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">性能模式</Label>
                <P size="sm" class="text-[var(--fg-subtle)]">
                    {perfModeHint}切换后需重新载入模型生效。
                </P>
            </div>
            <SelectMenu
                value={perfMode}
                options={[
                    { value: 'high', label: '性能优先' },
                    { value: 'balanced', label: '均衡' },
                    { value: 'low', label: '低功耗' }
                ]}
                ariaLabel="性能模式"
                class="w-full sm:w-56 sm:flex-none"
                onchange={(v) => {
                    perfMode = v;
                    updateSetting('aiPerfMode', v);
                }}
            />
        </div>

        <!-- 上下文长度：对话可用上下文（token），切换后需重新载入模型生效 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label for="ai-context-length" class="text-[15px] text-[var(--fg)]">
                    上下文长度
                </Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    对话可用上下文长度（token），范围 {CONTEXT_MIN}–{CONTEXT_MAX}，步进 {CONTEXT_STEP}；切换后需重新载入模型生效。
                </P>
            </div>
            <input
                id="ai-context-length"
                type="number"
                min={CONTEXT_MIN}
                max={CONTEXT_MAX}
                step={CONTEXT_STEP}
                value={contextLength}
                onchange={onContextLengthChange}
                aria-label="上下文长度"
                class="w-full rounded-lg border border-[var(--divider)] bg-[var(--field)] px-3 py-2 text-sm text-[var(--fg)] outline-none focus:border-primary-500 sm:w-40 sm:flex-none"
            />
        </div>

        <!-- 推荐值展示与一键应用 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">推荐值</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    PC 推荐 {contextPc} · 移动端推荐 {contextMobile}。PC 与移动端分别提供推荐值；首次运行会按设备自动选择推荐值。
                </P>
            </div>
            <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-none sm:flex-row sm:items-center">
                <Button
                    color="light"
                    size="sm"
                    onclick={() => applyRecommendedContext(contextPc)}
                    class="w-full sm:w-auto"
                >
                    应用 PC 推荐
                </Button>
                <Button
                    color="light"
                    size="sm"
                    onclick={() => applyRecommendedContext(contextMobile)}
                    class="w-full sm:w-auto"
                >
                    应用移动端推荐
                </Button>
            </div>
        </div>

        <!-- PC 推荐值：可调整，供「应用 PC 推荐」使用 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label for="ai-context-pc" class="text-[15px] text-[var(--fg)]">PC 推荐值</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    PC 端一键应用时使用的推荐上下文长度（token）。
                </P>
            </div>
            <input
                id="ai-context-pc"
                type="number"
                min={CONTEXT_MIN}
                max={CONTEXT_MAX}
                step={CONTEXT_STEP}
                value={contextPc}
                onchange={onContextPcChange}
                aria-label="PC 推荐值"
                class="w-full rounded-lg border border-[var(--divider)] bg-[var(--field)] px-3 py-2 text-sm text-[var(--fg)] outline-none focus:border-primary-500 sm:w-40 sm:flex-none"
            />
        </div>

        <!-- 移动端推荐值：可调整，供「应用移动端推荐」使用 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label for="ai-context-mobile" class="text-[15px] text-[var(--fg)]">
                    移动端推荐值
                </Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    移动端一键应用时使用的推荐上下文长度（token）。
                </P>
            </div>
            <input
                id="ai-context-mobile"
                type="number"
                min={CONTEXT_MIN}
                max={CONTEXT_MAX}
                step={CONTEXT_STEP}
                value={contextMobile}
                onchange={onContextMobileChange}
                aria-label="移动端推荐值"
                class="w-full rounded-lg border border-[var(--divider)] bg-[var(--field)] px-3 py-2 text-sm text-[var(--fg)] outline-none focus:border-primary-500 sm:w-40 sm:flex-none"
            />
        </div>
    </div>
</div>
