<script>
    /**
     * 聊天消息气泡（纯展示组件）。
     * - role === 'user'：右对齐、主题色底、白字
     * - role === 'assistant'：左对齐、浅色令牌底、常规文字色
     * - role === 'system'：不渲染任何可见内容
     * pending 为 true 时在文本末尾追加一个闪烁光标，表示正在生成。
     */
    let { role, content, pending = false } = $props();
</script>

{#if role === 'user'}
    <!-- 用户消息：右对齐，主题色气泡 -->
    <div class="flex w-full justify-end">
        <div
            class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary-500 px-3.5 py-2.5 text-sm leading-relaxed text-white"
        >
            {content}{#if pending}<span class="ml-0.5 inline-block animate-pulse" aria-hidden="true"
                    >▋</span
                >{/if}
        </div>
    </div>
{:else if role === 'assistant'}
    <!-- 助手消息：左对齐，浅色气泡 -->
    <div class="flex w-full justify-start">
        <div
            class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--field)] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--fg)]"
        >
            {content}{#if pending}<span
                    class="ml-0.5 inline-block animate-pulse text-[var(--fg-subtle)]"
                    aria-hidden="true">▋</span
                >{/if}
        </div>
    </div>
{/if}
