# Folder to TXT

An Obsidian plugin that exports a folder of notes as plain `.txt` files to anywhere
on disk, recreating the subfolder structure at the destination.

Useful when something outside Obsidian needs your notes as plain text — a
transcription tool, an e-reader, an archive, a system that won't take markdown.

Desktop only: it writes outside the vault, which needs Node's filesystem access.

## Install

### Manually

1. Download `main.js` and `manifest.json` from the
   [latest release](https://github.com/the-vfp/obsidian-folder-to-txt/releases/latest).
2. Put both in `<your vault>/.obsidian/plugins/folder-to-txt/` (create the folder).
3. In Obsidian: **Settings → Community plugins**. Turn off Restricted Mode if it's on,
   click the refresh icon next to **Installed plugins**, then enable **Folder to TXT**.

### With BRAT

Add `the-vfp/obsidian-folder-to-txt` as a beta plugin in
[BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Use

Set a destination first in **Settings → Folder to TXT → Output folder**.

Then, any of:

- Right-click a folder in the file explorer → **Export folder as .txt**
- Right-click a note → **Export note as .txt**
- Command palette → **Export a folder as .txt files** (opens a folder picker)
- Command palette → **Export the whole vault as .txt files**

A folder export creates a subfolder at the destination named after the folder you
exported, so separate exports never mix together. Single notes are written straight
into the output folder.

Only `.md` files are exported — attachments, canvases and other file types are skipped.
If two notes in one folder reduce to the same filename after sanitising (`A: B` and
`A- B` both become `A- B`), the second gets a ` (2)` suffix rather than overwriting.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Output folder | — | Where exports are written. Full path, with a folder picker. |
| Strip frontmatter | on | Removes the YAML block at the top of each note. |
| Unwrap wikilinks | on | `[[Note\|Alias]]` → `Alias`, `[[folder/Note]]` → `Note`. |
| Drop embeds | off | Removes `![[...]]` entirely instead of leaving the name behind. |
| Strip all markdown syntax | off | Flattens headings, emphasis, lists, callouts, code fences and links to plain prose. |
| Add the note title at the top | off | Writes the filename as the first line. |
| Overwrite existing files | on | Turn off to skip any `.txt` already at the destination. |
| Use Windows line endings | off | Writes CRLF instead of LF. |

Settings are per-vault, stored in `data.json` next to the plugin.

## A caveat

Content is converted as text, not evaluated. Templater syntax, Dataview query blocks
and Excalidraw data pass through literally rather than being resolved. Try one small
folder before running it across a large vault.

## Development

There is no build step. `main.js` is plain CommonJS and is the source — edit it and run
**Reload app without saving** from the command palette to pick up changes.

The conversion functions at the top of `main.js` (`removeFrontmatter`, `unwrapWikilinks`,
`flattenMarkdown`, `convert`) are pure and free of Obsidian imports, so they can be
sliced out and tested in plain Node.

## License

MIT
