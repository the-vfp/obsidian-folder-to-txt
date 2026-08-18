# Folder to TXT

An Obsidian plugin that does two things with a folder of notes:

- **Export as `.txt`** — writes every note as a plain text file anywhere on disk,
  recreating the subfolder structure at the destination.
- **Export an index** — writes a single file showing the folder tree, optionally
  annotated with a one-line gist of each note, and copies it to your clipboard.

The first is for when something outside Obsidian needs your notes as plain text — a
transcription tool, an e-reader, an archive, a system that won't take markdown. The
second is for handing an AI assistant a structural snapshot of a vault without
uploading the notes themselves.

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

- Right-click a folder in the file explorer → **Export folder as .txt** or **Export index of folder**
- Right-click a note → **Export note as .txt**
- Command palette → **Export a folder as .txt files** (opens a folder picker)
- Command palette → **Export the whole vault as .txt files**
- Command palette → **Export an index of a folder** / **Export an index of the whole vault**

A folder export creates a subfolder at the destination named after the folder you
exported, so separate exports never mix together. Single notes are written straight
into the output folder.

## The index

An index is one markdown file containing a tree like this:

```text
10. Projects/
├── 1. Mythmaking/
│   ├── 0. Introduction.md — Writing has always been a painful process for me. I've always…
│   └── ZZZ Scratchpad.md — My thoughts on writing with AI
├── 2. SparkGPT/
│   ├── Spark Phrase List — v1 Draft.md
│   └── Spark Plugin — Project Scope.md
```

The gist is a note's frontmatter `description` (or `summary`/`subtitle`) if it has one,
otherwise its first line of prose with markdown flattened out. Notes whose first line
just repeats their own title are left bare rather than echoing it.

By default the index goes to your clipboard *and* to `<folder> index.md` in the output
folder; either half can be switched off. Tags, word counts and modified dates are
available but off by default, since they cost tokens without helping an assistant much.

Set a depth limit to keep large vaults manageable — folders past the limit collapse to
a `… 47 more items` line rather than disappearing silently.

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
| Copy the index to the clipboard | on | Ready to paste straight into a chat. |
| Also write the index to a file | on | Saves `<folder> index.md` in the output folder. |
| Include a one-line gist | on | Frontmatter description, else the note's first line. |
| Gist length | 120 | Characters before the gist is truncated. |
| Include tags | off | Every tag on the note, frontmatter and inline. |
| Include word counts | off | Word count per note. |
| Include last modified date | off | The date each note was last changed. |
| Include non-markdown files | off | Lists attachments and canvases too, not just notes. |
| Depth limit | 0 | Folder levels to show; 0 is unlimited. |

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

## Credits

Written with [Claude Code](https://claude.com/claude-code) — Claude wrote the
implementation and the tests; the behaviour, defaults and review are mine.

## License

MIT
