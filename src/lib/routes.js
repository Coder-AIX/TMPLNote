import Notes from './pages/Notes.svelte';
import Settings from './pages/Settings.svelte';
import TemplateEditor from './pages/TemplateEditor.svelte';
import Chat from './pages/Chat.svelte';

const routes = {
    '/': Notes,
    '/settings': Settings,
    '/chat': Chat,
    '/settings/:section': Settings,
    '/template/:id': TemplateEditor,
    '*': Notes
};

export default routes;
