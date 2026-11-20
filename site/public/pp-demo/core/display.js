// Display coordinates and palette mirror PA-Terminal's ui.c.
const WIDTH = 240, HEIGHT = 320, TEXT_WIDTH = 216;
const batteryX = 200, batteryY = 9, batteryWidth = 25, batteryHeight = 13;
const wifiPulse = ['#526158', '#839278', '#b6cfa4', '#839278'];
const colors = {
  screen: '#172923', text: '#e6eddf', rule: '#34443c', origin: '#b6cfa4',
  state: '#9aaa99', footer: '#b3bfb0', task: '#a7c7e8',
};

function loadImage(url) {
  const image = new Image();
  image.src = url;
  return image.decode().then(() => image);
}

const asset = name => new URL(`../display/${name}`, import.meta.url);
const glyphFor = (font, char) => font.glyphs[char.codePointAt(0)] || font.glyphs[63];
const advance = (font, char) => glyphFor(font, char)?.[6] ?? 16;

function lines(text, font, width = TEXT_WIDTH) {
  const result = [''];
  let used = 0;
  for (const character of text) {
    if (character === '\r') continue;
    const char = character === '\t' ? ' ' : character;
    const step = char === '\n' ? 0 : advance(font, char);
    if (char === '\n' || (used && used + step > width)) {
      result.push('');
      used = 0;
    }
    if (char !== '\n') {
      result[result.length - 1] += char;
      used = Math.min(width, used + step);
    }
  }
  return result;
}

