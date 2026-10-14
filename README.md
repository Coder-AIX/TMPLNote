<div align="center">

# TMPLNote

**带模板与 AI 的离线优先笔记应用（PWA）**

[![License: Personal-Use Only / Non-Commercial](https://img.shields.io/badge/License-Personal--Use_Only_%2F_Non--Commercial-red)](./README.md)
[![Svelte 5](https://img.shields.io/badge/Svelte-5-FF3E00)](https://svelte.dev)
[![Vite 6](https://img.shields.io/badge/Vite-6-646CFF)](https://vite.dev)
[![Tailwind CSS 4](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4)](https://tailwindcss.com)
[![PWA](https://img.shields.io/badge/PWA-offline--ready-5A0FC8)](https://web.dev/progressive-web-apps/)
[![Local AI](https://img.shields.io/badge/Local_AI-WebGPU-4B5563)](https://github.com/wllama/wllama)

版本 `v0.1.0`

在线体验：**<https://coder-aix.github.io/TMPLNote/>**

</div>

---

> **许可提示**
>
> 本项目**个人免费使用，禁止商用**。任何商业用途（包括但不限于将本项目或其衍生作品用于商业产品、付费服务、企业内部盈利性场景）均需事先获得作者书面授权。详见文末[许可协议](#许可协议)章节。

---

## 目录

- [亮点](#亮点)
- [离线优先](#离线优先)
- [本地 AI](#本地-ai)
- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [部署到 GitHub Pages](#部署到-github-pages)
- [AI 模型获取与使用](#ai-模型获取与使用)
- [数据与隐私](#数据与隐私)
- [目录结构](#目录结构)
- [许可协议](#许可协议)

## 亮点

- **离线优先**：笔记、文件夹、模板与设置全部保存在本地浏览器（IndexedDB），无需账号、不依赖网络，断网也能完整使用。
- **本地 AI**：内置基于 WebGPU + GGUF 的本地小模型推理，对话数据不出设备；AI 智能体还能读取与新建你的本地笔记。

## 离线优先

TMPLNote 是一个渐进式 Web 应用（PWA）。所有核心数据都存放在浏览器本地的 IndexedDB 中，应用本身通过 Service Worker 预缓存，安装后可完全离线运行。

- 数据只写入本地浏览器，不经过任何服务器。
- 无需登录，不上传内容。
- 安装到桌面后可作为独立应用启动，断网可正常编辑与查阅。

## 本地 AI

TMPLNote 内置本地 AI 对话能力，模型在你的设备上运行，推理过程与对话内容都不离开本机。

- **本地推理**：基于 `@wllama/wllama`，通过 **WebGPU** 加载 **GGUF** 格式的本地小模型进行离线推理。
- **隐私**：对话历史保存在独立的本地数据库，内容不发送到任何服务器。
- **Agent 工具调用**：AI 智能体可读取本地笔记、新建本地笔记。
- **写操作授权**：所有写操作（如新建笔记）都会强制弹出授权确认；拒绝后不会执行。
- **上下文长度可调**：4096 – 51200。
- **性能模式**：GPU 全层加速 / CPU 全速 / CPU 半速。
- **模型存储方式可选**：缓存到浏览器，或仅在本次会话中使用。
- **灵活导入**：支持导入任意本地 GGUF 模型文件，同一时刻仅载入一个模型。
- **推荐模型**：来自 Hugging Face 镜像 `hf-mirror.com`，仓库为 `unsloth/Qwen3.5-0.8B-GGUF`（PC 推荐 Q8_0，移动端推荐 Q4_0）。

> 提示：模型首次使用需要联网下载（数百 MB），下载完成后由浏览器缓存，之后即可离线推理。

## 功能特性

### 笔记与文件夹管理

| 能力 | 说明 |
| --- | --- |
| 多层文件夹 | 支持根目录与子文件夹的层级结构 |
| 未分类 | 快速收纳未归类的笔记 |
| 全部笔记 | 集中查看所有笔记 |
| 最近删除 | 回收站，默认保留 30 天，可配置为永久保留 |

### 富文本编辑

标题 1–3、加粗、斜体、下划线、删除线、任务列表、有序 / 无序列表、引用、高亮、对齐、缩进、插入图片、清除格式。

### 模板笔记

提供模板编辑器，并支持从模板一键新建笔记。

### 本地 AI 对话

见上文[本地 AI](#本地-ai)章节。

### 数据导入导出

- **选择性导出**：导出为 Markdown / 纯文本 / Word 的 ZIP 压缩包。
- **完整备份与恢复**：JSON 格式的完整备份与恢复。
- **导入**：支持导入本应用导出的 ZIP，或 Markdown / 纯文本 / Word 文件。

### 其它

| 能力 | 说明 |
| --- | --- |
| 安全 | 访问锁，基于 PBKDF2 派生哈希 |
| 外观 | 跟随系统 / 手动暗色主题 |
| 语言 | 简体中文（zh-CN）/ 英文（en） |
| PWA | 可安装到桌面、Service Worker 预缓存、离线可用 |

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 前端框架 | Svelte 5（runes） |
| 构建工具 | Vite 6 |
| 样式 | Tailwind CSS 4 |
| PWA | vite-plugin-pwa（Workbox） |
| 本地存储 | IndexedDB（idb） |
| 富文本编辑器 | @opentiny/fluent-editor |
| AI / 对话 | Vercel AI SDK（`ai` / `@ai-sdk/openai-compatible` / `zod`） |
| 本地推理 | @wllama/wllama（WebGPU / GGUF） |
| 导入导出与格式转换 | docx / mammoth / turndown / marked / fflate |

## 快速开始

### 环境要求

- Node.js 18+ 与 npm（建议使用较新的 LTS 版本）。

### 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/Coder-AIX/TMPLNote.git
cd TMPLNote

# 2. 安装依赖
npm install

# 3. 本地开发（默认 http://localhost:5173）
npm run dev

# 4. 生产构建（输出到 dist/）
npm run build

# 5. 本地预览构建产物
npm run preview
```

可选：重新生成 PWA 图标。

```bash
npm run icons
```

> 开发与预览服务器已配置跨域隔离响应头（COOP / COEP），以解锁本地推理的多线程能力。

## 部署到 GitHub Pages

本项目已适配 GitHub Pages **项目子路径**（构建 `base` 为 `/TMPLNote/`），并通过 GitHub Actions 自动构建部署。

### 在线访问

<https://coder-aix.github.io/TMPLNote/>

### 自动部署（推荐）

推送 `main` 分支会触发 `.github/workflows/deploy.yml`：安装依赖 → 构建 → 发布到 GitHub Pages。

首次使用需在仓库中启用 Pages：

1. 打开仓库 **Settings → Pages**。
2. 将 **Source** 设为 **GitHub Actions**。
3. 推送 `main`（或在 Actions 页手动运行 `Deploy to GitHub Pages`），等待工作流完成即可访问。

### 本地构建部署（备选）

也可以本地构建后手动发布到 Pages：

```bash
npm run build
```

将生成的 `dist/` 目录内容部署到任意静态托管即可（例如 GitHub Pages 的 `gh-pages` 分支）。

> **关于跨域隔离**：GitHub Pages 为纯静态托管，无法自定义 HTTP 响应头。本项目通过 Service Worker 注入 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`，在静态托管上实现跨域隔离，从而解锁本地 AI 的多线程推理。
>
> **已知限制**：iOS Safari 不支持 `credentialless`，无法进入跨域隔离，因此移动端会按设计**关闭本地 AI**。

## AI 模型获取与使用

1. 打开应用中的 **设置 → AI**。
2. 点击**复制模型下载链接**。
3. 在浏览器地址栏打开该链接，下载 GGUF 模型文件。
4. 回到应用，点击**选择文件导入**，载入刚下载的 GGUF 文件。
5. 载入完成后，进入**对话**页面开始使用。

> 注意：模型首次使用需联网下载（数百 MB）；下载完成后由浏览器缓存，之后可在离线状态下进行推理。

## 数据与隐私

- **笔记 / 文件夹 / 设置**：存储在 IndexedDB 数据库 `tmplnote`。
- **对话历史**：存储在独立 IndexedDB 数据库 `tmplnote-chat`。
- **本地模型权重**：存储在 Cache Storage `ai-models`。
- 所有数据均保存在本地浏览器，**无需联网，不上传服务器**。

## 目录结构

```text
TMPLNote/
├─ public/              # 静态资源与 PWA 图标
├─ scripts/             # 构建辅助脚本（如生成图标）
├─ src/
│  ├─ lib/
│  │  ├─ ai/            # 本地 AI 推理、对话与工具调用
│  │  ├─ components/    # 通用 UI 组件
│  │  ├─ db/            # IndexedDB 数据访问层
│  │  ├─ layout/        # 布局组件
│  │  ├─ pages/         # 页面
│  │  ├─ stores/        # 全局状态
│  │  ├─ utils/         # 工具函数与导入导出
│  │  └─ routes.js      # 路由定义
│  ├─ App.svelte
│  ├─ main.js
│  └─ service-worker.js
├─ index.html
├─ package.json
└─ vite.config.js
```

## 许可协议

本项目采用**个人免费使用、禁止商用**的授权方式：

- **允许**：个人学习、研究与自用。
- **禁止**：任何形式的商业用途。
- 如需将本项目用于商业场景，须事先获得作者的书面授权。

本仓库不附带独立的 `LICENSE` 文件；以上说明即为本项目的许可声明。
