<script>
    import { Button, P, Label, Select, Modal } from 'flowbite-svelte';
    import { loadSettings } from '../stores/settings.js';
    import { bumpNotes, bumpFolders } from '../stores/workspace.js';

    // 父级以 <ImportDialog bind:open={...} /> 使用
    let { open = $bindable(false) } = $props();

    let file = $state(null); // 选中且预览成功的文件
    let inspection = $state(null); // { kind, format?, folders, entries }
    let selected = $state([]); // 选中的 entry.path 数组
    let mode = $state('merge'); // 'merge' | 'replace'（仅 ZIP）
    let importing = $state(false);
    let error = $state('');
    let message = $state('');
    let fileInput = $state();

    /** 打开时重置所有状态 */
    $effect(() => {
        if (open) {
            file = null;
            inspection = null;
            selected = [];
            mode = 'merge';
            importing = false;
            error = '';
            message = '';
        }
    });

    /** 关闭（取消 / ESC / 点击遮罩）时清理未提交的内容，不写库 */
    $effect(() => {
        if (!open) {
            file = null;
            inspection = null;
            selected = [];
            mode = 'merge';
            importing = false;
        }
    });

    /** 复选框通用类名 */
    const CHECKBOX = 'h-4 w-4 shrink-0 cursor-pointer accent-primary-600';

    /** ZIP 数据格式 → 可读标签 */
    function formatLabel(format) {
        if (format === 'text') return '纯文本';
        if (format === 'docx') return 'Word';
        return 'Markdown';
    }

    /** 单条条目：勾选/取消（重新赋值数组保证响应式） */
    function togglePath(path, checked) {
        if (checked) {
            if (!selected.includes(path)) selected = [...selected, path];
        } else {
            selected = selected.filter((item) => item !== path);
        }
    }

    /** 全选全部条目 */
    function selectAllEntries() {
        if (!inspection) return;
        selected = inspection.entries.map((entry) => entry.path);
    }

    /** 清空选择 */
    function clearEntries() {
        selected = [];
    }

    /** 选择文件：解析并预览（不写库） */
    async function onFileChange(event) {
        const f = event?.currentTarget?.files?.[0];
        if (!f) return;

        error = '';
        message = '';
        inspection = null;
        selected = [];

        try {
            const { fileKind, inspectImport, importBundle } = await import(
                '../db/importBundle.js'
            );
            const kind = fileKind(f);
            if (kind === 'unknown') {
                error = '不支持的文件类型。';
                return;
            }
            inspection = await inspectImport(f);
            file = f;
            selected =
                inspection.kind === 'zip' ? inspection.entries.map((entry) => entry.path) : [];
        } catch (e) {
            error = e?.message || '无法读取文件。';
        } finally {
            if (fileInput) fileInput.value = '';
        }
    }

    /** 确认导入：写库并刷新相关状态 */
    async function confirmImport() {
        if (!file || !inspection) return;

        importing = true;
        error = '';
        try {
            const { importBundle } = await import('../db/importBundle.js');
            const res = await importBundle(file, {
                mode,
                selectedPaths: inspection.kind === 'zip' ? selected : undefined
            });
            await loadSettings();
            bumpNotes();
            bumpFolders();
            message =
                `已导入 ${res.notes} 条笔记、${res.folders} 个文件夹` +
                (res.skipped ? `，跳过 ${res.skipped} 项` : '') +
                (res.errors?.length ? `，${res.errors.length} 条失败` : '') +
                '。';
            open = false;
        } catch (e) {
            error = e?.message || '导入失败。';
        } finally {
            importing = false;
        }
    }
</script>

<Modal
    bind:open
    title="导入数据"
    size="none"
    class="max-w-[calc(100vw-2rem)] sm:max-w-lg max-md:mt-4 max-md:mb-auto"
