// @ts-check
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates `sw.js` after the build. It precaches every file emitted to the
 * output directory so the app works fully offline after the first visit.
 * The cache name is derived from the content of all files, so any change to
 * the build produces a new service worker and old caches get cleaned up.
 *
 * @returns {import("astro").AstroIntegration}
 */
export default function serviceWorker() {
	/** @type {string} */
	let base = "/";

	return {
		name: "service-worker",
		hooks: {
			"astro:config:done": ({ config }) => {
				base = config.base.endsWith("/") ? config.base : `${config.base}/`;
			},
			"astro:build:done": async ({ dir, logger }) => {
				const outDir = fileURLToPath(dir);
				const files = (await walk(outDir)).filter((f) => !f.endsWith(".map")).sort();

				const hash = createHash("sha256");
				const urls = [];
				for (const file of files) {
					const rel = relative(outDir, file).split(sep).join("/");
					if (rel === "sw.js") continue;
					hash.update(rel);
					hash.update(await readFile(file));
					// Serve directory indexes from their canonical URL.
					urls.push(base + rel.replace(/(^|\/)index\.html$/, "$1"));
				}
				const version = hash.digest("hex").slice(0, 12);

				await writeFile(join(outDir, "sw.js"), swSource({ version, base, urls }));
				logger.info(`sw.js generated (${urls.length} files, version ${version})`);
			},
		},
	};
}

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])),
	);
	return nested.flat();
}

/** @param {{ version: string; base: string; urls: string[] }} opts */
function swSource({ version, base, urls }) {
	return `// Generated at build time. Do not edit.
const CACHE = "md-preview-${version}";
const BASE = ${JSON.stringify(base)};
const PRECACHE = ${JSON.stringify(urls, null, 1)};

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(
				keys.filter((k) => k.startsWith("md-preview-") && k !== CACHE).map((k) => caches.delete(k)),
			))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

	// Navigations: network first (fresh HTML when online), fall back to the cached app shell.
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((c) => c.put(BASE, copy));
					}
					return res;
				})
				.catch(() => caches.match(BASE, { ignoreSearch: true })),
		);
		return;
	}

	// Static assets: cache first, then network (and cache the result).
	event.respondWith(
		caches.match(request, { ignoreSearch: true }).then((cached) =>
			cached ||
			fetch(request).then((res) => {
				if (res.ok) {
					const copy = res.clone();
					caches.open(CACHE).then((c) => c.put(request, copy));
				}
				return res;
			}),
		),
	);
});
`;
}