export async function mountDisplay(canvas) {
  const [fonts, open, blink, inputOpen, inputBlink] = await Promise.all([
    fetch(asset('fonts.json')).then(response => {
      if (!response.ok) throw new Error('未能加载固件字形');
      return response.json();
    }),
    ...['cat_idle_open', 'cat_idle_blink', 'cat_input_open', 'cat_input_blink']
      .map(name => loadImage(asset(`${name}.png`))),
  ]);
  await Promise.all(Object.entries(fonts).map(async ([id, font]) => {
    font.atlas = await loadImage(asset(`font-${id}.png`));
  }));
  const context = canvas.getContext('2d', { alpha: false });
  const mask = document.createElement('canvas');
  mask.width = WIDTH;
  mask.height = HEIGHT;
  const stencil = mask.getContext('2d');
  const thumbnails = new Map();
  const started = performance.now();
  let frame, level = 0;

  function label(value, x, y, w, h, {
    color = colors.text, font = fonts[16], center = false, dots = false,
  } = {}) {
    if (!value) return;
    let rows = lines(value, font, w);
    if (dots && rows.length > 1) {
      const chars = Array.from(rows[0]);
      let used = chars.reduce((sum, char) => sum + advance(font, char), 0);
      const ellipsis = 3 * advance(font, '.');
      while (chars.length && used + ellipsis > w) used -= advance(font, chars.pop());
      rows = [chars.join('') + '...'];
    }
    stencil.clearRect(0, 0, w, h);
    stencil.save();
    stencil.beginPath();
    stencil.rect(0, 0, w, h);
    stencil.clip();
    const lineHeight = font.height + 1;
    for (let row = 0; row < rows.length && row * lineHeight < h; row++) {
      const chars = Array.from(rows[row]);
      let left = center ? Math.floor((w - chars.reduce((sum, c) => sum + advance(font, c), 0)) / 2) : 0;
      for (const char of chars) {
        const glyph = glyphFor(font, char);
        if (!glyph) { left += 16; continue; }
        const [sx, sy, gw, gh, dx, dy, step] = glyph;
        const top = row * lineHeight + font.height - font.baseline - gh - dy;
        if (gw && gh) stencil.drawImage(font.atlas, sx, sy, gw, gh, left + dx, top, gw, gh);
        left += step;
      }
    }
    stencil.globalCompositeOperation = 'source-in';
    stencil.fillStyle = color;
    stencil.fillRect(0, 0, w, h);
    stencil.restore();
    context.drawImage(mask, 0, 0, w, h, x, y, w, h);
  }

  function rect(x, y, w, h, color, radius = 0) {
    context.fillStyle = color;
    if (!radius) { context.fillRect(x, y, w, h); return; }
    context.beginPath();
    context.roundRect(x, y, w, h, radius);
    context.fill();
  }

  function batteryIcon(level) {
    const percent = Number.isFinite(level) && level >= 0 ? Math.min(100, Math.trunc(level)) : -1;
    const filled = percent > 0 ? Math.max(1, Math.floor(percent * batteryWidth / 100)) : 0;
    const value = percent < 0 ? '--' : String(percent);
    const font = fonts.battery;
    const numberY = batteryY + Math.floor((batteryHeight - font.height) / 2);
    rect(batteryX + batteryWidth + 1, batteryY + 4, 2, 5, '#718479', 1);
    rect(batteryX, batteryY, batteryWidth, batteryHeight, '#46594f', 3);
    if (filled) {
      context.save();
      context.beginPath();
      context.rect(batteryX, batteryY, filled, batteryHeight);
      context.clip();
      rect(batteryX, batteryY, batteryWidth, batteryHeight, percent <= 20 ? '#ed817a' : '#dce8da', 3);
      label(value, batteryX, numberY, batteryWidth, font.height,
        { font, center: true, color: colors.screen });
      context.restore();
    }
    if (filled < batteryWidth) {
      context.save();
      context.beginPath();
      context.rect(batteryX + filled, batteryY, batteryWidth - filled, batteryHeight);
      context.clip();
      label(value, batteryX, numberY, batteryWidth, font.height,
        { font, center: true, color: percent === 0 ? '#ffc4be' : '#f1f5ed' });
      context.restore();
    }
  }

  function thumbnail(source) {
    if (!thumbnails.has(source)) {
      thumbnails.set(source, null);
      loadImage(new URL(source, document.baseURI)).then(image => {
        thumbnails.set(source, image);
        if (frame?.image?.src === source) paint();
      }).catch(() => { thumbnails.set(source, null); });
    }
    const image = thumbnails.get(source);
    if (!image) return;
    const scale = Math.min(1, 216 / image.width, 144 / image.height);
    const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
    context.drawImage(image, Math.floor((WIDTH - w) / 2), 72 + Math.floor((144 - h) / 2), w, h);
  }

  function paint() {
    if (!frame) return;
    const { view, state, hint, origin, body, volume, clock, battery, rssi, queue, task,
      choices, selection, menuDetail, volumeFeedback, elapsed, signal, brightness, textSize, follow, image,
      awaitingReply, wifiSearching, menuGrid } = frame;
    rect(0, 0, WIDTH, HEIGHT, view === 'sleep' ? '#000' : colors.screen);
    if (view === 'sleep') return;
    const symbol = (code, x, y, w, h, color, center = false) =>
      label(String.fromCodePoint(code), x, y, w, h, { font: fonts.symbols, color, center });
    label(clock, 12, 6, 65, 21);
    symbol(volume === 0 ? 0xf026 : volume < 55 ? 0xf027 : 0xf028, 144, 8, 20, 17, colors.text);
    const wifiColor = wifiSearching ? wifiPulse[Math.floor(performance.now() / 240) % wifiPulse.length]
      : rssi > -70 ? colors.origin : rssi > -90 ? '#839278' : '#526158';
    symbol(0xf1eb, 172, 8, 20, 17, wifiColor);
    batteryIcon(battery);
    rect(12, 29, 216, 1, colors.rule);
    rect(12, 288, 216, 1, colors.rule);

    const input = view === 'input';
    if (input || view === 'idle') {
      const time = (performance.now() - started) % 11000;
      const closed = (time > 4200 && time < 4350) || (time > 8500 && time < 8620);
      context.drawImage(input ? (closed ? inputBlink : inputOpen) : (closed ? blink : open),
        input ? 90 : 60, input ? 35 : 88);
    }
    level = (level * 3 + (signal || 0)) / 4;
    if (input && elapsed && signal) [5, 9, 12, 9, 5].forEach((weight, i) => {
      const h = 2 + Math.floor(level * weight);
      rect(101 + i * 8, 114 - Math.floor(h / 2), 3, h, colors.origin, 2);
    });
    if (view !== 'idle') label(input ? '你说的' : origin, 12, input ? 123 : 38, 216, 22,
      { color: task ? colors.task : colors.origin, dots: true });
    if (view === 'menu') {
      const first = Math.max(0, selection - 6);
      choices.slice(first, first + 7).forEach((choice, i) => {
        const selected = first + i === selection;
        const tile = menuGrid && i < 4;
        const x = tile ? 18 + i % 2 * 106 : 18;
        const y = tile ? 66 + Math.floor(i / 2) * 66 : menuGrid ? 198 + (i - 4) * 29 : 61 + i * 29;
        const w = tile ? 98 : 204;
        if (tile || selected) rect(x, y, w, tile ? 58 : 26,
          task ? '#263c47' : menuGrid ? selected ? '#355843' : '#233c30' : '#2a3c31', 4);
        label(choice, x + 6, y + (tile ? 18 : 3), w - (tile ? 12 : 6), 23, { dots: true, center: menuGrid });
      });
      if (menuDetail) label(menuDetail, 18, 222, TEXT_WIDTH, 28,
        { font: fonts[textSize === 18 ? 18 : 16], color: colors.state });
    } else if (view === 'brightness') {
      label(body, 12, 111, TEXT_WIDTH, 33, { font: fonts[18], center: true });
      rect(36, 170, 168, 6, colors.rule, 2);
      if (brightness > 40) rect(36, 170, Math.floor((brightness - 40) * 168 / 60), 6, colors.origin, 2);
    } else if (view === 'image' && image) thumbnail(image.src);
    else if (view !== 'idle') {
      const font = fonts[textSize === 18 ? 18 : 16];
      const h = input ? 110 : 198;
      const count = Math.floor(h / (font.height + 1));
      const bodyLines = lines(body, font);
      const visible = (input || follow ? bodyLines.slice(-count) : bodyLines.slice(0, count)).join('\n');
      label(visible, 12, input ? 145 : 66, TEXT_WIDTH, h, { font });
    }
    label(volumeFeedback ? `音量 ${volume}` : input && elapsed ? `${elapsed.toFixed(1)} 秒` : state,
      12, 265, 216, 21, { color: volumeFeedback ? colors.origin : colors.state });
    if (volumeFeedback) {
      rect(108, 274, 120, 4, colors.rule, 2);
      if (volume) rect(108, 274, Math.floor(volume * 120 / 100), 4, colors.origin, 2);
    } else if (awaitingReply) {
      const activeDot = Math.floor(performance.now() / 240) % 3;
      for (let i = 0; i < 3; i++)
        rect(86 + i * 9, 273, 4, 4, i === activeDot ? colors.origin : '#526158', 2);
    }
    label(hint, 12, 294, 196, 22, { color: colors.footer });
    symbol(queue ? 0xf00b : 0xf8a2, 212, 297, 18, 17, colors.text);
    if (brightness < 65) rect(0, 0, WIDTH, HEIGHT, `rgba(0,0,0,${(65 - brightness) / 110})`);
    if (brightness > 65) rect(0, 0, WIDTH, HEIGHT, `rgba(255,255,255,${(brightness - 65) / 230})`);
  }

  // Repaint only while the avatar or Wi-Fi indicator is animated.
  setInterval(() => { if (frame && (frame.wifiSearching || ['idle', 'input'].includes(frame.view))) paint(); }, 60);
  return {
    render(next) { frame = next; paint(); },
    pages(text, size) {
      const font = fonts[size === 18 ? 18 : 16];
      const rows = lines(text, font);
      const count = Math.floor(198 / (font.height + 1));
      return Array.from({ length: Math.ceil(rows.length / count) }, (_, i) =>
        rows.slice(i * count, (i + 1) * count).join('\n'));
    },
  };
}
