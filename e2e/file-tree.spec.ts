import { expect, test } from '@playwright/test';
import {
	confirmTreeName,
	createTreeNode,
	createTreeNodeFrom,
	dragTreeNode,
	gotoEditor,
	hoverTreeNode,
	readNodes,
	treeContextMenu,
	waitForHydration,
	waitForNodeContent,
} from './helpers';

test.describe('File tree', () => {
	test('seeds a single example file on the very first load', async ({ page }) => {
		await gotoEditor(page);

		const file = page.getByTestId('tree-file');
		await expect(file).toHaveCount(1);
		await expect(file).toHaveAttribute('data-name', 'welcome');
		await expect(page.getByTestId('active-file-name')).toHaveText('welcome');

		const nodes = await readNodes(page);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ type: 'file', parentId: 'root', name: 'welcome' });
	});

	test('the header buttons create a file and a folder in the root', async ({ page }) => {
		await gotoEditor(page);

		// Il nodo appena creato entra subito in rinomina: confermare senza
		// modificare il nome lo lascia con quello di default.
		await page.getByRole('button', { name: 'New folder' }).click();
		await confirmTreeName(page, 'new folder');
		await expect(page.getByTestId('tree-folder')).toHaveCount(1);

		// Con l'area vuota selezionata il nuovo file finisce nella radice.
		await page.getByTestId('tree-root').click();
		await createTreeNode(page, 'file', 'notes');

		const nodes = await readNodes(page);
		expect(nodes.filter((node) => node.parentId === 'root')).toHaveLength(3);
	});

	test('creates a child inside the folder picked with the context menu', async ({ page }) => {
		await gotoEditor(page);
		await createTreeNode(page, 'folder', 'drafts');
		await createTreeNodeFrom(page, 'drafts', 'file', 'draft');

		const nodes = await readNodes(page);
		const folder = nodes.find((node) => node.name === 'drafts')!;
		expect(nodes.find((node) => node.name === 'draft')!.parentId).toBe(folder.id);
	});

	test('creates a sibling when the context menu is opened on a file', async ({ page }) => {
		await gotoEditor(page);
		await createTreeNode(page, 'folder', 'drafts');
		await createTreeNodeFrom(page, 'drafts', 'file', 'draft');
		// Dal file dentro la cartella: il nuovo nodo è un fratello, non un figlio.
		await createTreeNodeFrom(page, 'draft', 'file', 'other');

		const nodes = await readNodes(page);
		const folder = nodes.find((node) => node.name === 'drafts')!;
		expect(nodes.find((node) => node.name === 'other')!.parentId).toBe(folder.id);
	});

	test('renames a file from the context menu and keeps it open', async ({ page }) => {
		await gotoEditor(page);

		await treeContextMenu(page, 'welcome', 'Rinomina');
		await confirmTreeName(page, 'readme');

		await expect(page.getByTestId('active-file-name')).toHaveText('readme');
	});

	test('escape cancels a rename', async ({ page }) => {
		await gotoEditor(page);

		await treeContextMenu(page, 'welcome', 'Rinomina');
		await page.getByTestId('tree-rename-input').fill('nope');
		await page.getByTestId('tree-rename-input').press('Escape');

		await expect(page.locator('[data-name="welcome"]')).toBeVisible();
		await expect(page.locator('[data-name="nope"]')).toHaveCount(0);
	});

	test('deletes a folder and everything inside it', async ({ page }) => {
		await gotoEditor(page);
		await createTreeNode(page, 'folder', 'drafts');
		await createTreeNodeFrom(page, 'drafts', 'file', 'draft');
		expect(await readNodes(page)).toHaveLength(3);

		page.once('dialog', (dialog) => dialog.accept());
		await treeContextMenu(page, 'drafts', 'Elimina');

		await expect(page.getByTestId('tree-folder')).toHaveCount(0);
		await expect(async () => {
			expect(await readNodes(page)).toHaveLength(1);
		}).toPass();
		// Cancellato il file aperto, l'editor ripiega su quello rimasto.
		await expect(page.getByTestId('active-file-name')).toHaveText('welcome');
	});

	test('moves a file into a folder with drag and drop, and back to the root', async ({ page }) => {
		await gotoEditor(page);
		await createTreeNode(page, 'folder', 'drafts');

		expect(await dragTreeNode(page, 'welcome', 'drafts')).toBe(true);
		await expect(async () => {
			const nodes = await readNodes(page);
			const folder = nodes.find((node) => node.name === 'drafts')!;
			expect(nodes.find((node) => node.name === 'welcome')!.parentId).toBe(folder.id);
		}).toPass();

		// La cartella si apre da sola sul drop, quindi la riga è di nuovo visibile.
		await expect(page.locator('[data-name="welcome"]')).toBeVisible();
		expect(await dragTreeNode(page, 'welcome', null)).toBe(true);
		await expect(async () => {
			const nodes = await readNodes(page);
			expect(nodes.find((node) => node.name === 'welcome')!.parentId).toBe('root');
		}).toPass();
	});

	test('refuses to drop a folder inside its own descendant', async ({ page }) => {
		await gotoEditor(page);
		await createTreeNode(page, 'folder', 'outer');
		await createTreeNodeFrom(page, 'outer', 'folder', 'inner');

		const outerBefore = (await readNodes(page)).find((node) => node.name === 'outer')!;

		expect(await dragTreeNode(page, 'outer', 'inner')).toBe(false);

		const nodesAfter = await readNodes(page);
		expect(nodesAfter.find((node) => node.name === 'outer')!.parentId).toBe(outerBefore.parentId);
	});

	test('switching file saves the outgoing one and loads the other', async ({ page }) => {
		await gotoEditor(page);
		await page.getByTestId('tree-root').click();
		await createTreeNode(page, 'file', 'notes');

		const input = page.locator('#markdown-input');
		await expect(input).toHaveValue('');
		await input.fill('# Notes');

		// Il cambio di file avviene prima che il debounce scada: la modifica in
		// sospeso deve finire comunque in notes.
		await page.locator('[data-name="welcome"]').click();
		await expect(input).toHaveValue(/Hello Markdown/);
		await waitForNodeContent(page, 'notes', /# Notes/);

		await page.locator('[data-name="notes"]').click();
		await expect(input).toHaveValue('# Notes');
	});

	test('restores which folders were open after a reload', async ({ page }) => {
		await gotoEditor(page);
		await createTreeNode(page, 'folder', 'drafts');
		// Creare un figlio apre la cartella che lo accoglie.
		await createTreeNodeFrom(page, 'drafts', 'file', 'draft');

		await page.goto('./');
		await expect(page.locator('[data-name="draft"]')).toBeVisible();
		expect((await readNodes(page)).find((node) => node.name === 'drafts')!.expanded).toBe(true);

		await page.locator('[data-name="drafts"]').click();
		await expect(page.locator('[data-name="draft"]')).toHaveCount(0);

		await page.goto('./');
		await expect(page.getByTestId('tree-folder')).toHaveCount(1);
		await expect(page.locator('[data-name="draft"]')).toHaveCount(0);
		expect((await readNodes(page)).find((node) => node.name === 'drafts')!.expanded).toBe(false);
	});

	test('highlights only the destination folder while dragging, not the files in it', async ({
		page,
	}) => {
		await gotoEditor(page);
		await createTreeNode(page, 'folder', 'drafts');
		await createTreeNodeFrom(page, 'drafts', 'file', 'draft');

		// Il drop su un file viene dirottato sulla cartella che lo contiene, ma a
		// illuminarsi deve essere solo quella cartella.
		await hoverTreeNode(page, 'welcome', 'draft');

		await expect(page.locator('[data-name="drafts"]')).toHaveAttribute('data-drop-target', '');
		await expect(page.locator('[data-testid="tree-file"][data-drop-target]')).toHaveCount(0);
		// L'evidenziazione è davvero disegnata, non solo un attributo.
		const border = await page
			.locator('[data-name="drafts"]')
			.evaluate((el) => getComputedStyle(el).borderTopColor);
		expect(border).not.toMatch(/\/ 0\)|transparent/);
	});

	test('restores whether the sidebar is open after a reload', async ({ page }) => {
		await gotoEditor(page);
		const sidebar = page.locator('[data-slot="sidebar"][data-state]');
		await expect(sidebar).toHaveAttribute('data-state', 'expanded');

		await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
		await expect(sidebar).toHaveAttribute('data-state', 'collapsed');

		await page.goto('./');
		await expect(sidebar).toHaveAttribute('data-state', 'collapsed');

		await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
		await page.goto('./');
		await expect(sidebar).toHaveAttribute('data-state', 'expanded');
	});

	test.describe('small screens', () => {
		test.use({ viewport: { width: 360, height: 640 } });

		// Su mobile la sidebar è un pannello a scomparsa che copre l'editor: resta
		// chiuso al caricamento qualunque cosa dica il cookie, e da chiuso non è
		// nemmeno montato.
		test('ignores the stored sidebar state', async ({ page, context }) => {
			for (const value of ['false', 'true']) {
				await context.addCookies([
					{ name: 'sidebar_state', value, url: 'http://localhost:4321' },
				]);
				await page.goto('./');
				await waitForHydration(page);
				await expect(page.getByTestId('tree-file')).toHaveCount(0);
			}

			// Aprendolo a mano il pannello compare, quindi l'assenza qui sopra è
			// davvero il pannello chiuso e non un albero che non si carica.
			await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
			await expect(page.getByTestId('tree-file')).toHaveCount(1);
		});
	});

	test('reopens the last edited file after a reload', async ({ page }) => {
		await gotoEditor(page);
		await page.getByTestId('tree-root').click();
		await createTreeNode(page, 'file', 'notes');
		await page.locator('#markdown-input').fill('# Persisted');
		await waitForNodeContent(page, 'notes', /# Persisted/);

		await page.goto('./');

		await expect(page.getByTestId('active-file-name')).toHaveText('notes');
		await expect(page.locator('#markdown-input')).toHaveValue('# Persisted');
	});
});
