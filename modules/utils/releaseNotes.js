"use strict;";

const vscode = require("vscode");
const path = require("path");

const versionRE = /([0-9]+)\.([0-9]+)\.([0-9]+)/;
const notesRE = /(^# .*$)?(?:^##(?<category>.*)$\s*(?<note>(?:[\S\s](?!##))*))*/gm;

class Version {
  constructor(major, minor, patch) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.pre = +minor % 2 == 1;
  }

  toString() {
    return this.pre
      ? `${this.major}.pre${+this.minor + 1}.patch${this.patch}`
      : `${this.major}.${this.minor}.${this.patch}`;
  }

  includePreRelease() {
    return new Version(this.major, !this.pre ? this.minor - 1 : this.minor, 0);
  }
}

function toVersion(version) {
  const [, major, minor, patch] = versionRE.exec(version) ?? [0, 0, 0, 0];
  return new Version(major, minor, patch);
}

function compare(version, other) {
  let order = ["major", "minor", "patch"];
  let res = 0;
  for (let ord of order) {
    res = Math.sign(version[ord] - other[ord]);
    if (res) {
      return res;
    }
  }

  return res;
}

async function findReleaseNotes(folder, version) {
  let decoder = new TextDecoder();
  const preVersion = version.includePreRelease();
  let files = (await vscode.workspace.fs.readDirectory(folder))
    .filter(([name, type]) => {
      if (type != vscode.FileType.File) {
        return false;
      }

      const fileVersion = toVersion(name);
      return compare(version, fileVersion) > -1 && compare(fileVersion, preVersion) > -1;
    })
    .map(([fileName]) => fileName);

  files.sort((x, y) => compare(toVersion(y), toVersion(x)));

  let content = files.map(async (fileName) => {
    let filePath = vscode.Uri.joinPath(folder, fileName);
    let notes = decoder.decode(await vscode.workspace.fs.readFile(filePath));
    let version = toVersion(fileName);
    return { version, notes };
  });

  return await Promise.all(content);
}

function addReleaseNote(entry, notes) {
  for (let match of [...notes.matchAll(notesRE)]) {
    const [, , category, note] = match;
    if (category && note) {
      entry[category] = entry[category] || [];
      entry[category].unshift(note);
    }
  }

  console.log(JSON.stringify(entry));

  return entry;
}

async function getReleaseNotes() {
  let extension = vscode.extensions.getExtension("farrese.midas");
  let version = toVersion(extension.packageJSON.version);
  let extensionPath = extension.extensionUri.fsPath;
  let notesPath = vscode.Uri.file(path.normalize(path.join(extensionPath, "release_notes")));
  let entries = await findReleaseNotes(notesPath, version);

  let releaseNotes = entries.reduceRight(
    (accumulator, current) => {
      if (compare(current.version, accumulator.version) > 0) {
        if (Object.keys(accumulator.entry).length && !accumulator.version.pre) {
          accumulator.notes.unshift({ ...accumulator.entry, version: accumulator.version });
          accumulator.entry = {};
        }

        accumulator.version = current.version;
      }

      accumulator.entry = addReleaseNote(accumulator.entry, current.notes);

      return accumulator;
    },
    { notes: [], entry: {}, version: toVersion("0.0.0") }
  );

  if (Object.keys(releaseNotes.entry)) {
    releaseNotes.notes.unshift({ ...releaseNotes.entry, version });
    releaseNotes.entry = {};
  }

  return renderReleaseNotes(releaseNotes.notes);
}

function render(version, notes) {
  let renderedNotes = "";

  let keys = Object.keys(notes);
  keys.sort().reverse();
  for (let key of keys) {
    renderedNotes = `\n### ${key}

${notes[key].join("\n")}${renderedNotes}`;
  }

  return `## ${version.pre ? "Pre-" : ""}Release ${version}

${renderedNotes}`;
}

function renderReleaseNotes(notes) {
  let renderedNotes = "";
  for (let releaseNote of notes) {
    let { version, ...rest } = releaseNote;
    let keys = Object.keys(releaseNote);
    keys.sort();
    renderedNotes = `${renderedNotes}${render(version, rest)}`;
  }

  return renderedNotes;
}

module.exports = { getReleaseNotes };
