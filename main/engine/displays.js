'use strict';
// Seznam zaslonov, kot jih vidi CasparCG.
//
// CasparCG izbere zaslon po zaporedni številki iz Windows funkcije
// EnumDisplayDevices. Ta vrstni red se ne ujema nujno s številkami v
// Windows nastavitvah, zato ga preberemo z istim klicem kot CasparCG in
// vsakemu zaslonu dodamo položaj, ločljivost in ime monitorja.

const { execFile } = require('child_process');

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PlayoutDisp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields; public int dmPositionX; public int dmPositionY;
    public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@
[void][PlayoutDisp]::SetProcessDPIAware()
$out = @()
$n = 0
while ($true) {
  $d = New-Object PlayoutDisp+DISPLAY_DEVICE
  $d.cb = [Runtime.InteropServices.Marshal]::SizeOf($d)
  if (-not [PlayoutDisp]::EnumDisplayDevices($null, [uint32]$n, [ref]$d, 0)) { break }
  $m = New-Object PlayoutDisp+DEVMODE
  $m.dmSize = [int16][Runtime.InteropServices.Marshal]::SizeOf($m)
  $active = (($d.StateFlags -band 1) -ne 0)
  $hasMode = [PlayoutDisp]::EnumDisplaySettings($d.DeviceName, -1, [ref]$m)
  $mon = New-Object PlayoutDisp+DISPLAY_DEVICE
  $mon.cb = [Runtime.InteropServices.Marshal]::SizeOf($mon)
  $monName = ''
  if ([PlayoutDisp]::EnumDisplayDevices($d.DeviceName, 0, [ref]$mon, 0)) { $monName = $mon.DeviceString }
  $out += [pscustomobject]@{
    index = $n; device = $d.DeviceName; adapter = $d.DeviceString; monitor = $monName;
    active = ($active -and $hasMode); primary = (($d.StateFlags -band 4) -ne 0);
    x = $m.dmPositionX; y = $m.dmPositionY; width = $m.dmPelsWidth; height = $m.dmPelsHeight;
    hz = $m.dmDisplayFrequency
  }
  $n++
}
ConvertTo-Json -InputObject @($out) -Compress
`;

/**
 * Rezervni seznam iz Electrona, če PowerShell ne deluje. Predpostavi, da je
 * prvi zaslon v seznamu Windows glavni zaslon na položaju 0,0 (običajno), zato
 * uporabi zaslon #0 in okno premakne na fizične koordinate izbranega zaslona.
 */
function fromElectron(electronScreen) {
  const primaryId = electronScreen.getPrimaryDisplay().id;
  return electronScreen.getAllDisplays().map((d, i) => {
    const r = typeof electronScreen.dipToScreenRect === 'function' ? electronScreen.dipToScreenRect(null, d.bounds) : d.bounds;
    return {
      index: 0,
      offsetX: r.x,
      offsetY: r.y,
      device: `electron:${d.id}`,
      adapter: '',
      monitor: d.label || `Zaslon ${i + 1}`,
      active: true,
      primary: d.id === primaryId,
      x: r.x, y: r.y, width: r.width, height: r.height,
      hz: Math.round(d.displayFrequency || 0),
      approx: true,
    };
  });
}

function listDisplays(electronScreen) {
  if (process.platform !== 'win32') {
    // Za razvoj na drugih sistemih: en navidezni zaslon.
    return Promise.resolve([
      { index: 0, device: 'DEV', adapter: 'Razvojni zaslon', monitor: 'Razvoj', active: true, primary: true,
        x: 0, y: 0, width: 1920, height: 1080, hz: 60 },
    ]);
  }
  return new Promise((resolve, reject) => {
    // -EncodedCommand: skripta gre v base64, da je Windows ne pokvari pri narekovajih.
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        let list = null;
        let problem = '';
        if (err) {
          problem = `${err.message} ${String(stderr || '').trim()}`.trim();
        } else {
          try {
            list = JSON.parse(stdout.trim() || '[]').filter((d) => d.active);
            if (!list.length) problem = 'PowerShell ni vrnil nobenega zaslona';
          } catch (e) {
            problem = `Nepričakovan odgovor PowerShell: ${String(stdout).slice(0, 200)}`;
          }
        }
        if (list && list.length) return resolve(list);
        if (electronScreen) {
          const fb = fromElectron(electronScreen);
          fb.problem = problem;
          return resolve(fb);
        }
        reject(new Error(problem));
      }
    );
  });
}

function describeDisplay(d) {
  const name = d.monitor && d.monitor !== 'Generic PnP Monitor' ? d.monitor : d.adapter;
  const prim = d.primary ? ', glavni' : '';
  if (d.approx) return `${d.monitor} – ${d.width}×${d.height} (položaj ${d.x}, ${d.y}${prim})`;
  return `${name} – ${d.width}×${d.height} @ ${d.hz} Hz (položaj ${d.x}, ${d.y}${prim})`;
}

module.exports = { listDisplays, describeDisplay };
