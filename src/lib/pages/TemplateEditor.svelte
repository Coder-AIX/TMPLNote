<script>
    import { tick, untrack, onDestroy } from 'svelte';
    import { push } from 'svelte-spa-router';
    import RichEditor from '../components/RichEditor.svelte';
    import notesRepository from '../db/notes.js';
    import { bumpNotes } from '../stores/workspace.js';

    let { params } = $props();

    let template = $state(null);
    let templateTitle = $state('');
    let content = $state('');
    let status = $state('idle'); // idle | saving | saved | error
    let savedAt = $state('');
    let dirty = $state(false);
    let currentId = null;
    let saveTimer;
    let loaded = $state(false);

    async function flush() {
        if (!dirty || !currentId) return;
        clearTimeout(saveTimer);
        const id = currentId;
        const payload = { title: templateTitle, content };
        dirty = false;
        try {
            await notesRepository.update(id, payload);
            status = 'saved';
            savedAt = new Date().toLocaleTimeString();
            bumpNotes();
        } catch (e) {
            status = 'error';
        }
    }

    function scheduleSave() {
        dirty = true;
        status = 'saving';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            flush();
        }, 600);
    }

    async function loadTemplate(id) {
        currentId = id;
        dirty = false;
        if (!id) {
            template = null;
            templateTitle = '';
            content = '';
            status = 'idle';
            loaded = true;
            return;
        }
        loaded = false;
        const t = await notesRepository.get(id);
        if (currentId !== id) return;
        template = t && t.isTemplate ? t : null;
        templateTitle = template?.title ?? '';
        content = template?.content ?? '';
        status = 'idle';
        loaded = true;
    }

    // 切换模板：先落盘上一条，再载入新一条
    $effect(() => {
        const id = params?.id;
        untrack(() => {
            (async () => {
                await flush();
                await loadTemplate(id);
                await tick();
            })();
        });
    });

    async function back() {
        await flush();
        push('/settings/templates');
    }

    async function deleteTemplate() {
        if (!currentId) return;
        if (!window.confirm('删除当前模板？')) return;
        clearTimeout(saveTimer);
        dirty = false;
        await notesRepository.remove(currentId);
        bumpNotes();
        push('/settings/templates');
    }

    onDestroy(() => {
        clearTimeout(saveTimer);
    });

    const statusText = $derived(
        status === 'saving'
            ? '保存中…'
            : status === 'saved'
              ? `已保存 ${savedAt}`
              : status === 'error'
                ? '保存失败'
                : ''
    );
</script>

<div class="flex h-full min-h-0 p-0 pb-[env(safe-area-inset-bottom)] md:p-4 md:pb-4">
    <div class="min-w-0 flex-1 overflow-hidden bg-[var(--card)] md:rounded-2xl md:shadow-[var(--card-shadow)]">
        {#if !loaded}
            <div class="flex h-full items-center justify-center p-6 text-center">
                <p class="text-sm text-[var(--fg-subtle)]">加载中…</p>
            </div>
        {:else if !template}
            <div class="flex h-full items-center justify-center p-6 text-center">
                <div class="flex flex-col items-center gap-4">
                    <p class="text-sm text-[var(--fg-subtle)]">模板不存在或已被删除</p>
                    <button
                        type="button"
                        class="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600"
                        onclick={back}
                    >
                        返回模板列表
                    </button>
                </div>
            </div>
        {:else}
            <div class="flex h-full min-h-0 flex-col">
                <div class="flex flex-none items-center gap-2 px-4 pt-3">
                    <button
                        type="button"
                        class="grid h-9 w-9 place-items-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--row-active)]"
                        aria-label="返回模板列表"
                        onclick={back}
                    >
                        <ha-icon name="arrow-left" collection="lucide" size="20"></ha-icon>
                    </button>
                </div>

                <RichEditor
                    value={content}
                    placeholder="输入模板内容…"
                    onchange={(html) => {
                        content = html;
                        scheduleSave();
                    }}
                    ondelete={deleteTemplate}
                >
                    {#snippet title()}
                        <div class="flex items-center gap-3 pt-6 pb-1">
                            <input
                                class="min-w-0 flex-1 border-0 bg-transparent text-[28px] font-semibold leading-tight text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)]"
                                placeholder="模板标题"
                                bind:value={templateTitle}
                                oninput={scheduleSave}
                            />
                            <span class="hidden shrink-0 text-xs text-[var(--fg-subtle)] sm:inline">{statusText}</span>
                        </div>
                    {/snippet}
                </RichEditor>
            </div>
        {/if}
    </div>
</div>
