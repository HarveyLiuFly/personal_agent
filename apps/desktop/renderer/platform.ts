/** Renderer-side platform labels. The sandboxed renderer has no `process`; use the UA platform. */
export type HostPlatform='mac'|'windows'|'linux';

export function hostPlatform(source:string=typeof navigator==='undefined'?'':navigator.platform||navigator.userAgent):HostPlatform{
 if(/Mac|iPhone|iPad/i.test(source))return 'mac';
 if(/Win/i.test(source))return 'windows';
 return 'linux';
}

/** Keyboard hint for a Cmd/Ctrl shortcut, e.g. "⌘ N" on macOS, "Ctrl N" elsewhere. */
export function shortcutLabel(key:string,platform:HostPlatform=hostPlatform()):string{
 return (platform==='mac'?'⌘ ':'Ctrl ')+key.toUpperCase();
}

/** Name of the system file manager for "reveal in folder" actions. */
export function fileManagerLabel(platform:HostPlatform=hostPlatform()):string{
 return platform==='mac'?'Finder':platform==='windows'?'资源管理器':'文件管理器';
}
