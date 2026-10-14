<script>
    // 全局：AI 写操作授权弹窗。由 AppLayout 挂载。
    import { Modal, Button, P } from 'flowbite-svelte';
    import { permissionRequest, allowPermission, denyPermission } from '../stores/aiPermission.js';

    /** 弹窗开关（与 permissionRequest 同步） */
    let open = $state(false);

    // 有请求则打开
    $effect(() => {
        open = Boolean($permissionRequest);
    });

    // 关闭弹窗（取消 / ESC / 点击遮罩）但仍有未决请求 → 视为拒绝
    $effect(() => {
        if (!open && $permissionRequest) denyPermission();
    });
</script>

<Modal bind:open title="AI 请求授权" size="none" class="max-w-[calc(100vw-2rem)] sm:max-w-md max-md:mt-4 max-md:mb-auto">
    {#if $permissionRequest}
        <div class="flex flex-col gap-3">
            <P class="text-[15px] text-[var(--fg)]">{$permissionRequest.title}</P>
            {#if $permissionRequest.detail}
                <P size="sm" class="whitespace-pre-wrap break-words text-[var(--fg-muted)]">{$permissionRequest.detail}</P>
            {/if}
            <P size="sm" class="text-[var(--fg-subtle)]">是否允许 AI 执行该操作？</P>
        </div>
    {/if}

    {#snippet footer()}
        <div class="flex w-full justify-end gap-2">
            <Button color="light" onclick={denyPermission}>拒绝</Button>
            <Button onclick={allowPermission}>允许</Button>
        </div>
    {/snippet}
</Modal>
