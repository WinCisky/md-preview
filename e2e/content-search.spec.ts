import { expect, test } from '@playwright/test';
import { createTreeNode, createTreeNodeFrom, gotoEditor, waitForNodeContent } from './helpers';

test.describe('Advanced search', () => {
	test('finds text inside documents and opens the match', async ({ page }) => {
		await gotoEditor(page);
		await createTreeNode(page, 'folder', 'drafts');
		await createTreeNodeFrom(page, 'drafts', 'file', 'chapter-one');
		const editor = page.locator('#markdown-input');
		const body = Array.from({ length: 80 }, (_, index) => `filler line ${index}`).join('\n');
		await editor.fill(`# Chapter\n\n${body}\n\nThe Needle is here, and another needle too.\n`);
		await waitForNodeContent(page, 'chapter-one', /Needle/);

		// Back to another file, so opening the match has to switch document.
		await page.locator('[data-name="welcome"] button').click();
		await expect(page.getByTestId('active-file-name')).toHaveText('welcome');

		await page.getByRole('button', { name: 'Search files' }).click();
		await page.getByTestId('tree-search-content').click();
		await expect(page.getByTestId('tree-search-content')).toHaveAttribute('aria-pressed', 'true');
		const search = page.getByTestId('tree-search');
		await expect(search).toBeFocused();
		await search.fill('NEEDLE');

		// The tree gives way to the matches, grouped by document.
		await expect(page.getByTestId('tree-file')).toHaveCount(0);
		const result = page.getByTestId('search-result');
		await expect(result).toHaveCount(1);
		await expect(result).toHaveAttribute('data-name', 'chapter-one');
		await expect(result.getByTestId('search-result-path')).toHaveText('drafts');
		await expect(result.getByTestId('search-result-count')).toHaveText('2');

		const match = result.getByTestId('search-match');
		await expect(match).toHaveCount(1);
		await expect(match).toHaveAttribute('data-line', '84');
		await expect(match.locator('mark')).toHaveText(['Needle', 'needle']);

		await match.click();
		await expect(page.getByTestId('active-file-name')).toHaveText('chapter-one');
		await expect(editor).toBeFocused();
		const selection = await editor.evaluate((el: HTMLTextAreaElement) => ({
			text: el.value.slice(el.selectionStart, el.selectionEnd),
			scrolled: el.scrollTop > 0,
		}));
		expect(selection).toEqual({ text: 'Needle', scrolled: true });

		// Name matches are reported as well.
		await search.fill('welcome');
		await expect(page.getByTestId('search-result')).toHaveAttribute('data-name', 'welcome');

		await search.fill('nothing-matches');
		await expect(page.getByTestId('tree-search-empty')).toBeVisible();
	});

	test('sees unsaved edits of the open file', async ({ page }) => {
		await gotoEditor(page);
		await page.locator('#markdown-input').fill('fresh unsaved words');

		await page.getByRole('button', { name: 'Search files' }).click();
		await page.getByTestId('tree-search-content').click();
		await page.getByTestId('tree-search').fill('unsaved');
		await expect(page.getByTestId('search-match').locator('mark')).toHaveText('unsaved');

		// Enter jumps to the first match without losing the edit.
		await page.getByTestId('tree-search').press('Enter');
		await expect(page.locator('#markdown-input')).toHaveValue('fresh unsaved words');
	});
});