>
    <div class="flex flex-col gap-4">
        <P size="sm" class="text-[var(--fg-muted)]">
            导入本应用导出的 ZIP，或 Markdown / 纯文本 / Word 文件。
        </P>

        <input
            type="file"
            bind:this={fileInput}
            accept=".zip,.md,.markdown,.txt,.docx,application/zip,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onchange={onFileChange}
            class="hidden"
        />

        <!-- 文件选择行 -->
        <div class="flex items-center gap-2">
            <Button color="light" onclick={() => fileInput?.click()}>
                <ha-icon name="upload" collection="lucide" size="18"></ha-icon>
                <span>选择文件</span>
            </Button>
            {#if file}
                <span class="min-w-0 flex-1 truncate text-sm text-[var(--fg-muted)]">
                    {file.name}
                </span>
            {/if}
        </div>

        <!-- 预览 -->
        {#if inspection?.kind === 'zip'}
            <div class="flex flex-wrap items-center gap-2 text-sm text-[var(--fg-muted)]">
                <span>格式</span>
                <span
                    class="rounded-full bg-[var(--row-active)] px-2 py-0.5 text-xs text-[var(--fg)]"
                >
                    {formatLabel(inspection.format)}
                </span>
            </div>

            <div class="flex items-center gap-2">
                <Button size="xs" color="light" onclick={selectAllEntries}>全选</Button>
                <Button size="xs" color="light" onclick={clearEntries}>清空</Button>
                <span class="ms-auto text-xs text-[var(--fg-subtle)]">已选 {selected.length} 项</span>
            </div>

            <div
                class="max-h-[40vh] overflow-y-auto rounded-lg border border-[var(--divider)]"
            >
                {#if inspection.entries.length === 0}
                    <p class="py-6 text-center text-sm text-[var(--fg-subtle)]">暂无可导入的条目</p>
                {:else}
                    <ul class="flex flex-col divide-y divide-[var(--divider)]">
                        {#each inspection.entries as entry (entry.path)}
                            <li>
                                <label
                                    class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
                                >
                                    <input
                                        type="checkbox"
                                        class={CHECKBOX}
                                        checked={selected.includes(entry.path)}
                                        onchange={(e) =>
                                            togglePath(entry.path, e.currentTarget.checked)}
                                    />
                                    <ha-icon
                                        name={entry.isTemplate ? 'layout-template' : 'file-text'}
                                        collection="lucide"
                                        size="15"
                                    ></ha-icon>
                                    <span class="min-w-0 flex-1 truncate">{entry.title}</span>
                                    <span
                                        class="shrink-0 rounded-full bg-[var(--row-active)] px-2 py-0.5 text-xs text-[var(--fg-subtle)]"
                                    >
                                        {entry.isTemplate ? '模板' : '笔记'}
                                    </span>
                                </label>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </div>
        {:else if inspection}
            <P size="sm" class="text-[var(--fg-muted)]">
                将新建 1 条笔记（归入『未分类』）。
            </P>
        {/if}

        <!-- 导入模式（仅 ZIP） -->
        {#if inspection?.kind === 'zip'}
            <div class="flex flex-col gap-1.5">
                <Label for="import-mode" class="text-[15px] text-[var(--fg)]">导入模式</Label>
                <Select id="import-mode" bind:value={mode} size="sm" aria-label="导入模式">
                    <option value="merge">合并（按 id 去重）</option>
                    <option value="replace">覆盖（清空现有笔记与文件夹）</option>
                </Select>
            </div>
            {#if mode === 'replace'}
                <P size="sm" class="text-red-500">将清空现有笔记与文件夹，且不可撤销。</P>
            {/if}
        {/if}

        <!-- 结果反馈 -->
        {#if error}
            <P size="sm" class="text-red-500" role="alert">{error}</P>
        {/if}
        {#if message}
            <P size="sm" class="text-[var(--fg-muted)]">{message}</P>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full items-center justify-end gap-2">
            <Button color="light" onclick={() => (open = false)}>取消</Button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={confirmImport}
                disabled={importing ||
                    !file ||
                    (inspection?.kind === 'zip' && selected.length === 0)}
            >
                {importing ? '导入中…' : '导入'}
            </button>
        </div>
    {/snippet}
</Modal>
