import { contextBridge, ipcRenderer } from 'electron'

const api = {
  readScreenshot: (path: string) => ipcRenderer.invoke('screenshot:read', path),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectsSave: (name: string, data: unknown) => ipcRenderer.invoke('projects:save', name, data),
  projectsLoad: (name: string) => ipcRenderer.invoke('projects:load', name),
  projectsDelete: (name: string) => ipcRenderer.invoke('projects:delete', name),
  fillRun: (req: unknown, runId: string) => ipcRenderer.invoke('fill:run', req, runId),
  fillStop: (runId: string) => ipcRenderer.invoke('fill:stop', runId),
  fillLoginLink: (runId: string, url: string | null) => ipcRenderer.invoke('fill:login-link', runId, url),
  onFillProgress: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('fill:progress', listener)
    return () => {
      ipcRenderer.removeListener('fill:progress', listener)
    }
  },
  onFillNeedLogin: (cb: (runId: string, url: string) => void) => {
    const listener = (_e: unknown, runId: string, url: string): void => cb(runId, url)
    ipcRenderer.on('fill:need-login', listener)
    return () => {
      ipcRenderer.removeListener('fill:need-login', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
