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

function listDisplays() {
  if (process.platform !== 'win32') {
    // Za razvoj na drugih sistemih: en navidezni zaslon.
    return Promise.resolve([
      { index: 0, device: 'DEV', adapter: 'Razvojni zaslon', monitor: 'Razvoj', active: true, primary: true,
        x: 0, y: 0, width: 1920, height: 1080, hz: 60 },
    ]);
  }
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const list = JSON.parse(stdout.trim() || '[]');
          resolve(list.filter((d) => d.active));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

function describeDisplay(d) {
  const name = d.monitor && d.monitor !== 'Generic PnP Monitor' ? d.monitor : d.adapter;
  const prim = d.primary ? ', glavni' : '';
  return `${name} – ${d.width}×${d.height} @ ${d.hz} Hz (položaj ${d.x}, ${d.y}${prim})`;
}

module.exports = { listDisplays, describeDisplay };
