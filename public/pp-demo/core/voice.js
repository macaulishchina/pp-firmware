// Synthetic PCM envelope. The screen uses the same five-bar meter as the terminal.
export function demoVoiceLevel(seconds) {
  const phrase = seconds % 5.6;
  if (phrase > 4.4) return .035;
  return .24 + .6 * (.5 + .5 * Math.sin(seconds * 3.1)) ** .8;
}
