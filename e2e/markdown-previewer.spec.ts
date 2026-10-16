import { expect, test } from '@playwright/test';
import { waitForHydration } from './helpers';

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

			// No horizontal overflow of the page.
			const { scrollWidth, clientWidth } = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				clientWidth: document.documentElement.clientWidth,
			}));
			expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

			// All the buttons stay inside the viewport.
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

		// `scrollBy` fires a genuine `scroll` event, unlike assigning `scrollTop`
		// and dispatching a synthetic one -- so these tests fail if the element
		// has stopped being a real scroll container.
		const scrollToBottom = (el: HTMLElement) => el.scrollBy(0, el.scrollHeight);

		test('the document itself does not scroll', async ({ page }) => {
			await page.goto('./');

			const input = page.locator('#markdown-input');
			const preview = page.locator('#preview-pane');
			await input.fill(longMarkdown);
			await expect(preview).toContainText('Line 200');

			// The layout is capped at the viewport height: overflow belongs to the
			// two panes, never to the page. A document scrollbar means an ancestor
			// lost its height cap, which silently kills scroll sync.
			const documentOverflows = await page.evaluate(
				() =>
					document.documentElement.scrollHeight > document.documentElement.clientHeight + 1 ||
					document.body.scrollHeight > document.body.clientHeight + 1
			);
			expect(documentOverflows).toBe(false);
		});

		test('both panes are real scroll containers', async ({ page }) => {
			await page.goto('./');

			const input = page.locator('#markdown-input');
			const preview = page.locator('#preview-pane');
			await input.fill(longMarkdown);
			await expect(preview).toContainText('Line 200');

			await expect(async () => {
				const overflows = (el: Element) => el.scrollHeight > el.clientHeight;
				expect(await input.evaluate(overflows)).toBe(true);
				expect(await preview.evaluate(overflows)).toBe(true);
			}).toPass();
		});

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
				await input.evaluate(scrollToBottom);
				// Guard against a vacuous pass: if neither pane scrolls, both
				// scrollTops stay 0 and the "at bottom" check trivially holds.
				expect(await input.evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBeGreaterThan(0);
				const atBottom = await preview.evaluate(
					(el) => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2
				);
				expect(atBottom).toBe(true);
			}).toPass();
		});

		test('aligns the centers of the two panes', async ({ page }) => {
			await page.goto('./');
			await waitForHydration(page);

			// Blocks of very different rendered heights, so a proportional sync
			// would drift away from the line under the center.
			const blocks = Array.from({ length: 120 }, (_, i) =>
				i % 10 === 0 ? `# Heading ${i}` : `Paragraph ${i}`
			);
			blocks.splice(60, 0, '```\n' + Array.from({ length: 40 }, (_, i) => `code ${i}`).join('\n') + '\n```');
			const input = page.locator('#markdown-input');
			const preview = page.locator('#preview-pane');
			await input.fill(blocks.join('\n\n'));
			await expect(preview).toContainText('Paragraph 119');

			// Put the line of "Paragraph 95" (after the tall code block) at the
			// center of the editor; these lines are short and never wrap.
			const targetLine = await input.evaluate((el: HTMLTextAreaElement) => {
				const line = el.value.split('\n').indexOf('Paragraph 95');
				const style = getComputedStyle(el);
				const lineHeight = parseFloat(style.lineHeight);
				const top = parseFloat(style.paddingTop) + (line + 0.5) * lineHeight - el.clientHeight / 2;
				el.scrollBy(0, top - el.scrollTop);
				return line;
			});

			await expect(async () => {
				const centerBlockLine = await preview.evaluate((el) => {
					const rect = el.getBoundingClientRect();
					const center = rect.top + rect.height / 2;
					const blocks = Array.from(el.querySelectorAll<HTMLElement>('article > [data-source-line]'));
					let closest = { line: -1, distance: Infinity };
					for (const block of blocks) {
						const r = block.getBoundingClientRect();
						const distance = Math.abs((r.top + r.bottom) / 2 - center);
						if (distance < closest.distance) closest = { line: Number(block.dataset.sourceLine), distance };
					}
					return closest.line;
				});
				expect(centerBlockLine).toBe(targetLine);
			}).toPass();
		});

		test('highlights the same word near the center in both panes while scrolling', async ({ page }) => {
			await page.goto('./');
			await waitForHydration(page);

			const paragraphs = Array.from(
				{ length: 80 },
				(_, i) => `Paragraph ${i} has **bold${i}** text and a [link${i}](https://example.com/link${i}) inside.`
			);
			const input = page.locator('#markdown-input');
			const preview = page.locator('#preview-pane');
			await input.fill(paragraphs.join('\n\n'));
			await expect(preview).toContainText('Paragraph 79');

			// fill() leaves the caret, and so both panes, at the bottom: go back
			// to the top, then a few real scroll steps down so the highlight
			// sees a scroll speed.
			await preview.evaluate((el) => el.scrollTo(0, 0));
			await expect.poll(() => input.evaluate((el) => el.scrollTop)).toBe(0);
			for (let step = 0; step < 8; step++) {
				await preview.evaluate((el) => el.scrollBy(0, 120));
				await page.waitForTimeout(16);
			}

			const previewHighlight = page.getByTestId('preview-scroll-highlight');
			const editorHighlight = page.getByTestId('editor-scroll-highlight');
			await expect(previewHighlight).toBeVisible();
			await expect(editorHighlight).toBeVisible();

			const word = await previewHighlight.getAttribute('data-word');
			expect(word).toMatch(/\w{3,}/);
			await expect(editorHighlight).toHaveAttribute('data-word', word!);

			// The editor box points at that very word in the source…
			const line = Number(await editorHighlight.getAttribute('data-line'));
			const column = Number(await editorHighlight.getAttribute('data-column'));
			const sourceWord = await input.evaluate(
				(el: HTMLTextAreaElement, [line, column, length]) =>
					el.value.split('\n')[line].slice(column, column + length),
				[line, column, word!.length] as const
			);
			expect(sourceWord).toBe(word);

			// …and both boxes sit around the vertical middle of their pane.
			for (const [highlight, pane] of [
				[previewHighlight, preview],
				[editorHighlight, input],
			] as const) {
				const box = (await highlight.boundingBox())!;
				const paneBox = (await pane.boundingBox())!;
				const middle = paneBox.y + paneBox.height / 2;
				expect(Math.abs(box.y + box.height / 2 - middle)).toBeLessThan(paneBox.height / 4);
			}

			// It fades out once scrolling stops.
			await expect
				.poll(() => previewHighlight.evaluate((el) => Number(getComputedStyle(el).opacity)))
				.toBe(0);
		});

		test('scrolling the preview to the bottom scrolls the input to the bottom', async ({ page }) => {
			await page.goto('./');

			const input = page.locator('#markdown-input');
			const preview = page.locator('#preview-pane');
			await input.fill(longMarkdown);
			await expect(preview).toContainText('Line 200');

			await expect(async () => {
				await preview.evaluate(scrollToBottom);
				expect(await preview.evaluate((el: HTMLDivElement) => el.scrollTop)).toBeGreaterThan(0);
				const atBottom = await input.evaluate(
					(el: HTMLTextAreaElement) => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2
				);
				expect(atBottom).toBe(true);
			}).toPass();
		});
	});
});
