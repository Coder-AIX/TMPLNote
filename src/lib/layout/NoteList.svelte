<script>
    import notesRepository from '../db/notes.js';
    import foldersRepository from '../db/folders.js';
    import { ROOT_ID } from '../db/schema.js';
    import { toggleSidebar } from '../stores/layout.js';
    import { formatRelativeTime, htmlToText } from '../utils/format.js';
    import {
        ALL_NOTES,
        TRASH_ID,
        selectedFolderId,
        selectedNoteId,
        notesVersion,
        foldersVersion,
        bumpNotes
    } from '../stores/workspace.js';

    /** 笔记列表摘要：只取正文第一行（<br> 或块级标签结束处截断）。 */
    function firstLineSummary(html) {
        if (typeof html !== 'string') return '';
        const firstLine = html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(?:p|div|h[1-6]|li|blockquote|pre|section)\s*>/gi, '\n')
            .split('\n')[0];
        return htmlToText(firstLine);
    }

    let search = $state('');
    let debouncedSearch = $state('');
    let sortBy = $state('createdAt');
    let ascending = $state(false);
    let notes = $state([]);
    let loading = $state(true);
    let error = $state('');
    let searchTimer;
    let folders = $state([]);

    let templatePickerOpen = $state(false);
    let templates = $state([]);
    let createBtnEl = $state();
    let pickerPos = $state({ x: 0, y: 0 });

    const isTrash = $derived($selectedFolderId === TRASH_ID);

    const scopeTitle = $derived.by(() => {
        const id = $selectedFolderId;
        if (id === TRASH_ID) return '最近删除';
        if (id === ALL_NOTES) return '全部笔记';
        if (id === ROOT_ID) return '未分类';
        for (const f of folders) {
            if (f.id === id) return f.name;
            for (const c of f.children) {
                if (c.id === id) return `${f.name} / ${c.name}`;
            }
        }
        return '';
    });

    let menu = $state({ open: false, x: 0, y: 0, note: null, view: 'root' }); // view: 'root' | 'move'

    let sortMenuOpen = $state(false);
    const SORT_OPTIONS = [
        { value: 'createdAt', label: '创建时间' },
        { value: 'updatedAt', label: '更新时间' },
        { value: 'title', label: '标题' }
    ];
    const sortLabel = $derived(
        SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? '创建时间'
    );

    // 搜索防抖
    $effect(() => {
        const q = search;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            debouncedSearch = q;
        }, 250);
        return () => clearTimeout(searchTimer);
    });

    // 数据加载（文件夹 / 版本 / 搜索 / 排序变化时）
    $effect(() => {
        $selectedFolderId;
        $notesVersion;
        debouncedSearch;
        sortBy;
        ascending;
        load();
    });

    // 文件夹列表加载（供「移动到」使用）
    $effect(() => {
        $foldersVersion;
        foldersRepository.tree().then((tree) => (folders = tree));
    });

    async function load() {
        loading = true;
        try {
            if ($selectedFolderId === TRASH_ID) {
                const all = await notesRepository.listTrash();
                const kw = String(debouncedSearch).trim().toLowerCase();
                notes = kw
                    ? all.filter((n) => {
                          const title = String(n.title ?? '').toLowerCase();
                          const content = String(n.content ?? '').toLowerCase();
                          return title.includes(kw) || content.includes(kw);
                      })
                    : all;
                error = '';
                return;
            }
            const folderId = $selectedFolderId === ALL_NOTES ? undefined : $selectedFolderId;
            notes = await notesRepository.list({
                folderId,
                search: debouncedSearch,
                sortBy,
                ascending
            });
            error = '';
        } catch (e) {
            error = e?.message || String(e);
        } finally {
            loading = false;
        }
    }

    async function openCreatePicker() {
        templates = await notesRepository.listTemplates();
        if (createBtnEl) {
            const r = createBtnEl.getBoundingClientRect();
            const w = 220;
            const h = 320;
            const x = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
            const y = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - h - 8));
            pickerPos = { x, y };
        }
        templatePickerOpen = true;
    }

    async function createBlank() {
        await createFrom(null);
    }

    async function createFromTemplate(t) {
        await createFrom(t);
    }

    async function createFrom(template) {
        const folderId = $selectedFolderId === ALL_NOTES ? ROOT_ID : $selectedFolderId;
        const note = template
            ? await notesRepository.create({
                  title: template.title,
                  content: template.content,
                  folderId
              })
            : await notesRepository.create({ title: '未命名笔记', folderId });
        templatePickerOpen = false;
        selectedNoteId.set(note.id);
        bumpNotes();
    }

    function openMenu(e, note) {
        e.preventDefault?.();
        e.stopPropagation?.();
        const w = 180,
            h = 220;
        const x = Math.min(e.clientX, window.innerWidth - w - 8);
        const y = Math.min(e.clientY, window.innerHeight - h - 8);
        menu = { open: true, x: Math.max(8, x), y: Math.max(8, y), note, view: 'root' };
    }

    function closeMenu() {
        menu = { ...menu, open: false, note: null, view: 'root' };
    }

    async function toggleMenuPinned() {
        const n = menu.note;
        if (!n) return;
        await notesRepository.update(n.id, { pinned: !n.pinned });
        closeMenu();
        bumpNotes();
    }

    async function moveTo(folderId) {
        const n = menu.note;
        if (!n) return;
        await notesRepository.move(n.id, folderId);
        closeMenu();
        bumpNotes();
    }

    async function removeFromMenu() {
        const n = menu.note;
        if (!n) return;
        closeMenu();
        await notesRepository.softDelete(n.id);
        if ($selectedNoteId === n.id) selectedNoteId.set(null);
        bumpNotes();
    }

    async function restoreFromMenu() {
        const n = menu.note;
        if (!n) return;
        closeMenu();
        await notesRepository.restore(n.id);
        bumpNotes();
    }

    async function removePermanentFromMenu() {
        const n = menu.note;
        if (!n) return;
        closeMenu();
        if (!window.confirm('彻底删除该笔记？此操作不可撤销。')) return;
        await notesRepository.removePermanent(n.id);
        bumpNotes();
    }

    async function emptyTrash() {
        if (!window.confirm('清空最近删除？此操作不可撤销。')) return;
        await notesRepository.emptyTrash();
        bumpNotes();
    }
