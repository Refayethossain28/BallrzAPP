# Forge — file-processing & report CLI

A single-file, zero-dependency Node.js CLI (`node:` builtins only) that scans
directory trees and produces terminal tables, HTML reports, and TODO
inventories.

Requires Node.js 18+.

## Setup

```sh
chmod +x forge.mjs      # once, optional
./forge.mjs --help      # or: node forge.mjs --help
```

## Commands

### `forge.mjs scan <dir>`

Walks the directory tree and prints:

- a table of file counts, total sizes and size share per extension,
  sorted by size
- the 10 largest files with their sizes

```sh
./forge.mjs scan ~/projects/my-app
```

### `forge.mjs report <dir> [--out report.html]`

Generates a standalone, styled HTML report (dark theme, inline CSS,
bar chart built from plain divs — no external assets) with the same stats:
summary cards, size-by-extension bar chart, largest files table.

```sh
./forge.mjs report ~/projects/my-app --out my-app-report.html
```

`--out` defaults to `report.html` in the current directory.
`--out=file.html` also works.

### `forge.mjs todo <dir>`

Greps source files (common code/config/doc extensions) for `TODO`, `FIXME`
and `HACK` comments and prints them grouped by file with line numbers and
color-coded tags.

```sh
./forge.mjs todo ~/projects/my-app
```

## Behavior notes

- `.git`, `node_modules` (plus `.hg`, `.svn`) directories are always skipped.
- Symlinks are skipped to avoid cycles.
- Unreadable files/directories are skipped with a note instead of crashing.
- Colors are disabled automatically when output is not a TTY (pipes, CI).
- Exit code 1 on bad usage (unknown command/option, missing or invalid dir).
