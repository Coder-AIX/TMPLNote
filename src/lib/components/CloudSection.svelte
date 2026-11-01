<script>
    /**
     * CloudSection.svelte — 设置页「百度网盘存档」
     *
     * 功能：
     * - 粘贴 access_token / 配置应用目录 / 配置桥接地址并验证；
     * - 列出云端 .tmplenc 存档；
     * - 上传前强制口令加密（完整备份 JSON）；
     * - 下载后解密并按合并 / 覆盖模式恢复；
     * - 删除云端存档；
     * - 自动备份配置与状态；Phase 2 增加双向同步开关、冲突与上次同步展示。
     */
    import { Button, Heading, P, Label, Select, Modal } from 'flowbite-svelte';
    import Switch from './Switch.svelte';
    import backupRepository from '../db/backup.js';
    import { stringifyBackup, parseBackup } from '../utils/backup.js';
    import { settings, updateSetting, loadSettings } from '../stores/settings.js';
    import { bumpNotes, bumpFolders } from '../stores/workspace.js';
    import { maskStyle, secretInputType } from '../utils/secretInput.js';
    import {
        MIN_PASSWORD_LENGTH,
        archiveFilename,
        assertPassword,
        encryptArchive,
        decryptArchive
    } from '../baidu/archiveCrypto.js';
    import {
        normalizeAppPath,
        assertArchiveSize,
        verifyToken,
        listArchives,
        getDownloadLink,
        downloadArchive,
        uploadArchive,
        deleteArchive
    } from '../baidu/client.js';
    import {
        baiduAutoState,
        enableAutoSync,
        disableAutoSync,
        saveAutoOptions,
        unlockAutoSync,
        runAutoSyncNow,
        clearStoredAutoPassphrase
    } from '../stores/baiduAuto.js';

    const INPUT_CLASS =
        'w-full rounded-lg border border-[var(--divider)] bg-[var(--field)] px-3 py-2.5 text-sm text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)] focus:border-primary-500';
    const SECRET_AUTOFILL = {
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        'data-bwignore': 'true',
        'data-lpignore': 'true',
        'data-1p-ignore': '',
        'data-form-type': 'other'
    };

    /** 自动备份周期选项（分钟） */
    const AUTO_INTERVAL_OPTIONS = [
        { value: '15', label: '每 15 分钟' },
        { value: '30', label: '每 30 分钟' },
        { value: '60', label: '每 1 小时' },
        { value: '180', label: '每 3 小时' },
        { value: '1440', label: '每 1 天' }
    ];

    /** 自动备份保留份数选项（份） */
    const AUTO_KEEP_OPTIONS = ['3', '7', '15', '30'];

    /** ———— 连接配置 ———— */
    let token = $state('');
    let appPath = $state('/apps/TMPLNote');
    let bridgeUrl = $state('/api/baidu');
    let showToken = $state(false);
    let saving = $state(false);
    let connection = $state(null);

    /** ———— 存档列表 ———— */
    let archives = $state([]);
    let selectedPath = $state('');
    let listLoading = $state(false);

    /** ———— 提示 ———— */
    let error = $state('');
    let message = $state('');

    /** ———— 上传 ———— */
    let uploadOpen = $state(false);
    let uploadPassword = $state('');
    let uploadConfirm = $state('');
    let uploadShow = $state(false);
    let uploadError = $state('');
    let uploading = $state(false);
    let uploadProgress = $state({ phase: '', completed: 0, total: 0 });

    /** ———— 下载 / 解密 ———— */
    let downloadOpen = $state(false);
    let downloadPassword = $state('');
    let downloadShow = $state(false);
    let downloadError = $state('');
    let downloading = $state(false);

    /** ———— 恢复 ———— */
    let pending = $state(null);
    let restoreOpen = $state(false);
    let restoreMode = $state('merge');
    let restoring = $state(false);
    let restoreError = $state('');

    /** ———— 删除 ———— */
    let deleteOpen = $state(false);
    let deleteTarget = $state(null);
    let deleting = $state(false);
    let deleteError = $state('');

    /** ———— 自动同步与备份（Phase 1 自动备份 + Phase 2 双向同步） ———— */
    let autoConfigOpen = $state(false);
    let autoPassphrase = $state('');
    let autoConfirm = $state('');
    let autoShowPassphrase = $state(false);
    let autoSavePassphrase = $state(true);
    // 配置弹窗中的双向同步开关（打开弹窗时取当前配置值）
    let autoSyncEnabled = $state(false);
    let autoIntervalValue = $state('30');
    let autoKeepCountValue = $state('7');
    let autoConfigError = $state('');
    let autoEnabling = $state(false);
    let autoRunning = $state(false);
    let autoDisabling = $state(false);
    let autoClearing = $state(false);
    let autoActionError = $state('');
    let autoUnlockValue = $state('');
    let autoUnlockShow = $state(false);
    let autoUnlockError = $state('');
    let autoUnlocking = $state(false);
    // 已启用状态卡中的双向同步开关镜像与保存中状态
    let autoSyncToggle = $state(false);
    let autoSyncSaving = $state(false);

    // 仅在 store 中的值真正变化时同步本地镜像，避免覆盖用户刚选中、尚未保存的值
    let syncedAutoInterval = -1;
    let syncedAutoKeepCount = -1;

    // 双向同步开关始终跟随 store 中的真实配置，避免保存失败后停留在错误状态
    $effect(() => {
        autoSyncToggle = Boolean($baiduAutoState.syncEnabled);
    });

    $effect(() => {
        const state = $baiduAutoState;
        if (state.intervalMinutes !== syncedAutoInterval) {
            syncedAutoInterval = state.intervalMinutes;
            autoIntervalValue = String(state.intervalMinutes);
        }
        if (state.keepCount !== syncedAutoKeepCount) {
            syncedAutoKeepCount = state.keepCount;
            autoKeepCountValue = String(state.keepCount);
        }
    });

    // 设置异步载入 / 保存后同步镜像
    $effect(() => {
        const s = $settings;
        token = s.baiduAccessToken || '';
        appPath = s.baiduAppPath || '/apps/TMPLNote';
        bridgeUrl = s.baiduBridgeUrl || '/api/baidu';
    });

    // 关闭恢复弹窗时丢弃待恢复数据（不写库）
    $effect(() => {
        if (!restoreOpen) pending = null;
    });

    let hasConfig = $derived(Boolean(token.trim() && appPath.trim()));
    let savedAt = $derived(Number($settings.baiduTokenSavedAt) || 0);
    let selectedArchive = $derived(
        archives.find((item) => item.path === selectedPath) || null
    );
    let pendingCounts = $derived(
        pending
            ? {
                  notes: pending.data?.notes?.length ?? 0,
                  folders: pending.data?.folders?.length ?? 0
              }
            : { notes: 0, folders: 0 }
    );

    /** 自动备份保留份数选项：当前值不在预设内时补充当前值，避免选项与真实配置不一致 */
    let autoKeepOptions = $derived.by(() => {
        const list = [...AUTO_KEEP_OPTIONS];
        const current = String(autoKeepCountValue || '7');
        if (!list.includes(current)) list.push(current);
        return list.sort((a, b) => Number(a) - Number(b));
    });

    /** 上次自动备份时间 */
    let lastBackupLabel = $derived(
        $baiduAutoState.lastBackupAt ? formatTimestamp($baiduAutoState.lastBackupAt) : '尚未备份'
    );

    /** 下次计划运行时间 */
    let nextRunLabel = $derived(
        $baiduAutoState.nextRunAt ? formatTimestamp($baiduAutoState.nextRunAt) : '—'
    );

    /** 自动运行阶段文案 */
    let autoProgressLabel = $derived(
        $baiduAutoState.progressText ||
            ($baiduAutoState.syncEnabled ? '正在同步…' : '正在备份…')
    );

    /** 自动功能状态卡标题：启用双向同步后改为「自动同步与备份已启用」 */
    let autoStatusTitle = $derived(
        $baiduAutoState.syncEnabled ? '自动同步与备份已启用' : '自动备份已启用'
    );

    /** 上次双向同步时间 */
    let lastSyncLabel = $derived(
        $baiduAutoState.lastSyncAt ? formatTimestamp($baiduAutoState.lastSyncAt) : '尚未同步'
    );

    /** 当前同步模式 */
    let syncModeLabel = $derived($baiduAutoState.syncEnabled ? '双向同步' : '仅备份');

    /** 冲突数量（仅展示，不参与合并逻辑） */
    let autoConflictCount = $derived($baiduAutoState.conflicts?.length || 0);

    /** 冲突标题预览：最多展示前 3 个 */
    let autoConflictPreview = $derived(($baiduAutoState.conflicts || []).slice(0, 3));

    /** 立即同步 / 立即备份按钮文案 */
    let autoRunButtonLabel = $derived.by(() => {
        const sync = $baiduAutoState.syncEnabled;
        if (autoRunning || $baiduAutoState.busy) return sync ? '同步中…' : '备份中…';
        return sync ? '立即同步' : '立即备份';
    });

    /** 上传按钮文案（含分片进度） */
    let uploadButtonText = $derived.by(() => {
        if (!uploading) return '加密并上传';
        if (uploadProgress.phase === 'precreate') return '预上传中…';
        if (uploadProgress.phase === 'upload') {
            return uploadProgress.total > 0
                ? `上传分片 ${uploadProgress.completed}/${uploadProgress.total}…`
                : '上传分片中…';
        }
        if (uploadProgress.phase === 'create') return '创建云端文件…';
        return '加密上传中…';
    });

    /** 当前桥接地址（空值回退默认） */
    function currentBridge() {
        return bridgeUrl.trim() || '/api/baidu';
    }

    /** 字节数 → 可读大小 */
    function formatSize(bytes) {
        const value = Number(bytes) || 0;
        if (value <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = value;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) {
            size /= 1024;
            index += 1;
        }
        return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
    }

    /** 秒级时间戳 → 本地时间 */
    function formatMtime(seconds) {
        const value = Number(seconds) || 0;
        return value > 0 ? new Date(value * 1000).toLocaleString() : '—';
    }

    /** 毫秒级时间戳 → 本地时间 */
    function formatTimestamp(ms) {
        const value = Number(ms) || 0;
        return value > 0 ? new Date(value).toLocaleString() : '';
    }

    /** 打开自动备份配置弹窗（每次打开都重置输入与选项镜像） */
    function openAutoConfig() {
        autoConfigError = '';
        autoPassphrase = '';
        autoConfirm = '';
        autoShowPassphrase = false;
        autoSavePassphrase = true;
        autoSyncEnabled = Boolean($baiduAutoState.syncEnabled);
        autoIntervalValue = String($baiduAutoState.intervalMinutes || 30);
        autoKeepCountValue = String($baiduAutoState.keepCount || 7);
        autoConfigOpen = true;
    }

    /** 校验本次输入的口令（已保存口令时不要求重复输入） */
    function validateAutoPassphrase() {
        if ($baiduAutoState.storedPassphrase) return '';
        try {
            assertPassword(autoPassphrase);
        } catch (e) {
            return e?.message || `自动同步口令至少需要 ${MIN_PASSWORD_LENGTH} 位。`;
        }
        if (autoPassphrase !== autoConfirm) {
            return '两次输入的自动同步口令不一致。';
        }
        return '';
    }

    /** 启用自动备份 */
    async function confirmEnableAuto() {
        autoConfigError = validateAutoPassphrase();
        if (autoConfigError) return;

        const useStored = $baiduAutoState.storedPassphrase;
        autoEnabling = true;
        try {
            await enableAutoSync({
                passphrase: useStored ? undefined : autoPassphrase,
                savePassphrase: autoSavePassphrase,
                backupEnabled: true,
                syncEnabled: autoSyncEnabled,
                intervalMinutes: Number(autoIntervalValue),
                keepCount: Number(autoKeepCountValue)
            });
            autoConfigOpen = false;
            autoPassphrase = '';
            autoConfirm = '';
            autoConfigError = '';
            autoActionError = '';
            autoUnlockError = '';
            error = '';
            message = autoSyncEnabled ? '自动同步与备份已启用。' : '自动备份已启用。';
        } catch (e) {
            autoConfigError = e?.message || '启用自动备份失败，请稍后重试。';
        } finally {
            autoEnabling = false;
        }
    }

    /** 解锁自动同步（仅本次会话） */
    async function confirmUnlockAuto() {
        autoUnlockError = '';
        if (!autoUnlockValue) {
            autoUnlockError = '请输入自动同步口令。';
            return;
        }
        autoUnlocking = true;
        try {
            await unlockAutoSync(autoUnlockValue);
            autoUnlockValue = '';
            autoUnlockShow = false;
            autoActionError = '';
        } catch (e) {
            autoUnlockError = e?.message || '自动同步口令错误。';
        } finally {
            autoUnlocking = false;
        }
    }

    /** 立即执行一次自动备份或双向同步（强制上传） */
    async function runAutoNow() {
        autoActionError = '';
        autoRunning = true;
        const sync = $baiduAutoState.syncEnabled;
        try {
            await runAutoSyncNow();
            error = '';
            message = sync ? '双向同步已完成。' : '自动备份已完成。';
            await refreshArchives({ silent: true });
        } catch (e) {
            autoActionError = e?.message || (sync ? '同步失败，请稍后重试。' : '自动备份失败，请稍后重试。');
        } finally {
            autoRunning = false;
        }
    }

    /**
     * 已启用状态下切换双向同步。
     * 开启前必须二次确认；用户取消或保存失败时把开关回退到 store 中的真实配置。
     */
    async function onAutoSyncToggle(checked) {
        autoActionError = '';
        if (checked) {
            const confirmed =
                typeof window === 'undefined'
                    ? true
                    : window.confirm(
                          '开启双向同步后，会下载云端最新自动备份并与本机合并；删除会传播，冲突会保存为副本。确定开启？'
                      );
            if (!confirmed) {
                autoSyncToggle = Boolean($baiduAutoState.syncEnabled);
                return;
            }
        }

        autoSyncToggle = checked;
        autoSyncSaving = true;
        try {
            await saveAutoOptions({ syncEnabled: checked });
            error = '';
            message = checked ? '已开启双向同步。' : '已关闭双向同步，恢复为仅备份。';
        } catch (e) {
            autoSyncToggle = Boolean($baiduAutoState.syncEnabled);
            autoActionError = e?.message || '保存双向同步设置失败。';
        } finally {
            autoSyncSaving = false;
        }
    }

    /** 暂停自动备份（二次确认；保留已保存口令与配置） */
    async function pauseAuto() {
        if (
            typeof window !== 'undefined' &&
            !window.confirm('暂停后将停止自动备份，已保存的口令与配置会保留。确定暂停吗？')
        ) {
            return;
        }
        autoActionError = '';
        autoDisabling = true;
        try {
            await disableAutoSync();
            error = '';
            message = '自动备份已暂停。';
        } catch (e) {
            autoActionError = e?.message || '暂停自动备份失败。';
        } finally {
            autoDisabling = false;
        }
    }

    /** 清除本机加密保存的自动同步口令（二次确认） */
    async function clearSavedAutoPassphrase() {
        if (
            typeof window !== 'undefined' &&
            !window.confirm('清除后，下次打开应用需要重新输入自动同步口令。确定清除吗？')
        ) {
            return;
        }
        autoActionError = '';
        autoClearing = true;
        try {
            await clearStoredAutoPassphrase();
            error = '';
            message = '已清除本机保存的自动同步口令。';
        } catch (e) {
            autoActionError = e?.message || '清除已保存口令失败。';
        } finally {
            autoClearing = false;
        }
    }

    /** 修改自动备份周期 */
    async function onAutoIntervalChange(event) {
        const next = Number(event?.currentTarget?.value);
        autoIntervalValue = String(Number.isFinite(next) && next > 0 ? next : 30);
        autoActionError = '';
        try {
            await saveAutoOptions({
                intervalMinutes: Number(autoIntervalValue),
                keepCount: Number(autoKeepCountValue)
            });
            error = '';
            message = '自动备份周期已更新。';
        } catch (e) {
            autoActionError = e?.message || '保存自动备份设置失败。';
        }
    }

    /** 修改自动备份保留份数 */
    async function onAutoKeepCountChange(event) {
        const next = Number(event?.currentTarget?.value);
        autoKeepCountValue = String(Number.isFinite(next) && next > 0 ? next : 7);
        autoActionError = '';
        try {
            await saveAutoOptions({
                intervalMinutes: Number(autoIntervalValue),
                keepCount: Number(autoKeepCountValue)
            });
            error = '';
            message = '自动备份保留份数已更新。';
        } catch (e) {
            autoActionError = e?.message || '保存自动备份设置失败。';
        }
    }

    /** 连接状态文案 */
    let connectionLabel = $derived.by(() => {
        if (connection) {
            const name =
                connection.netdisk_name || connection.baidu_name || `UK ${connection.uk ?? ''}`;
            return `已连接：${String(name).trim() || '百度网盘用户'}`;
        }
        if (savedAt) {
            return `token 已保存在本机（${new Date(savedAt).toLocaleString()} 验证）`;
        }
        return '';
    });

    /** 验证并保存连接配置 */
    async function saveConnection() {
        error = '';
        message = '';
        connection = null;

        let normalized;
        try {
            normalized = normalizeAppPath(appPath);
        } catch (e) {
            error = e?.message || '应用目录无效。';
            return;
        }

        const accessToken = token.trim();
        if (!accessToken) {
            error = '请先粘贴百度网盘 access_token。';
            return;
        }

        saving = true;
        try {
            const info = await verifyToken({
                token: accessToken,
                bridgeUrl: currentBridge()
            });

            await Promise.all([
                updateSetting('baiduAccessToken', accessToken),
                updateSetting('baiduAppPath', normalized),
                updateSetting('baiduBridgeUrl', currentBridge()),
                updateSetting('baiduTokenSavedAt', Date.now())
            ]);

            token = accessToken;
            appPath = normalized;
            bridgeUrl = currentBridge();
            connection = info;
            message = '已连接百度网盘。';
            await refreshArchives({ silent: true });
        } catch (e) {
            error = e?.message || '验证失败，请检查 token 与桥接服务。';
        } finally {
            saving = false;
        }
    }

    /** 刷新云端存档列表 */
    async function refreshArchives({ silent = false } = {}) {
        const accessToken = token.trim();
        if (!accessToken) {
            if (!silent) error = '请先配置 access_token。';
            return;
        }

        let normalized;
        try {
            normalized = normalizeAppPath(appPath);
        } catch (e) {
            if (!silent) error = e?.message || '应用目录无效。';
            return;
        }

        listLoading = true;
        if (!silent) {
            error = '';
            message = '';
        }
        try {
            const list = await listArchives({
                token: accessToken,
                bridgeUrl: currentBridge(),
                appPath: normalized
            });
            archives = list;
            if (!list.some((item) => item.path === selectedPath)) {
                selectedPath = list[0]?.path ?? '';
            }
            if (!silent) {
                message =
                    list.length > 0 ? `已加载 ${list.length} 个云端存档。` : '云端还没有加密存档。';
            }
        } catch (e) {
            archives = [];
            selectedPath = '';
            if (!silent) error = e?.message || '读取云端存档失败。';
        } finally {
            listLoading = false;
        }
    }

    /** 打开发送上传弹窗 */
    function openUpload() {
        uploadPassword = '';
        uploadConfirm = '';
        uploadShow = false;
        uploadError = '';
        uploadProgress = { phase: '', completed: 0, total: 0 };
        uploadOpen = true;
    }

    /** 加密并上传完整备份 */
    async function confirmUpload() {
        uploadError = '';
        try {
            assertPassword(uploadPassword);
        } catch (e) {
            uploadError = e.message;
            return;
        }
        if (uploadPassword !== uploadConfirm) {
            uploadError = '两次输入的口令不一致。';
            return;
        }

        let normalized;
        try {
            normalized = normalizeAppPath(appPath);
        } catch (e) {
            uploadError = e?.message || '应用目录无效。';
            return;
        }

        uploading = true;
        try {
            const backup = await backupRepository.exportAll();
            const text = stringifyBackup(backup);
            const bytes = await encryptArchive(text, uploadPassword);
            assertArchiveSize(bytes.byteLength, '加密存档');

            const filename = archiveFilename();
            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            await uploadArchive({
                token: token.trim(),
                bridgeUrl: currentBridge(),
                appPath: normalized,
                filename,
                blob,
                onProgress: (progress) => {
                    uploadProgress = progress;
                }
            });

            uploadOpen = false;
            uploadPassword = '';
            uploadConfirm = '';
            error = '';
            message = `存档已加密上传：${filename}`;
            await refreshArchives({ silent: true });
        } catch (e) {
            uploadError = e?.message || '上传存档失败。';
        } finally {
            uploading = false;
            uploadProgress = { phase: '', completed: 0, total: 0 };
        }
    }

    /** 打开下载弹窗 */
    function openDownload() {
        if (!selectedArchive) {
            error = '请先选择一个云端存档。';
            return;
        }
        downloadPassword = '';
        downloadShow = false;
        downloadError = '';
        downloadOpen = true;
    }

    /** 下载 + 解密，成功后进入恢复确认 */
    async function confirmDownload() {
        downloadError = '';
        try {
            assertPassword(downloadPassword);
        } catch (e) {
            downloadError = e.message;
            return;
        }

        const archive = selectedArchive;
        if (!archive) {
            downloadError = '请先选择一个云端存档。';
            return;
        }

        downloading = true;
        try {
            let bytes = null;
            // dlink 过期（31360）时重新获取一次
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const dlink = await getDownloadLink({
                    token: token.trim(),
                    bridgeUrl: currentBridge(),
                    fsId: archive.fsId
                });
                try {
                    bytes = await downloadArchive({
                        token: token.trim(),
                        bridgeUrl: currentBridge(),
                        dlink
                    });
                    break;
                } catch (e) {
                    if (e?.code === 31360 && attempt === 0) continue;
                    throw e;
                }
            }

            if (!bytes) {
                throw new Error('下载云端存档失败。');
            }

            const text = await decryptArchive(bytes, downloadPassword);
            pending = parseBackup(text);
            downloadOpen = false;
            downloadPassword = '';
            restoreMode = 'merge';
            restoreError = '';
            restoreOpen = true;
        } catch (e) {
            downloadError = e?.message || '下载或解密失败。';
        } finally {
            downloading = false;
        }
    }

    /** 确认恢复云端备份 */
    async function confirmRestore() {
        if (!pending) return;
        restoreError = '';
        restoring = true;
        try {
            const res = await backupRepository.importAll(pending, { mode: restoreMode });
            await loadSettings();
            bumpNotes();
            bumpFolders();
            message = `已从云端恢复 ${res.notes} 条笔记、${res.folders} 个文件夹。`;
            error = '';
            restoreOpen = false;
        } catch (e) {
            restoreError = e?.message || '恢复云端存档失败。';
        } finally {
            restoring = false;
        }
    }

    /** 请求删除某存档 */
    function askDelete(archive, event) {
        event?.preventDefault();
        event?.stopPropagation();
        deleteTarget = archive;
        deleteError = '';
        deleteOpen = true;
    }

    /** 确认删除云端存档 */
    async function confirmDelete() {
        if (!deleteTarget) return;
        const target = deleteTarget;
        deleteError = '';
        deleting = true;
        try {
            await deleteArchive({
                token: token.trim(),
                bridgeUrl: currentBridge(),
                path: target.path
            });
            deleteOpen = false;
            deleteTarget = null;
            error = '';
            message = `已删除云端存档：${target.name}`;
            if (selectedPath === target.path) selectedPath = '';
            await refreshArchives({ silent: true });
        } catch (e) {
            deleteError = e?.message || '删除云端存档失败。';
        } finally {
            deleting = false;
        }
    }
