import {BrowserWindow} from 'electron';
import {resolve} from 'node:path';
/** Reopening a GUI never reconstructs the execution Owner or its services. */
export async function createDesktopWindow(directory:string,documentPath:string,documentUrl:string,onCreated:(window:BrowserWindow)=>void,onClosed:(window:BrowserWindow)=>void):Promise<BrowserWindow>{
 const window=new BrowserWindow({width:1120,height:760,backgroundColor:'#0c1221',show:true,webPreferences:{preload:resolve(directory,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:false}});
 onCreated(window);window.once('closed',()=>onClosed(window));
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event,url)=>{if(url!==documentUrl)event.preventDefault();});
 window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 window.webContents.session.setPermissionCheckHandler(()=>false);
 window.webContents.on('will-attach-webview',event=>event.preventDefault());
 try{await window.loadFile(documentPath);return window;}catch(error){window.destroy();throw error;}
}
