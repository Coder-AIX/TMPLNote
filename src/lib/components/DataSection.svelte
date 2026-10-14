<script>
    import { Button, Heading, P, Label, Select, Modal } from 'flowbite-svelte';
    import ExportDialog from './ExportDialog.svelte';
    import ImportDialog from './ImportDialog.svelte';
    import backupRepository from '../db/backup.js';
    import {
        stringifyBackup,
        parseBackup,
        backupFilename,
        BACKUP_MIME
    } from '../utils/backup.js';
    import { bumpNotes, bumpFolders } from '../stores/workspace.js';
    import { loadSettings } from '../stores/settings.js';

    /** 选择性导出（ZIP）弹窗开关 */
    let exportOpen = $state(false);
    /** 导入弹窗开关 */
    let importOpen = $state(false);
    /** 完整备份（JSON）导出中 */
    let exporting = $state(false);
    /** 恢复中 */
    let restoring = $state(false);
    /** 恢复弹窗开关 */
    let restoreOpen = $state(false);
    /** 恢复方式：merge（合并去重）/ replace（覆盖清空） */
    let restoreMode = $state('merge');
    /** 已解析、待恢复的备份对象（解析失败时为 null，不写库） */
    let pending = $state(null);
    /** 错误提示 */
    let error = $state('');
    /** 成功提示 */
    let message = $state('');

    /** 隐藏的文件选择框 */
    let jsonInput = $state();

    /** 待恢复备份的统计（无待恢复项时为 0） */
    let pendingCounts = $derived(
        pending
            ? {
                  notes: pending.data?.notes?.length ?? 0,
                  folders: pending.data?.folders?.length ?? 0
              }
            : { notes: 0, folders: 0 }
    );

    /** 弹窗关闭（取消 / ESC / 点击遮罩）时丢弃待恢复数据，不写库 */
    $effect(() => {
        if (!restoreOpen) pending = null;
    });

    /** 导出完整 JSON 备份并触发下载 */
    async function handleExportBackup() {
        error = '';
        message = '';
        exporting = true;
        try {
            const b = await backupRepository.exportAll();
            const text = stringifyBackup(b);

            const blob = new Blob([text], { type: BACKUP_MIME });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = backupFilename();
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);

            message = '备份已导出。';
        } catch (e) {
            error = e?.message || '导出备份失败。';
        } finally {
            exporting = false;
        }
    }

    /** 触发隐藏的文件选择框 */
    function openRestorePicker() {
        error = '';
        message = '';
        jsonInput?.click();
    }

    /** 选取备份文件后解析；解析成功才打开恢复弹窗，失败仅提示 */
    async function onJsonChange(event) {
        error = '';
        message = '';
        try {
            const file = event?.currentTarget?.files?.[0];
            if (!file) return;
            const text = await file.text();
            pending = parseBackup(text);
            restoreMode = 'merge';
            restoreOpen = true;
        } catch (e) {
            error = e?.message || '无法解析该文件。';
        } finally {
            if (jsonInput) jsonInput.value = '';
        }
    }

    /** 取消恢复：关闭弹窗并丢弃待恢复数据（不写库） */
    function cancelRestore() {
        restoreOpen = false;
    }

    /** 确认恢复：写入备份并刷新相关状态 */
    async function confirmRestore() {
        if (!pending) return;
        error = '';
        restoring = true;
        try {
            const res = await backupRepository.importAll(pending, { mode: restoreMode });
            await loadSettings();
            bumpNotes();
            bumpFolders();
            message = `已恢复 ${res.notes} 条笔记、${res.folders} 个文件夹。`;
            restoreOpen = false;
        } catch (e) {
            error = e?.message || '恢复备份失败。';
        } finally {
            restoring = false;
        }
    }
</script>

