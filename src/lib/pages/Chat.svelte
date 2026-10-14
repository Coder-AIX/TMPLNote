<script>
    /**
     * Chat.svelte — 「对话」页（P4：接入真实流式对话）。
     *
     * 职责：
     * - 订阅 stores/chat.js 的会话状态，渲染会话侧栏、消息流与输入区；
     * - 组装一次发送（用户消息 + 流式助手回复）、支持中止生成；
     * - 模型运行态从 stores/ai.js 读取，未就绪时给出引导。
     */
    import { onMount } from 'svelte';
    import { fly, fade } from 'svelte/transition';
    import { Heading, P } from 'flowbite-svelte';
    import { push } from 'svelte-spa-router';
    import { toggleSidebar } from '../stores/layout.js';
    import { ai } from '../stores/ai.js';
    import {
        sessions,
        messages,
        currentId,
        generating,
        thinking,
        chatError,
        loadSessions,
        newSession,
        openSession,
        removeSession,
        sendMessage,
        abortGeneration
    } from '../stores/chat.js';
    import { runTool } from '../ai/tools.js';
    import ChatMessage from '../components/ChatMessage.svelte';

    /** 输入框草稿 */
    let draft = $state('');

    /** 消息滚动容器（用于自动滚到底） */
    let scrollEl = $state(null);

    /** 移动端「历史对话」菜单是否展开 */
    let historyOpen = $state(false);

    /** 短暂提示（保存成功/取消等），数秒后自动消失 */
    let notice = $state('');

    /** 显示提示并自动清除 */
    function flash(text) {
        notice = text;
        setTimeout(() => {
            if (notice === text) notice = '';
        }, 3000);
    }

    /** 由回复正文推导标题：取首个非空行，截断至 30 字 */
    function deriveTitle(content) {
        const firstLine =
            String(content ?? '')
                .split('\n')
                .map((s) => s.trim())
                .find(Boolean) ?? '';
        return firstLine.slice(0, 30) || 'AI 笔记';
    }

    /** 保存助手回复为笔记（走授权网关） */
    async function saveAsNote(msg) {
        const content = String(msg?.content ?? '').trim();
        if (!content) return;
        try {
            const res = await runTool('create_note', { title: deriveTitle(content), content });
            if (res?.denied) {
                flash('已取消保存');
                return;
            }
            flash(`已保存为笔记：${res?.title ?? deriveTitle(content)}`);
        } catch (e) {
            flash(`保存失败：${e?.message || String(e)}`);
        }
    }

    /** 当前模型展示名；直接取 store 字段（覆盖推荐与自定义导入模型），缺失时回退为占位文案 */
    const modelLabel = $derived($ai.modelLabel || '未选择模型');

    /** 是否满足对话前提：支持 WebGPU 且模型已载入就绪 */
    const ready = $derived($ai.supported && $ai.state === 'ready');

    /** AI 被环境关闭时的提示文案；reason 为空时回退到默认说明 */
    const disabledReason = $derived($ai.disabledReason || '当前环境不满足运行条件，AI 已关闭。');

    /** 最后一条助手消息 id（生成中用于显示光标） */
    const lastAssistantId = $derived.by(() => {
        for (let i = $messages.length - 1; i >= 0; i--) {
            if ($messages[i].role === 'assistant') return $messages[i].id;
        }
        return null;
    });

    // 载入会话列表；若已有历史且未选中会话，则打开最近一条
    onMount(() => {
        (async () => {
            await loadSessions();
            if ($sessions.length > 0 && !$currentId) {
                await openSession($sessions[0].id);
            }
        })();
    });

    /** 是否已排队一次滚动（按帧合并，避免高频滚动） */
    let scrollScheduled = $state(false);
    /** 是否吸附到底部（用户上翻离开底部时置 false） */
    let stickToBottom = $state(true);

    /** 消息区滚动：根据是否贴近底部更新吸附状态 */
    function onMessagesScroll() {
        if (!scrollEl) return;
        const distanceToBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        stickToBottom = distanceToBottom <= 16;
    }

    // 消息或生成状态变化时，按帧节流地滚动；仅在吸附状态滚到底（用户上翻后不再打断）
    $effect(() => {
        // 显式读取以建立依赖
        $messages;
        $generating;
        if (!scrollEl || !stickToBottom) return;
        if (scrollScheduled) return;
        scrollScheduled = true;
        requestAnimationFrame(() => {
            scrollScheduled = false;
            if (scrollEl && stickToBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
        });
    });

    // 切换/打开会话时，强制滚到底部（进入即在最新一条）
    $effect(() => {
        $currentId;
        if (!scrollEl) return;
        stickToBottom = true;
        requestAnimationFrame(() => {
            if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        });
    });

    /** 发送当前草稿（校验就绪与生成中状态） */
    async function submit() {
        const t = draft.trim();
        if (!t || !ready || $generating || $ai.disabled) return;
        draft = '';
        stickToBottom = true;
        await sendMessage(t);
    }

    /** 删除会话（带确认） */
    async function onRemove(session) {
        if (!window.confirm(`删除对话「${session.title || '新对话'}」？`)) return;
        await removeSession(session.id);
    }
</script>

<div class="flex h-full min-h-0 p-0 pb-[env(safe-area-inset-bottom)] md:gap-4 md:p-4 md:pb-4">
    <!-- 会话侧栏（仅桌面显示） -->
    <aside
        class="hidden min-h-0 flex-col overflow-hidden bg-[var(--card)] md:flex md:w-[240px]
               md:flex-none md:rounded-2xl md:shadow-[var(--card-shadow)]"
    >
        <div
            class="flex flex-none items-center justify-between border-b border-[var(--divider)] px-3 py-3"
        >
            <span class="text-sm font-semibold text-[var(--fg)]">会话</span>
            <button
                type="button"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--row-active)]"
                aria-label="新对话"
                onclick={() => newSession()}
            >
                <ha-icon name="plus" collection="lucide" size="18"></ha-icon>
            </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-2">
            {#if $sessions.length === 0}
                <p class="px-2 py-4 text-center text-sm text-[var(--fg-subtle)]">暂无对话</p>
            {:else}
                <ul class="flex flex-col gap-0.5">
                    {#each $sessions as s (s.id)}
                        <li class="group relative">
                            <button
                                type="button"
                                class="flex w-full items-center rounded-[10px] px-3 py-2 pe-8 text-left text-sm
                                       {s.id === $currentId
                                    ? 'bg-[var(--nav-active-bg)] font-medium text-[var(--nav-active-fg)]'
                                    : 'text-[var(--fg-muted)] hover:bg-[var(--row-active)]'}"
                                onclick={() => openSession(s.id)}
                            >
                                <span class="truncate">{s.title || '新对话'}</span>
                            </button>
                            <button
                                type="button"
                                class="absolute end-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center
                                       rounded-md text-[var(--fg-subtle)] opacity-0 hover:bg-[var(--row-active)]
                                       hover:text-[#ef4444] focus:opacity-100 group-hover:opacity-100 max-md:opacity-100"
                                aria-label="删除对话"
                                onclick={() => onRemove(s)}
                            >
                                <ha-icon name="trash-2" collection="lucide" size="15"></ha-icon>
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </aside>

    <!-- 主区：标题 + 消息 + 输入 -->
    <div
        class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--card)]
               md:rounded-2xl md:shadow-[var(--card-shadow)]"
    >
        <!-- 标题区：移动端侧边栏按钮 + 标题 + 模型名/新对话/历史对话（桌面由左侧会话栏承担会话切换） -->
        <header
            class="flex items-center justify-between gap-3 border-b border-[var(--divider)] px-4 py-3 md:px-5"
        >
            <div class="flex min-w-0 items-center gap-1.5">
                <button
                    type="button"
                    class="-ms-2 grid h-8 w-8 shrink-0 place-items-center text-[var(--fg-muted)] lg:hidden"
                    aria-label="打开侧边栏"
                    onclick={toggleSidebar}
                >
                    <ha-icon name="menu" collection="lucide" size="22"></ha-icon>
                </button>
                <Heading tag="h1" class="text-2xl font-bold text-[var(--fg)]">对话</Heading>
            </div>

            <div class="flex min-w-0 items-center gap-2 sm:gap-3">
                <!-- 模型名：仅桌面端显示 -->
                <span class="hidden max-w-none truncate text-sm text-[var(--fg-muted)] md:inline">
                    {modelLabel}
                </span>

                <!-- 新对话：桌面端文字按钮 -->
                <button
                    type="button"
                    class="hidden shrink-0 rounded-lg border border-[var(--divider)] px-3 py-1.5 text-sm
                           text-[var(--fg)] hover:bg-[var(--row-active)] md:inline-flex"
                    onclick={() => newSession()}
                >
                    新对话
                </button>

                <!-- 新对话：移动端图标按钮 -->
                <button
                    type="button"
                    class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--divider)]
                           text-[var(--fg)] hover:bg-[var(--row-active)] md:hidden"
                    aria-label="新对话"
                    onclick={() => newSession()}
                >
                    <ha-icon name="square-pen" collection="lucide" size="18"></ha-icon>
                </button>

                <!-- 历史对话：移动端图标按钮（打开右侧抽屉） -->
                <button
                    type="button"
                    class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--divider)]
                           text-[var(--fg)] hover:bg-[var(--row-active)] md:hidden"
                    aria-label="历史对话"
                    aria-expanded={historyOpen}
                    onclick={() => (historyOpen = true)}
                >
                    <ha-icon name="history" collection="lucide" size="18"></ha-icon>
                </button>
            </div>
        </header>

        <!-- 消息区：可滚动，随内容撑满剩余高度 -->
        <div bind:this={scrollEl} onscroll={onMessagesScroll} class="min-h-0 flex-1 overflow-auto p-4 md:p-5">
            {#if $messages.length === 0}
                <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                    <ha-icon
                        name="message-circle"
                        collection="lucide"
                        size="28"
                        class="text-[var(--fg-subtle)]"
                    ></ha-icon>
                    <P size="sm" class="text-[var(--fg-muted)]">
                        {ready
                            ? '发送消息开始对话'
                            : $ai.disabled
                              ? disabledReason
                              : '先在设置中下载并载入模型，然后开始对话。'}
                    </P>
                </div>
            {:else}
                <div class="flex flex-col gap-3">
                    {#each $messages as msg (msg.id)}
                        {@const pending = $generating && msg.id === lastAssistantId}
                        {@const isThinking =
                            pending &&
                            msg.role === 'assistant' &&
                            $thinking &&
                            !String(msg.content ?? '').trim()}
                        <div
                            class="flex flex-col {msg.role === 'user'
                                ? 'items-end'
                                : 'items-start'}"
                        >
                            {#if isThinking}
                                <!-- 思考中占位：已收到推理增量但尚无可见文本时给出反馈，避免移动端「空屏」 -->
                                <div class="flex w-full justify-start">
                                    <div
                                        class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl
                                               bg-[var(--field)] px-3.5 py-2.5 text-sm leading-relaxed
                                               text-[var(--fg-muted)]"
                                        role="status"
                                        aria-live="polite"
                                    >
                                        <span class="inline-block animate-pulse">思考中…</span>
                                    </div>
                                </div>
                            {:else}
                                <ChatMessage
                                    role={msg.role}
                                    content={msg.content}
                                    pending={pending}
                                />
                            {/if}
                            {#if msg.role === 'assistant' && !pending && String(msg.content ?? '').trim()}
                                <button
                                    type="button"
                                    class="mt-1 flex items-center gap-1 text-xs text-[var(--fg-subtle)] hover:text-primary-500"
                                    onclick={() => saveAsNote(msg)}
                                >
                                    <ha-icon
                                        name="bookmark"
                                        collection="lucide"
                                        size="14"
                                    ></ha-icon>
                                    <span>保存为笔记</span>
                                </button>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        <!-- 输入区：固定底部，未就绪时给出提示并禁用输入 -->
        <div class="border-t border-[var(--divider)] p-3 md:p-4">
            {#if notice}
                <div
                    class="mb-2 flex items-start gap-2 rounded-lg bg-[var(--field)] px-3 py-2 text-sm
                           text-[var(--fg-muted)]"
                    role="status"
                >
                    <ha-icon
                        name="bookmark"
                        collection="lucide"
                        size="16"
                        class="mt-0.5 shrink-0"
                    ></ha-icon>
                    <span>{notice}</span>
                </div>
            {/if}

            {#if $chatError}
                <div
                    class="mb-2 flex items-start gap-2 rounded-lg bg-[#ef4444]/10 px-3 py-2 text-sm
                           text-[#ef4444]"
                    role="alert"
                >
                    <ha-icon
                        name="triangle-alert"
                        collection="lucide"
                        size="16"
                        class="mt-0.5 shrink-0"
                    ></ha-icon>
                    <span>{$chatError}</span>
                </div>
            {/if}

            {#if $ai.disabled}
                <div
                    class="mb-2 flex items-start gap-2 rounded-lg bg-[#ef4444]/10 px-3 py-2 text-sm
                           font-medium text-[#ef4444]"
                    role="alert"
                >
                    <ha-icon
                        name="triangle-alert"
                        collection="lucide"
                        size="16"
                        class="mt-0.5 shrink-0"
                    ></ha-icon>
                    <span>{disabledReason}</span>
                </div>
            {:else if !$ai.supported}
                <div
                    class="mb-2 flex items-start gap-2 rounded-lg bg-[var(--field)] px-3 py-2 text-sm
                           text-[var(--fg-muted)]"
                    role="status"
                >
                    <ha-icon
                        name="triangle-alert"
                        collection="lucide"
                        size="16"
                        class="mt-0.5 shrink-0"
                    ></ha-icon>
                    <span>当前浏览器不支持 WebGPU，无法使用本地对话。</span>
                </div>
            {:else if !ready}
                <div
                    class="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg
                           bg-[var(--field)] px-3 py-2 text-sm text-[var(--fg-muted)]"
                    role="status"
                >
                    <span>模型尚未载入。前往设置下载并载入模型。</span>
                    <button
                        type="button"
                        class="shrink-0 rounded-lg bg-primary-500 px-3 py-1.5 text-sm font-medium
                               text-white hover:bg-primary-600"
                        onclick={() => push('/settings/ai')}
                    >
                        前往设置
                    </button>
                </div>
            {/if}

            <div class="flex items-end gap-2">
                <textarea
                    bind:value={draft}
                    rows="1"
                    disabled={!ready || $ai.disabled}
                    placeholder={$ai.disabled ? 'AI 已关闭' : '输入消息…'}
                    aria-label="消息输入框"
                    class="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border
                           border-[var(--divider)] bg-[var(--field)] px-3.5 py-2.5 text-sm
                           text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)]
                           focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
                    onkeydown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            submit();
                        }
                    }}
                ></textarea>

                {#if $generating}
                    <button
                        type="button"
                        aria-label="停止"
                        class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--row-active)]
                               text-[var(--fg)] hover:bg-[var(--divider)]"
                        onclick={abortGeneration}
                    >
                        <ha-icon name="square" collection="lucide" size="18"></ha-icon>
                    </button>
                {:else}
                    <button
                        type="button"
                        disabled={!ready || $ai.disabled}
                        aria-label="发送"
                        class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-500
                               text-white hover:bg-primary-600 disabled:cursor-not-allowed
                               disabled:opacity-50"
                        onclick={submit}
                    >
                        <ha-icon name="send" collection="lucide" size="18"></ha-icon>
                    </button>
                {/if}
            </div>
        </div>
    </div>

    <!-- 移动端：对话历史右侧抽屉 -->
    {#if historyOpen}
        <button
            type="button"
            class="fixed inset-0 z-40 bg-black/40 md:hidden"
            aria-label="关闭对话历史"
            onclick={() => (historyOpen = false)}
            in:fade={{ duration: 120 }}
        ></button>
        <aside
            class="fixed inset-y-0 end-0 z-50 flex w-72 max-w-[85vw] flex-col bg-[var(--canvas)]
                   shadow-[var(--card-shadow)] md:hidden"
            aria-label="对话历史"
            in:fly={{ x: 24, duration: 150 }}
        >
            <header
                class="flex flex-none items-center justify-between border-b border-[var(--divider)] px-4 py-3"
            >
                <span class="text-sm font-semibold text-[var(--fg)]">对话历史</span>
                <button
                    type="button"
                    class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--row-active)]"
                    aria-label="关闭"
                    onclick={() => (historyOpen = false)}
                >
                    <ha-icon name="x" collection="lucide" size="18"></ha-icon>
                </button>
            </header>

            <div class="min-h-0 flex-1 overflow-y-auto p-2">
                {#if $sessions.length === 0}
                    <p class="px-2 py-4 text-center text-sm text-[var(--fg-subtle)]">暂无对话</p>
                {:else}
                    <ul class="flex flex-col gap-0.5">
                        {#each $sessions as s (s.id)}
                            <li class="group relative">
                                <button
                                    type="button"
                                    class="flex w-full items-center rounded-[10px] px-3 py-2 pe-10 text-left text-sm
                                           {s.id === $currentId
                                        ? 'bg-[var(--nav-active-bg)] font-medium text-[var(--nav-active-fg)]'
                                        : 'text-[var(--fg-muted)] hover:bg-[var(--row-active)]'}"
                                    onclick={() => {
                                        openSession(s.id);
                                        historyOpen = false;
                                    }}
                                >
                                    <span class="truncate">{s.title || '新对话'}</span>
                                </button>
                                <button
                                    type="button"
                                    class="absolute end-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center
                                           rounded-md text-[var(--fg-subtle)] hover:bg-[var(--row-active)]
                                           hover:text-[#ef4444]"
                                    aria-label="删除对话"
                                    onclick={() => onRemove(s)}
                                >
                                    <ha-icon name="trash-2" collection="lucide" size="15"></ha-icon>
                                </button>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </div>
        </aside>
    {/if}
</div>
