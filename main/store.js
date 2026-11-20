'use strict';
// Preprosto shranjevanje JSON datotek. Zapis gre najprej v začasno
// datoteko in se nato preimenuje, da ob izpadu elektrike datoteka ne
// ostane napol zapisana.

const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Če je glavna datoteka poškodovana, poskusimo varnostno kopijo.
    try {
      return JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    } catch {
      return fallback;
    }
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  } catch { /* ni kritično */ }
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson };
