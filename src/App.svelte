<script>
    import { onMount } from 'svelte';
    import AppLayout from './lib/layout/AppLayout.svelte';
    import LockScreen from './lib/components/LockScreen.svelte';
    import { locked, encryptionEnabled, initLock } from './lib/stores/security.js';
    import { startTrashPurge } from './lib/utils/trashScheduler.js';
    import { autoLoadCachedModel } from './lib/stores/ai.js';
    import { initBaiduAutoSync } from './lib/stores/baiduAuto.js';

    let ready = $state(false);

    onMount(async () => {
        await initLock();
        startTrashPurge();
        ready = true;
        // 若浏览器缓存中已有模型，自动载入（不阻塞首屏）
        autoLoadCachedModel();
        // 初始化自动备份调度（不 await，不阻塞首屏；是否运行由 store 结合锁定态判断）
        initBaiduAutoSync().catch(() => {});
    });
</script>

{#if !ready}
    <div class="grid h-dvh place-items-center bg-[var(--canvas)] text-[var(--fg-muted)]">
        <span class="text-sm">加载中…</span>
    </div>
{:else if $encryptionEnabled && $locked}
    <LockScreen />
{:else}
    <AppLayout />
{/if}
