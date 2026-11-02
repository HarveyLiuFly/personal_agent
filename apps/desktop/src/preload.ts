import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from './bridge.ts';

const api: DesktopApi = Object.freeze({
  security: Object.freeze({ sandboxed: process.sandboxed === true, isolated: process.contextIsolated === true }),
  inspect: () => ipcRenderer.invoke('runtime:inspect'),
  runSmoke: () => ipcRenderer.invoke('runtime:smoke'),
});
contextBridge.exposeInMainWorld('personalAgent', api);
