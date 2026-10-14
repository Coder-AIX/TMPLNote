<script>
    import { Sidebar } from 'flowbite-svelte';
    import { push } from 'svelte-spa-router';
    import { sidebarOpen, closeSidebar } from '../stores/layout.js';
    import foldersRepository from '../db/folders.js';
    import { ROOT_ID } from '../db/schema.js';
    import {
        ALL_NOTES,
        TRASH_ID,
        selectedFolderId,
        selectedNoteId,
        foldersVersion,
        bumpFolders,
        bumpNotes
    } from '../stores/workspace.js';

    let folders = $state([]);
    let expanded = $state({});
    let containerOpen = $state(true);
    let creating = $state(null); // null | { parentId: string }
    let renamingId = $state(null);
    let nameDraft = $state('');

    async function load() {
        const tree = await foldersRepository.tree();
        folders = tree;
        for (const root of tree) {
            if (!(root.id in expanded)) expanded[root.id] = true;
        }
        expanded = { ...expanded };
    }

    $effect(() => {
        $foldersVersion;
        load();
    });

    function select(id) {
        selectedFolderId.set(id);
        selectedNoteId.set(null);
        closeSidebar();
        push('/'); // 从设置页返回笔记工作区
    }

    function toggleExpand(id) {
        expanded = { ...expanded, [id]: !expanded[id] };
    }

    function toggleContainer() {
        containerOpen = !containerOpen;
    }

    function startCreate(parentId = ROOT_ID) {
        renamingId = null;
        creating = { parentId };
        nameDraft = '';
        if (parentId !== ROOT_ID) expanded = { ...expanded, [parentId]: true };
    }

    function cancelEdit() {
        creating = null;
        renamingId = null;
        nameDraft = '';
    }

    async function confirmCreate() {
        const target = creating;
        const name = nameDraft.trim();
        cancelEdit();
        if (!target || !name) return;
        try {
            await foldersRepository.create({ name, parentId: target.parentId });
            bumpFolders();
        } catch (e) {
            window.alert(e?.message || String(e));
        }
    }

    function startRename(folder) {
        creating = null;
        renamingId = folder.id;
        nameDraft = folder.name;
    }

    async function confirmRename() {
        const id = renamingId;
        const name = nameDraft.trim();
        cancelEdit();
        if (!id || !name) return;
        await foldersRepository.rename(id, name);
        bumpFolders();
    }

    async function removeFolder(folder) {
        const affected = [folder.id, ...(folder.children ?? []).map((c) => c.id)];
        if (!window.confirm(`删除文件夹「${folder.name}」？其内的笔记将移动到「未分类」。`)) return;
        await foldersRepository.remove(folder.id);
        if (affected.includes($selectedFolderId)) selectedFolderId.set(ROOT_ID);
        bumpFolders();
        bumpNotes();
    }

    // ---- 视觉类名（Tailwind 工具类 + CSS 变量令牌，仅样式，不含逻辑） ----
    const BASE_ITEM = 'flex h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-[15px] transition-colors';
    const SELECTED = 'bg-[var(--nav-active-bg)] font-medium text-[var(--nav-active-fg)]';
    const MUTED = 'text-[var(--fg-muted)]';
    const HOVER = 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]';
    const ACTION_BTN = 'grid h-7 w-7 place-items-center rounded-md text-[var(--fg-subtle)] transition-colors';
    const INPUT = 'min-w-0 flex-1 rounded-md border border-[var(--divider)] bg-[var(--field)] px-2 py-1 text-[15px] text-[var(--fg)] outline-none focus:border-primary-500';

    /** 导航项（全部笔记/未分类/我的文件夹）整体类名 */
    function navItemClass(active) {
        return `${BASE_ITEM} ${active ? SELECTED : `${MUTED} ${HOVER}`}`;
    }

    /** 根文件夹行容器类名（缩进一级） */
    function folderRowClass(active) {
        return `group ms-5 flex h-10 items-center rounded-[10px] pe-1 ${active ? SELECTED : HOVER}`;
    }

    /** 子文件夹行容器类名（缩进两级；额外 20px 缩进由行内占位提供） */
    function childRowClass(active) {
        return `group ms-5 flex h-10 items-center rounded-[10px] pe-1 ${active ? SELECTED : HOVER}`;
    }

    /** 文件夹名称按钮（根 / 子同款；folder 图标横向位置由行内占位控制） */
    function folderNameClass(active) {
        return `flex h-full min-w-0 flex-1 items-center gap-2.5 ps-1 pe-1 text-[15px] ${
            active ? 'font-medium text-[var(--nav-active-fg)]' : MUTED
        }`;
    }
