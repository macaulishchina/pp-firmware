/** One place for simulated hardware geometry and timing. These are not firmware settings. */
export const PP_PROFILE = Object.freeze({
  id: 'folotoy-ai-passport',
  screen: Object.freeze({ width: 240, height: 320 }),
  interaction: Object.freeze({ holdMs: 220, doubleMs: 300, maxRecordingSeconds: 60 }),
  simulation: Object.freeze({ recognitionMs: 800, executionMs: 2600, queuedDelayMs: 1700, playbackMs: 7000, longPlaybackMs: 12000 }),
  idleSleepMs: 120000,
  pageCharacters: 61,
  maxEvents: 24,
});
