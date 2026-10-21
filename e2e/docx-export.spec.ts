import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { dropFiles, gotoEditor, PNG_1X1_BASE64, waitForRecordCount } from './helpers';

const SAMPLE = String.raw`# Title & \<stuff\>

Some **bold**, *italic*, ~~struck~~, ${'`'}code${'`'}, H~2~O, x^2^, ==marked== and a [link](<https://example.com/a b>).

- one
- two
  1. nested
  2. nested two
- [x] done task

3. three
4. four

> quoted text

> [!WARNING]
> Careful

| Left | Right |
| :--- | ----: |
| a    | b     |

${'```'}js
const a = 1;
${'\t'}indented();
${'```'}

Term
: Definition

---

<div>raw &amp; html</div>

![remote](javascript:alert(1))
`;

async function exportDocx(page: import('@playwright/test').Page) {
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download Word' }).click();
	const download = await downloadPromise;
	const entries = unzipSync(new Uint8Array(readFileSync(await download.path())));
	return { download, entries };
}

test.describe('Word export', () => {
	test('exports a well-formed .docx named after the open file', async ({ page }) => {
		await gotoEditor(page);
		await page.locator('#markdown-input').fill(SAMPLE);

		const { download, entries } = await exportDocx(page);
		expect(download.suggestedFilename()).toBe('welcome.docx');
		expect(Object.keys(entries)).toEqual(
			expect.arrayContaining([
				'[Content_Types].xml',
				'_rels/.rels',
				'word/document.xml',
				'word/styles.xml',
				'word/numbering.xml',
				'word/_rels/document.xml.rels',
			])
		);

		// Every XML part must parse: a single malformed one makes Word refuse the file.
		const xmlParts = Object.entries(entries)
			.filter(([name]) => name.endsWith('.xml') || name.endsWith('.rels'))
			.map(([name, bytes]) => ({ name, xml: strFromU8(bytes) }));
		const errors = await page.evaluate((parts) => {
			const parser = new DOMParser();
			return parts
				.filter(({ xml }) => parser.parseFromString(xml, 'application/xml').querySelector('parsererror'))
				.map(({ name }) => name);
		}, xmlParts);
		expect(errors).toEqual([]);

		const document = strFromU8(entries['word/document.xml']);
		expect(document).toContain('<w:pStyle w:val="Heading1"/>');
		expect(document).toContain('Title &amp; ');
		expect(document).toContain('&lt;');
		expect(document).toContain('<w:b/>');
		expect(document).toContain('<w:strike/>');
		expect(document).toContain('w:val="subscript"');
		expect(document).toContain('w:val="superscript"');
		expect(document).toContain('<w:highlight w:val="yellow"/>');
		expect(document).toContain('<w:hyperlink');
		expect(document).toContain('<w:numPr>');
		expect(document).toContain('☒ ');
		expect(document).toContain('<w:tbl>');
		expect(document).toContain('<w:jc w:val="right"/>');
		expect(document).toContain('<w:pStyle w:val="SourceCode"/>');
		expect(document).toContain('<w:tab/>');
		expect(document).toContain('Warning');
		expect(document).toContain('raw &amp; html');
		expect(document).not.toContain('javascript:');

		const rels = strFromU8(entries['word/_rels/document.xml.rels']);
		expect(rels).toContain('Target="https://example.com/a%20b" TargetMode="External"');

		// The ordered list starting at 3 keeps its number.
		expect(strFromU8(entries['word/numbering.xml'])).toContain('<w:startOverride w:val="3"/>');
	});

	test('embeds image attachments', async ({ page }) => {
		await gotoEditor(page);
		await page.locator('#markdown-input').fill('');
		await dropFiles(page, [{ name: 'pic.png', mimeType: 'image/png', base64: PNG_1X1_BASE64 }]);
		await waitForRecordCount(page, 'attachments', 1);

		const { entries } = await exportDocx(page);
		expect(Object.keys(entries)).toContain('word/media/image1.png');
		expect(strFromU8(entries['word/document.xml'])).toContain('<a:blip r:embed="');
	});
});
