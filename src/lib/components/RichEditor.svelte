<script>
    import { onMount, onDestroy } from 'svelte';
    import FluentEditor from '@opentiny/fluent-editor';

    // —— 工具栏图标映射 ——
    // 图标一律使用内联 lucide SVG，与应用其它图标同一套几何与描边宽度。
    // 同步、可靠、无外链依赖（避免异步图标组件在 innerHTML 注入下静默失败）。
    const SVG_IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>';
    const SVG_ERASER = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21" /><path d="m5.082 11.09 8.828 8.828" /></svg>';
    const SVG_LIST = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" /><path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" /></svg>';
    const SVG_LIST_ORDERED = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h10" /><path d="M11 12h10" /><path d="M11 19h10" /><path d="M4 4h1v5" /><path d="M4 9h2" /><path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02" /></svg>';
    const SVG_LIST_CHECKS = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5h8" /><path d="M13 12h8" /><path d="M13 19h8" /><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /></svg>';
    const SVG_QUOTE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" /><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" /></svg>';
    const SVG_HIGHLIGHTER = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3" /><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" /></svg>';
    const SVG_ALIGN_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H3" /><path d="M15 12H3" /><path d="M17 19H3" /></svg>';
    const SVG_ALIGN_CENTER = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H3" /><path d="M17 12H7" /><path d="M19 19H5" /></svg>';
    const SVG_ALIGN_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H3" /><path d="M21 12H9" /><path d="M21 19H7" /></svg>';
    const SVG_INDENT_DECREASE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H11" /><path d="M21 12H11" /><path d="M21 19H11" /><path d="m7 8-4 4 4 4" /></svg>';
    const SVG_INDENT_INCREASE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H11" /><path d="M21 12H11" /><path d="M21 19H11" /><path d="m3 8 4 4-4 4" /></svg>';
    const SVG_CHEVRON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>';
    const SVG_TRASH_2 = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>';

    const ICON_BY_NAME = {
        image: SVG_IMAGE,
        clean: SVG_ERASER,
        bold: '<b>B</b>',
        italic: '<i>I</i>',
        underline: '<u>U</u>',
        strike: '<s>S</s>',
        blockquote: SVG_QUOTE,
        background: SVG_HIGHLIGHTER,
        more: SVG_CHEVRON_DOWN,
        delete: SVG_TRASH_2
    };
    const ICON_HEADER = { '1': 'H<sub>1</sub>', '2': 'H<sub>2</sub>', '3': 'H<sub>3</sub>' };
    const ICON_LIST = {
        bullet: SVG_LIST,
        ordered: SVG_LIST_ORDERED,
        check: SVG_LIST_CHECKS
    };
    const ICON_ALIGN = {
        '': SVG_ALIGN_LEFT,
        center: SVG_ALIGN_CENTER,
        right: SVG_ALIGN_RIGHT
    };
    const ICON_INDENT = { '-1': SVG_INDENT_DECREASE, '+1': SVG_INDENT_INCREASE };

    let {
        value = '',
        placeholder = '在此输入内容…',
        onchange = undefined,
        ondelete = undefined,
        class: className = '',
        title = undefined
    } = $props();

    let wrapperEl;
    let toolbarEl;
    let container;
    let editor = null;

    // 停靠状态
    let focused = false;
    let docked = false;
    let rafId = 0;
    let settleTimers = [];
    let vv;
    let onViewportChange;
    let onOrientationChange;

    /** 键盘闭合时的视觉视口高度基准（兼容 resizes-content：布局视口会随键盘收缩） */
    let baseVisualHeight = 0;

    const KEYBOARD_THRESHOLD = 120;

    function isNarrow() {
        return window.matchMedia('(max-width: 1023px)').matches;
    }

    /** 当前视觉视口高度（无 visualViewport 时回退布局视口） */
    function visualHeight() {
        const visual = window.visualViewport;
        return visual ? visual.height : window.innerHeight || document.documentElement.clientHeight;
    }

    /**
     * 键盘遮挡高度。
     * 兼容两种 interactive-widget 模式：
     *   · resizes-visual ：布局视口不变、视觉视口收缩 → base - 当前视觉高度 = 键盘高度
     *   · resizes-content：布局视口与视觉视口同时收缩 → 上式同样成立；
     *                       并由 inner - visual.height - offsetTop 兜底（旧式计算）。
     */
    function keyboardInset() {
        const visual = window.visualViewport;
        const inner = window.innerHeight || document.documentElement.clientHeight;
        const current = visual ? visual.height : inner;
        const base = baseVisualHeight || inner;
        const byVisual = Math.max(0, base - current);
        const byLayout = visual ? Math.max(0, inner - visual.height - visual.offsetTop) : 0;
        return Math.max(byVisual, byLayout);
    }

    function applyDock() {
        if (!wrapperEl || !toolbarEl || !container) return;

        // 以「观察到过的最大视觉高度」作为键盘闭合基准（单调递增，避免基准被键盘态/时序污染）
        baseVisualHeight = Math.max(baseVisualHeight, visualHeight());

        const inset = keyboardInset();
        const shouldDock = isNarrow() && focused && inset > KEYBOARD_THRESHOLD;

        if (shouldDock) {
            const rect = wrapperEl.getBoundingClientRect();
            const visual = window.visualViewport;
            const inner = window.innerHeight || document.documentElement.clientHeight;
            // 视觉视口底边相对布局视口的纵坐标（两种 interactive-widget 模式下均指向键盘顶端）
            const vvBottom = visual ? visual.offsetTop + visual.height : inner;

            // ① 先切换为可见（移除窄屏 display:none），并打好定位基准
            toolbarEl.style.position = 'fixed';
            toolbarEl.style.left = `${rect.left}px`;
            toolbarEl.style.width = `${rect.width}px`;
            toolbarEl.style.bottom = 'auto';
            toolbarEl.style.zIndex = '40';
            toolbarEl.classList.add('ql-mobile-docked');

            // ② 可见之后再测量高度，避免测到 0（同步读取会触发一次 reflow）
            const toolbarHeight = toolbarEl.offsetHeight;

            // ③ 依据视觉视口几何精确贴合键盘顶端
            toolbarEl.style.top = `${Math.max(0, vvBottom - toolbarHeight)}px`;
            container.style.paddingBottom = `${toolbarHeight}px`;
            docked = true;
        } else if (docked) {
            resetDock();
        }
    }

    /** 清理已排定的「键盘落定」兜底定时器，防止堆积 */
    function clearSettleTimers() {
        settleTimers.forEach((id) => clearTimeout(id));
        settleTimers = [];
    }

    /** 键盘动画期间视口尺寸可能尚未稳定；补两次落定重算，避免首次不显示 */
    function scheduleSettle() {
        clearSettleTimers();
        settleTimers.push(setTimeout(() => applyDock(), 250));
        settleTimers.push(setTimeout(() => applyDock(), 500));
    }

    function resetDock() {
        if (toolbarEl) {
            toolbarEl.style.position = '';
            toolbarEl.style.left = '';
            toolbarEl.style.width = '';
            toolbarEl.style.bottom = '';
            toolbarEl.style.top = '';
            toolbarEl.style.zIndex = '';
            toolbarEl.classList.remove('ql-mobile-docked');
        }
        if (container) container.style.paddingBottom = '';
        docked = false;
    }

    function schedule() {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(applyDock);
    }

    /** 构造完成后重绘工具栏图标，避免被 FluentEditor 内置图标表覆盖 */
    function paintToolbarIcons() {
        if (!toolbarEl) return;
        toolbarEl.querySelectorAll('button').forEach((btn) => {
            const cls = Array.from(btn.classList).find((c) => c.startsWith('ql-'));
            if (!cls) return;
            const name = cls.slice(3);
            const value = btn.getAttribute('value') || '';
            let html = null;
            if (name === 'header') html = ICON_HEADER[value];
            else if (name === 'list') html = ICON_LIST[value];
            else if (name === 'align') html = ICON_ALIGN[value];
            else if (name === 'indent') html = ICON_INDENT[value];
            else html = ICON_BY_NAME[name];
            if (html != null) btn.innerHTML = html;
        });
    }

    onMount(() => {
        editor = new FluentEditor(container, {
            theme: 'snow',
            placeholder,
            i18n: { lang: 'zh-CN' },
            modules: {
                toolbar: { container: toolbarEl }
            }
        });

        // 构造完成后立即重绘图标（此时 buildButtons 已执行，且不会再被覆盖）
        paintToolbarIcons();

        if (value) {
            editor.root.innerHTML = value;
        }

        // 仅在用户输入时回调；忽略 api/silent 变更，避免初始化与程序化赋值触发自动保存
        editor.on('text-change', (delta, oldDelta, source) => {
            if (source === 'user') {
                onchange?.(editor.root.innerHTML);
            }
        });

        // 选区变化：有选区=聚焦，null=失焦
        editor.on('selection-change', (range) => {
            focused = Boolean(range);
            // 每次聚焦/失焦先清理旧的落定定时器，避免堆积
            clearSettleTimers();
            schedule();
            if (focused) {
                // 键盘动画期间视口尺寸可能尚未稳定；补两次落定重算，避免首次不显示
                scheduleSettle();
            }
        });

        // —— 自定义工具栏 handler ——
        // 在初始化后用 addHandler 注册，避免依赖未注册的模块/格式
        try {
            const toolbar = editor.getModule('toolbar');
            if (toolbar) {
                // 删除笔记：交由父级处理实际删除
                toolbar.addHandler('delete', () => ondelete?.());

                // 插入图片：选择本地图片 → DataURL → 插入 image embed
                toolbar.addHandler('image', () => {
                    try {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.style.display = 'none';
                        input.addEventListener('change', () => {
                            const file = input.files && input.files[0];
                            if (!file) {
                                input.remove();
                                return;
                            }
                            const reader = new FileReader();
                            reader.onload = () => {
                                try {
                                    const range = editor.getSelection(true) || {
                                        index: editor.getLength(),
                                        length: 0
                                    };
                                    const index = range.index;
                                    editor.insertEmbed(index, 'image', reader.result, 'user');
                                    editor.setSelection(index + 1, 0);
                                } catch (e) {
                                    window.alert('插入图片失败：' + (e?.message || e));
                                } finally {
                                    input.remove();
                                }
                            };
                            reader.onerror = () => {
                                window.alert(
                                    '插入图片失败：' + (reader.error?.message || reader.error)
                                );
                                input.remove();
                            };
                            reader.readAsDataURL(file);
                        });
                        document.body.appendChild(input);
                        input.click();
                    } catch (e) {
                        window.alert('插入图片失败：' + (e?.message || e));
                    }
                });

                // 高亮开关：已高亮则取消，否则套用浅黄
                toolbar.addHandler('background', () => {
                    try {
                        const range = editor.getSelection(true);
                        const format = editor.getFormat(range) || {};
                        if (format.background) {
                            editor.format('background', false, 'user');
                        } else {
                            editor.format('background', '#FEF3C7', 'user');
                        }
                    } catch (e) {
                        window.alert('设置高亮失败：' + (e?.message || e));
                    }
                });

                // 「更多」为占位按钮，暂不处理
                toolbar.addHandler('more', () => {});

                // Quill 在初始化 attach 时会跳过未注册格式的按钮（more/delete），此处补挂一次
                if (typeof toolbar.attach === 'function' && Array.isArray(toolbar.controls)) {
                    const attached = new Set(toolbar.controls.map((pair) => pair[1]));
                    toolbarEl.querySelectorAll('button').forEach((btn) => {
                        if (!attached.has(btn)) {
                            try {
                                toolbar.attach(btn);
                            } catch (_) {
                                // 忽略补挂异常
                            }
                        }
                    });
                }
            }
        } catch (e) {
            // 缺少 toolbar 模块时容错，避免整页崩溃
            console.warn('工具栏 handler 注册失败：', e);
        }

        baseVisualHeight = visualHeight();
        vv = window.visualViewport;
        onViewportChange = () => schedule();
        // 旋转会重建布局视口与视觉视口，需先重置基准再重算停靠
        onOrientationChange = () => {
            baseVisualHeight = 0;
            schedule();
        };
        if (vv) {
            vv.addEventListener('resize', onViewportChange);
            vv.addEventListener('scroll', onViewportChange);
        }
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('orientationchange', onOrientationChange);
    });

    onDestroy(() => {
        cancelAnimationFrame(rafId);
        clearSettleTimers();
        if (vv && onViewportChange) {
            vv.removeEventListener('resize', onViewportChange);
            vv.removeEventListener('scroll', onViewportChange);
        }
        if (onViewportChange) {
            window.removeEventListener('resize', onViewportChange);
        }
        if (onOrientationChange) {
            window.removeEventListener('orientationchange', onOrientationChange);
        }
        resetDock();
        try {
            editor?.destroy?.();
        } catch (_) {
            // 忽略销毁异常（不同版本销毁 API 可能缺失）
        }
        editor = null;
    });
