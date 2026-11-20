// Diagnostika: izpiše surov izhod PowerShell skripte za zaslone.
const { execFile } = require('child_process');
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'engine', 'displays.js'), 'utf8');
const script = /String\.raw`([\s\S]*?)`;/.exec(src)[1].replace("ConvertTo-Json -InputObject @($out) -Compress", "$out | Format-List | Out-String -Width 200\nConvertTo-Json -InputObject @($out) -Compress");
const enc = Buffer.from(script, 'utf16le').toString('base64');
execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], (err, out, errOut) => {
  console.log('ERR', err && err.message);
  console.log('STDOUT', out);
  console.log('STDERR', errOut);
});
