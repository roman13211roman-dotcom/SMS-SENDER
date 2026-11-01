/**
 * preload.js — безпечно "прокидає" у вікно (renderer) обмежений набір
 * функцій для спілкування з головним процесом (main.js) через IPC.
 * Renderer НІКОЛИ не має прямого доступу до Node.js/Playwright —
 * лише через ці канали. Усі дії над акаунтом приймають його id.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Налаштування (мова, список акаунтів з їхніми текстами/групами/часом)
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  getLimits: () => ipcRenderer.invoke('meta:limits'),

  // Статистика: { total, perAccount: { [id]: count } }
  loadStats: () => ipcRenderer.invoke('stats:load'),

  // Акаунти
  loadSessions: () => ipcRenderer.invoke('accounts:sessions'),
  deleteAccount: (id) => ipcRenderer.invoke('account:delete', id),

  // Зображення
  selectImage: () => ipcRenderer.invoke('image:select'),

  // Логін
  startLogin: (id) => ipcRenderer.invoke('login:start', id),
  confirmLogin: (id) => ipcRenderer.invoke('login:confirm', id),
  cancelLogin: (id) => ipcRenderer.invoke('login:cancel', id),

  // Публікація
  startPublish: (payload) => ipcRenderer.invoke('publish:start', payload),
  stopPublish: (id) => ipcRenderer.invoke('publish:stop', id),
  pausePublish: (id) => ipcRenderer.invoke('publish:pause', id),
  resumePublish: (id) => ipcRenderer.invoke('publish:resume', id),

  // Верифікація груп та постійний чорний список (лише читання)
  loadBlacklist: (id) => ipcRenderer.invoke('blacklist:list', id),
  revealShots: (id) => ipcRenderer.invoke('trace:reveal', id),
  resetBlacklist: (id) => ipcRenderer.invoke('blacklist:reset', id),
  revealBlacklist: (id) => ipcRenderer.invoke('blacklist:reveal', id),
  loadWorklist: (id) => ipcRenderer.invoke('worklist:list', id),
  loadVerify: () => ipcRenderer.invoke('verify:load'),
  importGroups: () => ipcRenderer.invoke('groups:import'),
  onVerifyUpdate: (callback) =>
    ipcRenderer.on('verify:update', (_event, id, url, entry) => callback(id, url, entry)),

  loadResults: () => ipcRenderer.invoke('results:load'),
  clearResults: (id) => ipcRenderer.invoke('results:clear', id),
  getWarmupInfo: (payload) => ipcRenderer.invoke('warmup:info', payload),
  getTodayKey: () => ipcRenderer.invoke('warmup:today'),
  previewText: (text) => ipcRenderer.invoke('text:preview', text),

  // Підписки на події з main process → renderer
  onLog: (callback) => ipcRenderer.on('log', (_event, id, msg) => callback(id, msg)),
  onProgress: (callback) =>
    ipcRenderer.on('progress', (_event, id, done, total) => callback(id, done, total)),
  onPublishFinished: (callback) => ipcRenderer.on('publish:finished', (_event, id) => callback(id)),
  onStatus: (callback) =>
    ipcRenderer.on('account:status', (_event, id, state, extra) => callback(id, state, extra)),
  onResultUpdate: (callback) =>
    ipcRenderer.on('results:update', (_event, id, url, entry) => callback(id, url, entry)),
  onAccountBlocked: (callback) =>
    ipcRenderer.on('account:blocked', (_event, id, reason) => callback(id, reason)),
  onActivityCounts: (callback) =>
    ipcRenderer.on('activity:counts', (_event, id, counts) => callback(id, counts)),
  onStatsUpdate: (callback) => ipcRenderer.on('stats:update', (_event, stats) => callback(stats)),
});
