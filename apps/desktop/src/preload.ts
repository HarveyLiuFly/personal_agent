import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from './bridge.ts';

const api: DesktopApi = Object.freeze<DesktopApi>({
  security: Object.freeze({ sandboxed: process.sandboxed === true, isolated: process.contextIsolated === true }),
  inspect: () => ipcRenderer.invoke('runtime:inspect'),
  runSmoke: () => ipcRenderer.invoke('runtime:smoke'),
  chooseProject: () => ipcRenderer.invoke('history:chooseProject'),
  listThreads: query => ipcRenderer.invoke('history:listThreads', query),
  listTurns: query => ipcRenderer.invoke('history:listTurns', query),
  listItems: query => ipcRenderer.invoke('history:listItems', query),
});
contextBridge.exposeInMainWorld('personalAgent', api);
