// Synthetic PCM envelope. The screen uses the same five-bar meter as the terminal.
export function demoVoiceLevel(seconds) {
  const phrase = seconds % 5.6;
  if (phrase > 4.4) return .035;
  return .24 + .6 * (.5 + .5 * Math.sin(seconds * 3.1)) ** .8;
}

let recordingAudio;

export function prepareRecordingCues() {
  if (!globalThis.AudioContext) return;
  try {
    recordingAudio ??= new AudioContext();
    if (recordingAudio.state !== 'running') void recordingAudio.resume().catch(() => {});
  } catch {
    // Browser audio restrictions never prevent the simulated gesture.
  }
}

export function playRecordingCue(opening, volume) {
  if (recordingAudio?.state !== 'running' || !volume) return;
  const now = recordingAudio.currentTime;
  const tone = recordingAudio.createOscillator();
  const envelope = recordingAudio.createGain();
  tone.frequency.setValueAtTime(opening ? 720 : 980, now);
  tone.frequency.linearRampToValueAtTime(opening ? 1120 : 590, now + .032);
  envelope.gain.setValueAtTime(0, now);
  envelope.gain.linearRampToValueAtTime(.125 * volume / 100, now + .004);
  envelope.gain.setValueAtTime(.125 * volume / 100, now + .022);
  envelope.gain.linearRampToValueAtTime(0, now + .032);
  tone.connect(envelope);
  envelope.connect(recordingAudio.destination);
  tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
  tone.start();
  tone.stop(now + .032);
}
