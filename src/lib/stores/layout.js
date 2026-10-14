import { writable } from 'svelte/store';

// 移动端抽屉是否打开
export const sidebarOpen = writable(false);

export function openSidebar() {
    sidebarOpen.set(true);
}

export function closeSidebar() {
    sidebarOpen.set(false);
}

export function toggleSidebar() {
    sidebarOpen.update((open) => !open);
}
