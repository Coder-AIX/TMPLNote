<script>
    import { untrack } from 'svelte';
    import { Heading, P, Label, Modal } from 'flowbite-svelte';
    import Switch from '../components/Switch.svelte';
    import SelectMenu from '../components/SelectMenu.svelte';
    import { toggleSidebar } from '../stores/layout.js';
    import { settings, resolvedDark, updateSetting } from '../stores/settings.js';
    import { enableEncryption, disableEncryption } from '../stores/security.js';
    import { maskStyle, secretInputType } from '../utils/secretInput.js';
    import TemplateSection from '../components/TemplateSection.svelte';
    import DataSection from '../components/DataSection.svelte';
    import CloudSection from '../components/CloudSection.svelte';
    import AiSection from '../components/AiSection.svelte';

    let { params } = $props();

    /** 分区导航定义 */
    const SECTIONS = [
        { id: 'system', label: '系统', icon: 'settings-2' },
        { id: 'ai', label: 'AI', icon: 'sparkles' },
        { id: 'templates', label: '模板', icon: 'layout-template' },
        { id: 'data', label: '数据', icon: 'database' },
        { id: 'cloud', label: '网盘', icon: 'cloud' },
        { id: 'about', label: '关于', icon: 'info' }
    ];

    const SECTION_IDS = SECTIONS.map((item) => item.id);

    /** 关于分区：主要能力列表 */
    const CAPABILITIES = ['文件夹与笔记管理', '富文本编辑', '模板笔记', '本地 AI 对话（WebGPU / GGUF）', '百度网盘加密存档'];

    /** 当前分区 */
    let section = $state('system');

    // 路由参数变化时同步分区（例如从模板编辑页返回 /settings/templates）
    $effect(() => {
        const target = params?.section;
        if (!SECTION_IDS.includes(target)) return;
        untrack(() => {
            if (target !== section) section = target;
        });
    });

    // 控件镜像：配合 bind 使用，保证控件与持久化状态始终一致
    let language = $state($settings.language);
    let followSystem = $state($settings.followSystem);
    let dark = $state($settings.followSystem ? $resolvedDark : $settings.dark);

    // 外部状态变化（如异步载入设置、跟随系统时系统主题切换）时同步镜像
    $effect(() => {
        language = $settings.language;
        followSystem = $settings.followSystem;
    });
    $effect(() => {
        dark = $settings.followSystem ? $resolvedDark : $settings.dark;
    });

    // 加密开关镜像：真实状态以设置为准；开启需先设密码，确认前不落库
    let encryptionEnabled = $state($settings.encryptionEnabled);

    // 设置密码弹窗：输入与错误状态
    let showPasswordModal = $state(false);
    let newPassword = $state('');
    let confirmPassword = $state('');
    let passwordError = $state('');
    let showNewPassword = $state(false);
    let showConfirmPassword = $state(false);

    // 外部状态变化时同步镜像
    $effect(() => {
        encryptionEnabled = $settings.encryptionEnabled;
    });

    // 弹窗关闭（取消 / ESC / 点击遮罩）时，未落库的开启意图回滚为真实状态
    $effect(() => {
        if (!showPasswordModal) {
            encryptionEnabled = $settings.encryptionEnabled;
        }
    });

    /** 加密开关变更：开启则弹窗等待设置密码，关闭则直接清除凭据 */
    async function onEncryptionToggle(checked) {
        if (checked) {
            newPassword = '';
            confirmPassword = '';
            passwordError = '';
            showPasswordModal = true;
        } else {
            await disableEncryption();
        }
    }

    /** 取消设置密码：仅关闭弹窗，不改变设置（开关回落到未启用） */
    function cancelPasswordSetup() {
        showPasswordModal = false;
    }

    /** 确认设置密码：校验通过后启用加密 */
    async function confirmPasswordSetup() {
        if (!newPassword) {
            passwordError = '请输入新密码。';
            return;
        }
        if (newPassword.length < 4) {
            passwordError = '密码至少需要 4 位。';
            return;
        }
        if (newPassword !== confirmPassword) {
            passwordError = '两次输入的密码不一致。';
            return;
        }
        passwordError = '';
        await enableEncryption(newPassword);
        newPassword = '';
        confirmPassword = '';
        showPasswordModal = false;
    }

    /** 分区导航项类名（激活态用导航令牌，未激活用弱化文字 + hover 行高亮） */
    function navClass(active) {
        const base =
            'inline-flex h-10 shrink-0 items-center justify-center gap-3 rounded-[10px] px-3.5 text-[15px] transition-colors lg:w-full lg:justify-start';
        return active
            ? `${base} bg-[var(--nav-active-bg)] font-medium text-[var(--nav-active-fg)]`
            : `${base} text-[var(--fg-muted)] hover:bg-[var(--row-active)]`;
    }
</script>

