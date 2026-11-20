'use strict';
// Okno aplikacije ve, da teče v namizni aplikaciji (in ne na tablici),
// in lahko prebere pot do datotek, ki jih uporabnik povleče v okno.
const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('playoutDesktop', {
  isDesktop: true,
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
