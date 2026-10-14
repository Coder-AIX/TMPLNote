<script>
    import NoteList from '../layout/NoteList.svelte';
    import NoteEditor from '../layout/NoteEditor.svelte';
    import { selectedNoteId } from '../stores/workspace.js';
</script>

<div class="flex h-full min-h-0 gap-0 p-0 pb-[env(safe-area-inset-bottom)] md:gap-4 md:p-4 md:pb-4">
    <div
        class="min-w-0 flex-1 overflow-hidden bg-[var(--card)]
               md:w-[320px] md:flex-none md:rounded-2xl md:shadow-[var(--card-shadow)]
               {$selectedNoteId ? 'hidden md:block' : 'block'}"
    >
        <NoteList />
    </div>
    <div
        class="min-w-0 flex-1 overflow-hidden bg-[var(--card)]
               md:rounded-2xl md:shadow-[var(--card-shadow)]
               {$selectedNoteId ? 'block' : 'hidden md:block'}"
    >
        <NoteEditor />
    </div>
</div>
