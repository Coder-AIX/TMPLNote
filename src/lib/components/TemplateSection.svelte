<script>
    import { Heading } from 'flowbite-svelte';
    import { push } from 'svelte-spa-router';
    import notesRepository from '../db/notes.js';
    import { notesVersion, bumpNotes } from '../stores/workspace.js';
    import { formatRelativeTime } from '../utils/format.js';

    let templates = $state([]);
    let loading = $state(false);

    /** 拉取全部模板（按更新时间倒序） */
    async function load() {
        loading = true;
        try {
            templates = await notesRepository.listTemplates();
        } finally {
            loading = false;
        }
    }

    // 挂载时以及数据版本变化时重新加载
    $effect(() => {
        $notesVersion;
        load();
    });

    /** 新建模板并跳转到独立编辑页 */
    async function createTemplate() {
        const t = await notesRepository.createTemplate({ title: '未命名模板', content: '' });
        bumpNotes();
        push(`/template/${t.id}`);
    }

    /** 打开指定模板的独立编辑页 */
    function openTemplate(t) {
        push(`/template/${t.id}`);
    }

    /** 删除模板（带确认） */
    async function removeTemplate(t) {
        if (!window.confirm(`删除模板「${t.title}」？`)) return;
        await notesRepository.remove(t.id);
        bumpNotes();
    }
</script>

<div class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3">
        <Heading tag="h2" class="text-lg font-semibold text-[var(--fg)]">模板</Heading>
        <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-600"
            onclick={createTemplate}
        >
            <ha-icon name="plus" collection="lucide" size="18"></ha-icon>
            <span>新建模板</span>
        </button>
    </div>

    {#if loading}
        <p class="py-6 text-center text-sm text-[var(--fg-subtle)]">加载中…</p>
    {:else if templates.length === 0}
        <p class="py-6 text-center text-sm text-[var(--fg-subtle)]">
            暂无模板，点击「新建模板」创建
        </p>
    {:else}
        <ul class="flex flex-col divide-y divide-[var(--divider)]">
            {#each templates as t (t.id)}
                <li class="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                        onclick={() => openTemplate(t)}
                    >
                        <span class="truncate text-[15px] font-medium text-[var(--fg)]">
                            {t.title}
                        </span>
                        <span class="text-xs text-[var(--fg-subtle)]">
                            {formatRelativeTime(t.updatedAt)}
                        </span>
                    </button>

                    <div class="flex flex-none items-center gap-1">
                        <button
                            type="button"
                            class="grid h-8 w-8 place-items-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--row-active)] hover:text-[var(--fg)]"
                            aria-label="编辑模板"
                            onclick={() => openTemplate(t)}
                        >
                            <ha-icon name="pencil" collection="lucide" size="16"></ha-icon>
                        </button>
                        <button
                            type="button"
                            class="grid h-8 w-8 place-items-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--row-active)] hover:text-[var(--fg)]"
                            aria-label="删除模板"
                            onclick={() => removeTemplate(t)}
                        >
                            <ha-icon name="trash-2" collection="lucide" size="16"></ha-icon>
                        </button>
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
</div>
