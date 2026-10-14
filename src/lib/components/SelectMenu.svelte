<script>
    /**
     * SelectMenu —— 轻量自定义下拉（样式对齐笔记列表排序菜单）
     * @type {{
     *   value: any,
     *   options: Array<{ value: any, label: string }>,
     *   ariaLabel?: string,
     *   onchange?: (value: any) => void,
     *   class?: string
     * }}
     */
    let { value = null, options = [], ariaLabel = '选择', onchange = () => {}, class: className = '' } = $props();

    /** 面板是否展开 */
    let open = $state(false);

    /** 当前选项 */
    const current = $derived(options.find((o) => o.value === value) ?? null);

    /** 菜单是否向上展开（空间不足时翻转，避免被视口底部裁剪） */
    let openUp = $state(false);

    /** 触发按钮元素引用（用于测量可用空间） */
    let triggerEl = $state(null);

    /** 估算菜单高度（每项约 34px，最大 256px） */
    function estimateMenuHeight() {
        return Math.min(options.length * 34 + 8, 256);
    }

    /** 打开前根据下方可用空间决定展开方向 */
    function toggle() {
        if (!open && triggerEl) {
            const rect = triggerEl.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            openUp = spaceBelow < estimateMenuHeight() + 12;
        }
        open = !open;
    }

    /** 选择某项并关闭 */
    function pick(next) {
        open = false;
        if (next !== value) onchange(next);
    }
</script>

<div class="relative {className}">
    <button
        type="button"
        class="flex w-full items-center justify-between gap-1 rounded-md border border-[var(--divider)] bg-[var(--card)] px-2.5 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
        aria-label={ariaLabel}
        aria-expanded={open}
        bind:this={triggerEl}
        onclick={toggle}
    >
        <span class="truncate">{current?.label ?? ''}</span>
        <ha-icon name="chevron-down" collection="lucide" size="14"></ha-icon>
    </button>

    {#if open}
        <!-- 全屏遮罩：点击外部关闭 -->
        <button
            type="button"
            class="fixed inset-0 z-20 cursor-default"
            aria-label="关闭菜单"
            onclick={() => (open = false)}
        ></button>
        <div
            class="absolute end-0 z-30 max-h-64 w-full min-w-[8rem] overflow-y-auto rounded-lg border border-[var(--divider)] bg-[var(--card)] p-1 shadow-[var(--card-shadow)] {openUp
                ? 'bottom-full mb-1'
                : 'top-full mt-1'}"
        >
            {#each options as opt (opt.value)}
                <button
                    type="button"
                    class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                    onclick={() => pick(opt.value)}
                >
                    <span>{opt.label}</span>
                    {#if opt.value === value}
                        <ha-icon name="check" collection="lucide" size="14" class="text-primary-500"></ha-icon>
                    {/if}
                </button>
            {/each}
        </div>
    {/if}
</div>
