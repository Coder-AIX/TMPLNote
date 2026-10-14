<script>
    import { Button, P, Modal } from 'flowbite-svelte';
    import foldersRepository from '../db/folders.js';
    import notesRepository from '../db/notes.js';
    import { ROOT_ID } from '../db/schema.js';

    // 父级以 <ExportDialog bind:open={...} /> 使用
    let { open = $bindable(false) } = $props();

    let format = $state('markdown');
    let tree = $state([]); // 根文件夹数组（含 children）
    let unfiled = $state([]); // 未分类笔记（folderId === ROOT_ID 且非模板）
    let notesByFolder = $state({}); // folderId → 该文件夹下笔记数组（非模板）
    let templates = $state([]);
    let noteIds = $state([]);
    let loading = $state(false);
    let exporting = $state(false);
    let error = $state('');

    const FORMAT_OPTIONS = [
        { value: 'markdown', label: 'Markdown (.md)' },
        { value: 'text', label: '纯文本 (.txt)' },
        { value: 'docx', label: 'Word (.docx)' }
    ];
    let formatMenuOpen = $state(false);
    let formatLabel = $derived(
        FORMAT_OPTIONS.find((item) => item.value === format)?.label ?? 'Markdown (.md)'
    );

    // 块折叠状态（默认展开）
    let expandedTemplates = $state(true);
    let expandedNotes = $state(true);

    /** 文件夹折叠状态：id → 是否展开；缺省视为展开 */
    let expandedFolders = $state({});

    function isFolderExpanded(id) {
        return expandedFolders[id] !== false;
    }
    function toggleFolderExpand(id) {
        expandedFolders = { ...expandedFolders, [id]: !isFolderExpanded(id) };
    }
    /** 文件夹是否有可折叠内容 */
    function folderHasChildren(folder) {
        return (folder.children?.length ?? 0) > 0 || (notesByFolder[folder.id]?.length ?? 0) > 0;
    }

    /** 载入文件夹树、全部非模板笔记（按 folderId 分组）与模板列表 */
    async function load() {
        loading = true;
        try {
            const [folderTree, notes, tmpl] = await Promise.all([
                foldersRepository.tree(),
                notesRepository.list({ includeTemplates: false }),
                notesRepository.listTemplates()
            ]);

            const unfiledNotes = [];
            const grouped = {};
            for (const note of notes) {
                const folderId = note.folderId ?? ROOT_ID;
                if (folderId === ROOT_ID) {
                    unfiledNotes.push(note);
                } else {
                    (grouped[folderId] ??= []).push(note);
                }
            }

            tree = folderTree;
            unfiled = unfiledNotes;
            notesByFolder = grouped;
            templates = tmpl;
        } finally {
            loading = false;
        }
    }

    // 每次打开时重新载入并重置选择与错误
    $effect(() => {
        if (!open) return;
        format = 'markdown';
        error = '';
        formatMenuOpen = false;
        noteIds = [];
        expandedFolders = {};
        load();
    });

    /** 顶部「已选 N 项」计数 */
    let selectedCount = $derived(noteIds.length);

    /** 模板 id 集合 */
    let templateIds = $derived(new Set(templates.map((item) => item.id)));

    /** 全部非模板笔记 id（未分类 + 各文件夹下） */
    let nonTemplateNoteIdList = $derived.by(() => {
        const ids = unfiled.map((item) => item.id);
        for (const root of tree) {
            for (const note of notesByFolder[root.id] ?? []) ids.push(note.id);
            for (const child of root.children ?? []) {
                for (const note of notesByFolder[child.id] ?? []) ids.push(note.id);
            }
        }
        return ids;
    });

    /** 模板块：已选数量 */
    let selectedTemplateCount = $derived(
        templates.filter((item) => noteIds.includes(item.id)).length
    );

    /** 笔记块：已选数量（非模板笔记） */
    let selectedNotesCount = $derived(noteIds.filter((id) => !templateIds.has(id)).length);

    /** 笔记块：总数（全部非模板笔记） */
    let notesTotal = $derived(nonTemplateNoteIdList.length);

    /** 模板块是否已全选 */
    let templatesAllSelected = $derived(
        templates.length > 0 && templates.every((item) => noteIds.includes(item.id))
    );

    /** 笔记块是否已全选 */
    let notesAllSelected = $derived(
        nonTemplateNoteIdList.length > 0 &&
            nonTemplateNoteIdList.every((id) => noteIds.includes(id))
    );

    /** 派生：仅包含「全选」状态的文件夹 id（传给导出层） */
    let effectiveFolderIds = $derived.by(() => {
        const ids = [];
        for (const root of tree) {
            if (folderState(root) === 'all') ids.push(root.id);
            for (const child of root.children ?? []) {
                if (folderState(child) === 'all') ids.push(child.id);
            }
        }
        return ids;
    });

    /** 单个笔记：勾选/取消（重新赋值以保证响应式） */
    function toggleNote(id, checked) {
        if (checked) {
            if (!noteIds.includes(id)) noteIds = [...noteIds, id];
        } else {
            noteIds = noteIds.filter((item) => item !== id);
        }
    }

    /** 某文件夹的全部后代笔记 id（含其子文件夹下的笔记） */
    function descendantNoteIds(folder) {
        const ids = [];
        for (const note of notesByFolder[folder.id] ?? []) ids.push(note.id);
        for (const child of folder.children ?? []) {
            for (const note of notesByFolder[child.id] ?? []) ids.push(note.id);
        }
        return ids;
    }

    /** 文件夹状态：'all' | 'partial' | 'none'（按后代笔记的选中情况派生） */
    function folderState(folder) {
        const ids = descendantNoteIds(folder);
        if (ids.length === 0) return 'none';
        let selected = 0;
        for (const id of ids) if (noteIds.includes(id)) selected += 1;
        if (selected === 0) return 'none';
        if (selected === ids.length) return 'all';
        return 'partial';
    }

    /** 勾选/取消文件夹（级联全部后代笔记） */
    function toggleFolderAll(folder) {
        const ids = descendantNoteIds(folder);
        if (ids.length === 0) return;
        const set = new Set(ids);
        if (folderState(folder) === 'all') {
            noteIds = noteIds.filter((id) => !set.has(id));
        } else {
            noteIds = Array.from(new Set([...noteIds, ...ids]));
        }
    }

    /** 块内全选/取消：模板 */
    function toggleSelectTemplates() {
        if (templatesAllSelected) {
            noteIds = noteIds.filter((id) => !templateIds.has(id));
        } else {
            noteIds = Array.from(new Set([...noteIds, ...templates.map((item) => item.id)]));
        }
    }

    /** 块内全选/取消：笔记（全部非模板笔记） */
    function toggleSelectNotes() {
        if (notesAllSelected) {
            const noteSet = new Set(nonTemplateNoteIdList);
            noteIds = noteIds.filter((id) => !noteSet.has(id));
        } else {
            noteIds = Array.from(new Set([...noteIds, ...nonTemplateNoteIdList]));
        }
    }

    /** 全选：所有模板 + 所有非模板笔记 */
    function selectAll() {
        noteIds = Array.from(
            new Set([...templates.map((item) => item.id), ...nonTemplateNoteIdList])
        );
    }

    /** 清空：取消全部选择 */
    function clearAll() {
        noteIds = [];
    }

    /** 导出：动态载入导出编排层，构建 ZIP 并触发下载 */
    async function handleExport() {
        error = '';
        exporting = true;
        try {
            const { buildExport } = await import('../db/exportBundle.js');
            const { blob, filename } = await buildExport({
                noteIds,
                folderIds: effectiveFolderIds,
                format
            });

            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);

            open = false;
        } catch (e) {
            error = e?.message || '导出失败。';
        } finally {
            exporting = false;
        }
    }
