import { Menu, Tray, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

/** 32px app mark. Inline so packaging needs no extra asset path. */
const icon =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEa0lEQVR42s1XX4hUZRT/nXO+e2fu7M4OLo7r5oYk00O7ayQTlmQgYSmV0ss89VBPQRFBBIFFRU9C0GOFuVYUQrHUQxgoGa4kaNqwPqyr1u1By8W/7ai77r0z9/tODzuzbeb+cWelDhy4F+79zu8753f+EaZJqVSS/v5+23gvFou5q3JV0YTkbI7K5fLVmWzQtG8FgEURXi96XyOlR4noYeecKikvxDgpOWYmVT2ipD8OYeh9lFGbstUA0EDV+0Dv4+zx68Ky0VoL1aYu/zcQIogIrLP7Xc29N3R86PuGTWo8dBe71xsyAyCITWyNQAwCLwoChVOoEyMeFDbRZMNwefhQqVQSBoDC2kIbO95OROKsqxKRB4LUPdS8EoSIvPrZwo63F9YW2gBAhoeHdUXHihc933shSZIqAB93TkRVq57v3SOJXDzww4HDXNhcSCl0k7XW1ckxayxn0tsBYa11Ct1U2FxIGXfJpRW6QVUZwIysc87NSEoiAjNDRGb9ri6sqqTQDe6SSxsWVkpoHEB6tr+CIIAx5lYEg3UWURShUqkgCAL4vg/n3OyZARpnYTWTZygTbu1GJsaN6AbefuNNPLl5C6LoOoQFjTRVAHEc4/yFCzh67Bi++rofIyMjyGQys4JQTNYWM9/ABUGAlpYW+B7BGAPif3K1q+tuPFh8CFuf3oKXX30FwydPIgiCOT0xbwCN2FprkSQJ+r/ZjT9HR+H7Ph5Ztw6re+/HxI1r6OpaiXffegfPPv8crLOYybO3DWA62Wq1Gnb09SH8LYSf8tGR78BnfbvQc18P4ug6erq7sbq3Bz+Xy3OGYsGVrr29HflleXQu78TlK5dx5KcjIDaw1kFEcNfyTiRJMmeKmoUCiOMYURQDCiRJgvzSpVNegiomogjENGc/WTCAbLYVuWwbUukUntm6FRsf24hqPA7P83B9bAwnT5+C76cWH4BzDr7vY+eHH8FZB2LGklwOThUggjFpfN63E2fPnkVra+viZcHNZGxv77iJTDVcuTKKL3Z/gI8/2YVMJjOvdm4WYjxJEuz+8lOMVkYhzIjiGOdGRjB4fBC/n/sDLZkWENGdBbBjVx/C8Fek0pMV3BiDdCqFbGt2Pv2geRK2L1mCfD6PVCoFdQ5a58dcMW+qEiZJ8i8VkaZGt3kBUFVks1kYY2BMbrKpiyzKhGLqrdHNZtwzHr7dswenfwlhbQ3OWlQqlaZu37BJq4qrcoEG55k4rZOn0a2INzY2hmq1CtBke2lrawPzgiq5EhE5ddEETSw3nOeILtIAET1RByAzhWC6wSbGdkdEREoDnOeIw71hTKB9IsKNZWE+JGyCeFZEmED7wr1hTKVSSQbPDLaka+nvxMh6a+2dnIyrIuLbxB6KvOipNSvXjDMAhEfDa47dNlW1LOyrag0KWx9Sm1eFVdVa/Wzr2G0Lj4bXpvaCUqkkB/cfPJNflj9MQp2e8e6tzwq0GMLM7HmeqOp+l7iXTgyeGJhazf4Xy+l/uZ7/BZvmdiorFtc5AAAAAElFTkSuQmCC';
let tray: Tray | undefined;

/**
 * Linux/Windows have no Dock: once the last window closes while the Main process keeps
 * running background work, the tray is the only visible way back in (or out).
 * GNOME needs the AppIndicator extension to show it; `pnpm dev` again also re-opens the window.
 */
export function installBackgroundTray(
  items: MenuItemConstructorOptions[],
  onClick: () => void,
): boolean {
  if (process.platform === 'darwin' || tray) return Boolean(tray);
  try {
    tray = new Tray(nativeImage.createFromDataURL(icon));
    tray.setToolTip('Personal Agent');
    tray.setContextMenu(Menu.buildFromTemplate(items));
    tray.on('click', onClick);
    return true;
  } catch {
    tray = undefined;
    return false;
  }
}
export function destroyBackgroundTray() {
  tray?.destroy();
  tray = undefined;
}