</script>

<div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
        <Heading tag="h2" class="text-lg font-semibold text-[var(--fg)]">百度网盘存档</Heading>
        <P size="sm" class="text-[var(--fg-muted)]">
            使用 access_token 直连百度网盘 OpenAPI。存档在浏览器内加密后再上传，口令不会保存。
        </P>
    </div>

    <!-- 连接配置 -->
    <div class="flex flex-col divide-y divide-[var(--divider)]">
        <div class="flex flex-col gap-2 py-4 first:pt-0">
            <Label for="baidu-token" class="text-[15px] text-[var(--fg)]">access_token</Label>
            <div class="relative">
                <input
                    id="baidu-token"
                    type={secretInputType(showToken)}
                    style={maskStyle(showToken)}
                    bind:value={token}
                    class="{INPUT_CLASS} pe-10"
                    placeholder="粘贴百度网盘 access_token"
                    {...SECRET_AUTOFILL}
                />
                <button
                    type="button"
                    class="absolute inset-y-0 end-0 grid w-10 place-items-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    aria-label={showToken ? '隐藏 token' : '显示 token'}
                    onclick={() => (showToken = !showToken)}
                >
                    <ha-icon
                        name={showToken ? 'eye-off' : 'eye'}
                        collection="lucide"
                        size="18"
                    ></ha-icon>
                </button>
            </div>
            <P size="sm" class="text-[var(--fg-subtle)]">
                仅保存在本机 IndexedDB，不进入备份。access_token 约 30 天过期，过期后需重新获取。
            </P>
        </div>

        <div class="flex flex-col gap-2 py-4">
            <Label for="baidu-app-path" class="text-[15px] text-[var(--fg)]">应用目录</Label>
            <input
                id="baidu-app-path"
                type="text"
                bind:value={appPath}
                class={INPUT_CLASS}
                placeholder="/apps/TMPLNote"
                autocomplete="off"
                spellcheck="false"
            />
            <P size="sm" class="text-[var(--fg-subtle)]">
                必须与百度控制台注册的产品名一致，且位于 /apps/ 下；存档会直接放在该目录。
            </P>
        </div>

        <div class="flex flex-col gap-2 py-4">
            <Label for="baidu-bridge" class="text-[15px] text-[var(--fg)]">
                桥接地址（高级）
            </Label>
            <input
                id="baidu-bridge"
                type="text"
                bind:value={bridgeUrl}
                class={INPUT_CLASS}
                placeholder="/api/baidu"
                autocomplete="off"
                spellcheck="false"
            />
            <P size="sm" class="text-[var(--fg-subtle)]">
                Cloudflare Pages 使用默认 /api/baidu；GitHub Pages 等静态部署需填写自建 Worker 地址。
            </P>
        </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
        <button
            type="button"
            class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            onclick={saveConnection}
            disabled={saving}
        >
            <ha-icon name="check" collection="lucide" size="18"></ha-icon>
            <span>{saving ? '验证中…' : '验证并保存'}</span>
        </button>
        <Button
            color="light"
            onclick={() => refreshArchives()}
            disabled={!hasConfig || listLoading}
            class="w-full sm:w-auto"
        >
            {listLoading ? '刷新中…' : '刷新存档'}
        </Button>
    </div>

    {#if connectionLabel}
        <P size="sm" class="text-[var(--fg-muted)]">{connectionLabel}</P>
    {/if}

    {#if error}
        <P size="sm" class="text-red-500" role="alert">{error}</P>
    {/if}
    {#if message}
        <P size="sm" class="text-[var(--fg-muted)]">{message}</P>
    {/if}

    <!-- 自动同步与备份（Phase 1 自动备份 + Phase 2 双向同步） -->
    <div class="flex flex-col gap-3 border-t border-[var(--divider)] pt-4">
        <div class="flex flex-col gap-1">
            <Label class="text-[15px] text-[var(--fg)]">自动同步与备份</Label>
            {#if !$baiduAutoState.configured}
                <P size="sm" class="text-[var(--fg-muted)]">
                    请先完成上方百度网盘连接（验证并保存），再启用自动备份。
                </P>
            {:else if !$baiduAutoState.enabled}
                <P size="sm" class="text-[var(--fg-muted)]">
                    笔记会在离开设备前加密，并自动上传到百度网盘。
                </P>
            {/if}
        </div>

        {#if !$baiduAutoState.configured}
            <div class="flex flex-col gap-2 sm:flex-row">
                <button
                    type="button"
                    class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                    disabled
                >
                    <ha-icon name="lock" collection="lucide" size="18"></ha-icon>
                    <span>启用自动备份…</span>
                </button>
            </div>
            <P size="sm" class="text-[var(--fg-subtle)]">
                完成连接并验证保存后，自动备份按钮才会可用。
            </P>
        {:else if !$baiduAutoState.enabled}
            <div class="flex flex-col gap-2 sm:flex-row">
                <button
                    type="button"
                    class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                    onclick={openAutoConfig}
                    disabled={$baiduAutoState.busy}
                >
                    <ha-icon name="rotate-ccw" collection="lucide" size="18"></ha-icon>
                    <span>启用自动备份…</span>
                </button>
            </div>
            {#if autoActionError}
                <P size="sm" class="text-red-500" role="alert">{autoActionError}</P>
            {/if}
        {:else}
            <div class="flex flex-col gap-3 rounded-lg border border-[var(--divider)] p-3">
                <div class="flex items-center gap-2">
                    <ha-icon
                        name={$baiduAutoState.syncEnabled ? 'history' : 'rotate-ccw'}
                        collection="lucide"
                        size="18"
                        class="shrink-0 text-primary-500"
                    ></ha-icon>
                    <span class="text-sm font-medium text-[var(--fg)]">{autoStatusTitle}</span>
                </div>

                <dl class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                    <div class="flex flex-col gap-0.5">
                        <dt class="text-xs text-[var(--fg-subtle)]">上次备份</dt>
                        <dd class="text-[var(--fg-muted)]">{lastBackupLabel}</dd>
                    </div>
                    <div class="flex flex-col gap-0.5">
                        <dt class="text-xs text-[var(--fg-subtle)]">上次同步</dt>
                        <dd class="text-[var(--fg-muted)]">{lastSyncLabel}</dd>
                    </div>
                    <div class="flex flex-col gap-0.5">
                        <dt class="text-xs text-[var(--fg-subtle)]">同步模式</dt>
                        <dd class="text-[var(--fg-muted)]">{syncModeLabel}</dd>
                    </div>
                    <div class="flex flex-col gap-0.5">
                        <dt class="text-xs text-[var(--fg-subtle)]">下次计划</dt>
                        <dd class="text-[var(--fg-muted)]">{nextRunLabel}</dd>
                    </div>
                    <div class="flex flex-col gap-0.5">
                        <dt class="text-xs text-[var(--fg-subtle)]">保留份数</dt>
                        <dd class="text-[var(--fg-muted)]">{$baiduAutoState.keepCount} 份</dd>
                    </div>
                    <div class="flex flex-col gap-0.5">
                        <dt class="text-xs text-[var(--fg-subtle)]">口令保存</dt>
                        <dd class="text-[var(--fg-muted)]">
                            {$baiduAutoState.storedPassphrase ? '已在本机加密保存' : '仅本次会话'}
                        </dd>
                    </div>
                </dl>

                <div
                    class="flex items-center justify-between gap-3 rounded-lg bg-[var(--field)] px-3 py-2.5"
                >
                    <div class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-sm text-[var(--fg)]">双向同步（多设备）</span>
                        <span class="text-xs text-[var(--fg-subtle)]">
                            会下载云端最新自动备份并与本机合并；删除会传播，冲突会保存为副本。
                        </span>
                    </div>
                    <Switch
                        checked={autoSyncToggle}
                        disabled={$baiduAutoState.busy || autoSyncSaving}
                        ariaLabel="双向同步（多设备）"
                        onchange={onAutoSyncToggle}
                    />
                </div>

                {#if autoConflictCount > 0}
                    <div class="flex flex-col gap-1.5 rounded-lg bg-[var(--field)] p-3">
                        <P size="sm" class="text-[var(--fg)]">
                            检测到 {autoConflictCount} 个冲突，已保存为副本。
                        </P>
                        <ul class="flex flex-col gap-0.5 text-xs text-[var(--fg-muted)]">
                            {#each autoConflictPreview as conflict (conflict.id)}
                                <li class="truncate">· {conflict.title}</li>
                            {/each}
                        </ul>
                        {#if autoConflictCount > autoConflictPreview.length}
                            <P size="sm" class="text-[var(--fg-subtle)]">
                                仅显示前 3 个冲突，可在笔记列表查看全部冲突副本。
                            </P>
                        {/if}
                    </div>
                {/if}

                {#if $baiduAutoState.authExpired}
                    <P size="sm" class="text-red-500" role="alert">
                        token 已失效，请重新获取并粘贴到上方，点击“验证并保存”后再启用/继续自动备份。
                    </P>
                {/if}

                {#if $baiduAutoState.lastError}
                    <P size="sm" class="text-red-500" role="alert">
                        {$baiduAutoState.lastError}
                    </P>
                {/if}

                {#if !$baiduAutoState.unlocked}
                    <div class="flex flex-col gap-1.5 rounded-lg bg-[var(--field)] p-3">
                        <Label for="auto-unlock-passphrase" class="text-[15px] text-[var(--fg)]">
                            自动同步口令
                        </Label>
                        <div class="flex flex-col gap-2 sm:flex-row">
                            <div class="relative min-w-0 flex-1">
                                <input
                                    id="auto-unlock-passphrase"
                                    type={secretInputType(autoUnlockShow)}
                                    style={maskStyle(autoUnlockShow)}
                                    bind:value={autoUnlockValue}
                                    class="{INPUT_CLASS} pe-10"
                                    placeholder="输入口令以解锁自动同步"
                                    {...SECRET_AUTOFILL}
                                />
                                <button
                                    type="button"
                                    class="absolute inset-y-0 end-0 grid w-10 place-items-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                                    aria-label={autoUnlockShow ? '隐藏口令' : '显示口令'}
                                    onclick={() => (autoUnlockShow = !autoUnlockShow)}
                                >
                                    <ha-icon
                                        name={autoUnlockShow ? 'eye-off' : 'eye'}
                                        collection="lucide"
                                        size="18"
                                    ></ha-icon>
                                </button>
                            </div>
                            <button
                                type="button"
                                class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--divider)] px-5 py-2.5 text-sm text-[var(--fg)] transition-colors hover:bg-[var(--row-active)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:flex-none"
                                onclick={confirmUnlockAuto}
                                disabled={autoUnlocking}
                            >
                                <ha-icon name="lock" collection="lucide" size="18"></ha-icon>
                                <span>{autoUnlocking ? '解锁中…' : '解锁'}</span>
                            </button>
                        </div>
                        {#if autoUnlockError}
                            <P size="sm" class="text-red-500" role="alert">{autoUnlockError}</P>
                        {/if}
                    </div>
                {/if}

                {#if $baiduAutoState.busy}
                    <P size="sm" class="text-[var(--fg-muted)]">{autoProgressLabel}</P>
                {/if}

                {#if autoActionError}
                    <P size="sm" class="text-red-500" role="alert">{autoActionError}</P>
                {/if}

                <div class="flex flex-col gap-2 sm:flex-row">
                    <button
                        type="button"
                        class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        onclick={runAutoNow}
                        disabled={$baiduAutoState.busy || autoRunning}
                    >
                        <ha-icon
                            name={$baiduAutoState.syncEnabled ? 'history' : 'upload'}
                            collection="lucide"
                            size="18"
                        ></ha-icon>
                        <span>{autoRunButtonLabel}</span>
                    </button>
                    <button
                        type="button"
                        class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--divider)] px-5 py-2.5 text-sm text-[var(--fg)] transition-colors hover:bg-[var(--row-active)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        onclick={pauseAuto}
                        disabled={$baiduAutoState.busy || autoDisabling}
                    >
                        <ha-icon name="square" collection="lucide" size="18"></ha-icon>
                        <span>{autoDisabling ? '暂停中…' : '暂停'}</span>
                    </button>
                    <button
                        type="button"
                        class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--divider)] px-5 py-2.5 text-sm text-[var(--fg)] transition-colors hover:bg-[var(--row-active)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        onclick={clearSavedAutoPassphrase}
                        disabled={$baiduAutoState.busy ||
                            autoClearing ||
                            !$baiduAutoState.storedPassphrase}
                    >
                        <ha-icon name="lock" collection="lucide" size="18"></ha-icon>
                        <span>{autoClearing ? '清除中…' : '清除已保存口令'}</span>
                    </button>
                </div>

                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div class="flex flex-col gap-1.5">
                        <Label for="auto-interval" class="text-[15px] text-[var(--fg)]">
                            自动备份周期
                        </Label>
                        <Select
                            id="auto-interval"
                            value={autoIntervalValue}
                            onchange={onAutoIntervalChange}
                            size="sm"
                            aria-label="自动备份周期"
                            disabled={$baiduAutoState.busy}
                        >
                            {#each AUTO_INTERVAL_OPTIONS as option (option.value)}
                                <option value={option.value}>{option.label}</option>
                            {/each}
                        </Select>
                    </div>
                    <div class="flex flex-col gap-1.5">
                        <Label for="auto-keep-count" class="text-[15px] text-[var(--fg)]">
                            保留份数
                        </Label>
                        <Select
                            id="auto-keep-count"
                            value={autoKeepCountValue}
                            onchange={onAutoKeepCountChange}
                            size="sm"
                            aria-label="自动备份保留份数"
                            disabled={$baiduAutoState.busy}
                        >
                            {#each autoKeepOptions as option (option)}
                                <option value={option}>保留 {option} 份</option>
                            {/each}
                        </Select>
                    </div>
                </div>
            </div>
        {/if}
    </div>

    <!-- 云端存档列表 -->
    <div class="flex flex-col gap-3 border-t border-[var(--divider)] pt-4">
        <div class="flex items-center justify-between gap-3">
            <Label class="text-[15px] text-[var(--fg)]">云端存档</Label>
            <span class="text-xs text-[var(--fg-subtle)]">{archives.length} 个</span>
        </div>

        <div class="max-h-72 overflow-y-auto rounded-lg border border-[var(--divider)]">
            {#if listLoading}
                <p class="py-6 text-center text-sm text-[var(--fg-subtle)]">加载中…</p>
            {:else if archives.length === 0}
                <p class="py-6 text-center text-sm text-[var(--fg-subtle)]">
                    暂无云端存档，点击下方“上传存档”创建。
                </p>
            {:else}
                <ul class="flex flex-col divide-y divide-[var(--divider)]">
                    {#each archives as archive (archive.path)}
                        <li>
                            <label
                                class="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
                            >
                                <input
                                    type="radio"
                                    name="cloud-archive"
                                    class="h-4 w-4 shrink-0 cursor-pointer accent-primary-600"
                                    checked={selectedPath === archive.path}
                                    onchange={() => (selectedPath = archive.path)}
                                />
                                <ha-icon
                                    name="lock"
                                    collection="lucide"
                                    size="16"
                                    class="shrink-0 text-[var(--fg-subtle)]"
                                ></ha-icon>
                                <span class="flex min-w-0 flex-1 flex-col">
                                    <span class="truncate text-[var(--fg)]">{archive.name}</span>
                                    <span class="text-xs text-[var(--fg-subtle)]">
                                        {formatSize(archive.size)} · {formatMtime(archive.mtime)}
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--fg-subtle)] transition-colors hover:bg-[var(--row-active)] hover:text-red-500"
                                    aria-label="删除 {archive.name}"
                                    onclick={(event) => askDelete(archive, event)}
                                >
                                    <ha-icon
                                        name="trash-2"
                                        collection="lucide"
                                        size="16"
                                    ></ha-icon>
                                </button>
                            </label>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>

        <div class="flex flex-col gap-2 sm:flex-row">
            <button
                type="button"
                class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                onclick={openUpload}
                disabled={!hasConfig || uploading}
            >
                <ha-icon name="upload" collection="lucide" size="18"></ha-icon>
                <span>上传存档…</span>
            </button>
            <button
                type="button"
                class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--divider)] px-5 py-2.5 text-sm text-[var(--fg)] transition-colors hover:bg-[var(--row-active)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                onclick={openDownload}
                disabled={!selectedArchive || downloading}
            >
                <ha-icon name="download" collection="lucide" size="18"></ha-icon>
                <span>下载并恢复…</span>
            </button>
        </div>

        <P size="sm" class="text-[var(--fg-subtle)]">
            上传内容为完整备份 JSON，经口令加密后保存为 .tmplenc。口令不保存，忘记后无法恢复。
        </P>
    </div>
</div>

<!-- 上传：设置口令 -->
<Modal
    bind:open={uploadOpen}
    title="加密并上传存档"
    size="none"
    class="max-w-[calc(100vw-2rem)] sm:max-w-sm max-md:mt-4 max-md:mb-auto"
>
    <div class="flex flex-col gap-4">
        <P size="sm" class="text-[var(--fg-muted)]">
            将为完整备份设置加密口令。口令不会保存，忘记后无法恢复该存档。
        </P>

        <div class="flex flex-col gap-1.5">
            <Label for="archive-password" class="text-[15px] text-[var(--fg)]">加密口令</Label>
            <div class="relative">
                <input
                    id="archive-password"
                    type={secretInputType(uploadShow)}
                    style={maskStyle(uploadShow)}
                    bind:value={uploadPassword}
                    class="{INPUT_CLASS} pe-10"
                    placeholder="至少 {MIN_PASSWORD_LENGTH} 位"
                    {...SECRET_AUTOFILL}
                />
                <button
                    type="button"
                    class="absolute inset-y-0 end-0 grid w-10 place-items-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    aria-label={uploadShow ? '隐藏口令' : '显示口令'}
                    onclick={() => (uploadShow = !uploadShow)}
                >
                    <ha-icon
                        name={uploadShow ? 'eye-off' : 'eye'}
                        collection="lucide"
                        size="18"
                    ></ha-icon>
                </button>
            </div>
        </div>

        <div class="flex flex-col gap-1.5">
            <Label for="archive-password-confirm" class="text-[15px] text-[var(--fg)]">
                确认口令
            </Label>
            <input
                id="archive-password-confirm"
                type={secretInputType(uploadShow)}
                style={maskStyle(uploadShow)}
                bind:value={uploadConfirm}
                class={INPUT_CLASS}
                placeholder="再次输入口令"
                {...SECRET_AUTOFILL}
            />
        </div>

        {#if uploadError}
            <P size="sm" class="text-red-500" role="alert">{uploadError}</P>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full justify-end gap-2">
            <Button color="light" onclick={() => (uploadOpen = false)} disabled={uploading}>
                取消
            </Button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={confirmUpload}
                disabled={uploading}
            >
                {uploading ? uploadButtonText : '加密并上传'}
            </button>
        </div>
    {/snippet}
</Modal>

<!-- 下载：输入口令 -->
<Modal
    bind:open={downloadOpen}
    title="下载并恢复"
    size="none"
    class="max-w-[calc(100vw-2rem)] sm:max-w-sm max-md:mt-4 max-md:mb-auto"
>
    <div class="flex flex-col gap-4">
        <P size="sm" class="text-[var(--fg-muted)]">
            将从云端下载并解密所选存档，然后进入恢复确认。
        </P>

        {#if selectedArchive}
            <div class="flex min-w-0 flex-col gap-0.5 rounded-lg bg-[var(--field)] px-3 py-2">
                <span class="truncate text-sm text-[var(--fg)]">{selectedArchive.name}</span>
                <span class="text-xs text-[var(--fg-subtle)]">
                    {formatSize(selectedArchive.size)} · {formatMtime(selectedArchive.mtime)}
                </span>
            </div>
        {/if}

        <div class="flex flex-col gap-1.5">
            <Label for="archive-download-password" class="text-[15px] text-[var(--fg)]">
                解密口令
            </Label>
            <div class="relative">
                <input
                    id="archive-download-password"
                    type={secretInputType(downloadShow)}
                    style={maskStyle(downloadShow)}
                    bind:value={downloadPassword}
                    class="{INPUT_CLASS} pe-10"
                    placeholder="输入上传时设置的口令"
                    {...SECRET_AUTOFILL}
                />
                <button
                    type="button"
                    class="absolute inset-y-0 end-0 grid w-10 place-items-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    aria-label={downloadShow ? '隐藏口令' : '显示口令'}
                    onclick={() => (downloadShow = !downloadShow)}
                >
                    <ha-icon
                        name={downloadShow ? 'eye-off' : 'eye'}
                        collection="lucide"
                        size="18"
                    ></ha-icon>
                </button>
            </div>
        </div>

        {#if downloadError}
            <P size="sm" class="text-red-500" role="alert">{downloadError}</P>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full justify-end gap-2">
            <Button color="light" onclick={() => (downloadOpen = false)} disabled={downloading}>
                取消
            </Button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={confirmDownload}
                disabled={downloading}
            >
                {downloading ? '下载解密中…' : '下载并解密'}
            </button>
        </div>
    {/snippet}
</Modal>

<!-- 恢复确认 -->
<Modal
    bind:open={restoreOpen}
    title="恢复云端存档"
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
                <Label for="cloud-restore-mode" class="text-[15px] text-[var(--fg)]">
                    恢复方式
                </Label>
                <Select
                    id="cloud-restore-mode"
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

            {#if restoreError}
                <P size="sm" class="text-red-500" role="alert">{restoreError}</P>
            {/if}
        </div>
    {/if}

    {#snippet footer()}
        <div class="flex w-full justify-end gap-2">
            <Button color="light" onclick={() => (restoreOpen = false)} disabled={restoring}>
                取消
            </Button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={confirmRestore}
                disabled={restoring || !pending}
            >
                {restoring ? '恢复中…' : '恢复'}
            </button>
        </div>
    {/snippet}
</Modal>

<!-- 删除确认 -->
<Modal
    bind:open={deleteOpen}
    title="删除云端存档"
    size="none"
    class="max-w-[calc(100vw-2rem)] sm:max-w-sm max-md:mt-4 max-md:mb-auto"
>
    <div class="flex flex-col gap-3">
        <P size="sm" class="text-[var(--fg-muted)]">
            确定删除云端存档“{deleteTarget?.name ?? ''}”吗？删除后无法撤销。
        </P>
        {#if deleteError}
            <P size="sm" class="text-red-500" role="alert">{deleteError}</P>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full justify-end gap-2">
            <Button color="light" onclick={() => (deleteOpen = false)} disabled={deleting}>
                取消
            </Button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-red-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={confirmDelete}
                disabled={deleting}
            >
                {deleting ? '删除中…' : '删除'}
            </button>
        </div>
    {/snippet}
</Modal>

<!-- 自动备份：启用配置 -->
<Modal
    bind:open={autoConfigOpen}
    title="启用自动备份"
    size="none"
    class="max-w-[calc(100vw-2rem)] sm:max-w-sm max-md:mt-4 max-md:mb-auto"
>
    <div class="flex flex-col gap-4">
        <P size="sm" class="text-[var(--fg-muted)]">
            {#if $baiduAutoState.storedPassphrase}
                将使用本机已加密保存的自动同步口令。
            {:else}
                请设置自动同步口令，至少 {MIN_PASSWORD_LENGTH} 位；忘记后自动备份将无法解密恢复。
            {/if}
        </P>

        {#if !$baiduAutoState.storedPassphrase}
            <div class="flex flex-col gap-1.5">
                <Label for="auto-passphrase" class="text-[15px] text-[var(--fg)]">
                    自动同步口令
                </Label>
                <div class="relative">
                    <input
                        id="auto-passphrase"
                        type={secretInputType(autoShowPassphrase)}
                        style={maskStyle(autoShowPassphrase)}
                        bind:value={autoPassphrase}
                        class="{INPUT_CLASS} pe-10"
                        placeholder="至少 {MIN_PASSWORD_LENGTH} 位"
                        {...SECRET_AUTOFILL}
                    />
                    <button
                        type="button"
                        class="absolute inset-y-0 end-0 grid w-10 place-items-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                        aria-label={autoShowPassphrase ? '隐藏口令' : '显示口令'}
                        onclick={() => (autoShowPassphrase = !autoShowPassphrase)}
                    >
                        <ha-icon
                            name={autoShowPassphrase ? 'eye-off' : 'eye'}
                            collection="lucide"
                            size="18"
                        ></ha-icon>
                    </button>
                </div>
            </div>

            <div class="flex flex-col gap-1.5">
                <Label for="auto-passphrase-confirm" class="text-[15px] text-[var(--fg)]">
                    确认口令
                </Label>
                <input
                    id="auto-passphrase-confirm"
                    type={secretInputType(autoShowPassphrase)}
                    style={maskStyle(autoShowPassphrase)}
                    bind:value={autoConfirm}
                    class={INPUT_CLASS}
                    placeholder="再次输入口令"
                    {...SECRET_AUTOFILL}
                />
            </div>
        {/if}

        <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-3">
                <span class="text-[15px] text-[var(--fg)]">
                    在本机加密保存口令（用于无人值守自动备份）
                </span>
                <Switch
                    checked={autoSavePassphrase}
                    ariaLabel="在本机加密保存口令"
                    onchange={(checked) => (autoSavePassphrase = checked)}
                />
            </div>
            {#if !autoSavePassphrase}
                <P size="sm" class="text-[var(--fg-subtle)]">
                    关闭后，每次打开应用需要手动解锁自动同步。
                </P>
            {/if}
        </div>

        <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-3">
                <span class="text-[15px] text-[var(--fg)]">双向同步（多设备）</span>
                <Switch
                    checked={autoSyncEnabled}
                    ariaLabel="双向同步（多设备）"
                    disabled={autoEnabling}
                    onchange={(checked) => (autoSyncEnabled = checked)}
                />
            </div>
            <P size="sm" class="text-[var(--fg-subtle)]">
                开启后会下载云端最新自动备份并与本机合并；删除会传播，冲突会保存为副本。首次开启前请确认云端备份属于同一份笔记。
            </P>
        </div>

        <div class="flex flex-col gap-1.5">
            <Label for="auto-interval-config" class="text-[15px] text-[var(--fg)]">
                自动备份周期
            </Label>
            <Select
                id="auto-interval-config"
                value={autoIntervalValue}
                onchange={onAutoIntervalChange}
                size="sm"
                aria-label="自动备份周期"
                disabled={autoEnabling}
            >
                {#each AUTO_INTERVAL_OPTIONS as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                {/each}
            </Select>
        </div>

        <div class="flex flex-col gap-1.5">
            <Label for="auto-keep-count-config" class="text-[15px] text-[var(--fg)]">
                保留份数
            </Label>
            <Select
                id="auto-keep-count-config"
                value={autoKeepCountValue}
                onchange={onAutoKeepCountChange}
                size="sm"
                aria-label="自动备份保留份数"
                disabled={autoEnabling}
            >
                {#each autoKeepOptions as option (option)}
                    <option value={option}>保留 {option} 份</option>
                {/each}
            </Select>
        </div>

        {#if autoConfigError}
            <P size="sm" class="text-red-500" role="alert">{autoConfigError}</P>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full justify-end gap-2">
            <Button color="light" onclick={() => (autoConfigOpen = false)} disabled={autoEnabling}>
                取消
            </Button>
            <button
                type="button"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={confirmEnableAuto}
                disabled={autoEnabling}
            >
                {autoEnabling ? '启用中…' : '启用'}
            </button>
        </div>
    {/snippet}
</Modal>
