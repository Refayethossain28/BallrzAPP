#!/usr/bin/env node
/**
 * Forge — a zero-dependency file-processing and report tool.
 *
 *   forge.mjs scan <dir>                    stats table by extension + largest files
 *   forge.mjs report <dir> --out report.html  standalone styled HTML report
 *   forge.mjs todo <dir>                    TODO/FIXME/HACK comments grouped by file
 *   forge.mjs --help
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);
const TODO_PATTERN = /\b(TODO|FIXME|HACK)\b[:\s]?(.*)/;
const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.php', '.sh',
  '.bash', '.zsh', '.pl', '.lua', '.sql', '.html', '.htm', '.css', '.scss',
  '.less', '.vue', '.svelte', '.yml', '.yaml', '.toml', '.ini', '.md', '.txt'
]);

const isTTY = process.stdout.isTTY;
const color = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = color('1');
const dim = color('2');
const cyan = color('36');
const yellow = color('33');
const red = color('31');
const green = color('32');

// ---------- helpers ----------

function fail(message) {
  console.error(red('error: ') + message);
  process.exit(1);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function walk(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(dim(`  (skipping unreadable dir: ${dir})`));
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

function collectStats(root) {
  const byExt = new Map(); // ext -> { count, bytes }
  const files = [];
  let totalBytes = 0;

  walk(root, (file) => {
    let st;
    try {
      st = statSync(file);
    } catch {
      return;
    }
    const ext = extname(file).toLowerCase() || '(none)';
    const rec = byExt.get(ext) ?? { count: 0, bytes: 0 };
    rec.count++;
    rec.bytes += st.size;
    byExt.set(ext, rec);
    totalBytes += st.size;
    files.push({ path: file, size: st.size });
  });

  const rows = [...byExt.entries()]
    .map(([ext, r]) => ({ ext, ...r }))
    .sort((a, b) => b.bytes - a.bytes);
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 10);
  return { rows, largest, totalBytes, totalFiles: files.length };
}

function requireDir(arg) {
  if (!arg) fail('missing <dir> argument. Try: forge.mjs --help');
  const root = resolve(arg);
  let st;
  try {
    st = statSync(root);
  } catch {
    fail(`no such directory: ${root}`);
  }
  if (!st.isDirectory()) fail(`not a directory: ${root}`);
  return root;
}

function printTable(headers, rows, aligns) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const line = (cells, decorate) =>
    '  ' +
    cells
      .map((c, i) => {
        const s = String(c);
        const padded =
          aligns[i] === 'r' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
        return decorate ? decorate(padded) : padded;
      })
      .join('  ');
  console.log(line(headers, bold));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('──'));
  for (const row of rows) console.log(line(row));
}

// ---------- commands ----------

function cmdScan(root) {
  const { rows, largest, totalBytes, totalFiles } = collectStats(root);
  console.log(`\n${bold('Forge scan')} ${cyan(root)}\n`);
  if (!totalFiles) {
    console.log(dim('  (no files found)'));
    return;
  }

  printTable(
    ['Extension', 'Files', 'Size', 'Share'],
    rows.map((r) => [
      r.ext,
      r.count,
      formatBytes(r.bytes),
      totalBytes ? ((r.bytes / totalBytes) * 100).toFixed(1) + '%' : '0%'
    ]),
    ['l', 'r', 'r', 'r']
  );

  console.log(
    `\n  ${bold('Total:')} ${totalFiles} files, ${formatBytes(totalBytes)}\n`
  );

  console.log(bold('  Largest files'));
  for (const f of largest) {
    console.log(
      `  ${yellow(formatBytes(f.size).padStart(9))}  ${relative(root, f.path) || f.path}`
    );
  }
  console.log('');
}

function cmdTodo(root) {
  console.log(`\n${bold('Forge todo')} ${cyan(root)}\n`);
  let fileCount = 0;
  let hitCount = 0;

  walk(root, (file) => {
    if (!SOURCE_EXTS.has(extname(file).toLowerCase())) return;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text.includes('\0')) return; // binary despite the extension
    const hits = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(TODO_PATTERN);
      if (m) {
        hits.push({
          line: i + 1,
          tag: m[1],
          text: (m[2] || '').trim().slice(0, 120)
        });
      }
    }
    if (!hits.length) return;
    fileCount++;
    hitCount += hits.length;
    console.log(bold(cyan(relative(root, file) || file)));
    for (const h of hits) {
      const tag =
        h.tag === 'TODO' ? green(h.tag) : h.tag === 'FIXME' ? red(h.tag) : yellow(h.tag);
      console.log(`  ${dim(String(h.line).padStart(5) + ':')} ${tag} ${h.text}`);
    }
    console.log('');
  });

  if (!hitCount) console.log(dim('  Clean! No TODO / FIXME / HACK comments found.\n'));
  else console.log(`  ${bold('Total:')} ${hitCount} item(s) across ${fileCount} file(s)\n`);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function cmdReport(root, outPath) {
  const { rows, largest, totalBytes, totalFiles } = collectStats(root);
  const maxBytes = rows.length ? rows[0].bytes : 1;
  const generated = new Date().toLocaleString();

  const barRows = rows
    .map((r) => {
      const pct = totalBytes ? ((r.bytes / totalBytes) * 100).toFixed(1) : '0.0';
      const w = Math.max(0.8, (r.bytes / maxBytes) * 100);
      return `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(r.ext)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(2)}%"></div></div>
        <div class="bar-value">${escapeHtml(formatBytes(r.bytes))} · ${r.count} file${r.count === 1 ? '' : 's'} · ${pct}%</div>
      </div>`;
    })
    .join('');

  const largestRows = largest
    .map(
      (f) => `
      <tr>
        <td class="mono">${escapeHtml(relative(root, f.path) || f.path)}</td>
        <td class="num">${escapeHtml(formatBytes(f.size))}</td>
      </tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Forge report — ${escapeHtml(root)}</title>
<style>
  :root {
    --bg: #0d1017; --surface: #151a24; --surface-2: #1c2333; --border: #27304a;
    --text: #e7ebf5; --text-dim: #8d97b0; --accent: #ff6b4a; --accent-2: #ffa24a;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 40px 20px;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 26px; letter-spacing: -0.4px; }
  h1 span { color: var(--accent); }
  .sub { color: var(--text-dim); font-size: 13px; margin: 6px 0 26px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 26px; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px;
  }
  .card .k { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--text-dim); }
  .card .v { font-size: 24px; font-weight: 800; margin-top: 6px; }
  section {
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    padding: 20px 22px; margin-bottom: 20px;
  }
  section h2 { font-size: 15px; margin-bottom: 16px; color: var(--text); }
  .bar-row { display: grid; grid-template-columns: 90px 1fr 220px; gap: 12px; align-items: center; margin-bottom: 9px; }
  .bar-label { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--text); text-align: right; }
  .bar-track { background: var(--surface-2); border-radius: 6px; height: 16px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); min-width: 2px; }
  .bar-value { font-size: 12px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 8px; border-top: 1px solid var(--border); font-size: 13px; }
  tr:first-child td { border-top: none; }
  td.num { text-align: right; color: var(--accent-2); white-space: nowrap; font-weight: 600; }
  footer { text-align: center; color: var(--text-dim); font-size: 12px; margin-top: 26px; }
  @media (max-width: 640px) {
    .bar-row { grid-template-columns: 64px 1fr; }
    .bar-value { grid-column: 2; margin-top: -4px; margin-bottom: 4px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Forge<span>.</span> report</h1>
  <div class="sub mono">${escapeHtml(root)} · generated ${escapeHtml(generated)}</div>
  <div class="cards">
    <div class="card"><div class="k">Files</div><div class="v">${totalFiles}</div></div>
    <div class="card"><div class="k">Total size</div><div class="v">${escapeHtml(formatBytes(totalBytes))}</div></div>
    <div class="card"><div class="k">Extensions</div><div class="v">${rows.length}</div></div>
  </div>
  <section>
    <h2>Size by extension</h2>
    ${barRows || '<div class="sub">No files found.</div>'}
  </section>
  <section>
    <h2>Largest files</h2>
    <table>${largestRows || '<tr><td class="sub">No files found.</td></tr>'}</table>
  </section>
  <footer>Generated by Forge — a zero-dependency Node.js CLI.</footer>
</div>
</body>
</html>
`;

  writeFileSync(outPath, html);
  console.log(
    `${green('✓')} Report written: ${bold(resolve(outPath))} ` +
      dim(`(${totalFiles} files, ${formatBytes(totalBytes)})`)
  );
}

// ---------- CLI ----------

const HELP = `
${bold('Forge')} — zero-dependency file-processing & report tool

${bold('Usage:')}
  forge.mjs scan <dir>                     Stats table: counts & sizes by extension, largest files
  forge.mjs report <dir> [--out <file>]    Standalone styled HTML report (default: report.html)
  forge.mjs todo <dir>                     List TODO / FIXME / HACK comments grouped by file
  forge.mjs --help                         Show this help

${bold('Notes:')}
  ${dim('•')} .git and node_modules directories are always excluded
  ${dim('•')} symlinks are skipped to avoid cycles
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--out') {
      flags.out = argv[++i];
      if (!flags.out) fail('--out requires a file path');
    } else if (a.startsWith('--out=')) flags.out = a.slice(6);
    else if (a.startsWith('-')) fail(`unknown option: ${a}. Try: forge.mjs --help`);
    else positional.push(a);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

if (flags.help || !command) {
  console.log(HELP);
  process.exit(command ? 0 : flags.help ? 0 : 1);
}

switch (command) {
  case 'scan':
    cmdScan(requireDir(positional[1]));
    break;
  case 'report':
    cmdReport(requireDir(positional[1]), flags.out || 'report.html');
    break;
  case 'todo':
    cmdTodo(requireDir(positional[1]));
    break;
  default:
    fail(`unknown command: "${command}". Try: forge.mjs --help`);
}