<div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
        <Heading tag="h2" class="text-lg font-semibold text-[var(--fg)]">数据</Heading>
        <P size="sm" class="text-[var(--fg-muted)]">
            导出为 ZIP 备份，或从备份恢复。数据完全在你的设备本地处理。
        </P>
    </div>

    <div class="flex flex-col divide-y divide-[var(--divider)]">
        <!-- 选择性导出（ZIP） -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">导出数据</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    勾选文件夹与笔记，导出为 Markdown / 纯文本 / Word 的 ZIP 压缩包。
                </P>
            </div>
            <button
                type="button"
                class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 sm:w-auto sm:flex-none"
                onclick={() => (exportOpen = true)}
            >
                <ha-icon name="download" collection="lucide" size="18"></ha-icon>
                <span>导出…</span>
            </button>
        </div>

        <!-- 完整备份（JSON） -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">完整备份</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    导出/恢复包含笔记、文件夹与外观设置的全量 JSON 备份（不含密码等安全信息）。
                </P>
            </div>
            <div class="flex flex-wrap items-center gap-2 sm:flex-none">
                <Button
                    color="light"
                    disabled={exporting}
                    onclick={handleExportBackup}
                    class="w-full sm:w-auto"
                >
                    {exporting ? '导出中…' : '导出备份'}
                </Button>
                <Button
                    color="light"
                    onclick={openRestorePicker}
                    class="w-full sm:w-auto"
                >
                    恢复备份
                </Button>
            </div>
        </div>

        <!-- 导入 -->
        <div
            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div class="flex min-w-0 flex-col gap-0.5">
                <Label class="text-[15px] text-[var(--fg)]">导入</Label>
                <P size="sm" class="text-[var(--fg-muted)]">
                    导入本应用导出的 ZIP，或 Markdown / 纯文本 / Word 文件。
                </P>
            </div>
            <Button
                color="light"
                onclick={() => (importOpen = true)}
                class="w-full sm:w-auto sm:flex-none"
            >
                <ha-icon name="upload" collection="lucide" size="18"></ha-icon>
                <span>导入…</span>
            </Button>
        </div>
    </div>

    {#if error}
        <P size="sm" class="text-red-500" role="alert">{error}</P>
    {/if}
    {#if message}
        <P size="sm" class="text-[var(--fg-muted)]">{message}</P>
    {/if}
</div>

<!-- 选择性导出弹窗 -->
<ExportDialog bind:open={exportOpen} />

<!-- 导入弹窗 -->
<ImportDialog bind:open={importOpen} />

<!-- 恢复备份文件选择器（隐藏） -->
<input
    type="file"
    accept=".json,application/json"
    bind:this={jsonInput}
    onchange={onJsonChange}
    class="hidden"
/>

<!-- 恢复备份弹窗 -->
<Modal
    bind:open={restoreOpen}
    title="恢复备份"
    size="none"
    class="max-w-[calc(100vw-2rem)] sm:max-w-md max-md:mt-4 max-md:mb-auto"
>
    {#if pending}
        <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
                <P size="sm" class="text-[var(--fg-muted)]">
                    该备份包含 {pendingCounts.notes} 条笔记、{pendingCounts.folders} 个文件夹。
                </P>
                {#if pending.exportedAt}
                    <P size="sm" class="text-[var(--fg-subtle)]">
                        导出时间：{new Date(pending.exportedAt).toLocaleString()}
                    </P>
                {/if}
            </div>

            <div class="flex flex-col gap-1.5">
                <Label for="restore-mode" class="text-[15px] text-[var(--fg)]">恢复方式</Label>
                <Select
                    id="restore-mode"
                    bind:value={restoreMode}
                    size="sm"
                    aria-label="恢复方式"
                >
                    <option value="merge">合并（按 id 去重）</option>
                    <option value="replace">覆盖（清空现有数据）</option>
                </Select>
            </div>

            {#if restoreMode === 'replace'}
                <P size="sm" class="text-red-500" role="alert">
                    将清空现有笔记与文件夹后导入，且不可撤销。
                </P>
            {/if}
        </div>
    {/if}

    {#snippet footer()}
        <div class="flex w-full justify-end gap-2">
            <Button color="light" onclick={cancelRestore}>取消</Button>
            <Button onclick={confirmRestore} disabled={restoring || !pending}>
                {restoring ? '恢复中…' : '恢复'}
            </Button>
        </div>
    {/snippet}
</Modal>
