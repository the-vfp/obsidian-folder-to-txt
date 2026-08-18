'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, FuzzySuggestModal, TFolder, TFile } = obsidian;
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

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle('Export folder as .txt')
              .setIcon('file-text')
              .onClick(() => this.exportFolder(file))
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
