<script>
    import { onMount } from 'svelte';
    import { Heading, P } from 'flowbite-svelte';
    import { unlock } from '../stores/security.js';
    import { maskStyle, secretInputType } from '../utils/secretInput.js';

    /** 密码输入值 */
    let password = $state('');
    /** 是否明文显示密码 */
    let showPassword = $state(false);
    /** 错误提示文案 */
    let error = $state('');
    /** 校验进行中标记（避免重复提交） */
    let checking = $state(false);
    /** 输入框元素引用（失败后重新聚焦） */
    let inputEl = $state();

    /** 提交解锁：按钮点击或回车触发 */
    async function submit() {
        if (checking) return;
        checking = true;
        error = '';
        try {
            const ok = await unlock(password);
            if (!ok) {
                error = '密码错误，请重试';
                password = '';
                inputEl?.focus();
            }
        } catch {
            error = '密码错误，请重试';
            password = '';
            inputEl?.focus();
        } finally {
            checking = false;
        }
    }

    onMount(() => {
        inputEl?.focus();
    });
</script>

<div class="fixed inset-0 z-[100] grid place-items-center bg-[var(--canvas)] px-4">
    <div
        class="w-full max-w-[380px] rounded-2xl bg-[var(--card)] p-6 shadow-[var(--card-shadow)] sm:p-8"
    >
        <div class="flex flex-col items-center gap-1 text-center">
            <span
                class="grid h-12 w-12 place-items-center rounded-full bg-[var(--row-active)] text-[var(--fg-muted)]"
            >
                <ha-icon name="lock" collection="lucide" size="22"></ha-icon>
            </span>
            <Heading tag="h1" class="mt-3 text-xl font-semibold text-[var(--fg)]">已锁定</Heading>
            <P size="sm" class="text-[var(--fg-muted)]">请输入密码以进入 TMPLNote</P>
        </div>

        <div class="mt-6 flex flex-col gap-2">
            <div class="relative">
                <input
                    bind:this={inputEl}
                    bind:value={password}
                    type={secretInputType(showPassword)}
                    style={maskStyle(showPassword)}
                    class="w-full rounded-lg border border-[var(--divider)] bg-[var(--field)] py-2.5 ps-3 pe-10 text-sm text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)] focus:border-primary-500"
                    placeholder="密码"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    data-lpignore="true"
                    data-1p-ignore
                    data-form-type="other"
                    data-bwignore="true"
                    aria-label="密码"
                    onkeydown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            submit();
                        }
                    }}
                />
                <button
                    type="button"
                    class="absolute inset-y-0 end-0 grid w-10 place-items-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    onclick={() => (showPassword = !showPassword)}
                >
                    <ha-icon name={showPassword ? 'eye-off' : 'eye'} collection="lucide" size="18"></ha-icon>
                </button>
            </div>
            {#if error}
                <P size="sm" role="alert" class="text-red-500 dark:text-red-400">{error}</P>
            {/if}
        </div>

        <button
            type="button"
            onclick={submit}
            class="mt-5 w-full rounded-lg bg-primary-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={checking}
        >
            解锁
        </button>
    </div>
</div>
