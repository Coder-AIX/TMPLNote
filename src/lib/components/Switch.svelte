<script>
    /**
     * Switch —— 轻量开关（原生 button[role=switch]）
     * 不使用隐藏 input，避免移动端点击/聚焦时页面滚动跳动。
     * @type {{
     *   checked?: boolean,
     *   disabled?: boolean,
     *   ariaLabel?: string,
     *   onchange?: (checked: boolean) => void,
     *   class?: string
     * }}
     */
    let {
        checked = false,
        disabled = false,
        ariaLabel = '开关',
        onchange = () => {},
        class: className = ''
    } = $props();

    /** 切换状态并回调新值 */
    function toggle() {
        if (disabled) return;
        onchange(!checked);
    }
</script>

<button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    {disabled}
    class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors
           {checked ? 'bg-primary-600' : 'bg-[var(--divider)]'}
           {disabled ? 'cursor-not-allowed opacity-50' : ''} {className}"
    onclick={toggle}
>
    <span
        class="pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform
               {checked ? 'translate-x-[22px]' : 'translate-x-0.5'}"
    ></span>
</button>