<div class="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
    <div class="mx-auto max-w-4xl">
        <header class="flex flex-col gap-1 px-1">
            <div class="flex items-center gap-1.5">
                <button
                    type="button"
                    class="-ms-2 grid h-8 w-8 shrink-0 place-items-center text-[var(--fg-muted)] lg:hidden"
                    aria-label="打开侧边栏"
                    onclick={toggleSidebar}
                >
                    <ha-icon name="menu" collection="lucide" size="22"></ha-icon>
                </button>
                <Heading tag="h1" class="text-2xl font-bold text-[var(--fg)]">设置</Heading>
            </div>
            <P size="sm" class="text-[var(--fg-muted)]">管理应用偏好、模板与关于信息。</P>
        </header>

        <div class="mt-5 flex flex-col gap-5 lg:flex-row lg:gap-6">
            <!-- 分区导航：桌面端竖向，移动端横向分段 -->
            <nav
                class="flex flex-wrap gap-1.5 lg:w-44 lg:flex-none lg:flex-col"
                aria-label="设置分区"
            >
                {#each SECTIONS as item (item.id)}
                    <button
                        type="button"
                        class={navClass(section === item.id)}
                        aria-current={section === item.id ? 'page' : undefined}
                        onclick={() => (section = item.id)}
                    >
                        <ha-icon name={item.icon} collection="lucide" size="18"></ha-icon>
                        <span class="whitespace-nowrap">{item.label}</span>
                    </button>
                {/each}
            </nav>

            <!-- 内容卡片 -->
            <div
                class="min-w-0 flex-1 rounded-2xl bg-[var(--card)] p-5 shadow-[var(--card-shadow)] sm:p-6"
            >
                {#if section === 'system'}
                    <Heading tag="h2" class="text-lg font-semibold text-[var(--fg)]">系统</Heading>

                    <div class="mt-4 flex flex-col divide-y divide-[var(--divider)]">
                        <!-- 语言 -->
                        <div
                            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                        >
                            <div class="flex min-w-0 flex-col gap-0.5">
                                <Label class="text-[15px] text-[var(--fg)]">语言</Label>
                                <P size="sm" class="text-[var(--fg-muted)]">
                                    界面多语言将在后续版本提供。
                                </P>
                            </div>
                            <SelectMenu
                                value={language}
                                options={[
                                    { value: 'zh-CN', label: '简体中文' },
                                    { value: 'en', label: 'English' }
                                ]}
                                ariaLabel="语言"
                                class="w-full sm:w-44"
                                onchange={(v) => {
                                    language = v;
                                    updateSetting('language', v);
                                }}
                            />
                        </div>

                        <!-- 跟随系统 -->
                        <div
                            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                        >
                            <div class="flex min-w-0 flex-col gap-0.5">
                                <Label class="text-[15px] text-[var(--fg)]">跟随系统</Label>
                                <P size="sm" class="text-[var(--fg-muted)]">明暗主题跟随系统。</P>
                            </div>
                            <Switch
                                checked={followSystem}
                                ariaLabel="跟随系统"
                                onchange={(v) => {
                                    followSystem = v;
                                    updateSetting('followSystem', v);
                                }}
                            />
                        </div>

                        <!-- 暗色模式 -->
                        <div
                            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                        >
                            <div class="flex min-w-0 flex-col gap-0.5">
                                <Label class="text-[15px] text-[var(--fg)]">暗色模式</Label>
                                <P size="sm" class="text-[var(--fg-muted)]">
                                    {#if $settings.followSystem}
                                        已跟随系统（由系统主题决定）。
                                    {:else}
                                        手动控制深色外观。
                                    {/if}
                                </P>
                            </div>
                            <Switch
                                checked={dark}
                                disabled={$settings.followSystem}
                                ariaLabel="暗色模式"
                                onchange={(v) => {
                                    dark = v;
                                    updateSetting('dark', v);
                                }}
                            />
                        </div>

                        <!-- 加密（访问锁） -->
                        <div
                            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                        >
                            <div class="flex min-w-0 flex-col gap-0.5">
                                <Label class="text-[15px] text-[var(--fg)]">加密</Label>
                                <P size="sm" class="text-[var(--fg-muted)]">
                                    启用后每次进入应用需要输入密码。
                                </P>
                            </div>
                            <Switch
                                checked={encryptionEnabled}
                                ariaLabel="加密"
                                onchange={(v) => {
                                    encryptionEnabled = v;
                                    onEncryptionToggle(v);
                                }}
                            />
                        </div>

                        <!-- 最近删除保留天数 -->
                        <div
                            class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                        >
                            <div class="flex min-w-0 flex-col gap-0.5">
                                <Label class="text-[15px] text-[var(--fg)]">最近删除保留</Label>
                                <P size="sm" class="text-[var(--fg-muted)]">
                                    超过保留天数的笔记将被自动彻底删除。
                                </P>
                            </div>
                            <SelectMenu
                                value={String($settings.trashRetentionDays ?? 30)}
                                options={[
                                    { value: '7', label: '7 天' },
                                    { value: '15', label: '15 天' },
                                    { value: '30', label: '30 天' },
                                    { value: '60', label: '60 天' },
                                    { value: '90', label: '90 天' },
                                    { value: '0', label: '永久保留' }
                                ]}
                                ariaLabel="最近删除保留天数"
                                class="w-full sm:w-44"
                                onchange={(v) => updateSetting('trashRetentionDays', Number(v))}
                            />
                        </div>
                    </div>
                {:else if section === 'templates'}
                    <TemplateSection />
                {:else if section === 'data'}
                    <DataSection />
                {:else if section === 'cloud'}
                    <CloudSection />
                {:else if section === 'ai'}
                    <AiSection />
                {:else}
                    <div class="flex flex-col gap-4">
                        <Heading tag="h2" class="text-lg font-semibold text-[var(--fg)]">
                            关于 TMPLNote
                        </Heading>

                        <P class="text-[15px] leading-relaxed text-[var(--fg)]">
                            TMPLNote 是一款带模板与 AI 的离线笔记应用。
                        </P>

                        <P size="sm" class="leading-relaxed text-[var(--fg-muted)]">
                            数据全部保存在本地（IndexedDB），无需联网即可使用，并支持 PWA
                            离线访问。
                        </P>

                        <div class="flex flex-col gap-2">
                            <span class="text-sm font-medium text-[var(--fg)]">主要能力</span>
                            <ul class="flex flex-col gap-1.5">
                                {#each CAPABILITIES as capability (capability)}
                                    <li
                                        class="flex items-center gap-2 text-sm text-[var(--fg-muted)]"
                                    >
                                        <ha-icon
                                            name="check"
                                            collection="lucide"
                                            size="15"
                                            class="shrink-0 text-primary-500"
                                        ></ha-icon>
                                        <span>{capability}</span>
                                    </li>
                                {/each}
                            </ul>
                        </div>

                        <div
                            class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--divider)] pt-3 text-xs text-[var(--fg-subtle)]"
                        >
                            <span>版本 v0.1.0</span>
                            <span aria-hidden="true">·</span>
                            <span>Svelte 5 + Tailwind CSS + IndexedDB</span>
                        </div>
                    </div>
                {/if}
            </div>
        </div>
    </div>
</div>

<!-- 设置密码弹窗：开启加密时使用 -->
<Modal
    bind:open={showPasswordModal}
    title="设置密码"
    size="none"
    class="max-w-[calc(100vw-2rem)] sm:max-w-sm max-md:mt-4 max-md:mb-auto"
>
    <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
            <Label for="encryption-secret" class="text-[15px] text-[var(--fg)]">新密码</Label>
            <div class="relative">
                <input
                    id="encryption-secret"
                    type={secretInputType(showNewPassword)}
                    style={maskStyle(showNewPassword)}
                    bind:value={newPassword}
                    class="w-full rounded-lg border border-[var(--divider)] bg-[var(--field)] py-2.5 ps-3 pe-10 text-sm text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)] focus:border-primary-500"
                    placeholder="至少 4 位"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    data-bwignore="true"
                    data-lpignore="true"
                    data-1p-ignore
                    data-form-type="other"
                />
                <button
                    type="button"
                    class="absolute inset-y-0 end-0 grid w-10 place-items-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    aria-label={showNewPassword ? '隐藏密码' : '显示密码'}
                    onclick={() => (showNewPassword = !showNewPassword)}
                >
                    <ha-icon
                        name={showNewPassword ? 'eye-off' : 'eye'}
                        collection="lucide"
                        size="18"
                    ></ha-icon>
                </button>
            </div>
        </div>

        <div class="flex flex-col gap-1.5">
            <Label for="encryption-secret-confirm" class="text-[15px] text-[var(--fg)]">
                确认密码
            </Label>
            <div class="relative">
                <input
                    id="encryption-secret-confirm"
                    type={secretInputType(showConfirmPassword)}
                    style={maskStyle(showConfirmPassword)}
                    bind:value={confirmPassword}
                    class="w-full rounded-lg border border-[var(--divider)] bg-[var(--field)] py-2.5 ps-3 pe-10 text-sm text-[var(--fg)] outline-none placeholder:text-[var(--fg-subtle)] focus:border-primary-500"
                    placeholder="再次输入密码"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    data-bwignore="true"
                    data-lpignore="true"
                    data-1p-ignore
                    data-form-type="other"
                />
                <button
                    type="button"
                    class="absolute inset-y-0 end-0 grid w-10 place-items-center text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                    aria-label={showConfirmPassword ? '隐藏密码' : '显示密码'}
                    onclick={() => (showConfirmPassword = !showConfirmPassword)}
                >
                    <ha-icon
                        name={showConfirmPassword ? 'eye-off' : 'eye'}
                        collection="lucide"
                        size="18"
                    ></ha-icon>
                </button>
            </div>
        </div>

        {#if passwordError}
            <P size="sm" class="text-red-500" role="alert">{passwordError}</P>
        {/if}
    </div>

    {#snippet footer()}
        <div class="flex w-full justify-end gap-2">
            <button
                type="button"
                class="rounded-lg border border-[var(--divider)] px-4 py-2 text-sm text-[var(--fg)] hover:bg-[var(--row-active)]"
                onclick={cancelPasswordSetup}
            >
                取消
            </button>
            <button
                type="button"
                class="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600"
                onclick={confirmPasswordSetup}
            >
                确定
            </button>
        </div>
    {/snippet}
</Modal>
