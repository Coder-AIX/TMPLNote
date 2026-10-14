<script>
    import { tick, untrack, onMount } from 'svelte';
    import RichEditor from '../components/RichEditor.svelte';
    import notesRepository from '../db/notes.js';
    import { selectedNoteId, bumpNotes } from '../stores/workspace.js';

    let note = $state(null);
    let noteTitle = $state('');
    let content = $state('');
    let status = $state('idle'); // idle | saving | saved | error
    let savedAt = $state('');
    let dirty = $state(false);
    let currentId = null;
    let saveTimer;

    async function flush() {
        if (!dirty || !currentId) return;
        clearTimeout(saveTimer);
        const id = currentId;
        const payload = { title: noteTitle, content };
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

    async function loadNote(id) {
        currentId = id;
        dirty = false;
        if (!id) {
            note = null;
            noteTitle = '';
            content = '';
            status = 'idle';
            return;
        }
        const n = await notesRepository.get(id);
        if (currentId !== id) return;
        note = n ?? null;
        noteTitle = n?.title ?? '';
        content = n?.content ?? '';
        status = 'idle';
    }

    // 切换选中笔记：先落盘上一条，再载入新一条
    $effect(() => {
        const id = $selectedNoteId;
        untrack(() => {
            (async () => {
                await flush();
                await loadNote(id);
                await tick();
            })();
        });
    });

    /** 是否窄屏（移动端）：与项目其它 lg 断点保持一致 */
    function isNarrowViewport() {
        return typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
    }

    // 移动端：打开笔记时压入一条历史记录，
    // 使系统返回手势（左滑 / 返回键）回到「笔记列表」而不是直接退出应用。
    let historyPushed = false;
    $effect(() => {
        const id = $selectedNoteId;
        if (!id) {
            historyPushed = false;
            return;
        }
        if (!historyPushed && isNarrowViewport()) {
            try {
                history.pushState({ tmplnoteNote: id }, '', location.href);
                historyPushed = true;
            } catch (e) {
                /* 忽略：环境不支持时不影响其它功能 */
            }
        }
    });

    onMount(() => {
        const onPopState = () => {
            // 由系统返回触发：若正编辑笔记，则落盘并回到列表
            if ($selectedNoteId) {
                flush();
                selectedNoteId.set(null);
            }
            historyPushed = false;
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    });

    function back() {
        // 移动端已压入历史时，交给系统返回（popstate 会清空选中并回到列表）
        if (historyPushed) {
            historyPushed = false;
            history.back();
            return;
        }
        flush();
        selectedNoteId.set(null);
    }

    async function deleteNote() {
        if (!currentId) return;
        if (!window.confirm('删除笔记将移入「最近删除」，确定删除？')) return;
        clearTimeout(saveTimer);
        dirty = false;
        await notesRepository.softDelete(currentId);
        selectedNoteId.set(null);
        bumpNotes();
    }

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

<div class="flex h-full min-h-0 flex-col">
    {#if !note}
        <div class="flex h-full items-center justify-center p-6 text-center">
            <p class="text-sm text-[var(--fg-subtle)]">选择或新建一条笔记</p>
        </div>
    {:else}
        <div class="flex flex-none items-center gap-2 px-4 pt-3 lg:hidden">
            <button
                type="button"
                class="grid h-9 w-9 place-items-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--row-active)]"
                aria-label="返回列表"
                onclick={back}
            >
                <ha-icon name="arrow-left" collection="lucide" size="20"></ha-icon>
            </button>
        </div>

        <RichEditor
            value={content}
            placeholder="开始输入…"
            onchange={(html) => {
                content = html;
                scheduleSave();
            }}
            ondelete={deleteNote}
        >
            {#snippet title()}
                <div class="flex items-center gap-3 pt-6 pb-1">
                    <input
                        class="min-w-0 flex-1 border-0 bg-transparent text-[28px] font-semibold leading-tight text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)]"
                        placeholder="标题"
                        bind:value={noteTitle}
                        oninput={scheduleSave}
                    />
                    <span class="hidden shrink-0 text-xs text-[var(--fg-subtle)] sm:inline">{statusText}</span>
                </div>
            {/snippet}
        </RichEditor>
    {/if}
</div>
