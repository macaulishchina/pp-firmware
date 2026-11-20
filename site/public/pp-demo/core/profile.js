/** One place for simulated hardware geometry and timing. These are not firmware settings. */
export const PP_PROFILE = Object.freeze({
  id: 'folotoy-ai-passport',
  screen: Object.freeze({ width: 240, height: 320 }),
  interaction: Object.freeze({ holdMs: 200, doubleMs: 300, arrowHoldMs: 650, maxRecordingSeconds: 60 }),
  wifi: Object.freeze({ attempts: 3, retryMs: 60_000, attemptMs: 850 }),
  simulation: Object.freeze({ recognitionMs: 800, executionMs: 2600, responseCharactersPerSecond: 22, speechCharactersPerSecond: 6, automaticSpeechCharacters: 200 }),
  idleSleepMs: 120000,
  maxEvents: 24,
});
