<p align="center">
    <a href="https://wincisky.github.io/md-preview/" target="_blank"><img src="https://raw.githubusercontent.com/WinCisky/md-preview/refs/heads/main/public/favicon.svg" width="250" alt="md-preview logo"></a>
</p>

<p align="center">
    <a href="https://github.com/WinCisky/md-preview/actions"><img src="https://img.shields.io/github/actions/workflow/status/WinCisky/md-preview/deploy.yml" alt="Build Status"></a>
    <a href="https://github.com/WinCisky/md-preview/blob/main/LICENSE"><img src="https://img.shields.io/github/license/WinCisky/md-preview" alt="License"></a>
</p>

# md-preview

A web-based Markdown previewer that renders your Markdown in real time. Type or paste on the left, see the rendered output on the right — with syntax highlighting, dark/light mode, scroll sync between panes, and a local file tree saved to IndexedDB.

## Features

- **Live preview** — Rendered Markdown updates in real time as you type or paste
- **Split-pane layout** — Resizable input and preview panels; scroll position is synchronized proportionally between the two panes
- **Syntax highlighting** — Code blocks highlighted with `highlight.js`
- **Sanitized output** — HTML rendered via DOMPurify for safe rendering
- **Dark / light mode** — Theme follows your system color scheme via [`mode-watcher`](https://github.com/ArnaudBarre/mode-watcher)
- **Local file tree** — Files and folders live in IndexedDB; create, rename, delete and move them by drag & drop or from the right-click menu. Only the latest content of each file is kept
- **Attachments** — Images and files dropped or pasted into the editor are stored as blobs and referenced as `attachment:<id>`; an attachment is deleted as soon as the text stops referencing it
- **Download options** — Export as Markdown (`.md`) or PDF (via print dialog); a document with attachments is exported as a `.zip`

## Getting Started

```sh
# Install dependencies
pnpm install

# Start the dev server
pnpm dev
```

The server runs at `http://localhost:4321`.

## Building for Production

```sh
pnpm build
pnpm preview
```

The production build is output to `./dist/`.

## How It Works

1. User types or pastes Markdown into the left textarea
2. The text is parsed with [`marked`](https://github.com/markedjs/marked) and rendered as HTML
3. The HTML is sanitized with [`DOMPurify`](https://github.com/DanAyer/dompurify) before rendering
4. Code blocks are syntax-highlighted by `highlight.js`
5. A debounced save writes the active file back to IndexedDB via `files-db`
6. The scroll position of the textarea and preview pane is synced proportionally
