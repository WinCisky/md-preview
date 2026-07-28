import { expect, test } from '@playwright/test';

test.describe('Markdown Previewer', () => {
	test('shows default markdown rendered in the preview pane', async ({ page }) => {
		await page.goto('./');

		await expect(page.getByRole('heading', { name: 'Hello Markdown', level: 1 })).toBeVisible();
		await expect(page.locator('article')).toContainText('Type something on the left');
	});

	test('updates the preview when the markdown input changes', async ({ page }) => {
		await page.goto('./');

		const input = page.locator('#markdown-input');
		await input.fill('# Playwright Test\n\nThis is **bold** text.');

		await expect(page.getByRole('heading', { name: 'Playwright Test', level: 1 })).toBeVisible();
		await expect(page.locator('article strong')).toHaveText('bold');
	});

	test('keeps updating the preview across multiple consecutive edits', async ({ page }) => {
		// Regression test: the preview effect must react to every change of the
		// markdown input, not just the first one after mount.
		await page.goto('./');

		const input = page.locator('#markdown-input');
		const article = page.locator('article');

		await input.fill('# First Edit');
		await expect(page.getByRole('heading', { name: 'First Edit', level: 1 })).toBeVisible();

		await input.fill('# Second Edit');
		await expect(page.getByRole('heading', { name: 'Second Edit', level: 1 })).toBeVisible();
		await expect(article).not.toContainText('First Edit');

		await input.fill('# Third Edit');
		await expect(page.getByRole('heading', { name: 'Third Edit', level: 1 })).toBeVisible();
		await expect(article).not.toContainText('Second Edit');
	});

	test.describe('small screens', () => {
		test.use({ viewport: { width: 360, height: 640 } });

		test('stacks the panes vertically and keeps the whole toolbar in view', async ({ page }) => {
			await page.goto('./');

			const paneGroup = page.locator('[data-slot="resizable-pane-group"]');
			await expect(paneGroup).toHaveAttribute('data-direction', 'vertical');

			// Nessun overflow orizzontale della pagina.
			const { scrollWidth, clientWidth } = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				clientWidth: document.documentElement.clientWidth,
			}));
			expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

			// I pulsanti restano tutti dentro il viewport.
			const buttons = [
				page.getByRole('button', { name: 'Download Markdown' }),
				page.getByRole('button', { name: 'Download PDF' }),
			];
			for (const button of buttons) {
				const box = await button.boundingBox();
				expect(box).not.toBeNull();
				expect(box!.x + box!.width).toBeLessThanOrEqual(360);
				expect(box!.y + box!.height).toBeLessThanOrEqual(640);
			}
		});
	});

	test.describe('scroll sync', () => {
		// Long enough content so both the textarea and the preview pane
		// actually overflow and become scrollable.
		const longMarkdown = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join('\n\n');

		test('scrolling the input to the bottom scrolls the preview to the bottom', async ({ page }) => {
			await page.goto('./');

			const input = page.locator('#markdown-input');
			const preview = page.locator('#preview-pane');
			await input.fill(longMarkdown);
			// Wait for the (async) sanitized preview to actually render the long
			// content before relying on its scrollHeight, otherwise the sync
			// below would compute against the stale, shorter preview content.
			await expect(preview).toContainText('Line 200');

			await expect(async () => {
				await input.evaluate((el: HTMLTextAreaElement) => {
					el.scrollTop = el.scrollHeight;
					el.dispatchEvent(new Event('scroll'));
				});
				const atBottom = await preview.evaluate(
					(el) => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2
				);
				expect(atBottom).toBe(true);
			}).toPass();
		});

		test('scrolling the preview to the bottom scrolls the input to the bottom', async ({ page }) => {
			await page.goto('./');

			const input = page.locator('#markdown-input');
			const preview = page.locator('#preview-pane');
			await input.fill(longMarkdown);
			await expect(preview).toContainText('Line 200');

			await expect(async () => {
				await preview.evaluate((el: HTMLDivElement) => {
					el.scrollTop = el.scrollHeight;
					el.dispatchEvent(new Event('scroll'));
				});
				const atBottom = await input.evaluate(
					(el: HTMLTextAreaElement) => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2
				);
				expect(atBottom).toBe(true);
			}).toPass();
		});
	});
});
