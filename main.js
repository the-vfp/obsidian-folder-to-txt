'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, FuzzySuggestModal, TFolder, TFile, getAllTags } = obsidian;
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_SETTINGS = {
  outputPath: '',
  stripFrontmatter: true,
  unwrapWikilinks: true,
  dropEmbeds: false,
  stripMarkdown: false,
  addTitleHeader: false,
  overwrite: true,
  windowsLineEndings: false,

  // index export
  indexIncludeGist: true,
  indexGistLength: 120,
  indexIncludeTags: false,
  indexIncludeWordCount: false,
  indexIncludeModified: false,
  indexIncludeNonMarkdown: false,
  indexSkipEmptyFolders: true,
  indexMaxDepth: 0, // 0 = no limit
  indexWriteFile: true,
  indexCopyToClipboard: true,
};

/* ------------------------------------------------------------------ */
/* conversion                                                          */
/* ------------------------------------------------------------------ */

function removeFrontmatter(text) {
  if (!text.startsWith('---')) return text;
  const m = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

// [[folder/note#heading|Alias]] -> Alias ; [[folder/note]] -> note
function cleanLinkTarget(inner) {
  const pipe = inner.indexOf('|');
  if (pipe !== -1) return inner.slice(pipe + 1).trim();
  let target = inner;
  const hash = target.indexOf('#');
  if (hash === 0) return target.slice(1).replace(/^\^/, '').trim();
  if (hash > 0) target = target.slice(0, hash);
  const slash = target.lastIndexOf('/');
  if (slash !== -1) target = target.slice(slash + 1);
  return target.trim();
}

function unwrapWikilinks(text, dropEmbeds) {
  text = text.replace(/!\[\[([^\]]+?)\]\]/g, (_m, inner) =>
    dropEmbeds ? '' : cleanLinkTarget(inner));
  text = text.replace(/\[\[([^\]]+?)\]\]/g, (_m, inner) => cleanLinkTarget(inner));
  return text;
}