</script>

{#snippet checkbox(checked, indeterminate, onchange, label)}
    {@const active = checked || indeterminate}
    <input
        type="checkbox"
        class="peer sr-only"
        checked={checked}
        onchange={(e) => onchange(e.currentTarget.checked)}
        aria-label={label}
        aria-checked={indeterminate ? 'mixed' : checked ? 'true' : 'false'}
    />
    <span
        class="grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500/40 {active
            ? 'border-primary-500 bg-primary-500 text-white'
            : 'border-[var(--divider)] bg-[var(--field)] text-transparent'}"
        aria-hidden="true"
    >
        <ha-icon name={indeterminate ? 'minus' : 'check'} collection="lucide" size="12"></ha-icon>
    </span>
{/snippet}

{#snippet noteRow(note)}
    <label
        class="flex cursor-pointer items-center gap-2 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
        {@render checkbox(
            noteIds.includes(note.id),
            false,
            (checked) => toggleNote(note.id, checked),
            note.title
        )}
        <ha-icon name="file-text" collection="lucide" size="15"></ha-icon>
        <span class="truncate">{note.title}</span>
    </label>
{/snippet}

<Modal
    bind:open
    title="导出数据"
    size="none"
    class="max-w-[calc(100vw-2rem)] sm:max-w-lg max-md:mt-4 max-md:mb-auto"
>
    <div class="flex flex-col gap-4">
        <P size="sm" class="text-[var(--fg-muted)]">
            选择要导出的文件夹与笔记，导出为 ZIP 压缩包。
        </P>

        <!-- 工具行：全选 / 清空 + 选择计数 -->
        <div class="flex items-center gap-2">
            <Button size="xs" color="light" onclick={selectAll}>全选</Button>
            <Button size="xs" color="light" onclick={clearAll}>清空</Button>
            <span class="ms-auto text-xs text-[var(--fg-subtle)]">已选 {selectedCount} 项</span>
        </div>

        <!-- 可滚动选择区（两大块：模板 / 笔记） -->
        <div class="max-h-[46vh] overflow-y-auto rounded-lg border border-[var(--divider)]">
            {#if loading}
                <p class="py-6 text-center text-sm text-[var(--fg-subtle)]">加载中…</p>
            {:else}
                <!-- 模板块 -->
                <section>
                    <div
                        class="sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-[var(--divider)] bg-[var(--card)] px-3 py-2 text-sm font-medium text-[var(--fg)]"
                        role="button"
                        tabindex="0"
                        aria-expanded={expandedTemplates}
                        onclick={() => (expandedTemplates = !expandedTemplates)}
                        onkeydown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                expandedTemplates = !expandedTemplates;
                            }
                        }}
                    >
                        <ha-icon name="layout-template" collection="lucide" size="16"></ha-icon>
                        <span>模板</span>
                        <span class="truncate text-xs font-normal text-[var(--fg-subtle)]">
                            共 {templates.length} · 已选 {selectedTemplateCount}
                        </span>
                        <button
                            type="button"
                            class="ms-auto shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--field)] hover:text-[var(--fg)]"
                            onclick={(event) => {
                                event.stopPropagation();
                                toggleSelectTemplates();
                            }}
                        >
                            {templatesAllSelected ? '取消' : '全选'}
                        </button>
                        <ha-icon
                            name={expandedTemplates ? 'chevron-down' : 'chevron-right'}
                            collection="lucide"
                            size="16"
                        ></ha-icon>
                    </div>
                    {#if expandedTemplates}
                        <div class="flex flex-col gap-1.5 px-3 py-2">
                            {#if templates.length > 0}
                                {#each templates as t (t.id)}
                                    {@render noteRow(t)}
                                {/each}
                            {:else}
                                <p class="text-sm text-[var(--fg-subtle)]">暂无模板</p>
                            {/if}
                        </div>
                    {/if}
                </section>

                <!-- 笔记块 -->
                <section>
                    <div
                        class="sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-[var(--divider)] bg-[var(--card)] px-3 py-2 text-sm font-medium text-[var(--fg)]"
                        role="button"
                        tabindex="0"
                        aria-expanded={expandedNotes}
                        onclick={() => (expandedNotes = !expandedNotes)}
                        onkeydown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                expandedNotes = !expandedNotes;
                            }
                        }}
                    >
                        <ha-icon name="notebook-text" collection="lucide" size="16"></ha-icon>
                        <span>笔记</span>
                        <span class="truncate text-xs font-normal text-[var(--fg-subtle)]">
                            共 {notesTotal} · 已选 {selectedNotesCount}
                        </span>
                        <button
                            type="button"
                            class="ms-auto shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--field)] hover:text-[var(--fg)]"
                            onclick={(event) => {
                                event.stopPropagation();
                                toggleSelectNotes();
                            }}
                        >
                            {notesAllSelected ? '取消' : '全选'}
                        </button>
                        <ha-icon
                            name={expandedNotes ? 'chevron-down' : 'chevron-right'}
                            collection="lucide"
                            size="16"
                        ></ha-icon>
                    </div>
                    {#if expandedNotes}
                        <div class="flex flex-col gap-1.5 px-3 py-2">
                            {#if notesTotal > 0}
                                <!-- 未分类 -->
                                {#if unfiled.length > 0}
                                    <div class="flex flex-col gap-1.5">
                                        <div
                                            class="flex items-center gap-2 ps-1 text-sm font-medium text-[var(--fg)]"
                                        >
                                            <ha-icon
                                                name="folder"
                                                collection="lucide"
                                                size="16"
                                            ></ha-icon>
                                            <span>未分类</span>
                                        </div>
                                        <div class="flex flex-col gap-1.5 ps-6">
                                            {#each unfiled as n (n.id)}
                                                {@render noteRow(n)}
                                            {/each}
                                        </div>
                                    </div>
                                {/if}

                                <!-- 根文件夹：文件夹复选框 + 笔记 + 子文件夹 -->
                                {#each tree as folder (folder.id)}
                                    {@const state = folderState(folder)}
                                    <div class="flex flex-col gap-1.5">
                                        <div
                                            class="flex items-center gap-2 text-sm font-medium text-[var(--fg)]"
                                        >
                                            {#if folderHasChildren(folder)}
                                                <button
                                                    type="button"
                                                    class="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--fg-subtle)] transition-colors hover:bg-[var(--field)] hover:text-[var(--fg)]"
                                                    aria-label={isFolderExpanded(folder.id)
                                                        ? '折叠文件夹'
                                                        : '展开文件夹'}
                                                    aria-expanded={isFolderExpanded(folder.id)}
                                                    onclick={(event) => {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        toggleFolderExpand(folder.id);
                                                    }}
                                                >
                                                    <ha-icon
                                                        name={isFolderExpanded(folder.id)
                                                            ? 'chevron-down'
                                                            : 'chevron-right'}
                                                        collection="lucide"
                                                        size="16"
                                                    ></ha-icon>
                                                </button>
                                            {:else}
                                                <span class="h-6 w-6 shrink-0" aria-hidden="true"
                                                ></span>
                                            {/if}
                                            <label
                                                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                                            >
                                                {@render checkbox(
                                                    state === 'all',
                                                    state === 'partial',
                                                    () => toggleFolderAll(folder),
                                                    folder.name
                                                )}
                                                <ha-icon
                                                    name="folder"
                                                    collection="lucide"
                                                    size="16"
                                                ></ha-icon>
                                                <span class="truncate">{folder.name}</span>
                                            </label>
                                        </div>
                                        {#if isFolderExpanded(folder.id)}
                                            <div class="flex flex-col gap-1.5 ps-9">
                                                {#each notesByFolder[folder.id] ?? [] as n (n.id)}
                                                    {@render noteRow(n)}
                                                {/each}

                                                {#each folder.children ?? [] as child (child.id)}
                                                    {@const childState = folderState(child)}
                                                    <div class="flex flex-col gap-1.5">
                                                        <div
                                                            class="flex items-center gap-2 text-sm text-[var(--fg)]"
                                                        >
                                                            {#if folderHasChildren(child)}
                                                                <button
                                                                    type="button"
                                                                    class="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--fg-subtle)] transition-colors hover:bg-[var(--field)] hover:text-[var(--fg)]"
                                                                    aria-label={isFolderExpanded(
                                                                        child.id
                                                                    )
                                                                        ? '折叠文件夹'
                                                                        : '展开文件夹'}
                                                                    aria-expanded={isFolderExpanded(
                                                                        child.id
                                                                    )}
                                                                    onclick={(event) => {
                                                                        event.preventDefault();
                                                                        event.stopPropagation();
                                                                        toggleFolderExpand(child.id);
                                                                    }}
                                                                >
                                                                    <ha-icon
                                                                        name={isFolderExpanded(child.id)
                                                                            ? 'chevron-down'
                                                                            : 'chevron-right'}
                                                                        collection="lucide"
                                                                        size="16"
                                                                    ></ha-icon>
                                                                </button>
                                                            {:else}
                                                                <span
                                                                    class="h-6 w-6 shrink-0"
                                                                    aria-hidden="true"
                                                                ></span>
                                                            {/if}
                                                            <label
                                                                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                                                            >
                                                                {@render checkbox(
                                                                    childState === 'all',
                                                                    childState === 'partial',
                                                                    () => toggleFolderAll(child),
                                                                    child.name
                                                                )}
                                                                <ha-icon
                                                                    name="folder"
                                                                    collection="lucide"
                                                                    size="15"
                                                                ></ha-icon>
                                                                <span class="truncate">{child.name}</span>
                                                            </label>
                                                        </div>
                                                        {#if isFolderExpanded(child.id)}
                                                            <div class="flex flex-col gap-1.5 ps-9">
                                                                {#each notesByFolder[child.id] ?? [] as n (n.id)}
                                                                    {@render noteRow(n)}
                                                                {/each}
                                                            </div>
                                                        {/if}
                                                    </div>
                                                {/each}
                                            </div>
                                        {/if}
                                    </div>
                                {/each}
                            {:else}
                                <p class="text-sm text-[var(--fg-subtle)]">暂无笔记</p>
                            {/if}
                        </div>
                    {/if}
                </section>
            {/if}
        </div>

        <!-- 格式选择 -->
        <div class="flex items-center justify-between gap-3">
            <span class="text-[15px] text-[var(--fg)]">导出格式</span>
            <div class="relative">
                <button
                    type="button"
                    class="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-[var(--fg-muted)] transition-colors hover:bg-[var(--row-active)]"
                    aria-haspopup="listbox"
                    aria-expanded={formatMenuOpen}
                    onclick={() => (formatMenuOpen = !formatMenuOpen)}
                >
                    <span>{formatLabel}</span>
                    <ha-icon name="chevron-down" collection="lucide" size="14"></ha-icon>
                </button>
                {#if formatMenuOpen}
                    <button
                        type="button"
                        class="fixed inset-0 z-20 cursor-default"
                        aria-label="关闭导出格式菜单"
                        onclick={() => (formatMenuOpen = false)}
                    ></button>
                    <div
                        class="absolute end-0 bottom-full z-30 mb-1 w-44 rounded-lg border border-[var(--divider)] bg-[var(--card)] p-1 shadow-[var(--card-shadow)]"
                        role="listbox"
                        aria-label="导出格式"
                    >
                        {#each FORMAT_OPTIONS as opt (opt.value)}
                            <button
                                type="button"
                                role="option"
                                aria-selected={format === opt.value}
                                class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                                onclick={() => {
                                    format = opt.value;
                                    formatMenuOpen = false;
                                }}
                            >
                                <span>{opt.label}</span>
                                {#if format === opt.value}
                                    <ha-icon
                                        name="check"
                                        collection="lucide"
                                        size="14"
                                        class="text-primary-500"
                                    ></ha-icon>
                                {/if}
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>

        <P size="sm" class="text-[var(--fg-muted)]">
            Markdown/纯文本为有损导出；如需无损请使用『完整备份』。
        </P>

        {#if error}
            <P size="sm" class="text-red-500" role="alert">{error}</P>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full items-center justify-end gap-2">
            <Button color="light" onclick={() => (open = false)}>取消</Button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={handleExport}
                disabled={exporting || (noteIds.length === 0 && effectiveFolderIds.length === 0)}
            >
                {exporting ? '导出中…' : '导出'}
            </button>
        </div>
    {/snippet}
</Modal>