</script>

<div class="flex h-full min-h-0 flex-col">
    <!-- 头部：汉堡（仅移动端）+ 标题 -->
    <div class="flex flex-none items-center gap-2 px-4 pt-5 pb-4">
        <button
            type="button"
            class="-ms-1 flex h-8 w-8 items-center justify-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--row-active)] lg:hidden"
            aria-label="打开文件夹"
            onclick={toggleSidebar}
        >
            <ha-icon name="menu" collection="lucide" size="20"></ha-icon>
        </button>
        <h2 class="truncate text-xl font-bold text-[var(--fg)]">{scopeTitle}</h2>
        {#if isTrash}
            <button
                type="button"
                class="ms-auto shrink-0 rounded-md px-2 py-1 text-sm text-[#ef4444] transition-colors hover:bg-[var(--row-active)]"
                onclick={emptyTrash}
            >
                清空
            </button>
        {/if}
    </div>

    <!-- 头部下方分隔线 -->
    <div class="h-px w-full flex-none bg-[var(--divider)]"></div>

    <!-- 搜索 + 新建 -->
    <div class="flex flex-none items-center gap-2 px-4 py-3.5">
        <div class="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-[var(--field)] px-3">
            <ha-icon
                name="search"
                collection="lucide"
                size="15"
                class="shrink-0 text-[var(--fg-subtle)]"
            ></ha-icon>
            <input
                class="min-w-0 flex-1 border-0 bg-transparent text-sm text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)]"
                placeholder={isTrash
                    ? '搜索最近删除'
                    : $selectedFolderId === ALL_NOTES
                      ? '搜索全部笔记'
                      : `搜索「${scopeTitle}」`}
                bind:value={search}
            />
        </div>
        {#if !isTrash}
            <button
                type="button"
                class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-500 text-white hover:bg-primary-600"
                aria-label="新建笔记"
                bind:this={createBtnEl}
                onclick={openCreatePicker}
            >
                <ha-icon name="plus" collection="lucide" size="18"></ha-icon>
            </button>
        {/if}
    </div>

    <!-- 统计 + 排序 -->
    <div
        class="flex flex-none items-center justify-between border-b border-[var(--divider)] px-4 pb-3 text-xs text-[var(--fg-muted)]"
    >
        <span>共 {notes.length} 条</span>
        {#if !isTrash}
            <div class="relative">
            <button
                type="button"
                class="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--row-active)]"
                aria-label="排序方式"
                aria-expanded={sortMenuOpen}
                onclick={() => (sortMenuOpen = !sortMenuOpen)}
            >
                <span>按{sortLabel}</span>
                <ha-icon name="chevron-down" collection="lucide" size="14"></ha-icon>
            </button>

            {#if sortMenuOpen}
                <!-- 全屏遮罩：点击外部关闭 -->
                <button
                    type="button"
                    class="fixed inset-0 z-20 cursor-default"
                    aria-label="关闭排序菜单"
                    onclick={() => (sortMenuOpen = false)}
                ></button>
                <div
                    class="absolute end-0 top-full z-30 mt-1 w-32 rounded-lg border border-[var(--divider)] bg-[var(--card)] p-1 shadow-[var(--card-shadow)]"
                >
                    {#each SORT_OPTIONS as opt (opt.value)}
                        <button
                            type="button"
                            class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--row-active)]"
                            onclick={() => {
                                sortBy = opt.value;
                                sortMenuOpen = false;
                            }}
                        >
                            <span>{opt.label}</span>
                            {#if sortBy === opt.value}
                                <ha-icon
                                    name="check"
                                    collection="lucide"
                                    size="14"
                                    class="text-primary-500"
                                ></ha-icon>
                            {/if}
                        </button>
                    {/each}
                    <div class="my-1 h-px bg-[var(--divider)]"></div>
                    <button
                        type="button"
                        class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--row-active)]"
                        onclick={() => {
                            ascending = !ascending;
                            sortMenuOpen = false;
                        }}
                    >
                        <span>{ascending ? '升序' : '降序'}</span>
                        <ha-icon
                            name={ascending ? 'arrow-up' : 'arrow-down'}
                            collection="lucide"
                            size="14"
                        ></ha-icon>
                    </button>
                </div>
            {/if}
            </div>
        {/if}
    </div>

    <!-- 列表 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
        {#if error}
            <p class="px-4 py-6 text-sm text-[var(--fg-subtle)]">加载失败：{error}</p>
        {:else if loading}
            <p class="px-4 py-6 text-sm text-[var(--fg-subtle)]">加载中…</p>
        {:else if notes.length === 0}
            <p class="px-4 py-6 text-center text-sm text-[var(--fg-subtle)]">
                {isTrash ? '最近删除为空' : '暂无笔记'}
            </p>
        {:else}
            <ul>
                {#each notes as n (n.id)}
                    {@const summary = firstLineSummary(n.content)}
                    <li
                        class="group relative border-b border-[var(--divider)]"
                        oncontextmenu={(e) => openMenu(e, n)}
                    >
                        <button
                            type="button"
                            class="flex w-full flex-col gap-1 py-3.5 ps-4 pe-10 text-left {!isTrash &&
                            $selectedNoteId === n.id
                                ? 'bg-[var(--row-active)]'
                                : 'hover:bg-[var(--row-active)]'}"
                            onclick={() => {
                                if (!isTrash) selectedNoteId.set(n.id);
                            }}
                        >
                            <span class="w-full truncate text-[15px] font-semibold text-[var(--fg)]"
                                >{n.title}</span
                            >
                            {#if summary}
                                <span class="w-full truncate text-sm text-[var(--fg-muted)]"
                                    >{summary}</span
                                >
                            {/if}
                            <span class="flex w-full items-center gap-1.5">
                                <span class="text-xs text-[var(--fg-subtle)]"
                                    >{formatRelativeTime(isTrash ? n.deletedAt : n.createdAt)}</span
                                >
                                {#if !isTrash && n.pinned}
                                    <ha-icon
                                        name="star"
                                        collection="lucide"
                                        size="14"
                                        class="shrink-0 text-primary-500"
                                    ></ha-icon>
                                {/if}
                            </span>
                        </button>

                        <!-- hover 操作（移动端常显）：行右侧垂直居中 -->
                        <span
                            class="absolute end-2 top-1/2 z-10 flex -translate-y-1/2 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100"
                        >
                            <button
                                type="button"
                                class="grid h-7 w-7 place-items-center rounded-md text-[var(--fg-subtle)] hover:bg-black/[0.06] hover:text-[var(--fg)] dark:hover:bg-white/[0.1]"
                                aria-label="更多操作"
                                onclick={(e) => openMenu(e, n)}
                            >
                                <ha-icon name="ellipsis" collection="lucide" size="16"></ha-icon>
                            </button>
                        </span>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>

    <!-- 笔记操作菜单（自绘，两层：主菜单 / 移动列表） -->
    {#if menu.open && menu.note}
        <button
            type="button"
            class="fixed inset-0 z-40 cursor-default"
            aria-label="关闭菜单"
            onclick={closeMenu}
        ></button>
        <div
            class="fixed z-50 min-w-[180px] rounded-lg border border-[var(--divider)] bg-[var(--card)] p-1 shadow-[var(--card-shadow)]"
            style="left:{menu.x}px; top:{menu.y}px;"
        >
            {#if isTrash}
                <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                    onclick={restoreFromMenu}
                >
                    <ha-icon name="rotate-ccw" collection="lucide" size="15"></ha-icon>
                    <span>恢复</span>
                </button>
                <div class="my-1 h-px bg-[var(--divider)]"></div>
                <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[#ef4444] hover:bg-[var(--row-active)]"
                    onclick={removePermanentFromMenu}
                >
                    <ha-icon name="trash-2" collection="lucide" size="15"></ha-icon>
                    <span>彻底删除</span>
                </button>
            {:else if menu.view === 'root'}
                <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                    onclick={toggleMenuPinned}
                >
                    <ha-icon name="pin" collection="lucide" size="15"></ha-icon>
                    <span>{menu.note.pinned ? '取消置顶' : '置顶'}</span>
                </button>
                <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                    onclick={() => (menu = { ...menu, view: 'move' })}
                >
                    <ha-icon name="folder" collection="lucide" size="15"></ha-icon>
                    <span class="flex-1 text-left">移动到</span>
                    <ha-icon name="chevron-right" collection="lucide" size="14"></ha-icon>
                </button>
                <div class="my-1 h-px bg-[var(--divider)]"></div>
                <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[#ef4444] hover:bg-[var(--row-active)]"
                    onclick={removeFromMenu}
                >
                    <ha-icon name="trash-2" collection="lucide" size="15"></ha-icon>
                    <span>删除</span>
                </button>
            {:else}
                <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--fg-muted)] hover:bg-[var(--row-active)]"
                    onclick={() => (menu = { ...menu, view: 'root' })}
                >
                    <ha-icon name="arrow-left" collection="lucide" size="15"></ha-icon>
                    <span>返回</span>
                </button>
                <div class="my-1 h-px bg-[var(--divider)]"></div>
                <div class="max-h-64 overflow-y-auto">
                    <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                        onclick={() => moveTo(ROOT_ID)}
                    >
                        <ha-icon name="inbox" collection="lucide" size="15"></ha-icon><span>未分类</span>
                        {#if (menu.note.folderId ?? ROOT_ID) === ROOT_ID}
                            <ha-icon
                                name="check"
                                collection="lucide"
                                size="14"
                                class="ms-auto text-primary-500"
                            ></ha-icon>
                        {/if}
                    </button>
                    {#each folders as f (f.id)}
                        <button
                            type="button"
                            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                            onclick={() => moveTo(f.id)}
                        >
                            <ha-icon name="folder" collection="lucide" size="15"></ha-icon
                            ><span class="truncate">{f.name}</span>
                            {#if menu.note.folderId === f.id}
                                <ha-icon
                                    name="check"
                                    collection="lucide"
                                    size="14"
                                    class="ms-auto text-primary-500"
                                ></ha-icon>
                            {/if}
                        </button>
                        {#each f.children as c (c.id)}
                            <button
                                type="button"
                                class="flex w-full items-center gap-2 rounded-md ps-7 pe-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                                onclick={() => moveTo(c.id)}
                            >
                                <ha-icon name="folder" collection="lucide" size="15"></ha-icon
                                ><span class="truncate">{c.name}</span>
                                {#if menu.note.folderId === c.id}
                                    <ha-icon
                                        name="check"
                                        collection="lucide"
                                        size="14"
                                        class="ms-auto text-primary-500"
                                    ></ha-icon>
                                {/if}
                            </button>
                        {/each}
                    {/each}
                    {#if folders.length === 0}
                        <p class="px-2 py-2 text-xs text-[var(--fg-subtle)]">暂无文件夹</p>
                    {/if}
                </div>
            {/if}
        </div>
    {/if}

    <!-- 新建选择器（自绘：空白笔记 / 从模板新建） -->
    {#if templatePickerOpen}
        <button
            type="button"
            class="fixed inset-0 z-40 cursor-default"
            aria-label="关闭新建选择"
            onclick={() => (templatePickerOpen = false)}
        ></button>
        <div
            class="fixed z-50 w-[220px] rounded-lg border border-[var(--divider)] bg-[var(--card)] p-1 shadow-[var(--card-shadow)]"
            style="left:{pickerPos.x}px; top:{pickerPos.y}px;"
        >
            <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                onclick={createBlank}
            >
                <ha-icon name="file-plus" collection="lucide" size="15"></ha-icon>
                <span>空白笔记</span>
            </button>
            {#if templates.length > 0}
                <div class="my-1 h-px bg-[var(--divider)]"></div>
                <div class="max-h-64 overflow-y-auto">
                    {#each templates as t (t.id)}
                        <button
                            type="button"
                            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                            onclick={() => createFromTemplate(t)}
                        >
                            <ha-icon name="layout-template" collection="lucide" size="15"></ha-icon>
                            <span class="truncate">{t.title}</span>
                        </button>
                    {/each}
                </div>
            {:else}
                <p class="px-2 py-2 text-xs text-[var(--fg-subtle)]">暂无模板</p>
            {/if}
        </div>
    {/if}
</div>
