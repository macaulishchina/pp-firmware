/** Conservative whole-row pages for the simulated 240×320 screen, including blank lines. */
export function textPages(text, columns = 13, rows = 8) {
  const pages = [];
  let page = '', line = 1, width = 0;
  const flush = () => { if (page) pages.push(page); page = ''; line = 1; width = 0; };
  for (const char of Array.from(text)) {
    if (char === '\r') continue;
    if (char === '\n') {
      page += char;
      if (line === rows) flush();
      else { line++; width = 0; }
      continue;
    }
    const advance = char.codePointAt(0) > 127 ? 1 : 0.6;
    if (width + advance > columns) {
      if (line === rows) flush();
      else { line++; width = 0; }
    }
    page += char; width += advance;
  }
  flush();
  return pages.length ? pages : [''];
}