</script>

<Sidebar
    isOpen={$sidebarOpen}
    {closeSidebar}
    breakpoint="lg"
    position="fixed"
    ariaLabel="笔记文件夹"
    class="h-dvh w-[230px] bg-[var(--canvas)] dark:bg-[var(--canvas)]"
    classes={{ div: 'flex h-full w-full flex-col overflow-y-auto bg-[var(--canvas)] px-3 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]' }}
>
    <h1 class="px-3 pb-4">
        <a href="#/" onclick={closeSidebar} class="text-[22px] font-bold leading-none text-[var(--fg)]">
            TMPLNote
        </a>
    </h1>

    <nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <!-- 全部笔记 -->
        <button
            type="button"
            class={navItemClass($selectedFolderId === ALL_NOTES)}
            onclick={() => select(ALL_NOTES)}
        >
            <ha-icon name="notebook-text" collection="lucide" size="18"></ha-icon>
            <span class="truncate">全部笔记</span>
        </button>

        <!-- 未分类 -->
        <button
            type="button"
            class={navItemClass($selectedFolderId === ROOT_ID)}
            onclick={() => select(ROOT_ID)}
        >
            <ha-icon name="copy" collection="lucide" size="18"></ha-icon>
            <span class="truncate">未分类</span>
        </button>

        <!-- 最近删除 -->
        <button
            type="button"
            class={navItemClass($selectedFolderId === TRASH_ID)}
            onclick={() => select(TRASH_ID)}
        >
            <ha-icon name="trash-2" collection="lucide" size="18"></ha-icon>
            <span class="truncate">最近删除</span>
        </button>

        <!-- 我的文件夹：容器行 + 右侧新建按钮 -->
        <div class="flex items-center gap-1">
            <button
                type="button"
                class="{navItemClass(false)} min-w-0 flex-1"
                onclick={toggleContainer}
            >
                <ha-icon
                    name={containerOpen ? 'chevron-down' : 'chevron-right'}
                    collection="lucide"
                    size="16"
                ></ha-icon>
                <ha-icon name="folder" collection="lucide" size="17"></ha-icon>
                <span class="truncate">我的文件夹</span>
            </button>
            <button
                type="button"
                class="{ACTION_BTN} shrink-0 hover:text-primary-600"
                aria-label="新建文件夹"
                onclick={() => startCreate(ROOT_ID)}
            >
                <ha-icon name="plus" collection="lucide" size="18"></ha-icon>
            </button>
        </div>

        <!-- 根级新建输入 -->
        {#if creating && creating.parentId === ROOT_ID}
            <div class="ms-5 flex h-10 items-center gap-2 rounded-[10px] px-3">
                <ha-icon
                    name="folder"
                    collection="lucide"
                    size="17"
                    class="shrink-0 text-[var(--fg-subtle)]"
                ></ha-icon>
                <input
                    class={INPUT}
                    placeholder="文件夹名称"
                    bind:value={nameDraft}
                    onkeydown={(e) => {
                        if (e.key === 'Enter') confirmCreate();
                        if (e.key === 'Escape') cancelEdit();
                    }}
                    onblur={confirmCreate}
                />
            </div>
        {/if}

        {#if containerOpen}
            {#each folders as folder (folder.id)}
                <div class="flex flex-col gap-1">
                    <div class={folderRowClass($selectedFolderId === folder.id)}>
                        {#if folder.children.length > 0}
                            <button
                                type="button"
                                class="{ACTION_BTN} shrink-0 hover:text-[var(--fg-muted)]"
                                aria-label="展开/收起"
                                onclick={() => toggleExpand(folder.id)}
                            >
                                <ha-icon
                                    name={expanded[folder.id] ? 'chevron-down' : 'chevron-right'}
                                    collection="lucide"
                                    size="16"
                                ></ha-icon>
                            </button>
                        {:else}
                            <span class="h-7 w-7 shrink-0" aria-hidden="true"></span>
                        {/if}

                        {#if renamingId === folder.id}
                            <input
                                class="{INPUT} mx-1 h-7 py-0"
                                bind:value={nameDraft}
                                onkeydown={(e) => {
                                    if (e.key === 'Enter') confirmRename();
                                    if (e.key === 'Escape') cancelEdit();
                                }}
                                onblur={confirmRename}
                            />
                        {:else}
                            <button
                                type="button"
                                class={folderNameClass($selectedFolderId === folder.id)}
                                onclick={() => select(folder.id)}
                            >
                                <ha-icon name="folder" collection="lucide" size="17"></ha-icon>
                                <span class="truncate">{folder.name}</span>
                            </button>
                            <span
                                class="flex shrink-0 items-center opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                            >
                                <button
                                    type="button"
                                    class="{ACTION_BTN} hover:text-primary-600"
                                    aria-label="新建子文件夹"
                                    onclick={() => startCreate(folder.id)}
                                >
                                    <ha-icon name="folder-plus" collection="lucide" size="18"></ha-icon>
                                </button>
                                <button
                                    type="button"
                                    class="{ACTION_BTN} hover:text-primary-600"
                                    aria-label="重命名"
                                    onclick={() => startRename(folder)}
                                >
                                    <ha-icon name="pencil" collection="lucide" size="18"></ha-icon>
                                </button>
                                <button
                                    type="button"
                                    class="{ACTION_BTN} hover:text-primary-700"
                                    aria-label="删除"
                                    onclick={() => removeFolder(folder)}
                                >
                                    <ha-icon name="trash-2" collection="lucide" size="18"></ha-icon>
                                </button>
                            </span>
                        {/if}
                    </div>

                    {#if expanded[folder.id]}
                        {#each folder.children as child (child.id)}
                            <div class={childRowClass($selectedFolderId === child.id)}>
                                <span class="h-7 w-7 shrink-0" aria-hidden="true"></span>
                                <span class="h-7 w-5 shrink-0" aria-hidden="true"></span>
                                {#if renamingId === child.id}
                                    <input
                                        class="{INPUT} mx-1 h-7 py-0"
                                        bind:value={nameDraft}
                                        onkeydown={(e) => {
                                            if (e.key === 'Enter') confirmRename();
                                            if (e.key === 'Escape') cancelEdit();
                                        }}
                                        onblur={confirmRename}
                                    />
                                {:else}
                                    <button
                                        type="button"
                                        class={folderNameClass($selectedFolderId === child.id)}
                                        onclick={() => select(child.id)}
                                    >
                                        <ha-icon name="folder" collection="lucide" size="17"></ha-icon>
                                        <span class="truncate">{child.name}</span>
                                    </button>
                                    <span
                                        class="flex shrink-0 items-center opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                                    >
                                        <button
                                            type="button"
                                            class="{ACTION_BTN} hover:text-primary-600"
                                            aria-label="重命名"
                                            onclick={() => startRename(child)}
                                        >
                                            <ha-icon name="pencil" collection="lucide" size="18"></ha-icon>
                                        </button>
                                        <button
                                            type="button"
                                            class="{ACTION_BTN} hover:text-primary-700"
                                            aria-label="删除"
                                            onclick={() => removeFolder(child)}
                                        >
                                            <ha-icon name="trash-2" collection="lucide" size="18"></ha-icon>
                                        </button>
                                    </span>
                                {/if}
                            </div>
                        {/each}

                        {#if creating && creating.parentId === folder.id}
                            <div class="ms-10 flex h-10 items-center gap-2 rounded-[10px] px-3">
                                <ha-icon
                                    name="folder"
                                    collection="lucide"
                                    size="17"
                                    class="shrink-0 text-[var(--fg-subtle)]"
                                ></ha-icon>
                                <input
                                    class={INPUT}
                                    placeholder="子文件夹名称"
                                    bind:value={nameDraft}
                                    onkeydown={(e) => {
                                        if (e.key === 'Enter') confirmCreate();
                                        if (e.key === 'Escape') cancelEdit();
                                    }}
                                    onblur={confirmCreate}
                                />
                            </div>
                        {/if}
                    {/if}
                </div>
            {/each}
        {/if}
    </nav>

    <div class="mt-2 flex flex-col gap-1 border-t border-[var(--divider)] pt-2">
        <a href="#/chat" class={navItemClass(false)} onclick={closeSidebar}>
            <ha-icon name="message-circle" collection="lucide" size="18"></ha-icon>
            <span>对话</span>
        </a>
        <a href="#/settings" class={navItemClass(false)} onclick={closeSidebar}>
            <ha-icon name="settings" collection="lucide" size="18"></ha-icon>
            <span>设置</span>
        </a>
    </div>
</Sidebar>
