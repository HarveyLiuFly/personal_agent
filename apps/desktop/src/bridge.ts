export interface ConnectionInfo {
  status: 'connected' | 'error';
  models?: number;
  defaultModel?: string;
  errorCode?: string;
}
export interface SmokeInfo { status: 'passed' | 'error'; finalText?: string; threadId?: string; turnId?: string; errorCode?: string }
export interface DesktopApi {
  readonly security: { readonly sandboxed: boolean; readonly isolated: boolean };
  inspect(): Promise<ConnectionInfo>;
  runSmoke(): Promise<SmokeInfo>;
}
declare global { interface Window { personalAgent: DesktopApi } }