</script>

<div bind:this={wrapperEl} class="flex h-full min-h-0 flex-col overflow-hidden px-6 {className}">
    <div class="mx-auto flex min-h-0 w-full max-w-[1060px] flex-1 flex-col">
        <!-- 自定义工具栏：固定在编辑区顶部（flex-none）；停靠键盘时为 fixed（见 editor-overrides.css） -->
        <div bind:this={toolbarEl} class="flex-none" aria-label="编辑器工具栏">
            <button class="ql-image" aria-label="插入图片"></button>
            <span class="ql-toolbar-divider" aria-hidden="true"></span>
            <button class="ql-clean" aria-label="清除格式"></button>
            <button class="ql-header" value="1" aria-label="标题 1"></button>
            <button class="ql-header" value="2" aria-label="标题 2"></button>
            <button class="ql-header" value="3" aria-label="标题 3"></button>
            <button class="ql-bold" aria-label="加粗"></button>
            <button class="ql-italic" aria-label="斜体"></button>
            <button class="ql-underline" aria-label="下划线"></button>
            <button class="ql-list" value="check" aria-label="任务列表"></button>
            <button class="ql-strike" aria-label="删除线"></button>
            <button class="ql-list" value="bullet" aria-label="无序列表"></button>
            <button class="ql-list" value="ordered" aria-label="有序列表"></button>
            <button class="ql-blockquote" aria-label="引用"></button>
            <button class="ql-background" aria-label="高亮"></button>
            <button class="ql-align" value="" aria-label="左对齐"></button>
            <button class="ql-align" value="center" aria-label="居中"></button>
            <button class="ql-align" value="right" aria-label="右对齐"></button>
            <button class="ql-indent" value="-1" aria-label="减少缩进"></button>
            <button class="ql-indent" value="+1" aria-label="增加缩进"></button>
            <div class="ms-auto flex items-center">
                <button class="ql-delete" aria-label="删除笔记"></button>
            </div>
        </div>
        <div class="rte-divider h-px w-full flex-none bg-[var(--divider)]"></div>
        {#if title}
            {@render title()}
        {/if}
        <div bind:this={container} class="min-h-0 flex-1"></div>
    </div>
</div>
