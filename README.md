<p align="center">
    <a href="https://wincisky.github.io/md-preview/" target="_blank"><img src="https://raw.githubusercontent.com/WinCisky/md-preview/refs/heads/main/public/favicon.svg" width="250" alt="Json formatter logo"></a>
</p>

<p align="center">
    <a href="https://github.com/WinCisky/md-preview/actions"><img src="https://img.shields.io/github/actions/workflow/status/WinCisky/md-preview/deploy.yml" alt="Build Status"></a>
    <a href="https://github.com/WinCisky/md-preview/blob/main/LICENSE"><img src="https://img.shields.io/github/license/WinCisky/md-preview" alt="License"></a>
</p>

# JSON Formatter

A web-based JSON formatter and validator with automatic repair of malformed JSON. Paste any JSON string into the input panel and see it instantly formatted, validated, and — when needed — repaired in the live preview panel.

## Features

- **Live formatting** — Output updates in real time as you type or paste JSON
- **Automatic repair** — Malformed JSON (trailing commas, missing quotes, comments, single quotes, unquoted keys, etc.) is automatically repaired using [`jsonrepair`](https://github.com/martin-martin/json-repair)
- **Split-pane layout** — Resizable input and preview panels with layout persistence
- **Dark / light mode** — Editor theme follows your system color scheme via [`mode-watcher`](https://github.com/ArnaudBarre/mode-watcher)
- **Syntax highlighting** — Output rendered with CodeMirror 6 and GitHub light/dark themes

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

1. User pastes or types a JSON string into the left textarea
2. The app first tries to parse the input as valid JSON
3. If parsing fails, it runs the input through `jsonrepair` to fix common mistakes
4. The result is pretty-printed with 2-space indentation and displayed in the CodeMirror editor on the right
5. A warning alert appears when repair was needed; an error alert appears if the input could not be processed at all
