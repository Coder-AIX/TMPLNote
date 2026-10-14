import { writable } from 'svelte/store';

/** 「全部笔记」虚拟节点标识 */
export const ALL_NOTES = '__all__';

/** 「最近删除」虚拟节点标识 */
export const TRASH_ID = '__trash__';

/**
 * 当前选中的文件夹，取值可为：
 * - ALL_NOTES：全部笔记
 * - TRASH_ID：最近删除
 * - ''（ROOT_ID）：未分类
 * - 具体文件夹 id
 */
export const selectedFolderId = writable(ALL_NOTES);

/** 当前选中的笔记 id（null 表示未选中） */
export const selectedNoteId = writable(null);

/** 笔记数据版本号（用于触发列表/编辑器重新加载） */
export const notesVersion = writable(0);

/** 文件夹数据版本号 */
export const foldersVersion = writable(0);

export function bumpNotes() {
    notesVersion.update((n) => n + 1);
}

export function bumpFolders() {
    foldersVersion.update((n) => n + 1);
}
