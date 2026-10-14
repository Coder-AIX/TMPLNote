<script>
    import Sidebar from './Sidebar.svelte';
    import Router from 'svelte-spa-router';
    import routes from '../routes.js';
    import AiPermissionDialog from '../components/AiPermissionDialog.svelte';
</script>

<div class="flex h-dvh overflow-hidden bg-[var(--canvas)] text-[var(--fg)]">
    <Sidebar />
    <div class="flex min-w-0 flex-1 flex-col lg:pl-[230px]">
        <main class="min-h-0 flex-1 overflow-hidden">
            <Router {routes} />
        </main>
    </div>
    <AiPermissionDialog />
</div>
