'use strict';
// Prenese uradno Windows izdajo CasparCG Server in jo razpakira v vendor/casparcg.
// Teče v GitHub Actions na Windows (uporablja vgrajeni "tar" za razpakiranje).
// Doda še knjižnice Microsoft Visual C++ (app-local), da uporabniku ni treba
// nameščati ničesar posebej.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CASPAR_TAG = process.env.CASPAR_TAG || 'v2.5.1-stable';
const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const TARGET = path.join(VENDOR, 'casparcg');

async function gh(url) {
  const headers = { 'User-Agent': 'playout-build', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

function findExeDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'casparcg.exe') return dir;
    if (entry.isDirectory()) {
      const found = findExeDir(p);
      if (found) return found;
    }
  }
  return null;
}

function copyCrt() {
  // Poiščemo Microsoft.VC14x.CRT v namestitvi Visual Studia (na GitHub Windows strežniku).
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (!fs.existsSync(vswhere)) {
    console.warn('vswhere ni najden, preskočim VC++ knjižnice');
    return;
  }
  const vsPath = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
  const redistRoot = path.join(vsPath, 'VC', 'Redist', 'MSVC');
  const versions = fs.readdirSync(redistRoot).filter((v) => /^\d+\./.test(v)).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }));
  for (const v of versions.reverse()) {
    const x64 = path.join(redistRoot, v, 'x64');
    if (!fs.existsSync(x64)) continue;
    const crt = fs.readdirSync(x64).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d));
    if (!crt) continue;
    const src = path.join(x64, crt);
    for (const f of fs.readdirSync(src)) {
      const dst = path.join(TARGET, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(src, f), dst);
    }
    console.log(`VC++ knjižnice ${v} (${crt}) kopirane.`);
    return;
  }
  console.warn('VC++ CRT ni najden');
}

async function main() {
  if (fs.existsSync(path.join(TARGET, 'casparcg.exe'))) {
    console.log('CasparCG je že pripravljen v', TARGET);
    return;
  }
  const rel = await (await gh(`https://api.github.com/repos/CasparCG/server/releases/tags/${CASPAR_TAG}`)).json();
  const assets = rel.assets || [];
  console.log('Datoteke v izdaji:', assets.map((a) => a.name).join(', '));
  const asset =
    assets.find((a) => /win/i.test(a.name) && /\.(zip|7z)$/i.test(a.name) && !/pdb|debug|symbols/i.test(a.name)) ||
    assets.find((a) => /\.(zip|7z)$/i.test(a.name) && !/linux|ubuntu|noble|jammy|pdb|debug|source/i.test(a.name));
  if (!asset) throw new Error('Windows arhiv v izdaji CasparCG ni najden');

  fs.mkdirSync(VENDOR, { recursive: true });
  const zipPath = path.join(VENDOR, asset.name);
  console.log('Prenašam', asset.browser_download_url);
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'playout-build' } });
  if (!res.ok) throw new Error(`Prenos ni uspel: HTTP ${res.status}`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  const extractDir = path.join(VENDOR, 'extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  if (/\.7z$/i.test(zipPath)) {
    execFileSync('7z', ['x', '-y', `-o${extractDir}`, zipPath], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' });
  }

  const exeDir = findExeDir(extractDir);
  if (!exeDir) throw new Error('casparcg.exe ni najden v arhivu');
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.cpSync(exeDir, TARGET, { recursive: true });
  // Privzeta konfiguracija in zagonska skripta nista potrebni (aplikacija ustvari svojo).
  for (const f of ['casparcg.config', 'casparcg_auto_restart.bat']) {
    fs.rmSync(path.join(TARGET, f), { force: true });
  }
  fs.writeFileSync(path.join(TARGET, 'PLAYOUT_CASPAR_VERSION.txt'), `${CASPAR_TAG}\n${asset.name}\n`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });

  if (process.platform === 'win32') copyCrt();
  console.log('CasparCG pripravljen v', TARGET);
  console.log(fs.readdirSync(TARGET).join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
