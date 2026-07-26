/**
 * Preload bridge.
 *
 * This is the complete list of things the UI is allowed to do. The renderer
 * has no Node access and no `require`; it can only call the functions exposed
 * here. Adding a capability means adding it to this file deliberately — that
 * keeps a UI bug from becoming a filesystem bug.
 *
 * Note there is no generic "invoke any channel" escape hatch.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type Unsubscribe = () => void;

/**
 * Forward a main-process channel to a renderer callback. The event object is
 * deliberately NOT passed on — it carries a `sender` handle that would let the
 * renderer reach channels this bridge never meant to expose.
 */
function subscribe(channel: string, handler: (payload: unknown) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('forge', {
  // --- state ---
  getState: () => ipcRenderer.invoke('app:state'),
  getTranscript: () => ipcRenderer.invoke('app:transcript'),
  getCost: () => ipcRenderer.invoke('app:cost'),
  getSessions: (opts?: { archived?: boolean }) => ipcRenderer.invoke('app:sessions', opts),
  getProjects: () => ipcRenderer.invoke('app:projects'),
  getChanges: () => ipcRenderer.invoke('app:changes'),
  getKeyStatus: () => ipcRenderer.invoke('app:keyStatus'),

  // --- running ---
  prompt: (text: string) => ipcRenderer.invoke('app:prompt', text),
  retry: () => ipcRenderer.invoke('app:retry'),
  interrupt: () => ipcRenderer.invoke('app:interrupt'),
  answerPermission: (id: string, decision: unknown) =>
    ipcRenderer.invoke('app:permission', id, decision),

  // --- model & modes ---
  setModel: (spec: string) => ipcRenderer.invoke('app:setModel', spec),
  setTier: (tier: string, modelKey: string) => ipcRenderer.invoke('app:setTier', tier, modelKey),
  setPermissionMode: (mode: string) => ipcRenderer.invoke('app:setPermissionMode', mode),

  // --- sessions & projects ---
  newSession: () => ipcRenderer.invoke('app:newSession'),
  clear: () => ipcRenderer.invoke('app:clear'),
  resume: (id: string) => ipcRenderer.invoke('app:resume', id),
  archiveSession: (id: string) => ipcRenderer.invoke('app:archiveSession', id),
  unarchiveSession: (id: string) => ipcRenderer.invoke('app:unarchiveSession', id),
  deleteSession: (id: string) => ipcRenderer.invoke('app:deleteSession', id),
  pinSession: (id: string, pinned: boolean) => ipcRenderer.invoke('app:pinSession', id, pinned),
  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke('app:renameSession', id, title),
  openProject: () => ipcRenderer.invoke('app:openProject'),
  openProjectPath: (cwd: string) => ipcRenderer.invoke('app:openProjectPath', cwd),

  // --- changes ---
  revertFile: (path: string) => ipcRenderer.invoke('app:revertFile', path),
  restoreFile: (path: string) => ipcRenderer.invoke('app:restoreFile', path),
  revertAll: () => ipcRenderer.invoke('app:revertAll'),
  commit: (message: string) => ipcRenderer.invoke('app:commit', message),

  // --- keys & misc ---
  saveKey: (provider: string, key: string) => ipcRenderer.invoke('app:saveKey', provider, key),
  testKey: (provider: string, key: string) => ipcRenderer.invoke('app:testKey', provider, key),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),

  // --- streams ---
  onEvent: (handler: (event: unknown) => void) => subscribe('agent:event', handler),
  onPermission: (handler: (payload: unknown) => void) => subscribe('permission:request', handler),
  onState: (handler: (state: unknown) => void) => subscribe('agent:state', handler),
  onQueuedDispatch: (handler: (payload: unknown) => void) =>
    subscribe('agent:queued-dispatch', handler),
});
