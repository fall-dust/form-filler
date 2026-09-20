export { runFill, type FillHooks, type FillOutcome, type ReusableSession } from './engine'
export {
  launchBrowser,
  openPageAt,
  type LaunchConfig,
  type LaunchedBrowser
} from './browser'
export { similarity, bestMatch } from './similarity'
export { loadState, saveState, resetState, type FieldState } from './state'
export { writeReport, screenshotOnFail } from './report'
export {
  getLiveSession,
  setSession,
  closeSession,
  closeAllSessions,
  hasLiveSession,
  ensureSession,
  type FillSession
} from './session'
export {
  grabCurrentHtml,
  waitForGrabReady,
  readyHint,
  type GrabResult,
  type ReadyProbe
} from './grab'
export {
  detectNextButtons,
  clickNextButton,
  type NextButton,
  type NextClickTarget,
  type NextClickResult
} from './next-button'
export * from './types'
