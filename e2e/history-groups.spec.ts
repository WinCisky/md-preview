import { expect, test } from '@playwright/test';
import { seedDocuments } from './helpers';

// Le etichette dei mesi seguono la locale del browser: fissarla rende le
// asserzioni deterministiche a prescindere dalla macchina che esegue i test.
test.use({ locale: 'en-US' });

const NOW = new Date('2026-07-15T10:00:00Z');

const SEEDS = [
	{ id: 'doc-current', title: 'Current Month Doc', updatedAt: Date.UTC(2026, 6, 5) },
	{ id: 'doc-march', title: 'March Doc', updatedAt: Date.UTC(2026, 2, 10) },
	{ id: 'doc-january', title: 'January Doc', updatedAt: Date.UTC(2026, 0, 20) },
	{ id: 'doc-2025', title: 'Last Year Doc', updatedAt: Date.UTC(2025, 10, 2) },
	{ id: 'doc-2024-a', title: 'Older Doc A', updatedAt: Date.UTC(2024, 4, 5) },
	{ id: 'doc-2024-b', title: 'Older Doc B', updatedAt: Date.UTC(2024, 1, 5) },
];

test.describe('History grouping', () => {
	test.beforeEach(async ({ page }) => {
		await page.clock.setFixedTime(NOW);
		// Un primo caricamento serve solo ad avere un'origine su cui aprire IndexedDB.
		await page.goto('./history');
		await seedDocuments(page, SEEDS);
		await page.reload();
	});

	test('keeps the current month flat and folds older months and years', async ({ page }) => {
		// Solo il documento del mese corrente è fuori dalle cartelle.
		await expect(page.getByTestId('history-document')).toHaveCount(1);
		await expect(page.getByTestId('history-document-title')).toHaveText('Current Month Doc');

		const groups = page.getByTestId('history-group');
		await expect(groups).toHaveCount(4);
		await expect(groups.getByTestId('history-group-label')).toHaveText([
			'March',
			'January',
			'2025',
			'2024',
		]);
		await expect(groups.nth(0)).toHaveAttribute('data-group-key', 'month-2');
		await expect(groups.nth(1)).toHaveAttribute('data-group-key', 'month-0');
		await expect(groups.nth(2)).toHaveAttribute('data-group-key', 'year-2025');
		await expect(groups.nth(3)).toHaveAttribute('data-group-key', 'year-2024');
	});

	test('expands a year folder to reveal its documents', async ({ page }) => {
		const yearGroup = page.getByTestId('history-group').filter({ hasText: '2024' });
		await expect(yearGroup.getByTestId('history-document')).toHaveCount(0);

		await yearGroup.getByTestId('history-group-label').click();

		const documents = yearGroup.getByTestId('history-document');
		await expect(documents).toHaveCount(2);
		await expect(documents.getByTestId('history-document-title')).toHaveText([
			'Older Doc A',
			'Older Doc B',
		]);
	});

	test('expands a month folder to reveal its documents', async ({ page }) => {
		const monthGroup = page.getByTestId('history-group').filter({ hasText: 'March' });
		await monthGroup.getByTestId('history-group-label').click();

		await expect(monthGroup.getByTestId('history-document-title')).toHaveText('March Doc');
	});
});