function flattenMarkdown(text) {
  let t = text;
  t = t.replace(/%%[\s\S]*?%%/g, '');                                   // obsidian comments
  t = t.replace(/<!--[\s\S]*?-->/g, '');                                // html comments
  t = t.replace(/^[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)^[ \t]*(?:```|~~~)[ \t]*$/gm, '$1'); // fences
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '');                         // images
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');                        // links -> text
  t = t.replace(/^[ \t]*>[ \t]*\[!\w+\][-+]?[ \t]*(.*)$/gm, '$1');      // callout header -> title
  t = t.replace(/^[ \t]*>[ \t]?/gm, '');                                // blockquote markers
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');                           // headings
  t = t.replace(/^[ \t]*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, ''); // rules
  t = t.replace(/^([ \t]*)[-*+][ \t]+(?:\[[ xX\/\-]\][ \t]+)?/gm, '$1'); // bullets + tasks
  t = t.replace(/(\*\*\*|___)(.*?)\1/g, '$2');
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
  t = t.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1');
  t = t.replace(/(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, '$1');
  t = t.replace(/~~(.*?)~~/g, '$1');                                    // strikethrough
  t = t.replace(/==(.*?)==/g, '$1');                                    // highlight
  t = t.replace(/`([^`\n]+)`/g, '$1');                                  // inline code
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t;
}

function convert(text, basename, settings) {
  let t = text;
  if (settings.stripFrontmatter) t = removeFrontmatter(t);
  if (settings.unwrapWikilinks) t = unwrapWikilinks(t, settings.dropEmbeds || settings.stripMarkdown);
  if (settings.stripMarkdown) t = flattenMarkdown(t);
  t = t.replace(/^\s+/, '').replace(/\s+$/, '') + '\n';
  if (settings.addTitleHeader) t = basename + '\n\n' + t;
  t = t.replace(/\r\n/g, '\n');
  if (settings.windowsLineEndings) t = t.replace(/\n/g, '\r\n');
  return t;
}

/* ------------------------------------------------------------------ */
/* filesystem helpers                                                  */
/* ------------------------------------------------------------------ */

// Windows-hostile characters, plus trailing dots/spaces which Windows silently drops.
function safeSegment(name) {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'untitled';
}

function collectMarkdown(folder, out) {
  for (const child of folder.children) {
    if (child instanceof TFolder) collectMarkdown(child, out);
    else if (child instanceof TFile && child.extension === 'md') out.push(child);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* index export                                                        */
/* ------------------------------------------------------------------ */

function isIndexable(entry, settings) {
  if (entry instanceof TFolder) return true;
  return settings.indexIncludeNonMarkdown || entry.extension === 'md';
}

// Folders first, then files — matching the file explorer's own ordering.
function compareEntries(a, b) {
  const aFolder = a instanceof TFolder;
  const bFolder = b instanceof TFolder;
  if (aFolder !== bFolder) return aFolder ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// Memoised so a whole-vault walk stays linear rather than re-counting subtrees.
function countIndexableFiles(folder, settings, memo) {
  const cached = memo.get(folder.path);
  if (cached !== undefined) return cached;
  let n = 0;
  for (const child of folder.children) {
    if (child instanceof TFolder) n += countIndexableFiles(child, settings, memo);
    else if (isIndexable(child, settings)) n++;
  }
  memo.set(folder.path, n);
  return n;
}

// A vault full of node_modules would otherwise bury the notes in empty branches.
function isVisible(entry, settings, memo) {
  if (!isIndexable(entry, settings)) return false;
  if (entry instanceof TFolder && settings.indexSkipEmptyFolders) {
    return countIndexableFiles(entry, settings, memo) > 0;
  }
  return true;
}

// Every folder inside a pruned branch, so the summary can report what was left out.
function countAllFolders(folder) {
  if (!(folder instanceof TFolder)) return 0;
  let n = 0;
  for (const child of folder.children) {
    if (child instanceof TFolder) n += 1 + countAllFolders(child);
  }
  return n;
}

function countDescendants(folder, settings, memo) {
  let n = 0;
  for (const child of folder.children) {
    if (!isVisible(child, settings, memo)) continue;
    n++;
    if (child instanceof TFolder) n += countDescendants(child, settings, memo);
  }
  return n;
}

// One-line summary: the frontmatter description if there is one, else the first
// real line of prose, flattened so markdown syntax doesn't leak into the index.
function buildGist(raw, frontmatter, limit) {
  let text = '';
  if (frontmatter) {
    const field = frontmatter.description || frontmatter.summary || frontmatter.subtitle;
    if (typeof field === 'string' && field.trim()) text = field.trim();
  }
  if (!text) {
    const body = flattenMarkdown(unwrapWikilinks(removeFrontmatter(raw).slice(0, 4000), true));
    const line = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    text = line || '';
  }
  if (!text) return '';
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

function countWords(raw) {
  const body = removeFrontmatter(raw).trim();
  if (!body) return 0;
  return body.split(/\s+/).length;
}

function formatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

async function buildIndex(app, folder, settings, onProgress) {
  const lines = [];
  const stats = { notes: 0, folders: 0, hidden: 0, pruned: 0 };
  const memo = new Map();
  const needsContent = settings.indexIncludeGist || settings.indexIncludeWordCount;
  const limit = Math.max(20, Number(settings.indexGistLength) || 120);
  let seen = 0;

  async function annotate(file) {
    const parts = [];
    let raw = null;
    if (needsContent && file.extension === 'md') {
      try {
        raw = await app.vault.cachedRead(file);
      } catch (err) {
        console.error('[folder-to-txt] could not read ' + file.path, err);
      }
    }

    const cache = app.metadataCache.getFileCache(file);
    if (settings.indexIncludeGist && raw !== null) {
      const gist = buildGist(raw, cache && cache.frontmatter, limit);
      // Notes that open with an H1 of their own title would otherwise just echo it.
      const echoesTitle = gist.trim().toLowerCase() === file.basename.trim().toLowerCase();
      if (gist && !echoesTitle) parts.push('— ' + gist);
    }
    if (settings.indexIncludeTags && cache) {
      const tags = getAllTags ? getAllTags(cache) : null;
      if (tags && tags.length) parts.push('· ' + Array.from(new Set(tags)).join(' '));
    }
    if (settings.indexIncludeWordCount && raw !== null) {
      parts.push('· ' + countWords(raw) + 'w');
    }
    if (settings.indexIncludeModified && file.stat) {
      parts.push('· ' + formatDate(file.stat.mtime));
    }
    return parts.length ? ' ' + parts.join('  ') : '';
  }

  async function walk(current, prefix, depth) {
    const indexable = current.children.filter((c) => isIndexable(c, settings));
    const visible = indexable.filter((c) => isVisible(c, settings, memo)).sort(compareEntries);
    for (const dropped of indexable) {
      if (!visible.includes(dropped)) stats.pruned += 1 + countAllFolders(dropped);
    }

    for (let i = 0; i < visible.length; i++) {
      const child = visible[i];
      const last = i === visible.length - 1;
      const branch = prefix + (last ? '└── ' : '├── ');
      const childPrefix = prefix + (last ? '    ' : '│   ');

      if (child instanceof TFolder) {
        stats.folders++;
        lines.push(branch + child.name + '/');
        if (settings.indexMaxDepth > 0 && depth + 1 >= settings.indexMaxDepth) {
          const n = countDescendants(child, settings, memo);
          if (n) {
            lines.push(childPrefix + '… ' + n + ' more item' + (n === 1 ? '' : 's'));
            stats.hidden += n;
          }
        } else {
          await walk(child, childPrefix, depth + 1);
        }
      } else {
        stats.notes++;
        lines.push(branch + child.name + (await annotate(child)));
        if (++seen % 50 === 0 && onProgress) {
          onProgress(seen);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
  }

  await walk(folder, '', 0);

  const rootName = folder.isRoot() ? app.vault.getName() : folder.name;
  const summary = [
    stats.notes + ' file' + (stats.notes === 1 ? '' : 's'),
    stats.folders + ' folder' + (stats.folders === 1 ? '' : 's'),
    'generated ' + formatDate(Date.now()),
  ];
  if (stats.hidden) summary.splice(2, 0, stats.hidden + ' hidden by depth limit');
  if (stats.pruned) summary.splice(2, 0, stats.pruned + ' empty folders skipped');

  const text = [
    '# Index of ' + rootName,
    '',
    summary.join(' · '),
    '',
    '```text',
    rootName + '/',
    ...lines,
    '```',
    '',
  ].join('\n');

  return { text, stats };
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      require('electron').clipboard.writeText(text);
      return true;
    } catch (err2) {
      console.error('[folder-to-txt] clipboard unavailable', err, err2);
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

class FolderSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder('Pick a folder to export as .txt');
  }
  getItems() {
    return this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder);
  }
  getItemText(folder) {
    return folder.isRoot() ? '/ (whole vault)' : folder.path;
  }
  onChooseItem(folder) {
    this.onChoose(folder);
  }
}

module.exports = class FolderToTxtPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new FolderToTxtSettingTab(this.app, this));

    this.addCommand({
      id: 'export-folder-as-txt',
      name: 'Export a folder as .txt files',
      callback: () => new FolderSuggestModal(this.app, (f) => this.exportFolder(f)).open(),
    });

    this.addCommand({
      id: 'export-vault-as-txt',
      name: 'Export the whole vault as .txt files',
      callback: () => this.exportFolder(this.app.vault.getRoot()),
    });

    this.addCommand({
      id: 'export-folder-index',
      name: 'Export an index of a folder',
      callback: () => new FolderSuggestModal(this.app, (f) => this.exportIndex(f)).open(),
    });

    this.addCommand({
      id: 'export-vault-index',
      name: 'Export an index of the whole vault',
      callback: () => this.exportIndex(this.app.vault.getRoot()),
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle('Export folder as .txt')
              .setIcon('file-text')
              .onClick(() => this.exportFolder(file))
          );
          menu.addItem((item) =>
            item
              .setTitle('Export index of folder')
              .setIcon('list-tree')
              .onClick(() => this.exportIndex(file))
          );
        } else if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) =>
            item
              .setTitle('Export note as .txt')
              .setIcon('file-text')
              .onClick(() =>
                this.exportFiles([file], file.parent || this.app.vault.getRoot(), null)
              )
          );
        }
      })
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async exportFolder(folder) {
    const files = collectMarkdown(folder, []);
    const label = folder.isRoot() ? this.app.vault.getName() : folder.name;
    await this.exportFiles(files, folder, label);
  }

  async exportIndex(folder) {
    const settings = this.settings;

    if (!settings.indexWriteFile && !settings.indexCopyToClipboard) {
      new Notice('Folder to TXT: the index has nowhere to go — enable the file or the clipboard in settings.', 9000);
      return;
    }
    if (settings.indexWriteFile && !settings.outputPath) {
      new Notice('Folder to TXT: set an output folder in the plugin settings first.', 8000);
      return;
    }

    const notice = new Notice('Building index…', 0);
    let result;
    try {
      result = await buildIndex(this.app, folder, settings, (n) =>
        notice.setMessage('Building index… ' + n + ' files')
      );
    } catch (err) {
      notice.hide();
      new Notice('Folder to TXT: index failed — ' + err.message, 10000);
      console.error('[folder-to-txt]', err);
      return;
    }
    notice.hide();

    const done = [];

    if (settings.indexWriteFile) {
      const label = folder.isRoot() ? this.app.vault.getName() : folder.name;
      const target = path.join(settings.outputPath, safeSegment(label + ' index') + '.md');
      try {
        await fsp.mkdir(settings.outputPath, { recursive: true });
        const body = settings.windowsLineEndings ? result.text.replace(/\n/g, '\r\n') : result.text;
        await fsp.writeFile(target, body, 'utf8');
        done.push('Written to ' + target);
      } catch (err) {
        done.push('Could not write the file — ' + err.message);
        console.error('[folder-to-txt]', err);
      }
    }

    if (settings.indexCopyToClipboard) {
      done.push((await copyToClipboard(result.text)) ? 'Copied to clipboard' : 'Clipboard unavailable');
    }

    new Notice(
      'Indexed ' + result.stats.notes + ' file' + (result.stats.notes === 1 ? '' : 's') +
        ' in ' + result.stats.folders + ' folder' + (result.stats.folders === 1 ? '' : 's') +
        '\n' + done.join('\n'),
      12000
    );
  }

  // `base` is the vault folder that becomes the root of the mirrored tree.
  // `label` names the subfolder to create under the output path; null writes straight into it.
  async exportFiles(files, base, label) {
    const settings = this.settings;

    if (!settings.outputPath) {
      new Notice('Folder to TXT: set an output folder in the plugin settings first.', 8000);
      return;
    }
    if (!files.length) {
      new Notice('Folder to TXT: no markdown notes found there.');
      return;
    }

    const destRoot = label ? path.join(settings.outputPath, safeSegment(label)) : settings.outputPath;
    try {
      await fsp.mkdir(destRoot, { recursive: true });
    } catch (err) {
      new Notice('Folder to TXT: could not create ' + destRoot + '\n' + err.message, 10000);
      console.error('[folder-to-txt]', err);
      return;
    }

    const basePrefix = base.isRoot() ? '' : base.path + '/';
    const notice = new Notice('Exporting 0 / ' + files.length + '\u2026', 0);
    let written = 0;
    let skipped = 0;
    const errors = [];
    // Two notes in one folder can sanitise to the same filename ("A: B" and "A- B").
    const claimed = new Set();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const rel = file.path.startsWith(basePrefix) ? file.path.slice(basePrefix.length) : file.name;
        const segments = rel.split('/').map(safeSegment);
        const stem = safeSegment(file.basename);
        segments[segments.length - 1] = stem + '.txt';
        let target = path.join(destRoot, ...segments);

        for (let n = 2; claimed.has(target.toLowerCase()); n++) {
          segments[segments.length - 1] = stem + ' (' + n + ').txt';
          target = path.join(destRoot, ...segments);
        }
        claimed.add(target.toLowerCase());

        if (!settings.overwrite && fs.existsSync(target)) {
          skipped++;
        } else {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          const raw = await this.app.vault.cachedRead(file);
          await fsp.writeFile(target, convert(raw, file.basename, settings), 'utf8');
          written++;
        }
      } catch (err) {
        errors.push(file.path + ': ' + err.message);
        console.error('[folder-to-txt]', file.path, err);
      }

      if (i % 25 === 0) {
        notice.setMessage('Exporting ' + (i + 1) + ' / ' + files.length + '\u2026');
        await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
      }
    }

    notice.hide();

    let summary = 'Exported ' + written + ' note' + (written === 1 ? '' : 's') + ' to ' + destRoot;
    if (skipped) summary += '\nSkipped ' + skipped + ' existing file' + (skipped === 1 ? '' : 's');
    if (errors.length) summary += '\n' + errors.length + ' failed \u2014 see the developer console';
    new Notice(summary, 12000);
  }
};

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

class FolderToTxtSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  toggle(key, name, desc) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(this.plugin.settings[key]).onChange(async (v) => {
          this.plugin.settings[key] = v;
          await this.plugin.saveSettings();
        })
      );
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Output folder')
      .setDesc('Full path to a folder on disk. Each export creates a subfolder named after the folder you exported.')
      .addText((text) => {
        text
          .setPlaceholder('C:\\Users\\you\\Desktop\\Exports')
          .setValue(this.plugin.settings.outputPath)
          .onChange(async (v) => {
            this.plugin.settings.outputPath = v.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      })
      .addButton((btn) =>
        btn.setButtonText('Browse').onClick(async () => {
          const picked = await pickDirectory(this.plugin.settings.outputPath);
          if (picked) {
            this.plugin.settings.outputPath = picked;
            await this.plugin.saveSettings();
            this.display();
          }
        })
      );

    new Setting(containerEl).setName('Conversion').setHeading();

    this.toggle('stripFrontmatter', 'Strip frontmatter', 'Remove the YAML block at the top of each note.');
    this.toggle('unwrapWikilinks', 'Unwrap wikilinks', '[[Note|Alias]] becomes Alias, [[folder/Note]] becomes Note.');
    this.toggle('dropEmbeds', 'Drop embeds', 'Remove ![[...]] embeds entirely instead of leaving their name behind.');
    this.toggle('stripMarkdown', 'Strip all markdown syntax', 'Headings, bold, lists, callouts, code fences and links flattened to plain prose.');
    this.toggle('addTitleHeader', 'Add the note title at the top', 'Write the filename as the first line of each .txt.');

    new Setting(containerEl).setName('Output').setHeading();

    this.toggle('overwrite', 'Overwrite existing files', 'Turn off to skip any .txt that already exists at the destination.');
    this.toggle('windowsLineEndings', 'Use Windows line endings', 'Write CRLF instead of LF, for older editors like Notepad.');

    new Setting(containerEl)
      .setName('Index export')
      .setDesc('A single file listing the folder tree — a structural snapshot to hand to an AI assistant without uploading the notes themselves.')
      .setHeading();

    this.toggle('indexCopyToClipboard', 'Copy the index to the clipboard', 'Ready to paste straight into a chat.');
    this.toggle('indexWriteFile', 'Also write it to a file', 'Saves "<folder> index.md" in the output folder above.');

    this.toggle('indexIncludeGist', 'Include a one-line gist', 'The frontmatter description if a note has one, otherwise its first line of prose.');

    new Setting(containerEl)
      .setName('Gist length')
      .setDesc('Characters before the gist is truncated. Lower it to keep large indexes manageable.')
      .addSlider((s) =>
        s
          .setLimits(40, 300, 10)
          .setValue(Number(this.plugin.settings.indexGistLength) || 120)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.indexGistLength = v;
            await this.plugin.saveSettings();
          })
      );

    this.toggle('indexIncludeTags', 'Include tags', 'Every tag on the note, frontmatter and inline.');
    this.toggle('indexIncludeWordCount', 'Include word counts', 'Word count per note.');
    this.toggle('indexIncludeModified', 'Include last modified date', 'The date each note was last changed.');
    this.toggle('indexIncludeNonMarkdown', 'Include non-markdown files', 'List attachments, canvases and everything else, not just notes.');
    this.toggle('indexSkipEmptyFolders', 'Skip folders with no notes', 'Leaves out branches that contain nothing indexable — node_modules and the like. The summary line reports how many were dropped.');

    new Setting(containerEl)
      .setName('Depth limit')
      .setDesc('How many folder levels to show. 0 means no limit; deeper folders are summarised as a count.')
      .addSlider((s) =>
        s
          .setLimits(0, 10, 1)
          .setValue(Number(this.plugin.settings.indexMaxDepth) || 0)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.indexMaxDepth = v;
            await this.plugin.saveSettings();
          })
      );
  }
}

// Electron's directory picker, if this build exposes it. Falls back to the text field.
async function pickDirectory(defaultPath) {
  try {
    const electron = require('electron');
    const dialog = (electron.remote && electron.remote.dialog) || electron.dialog || null;
    if (!dialog) throw new Error('no dialog module');
    const opts = { properties: ['openDirectory', 'createDirectory'] };
    if (defaultPath) opts.defaultPath = defaultPath;
    const result = await dialog.showOpenDialog(opts);
    if (result && !result.canceled && result.filePaths && result.filePaths.length) {
      return result.filePaths[0];
    }
  } catch (err) {
    console.error('[folder-to-txt] directory picker unavailable', err);
    new Notice('Folder picker unavailable here \u2014 type or paste the path instead.', 6000);
  }
  return null;
}
