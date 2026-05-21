const DEFAULT_MIN_FONT_SIZE = 8;
const DEFAULT_MAX_FONT_SIZE = 170;
const DEFAULT_LINE_HEIGHT = 1;
const FIT_EPSILON = 0.01;

function clampFontSize(value, fallback) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : fallback;
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .join('\n')
    .trim();
}

function splitWords(paragraph) {
  return paragraph.trim().split(/\s+/).filter(Boolean);
}

function longestLineWidth(lines, measureText, fontSize) {
  return lines.reduce((max, line) => Math.max(max, measureText(line, fontSize)), 0);
}

export function wrapTextToWidth(text, { width, fontSize, measureText, multiLine = true }) {
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('wrapTextToWidth requires a positive width.');
  }
  if (typeof measureText !== 'function') {
    throw new Error('wrapTextToWidth requires a measureText(text, fontSize) function.');
  }

  const normalized = normalizeText(text);
  if (!normalized) return [''];

  if (!multiLine) {
    return normalized.replace(/\n+/g, ' ').split('\n');
  }

  const lines = [];
  for (const paragraph of normalized.split('\n')) {
    const words = splitWords(paragraph);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';
    for (const word of words) {
      const nextLine = line ? `${line} ${word}` : word;
      if (!line || measureText(nextLine, fontSize) <= width + FIT_EPSILON) {
        line = nextLine;
        continue;
      }

      lines.push(line);
      line = word;
    }

    if (line) lines.push(line);
  }

  return lines.length > 0 ? lines : [''];
}

export function fitTextToBox(text, options) {
  const {
    width,
    height,
    measureText,
    multiLine = true,
    widthOnly = false,
    lineHeight = DEFAULT_LINE_HEIGHT
  } = options ?? {};

  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('fitTextToBox requires a positive width.');
  }
  if (!widthOnly && (!Number.isFinite(height) || height <= 0)) {
    throw new Error('fitTextToBox requires a positive height unless widthOnly is true.');
  }
  if (typeof measureText !== 'function') {
    throw new Error('fitTextToBox requires a measureText(text, fontSize) function.');
  }

  const minFontSize = Math.floor(clampFontSize(options?.minFontSize, DEFAULT_MIN_FONT_SIZE));
  const maxFontSize = Math.floor(clampFontSize(options?.maxFontSize, DEFAULT_MAX_FONT_SIZE));
  const safeLineHeight = clampFontSize(lineHeight, DEFAULT_LINE_HEIGHT);
  const lowStart = Math.min(minFontSize, maxFontSize);
  const highStart = Math.max(minFontSize, maxFontSize);

  function layout(fontSize) {
    const lines = wrapTextToWidth(text, { width, fontSize, measureText, multiLine });
    const maxLineWidth = longestLineWidth(lines, measureText, fontSize);
    const lineHeightPx = fontSize * safeLineHeight;
    const blockHeight = lines.length * lineHeightPx;

    return {
      fontSize,
      lines,
      maxLineWidth,
      lineHeightPx,
      blockHeight,
      fits: maxLineWidth <= width + FIT_EPSILON
        && (widthOnly || blockHeight <= height + FIT_EPSILON)
    };
  }

  let low = lowStart;
  let high = highStart;
  let best = layout(lowStart);

  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = layout(mid);

    if (candidate.fits) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best.fits ? best : layout(lowStart);
}

export function createTtfAdvanceMeasurer(ttfBuffer) {
  const font = parseTtfMetrics(ttfBuffer);

  return function measureText(text, fontSize) {
    const normalized = String(text ?? '');
    let advance = 0;

    for (const char of normalized) {
      const codePoint = char.codePointAt(0);
      const glyphId = font.glyphIdForCodePoint(codePoint);
      advance += font.advanceWidthForGlyph(glyphId);
    }

    return (advance / font.unitsPerEm) * fontSize;
  };
}

function parseTtfMetrics(buffer) {
  const numTables = readUInt16(buffer, 4);
  const tables = {};

  for (let i = 0, offset = 12; i < numTables; i += 1, offset += 16) {
    const tag = buffer.toString('ascii', offset, offset + 4);
    tables[tag] = {
      offset: readUInt32(buffer, offset + 8),
      length: readUInt32(buffer, offset + 12)
    };
  }

  for (const requiredTable of ['head', 'hhea', 'hmtx', 'maxp', 'cmap']) {
    if (!tables[requiredTable]) {
      throw new Error(`Font TTF tidak memiliki table ${requiredTable}.`);
    }
  }

  const unitsPerEm = readUInt16(buffer, tables.head.offset + 18);
  const numberOfHMetrics = readUInt16(buffer, tables.hhea.offset + 34);
  const numGlyphs = readUInt16(buffer, tables.maxp.offset + 4);
  const cmap = parseCmap(buffer, tables.cmap.offset);

  function advanceWidthForGlyph(glyphId) {
    const safeGlyphId = Math.max(0, Math.min(glyphId, numGlyphs - 1));
    const hmtxOffset = tables.hmtx.offset;

    if (safeGlyphId < numberOfHMetrics) {
      return readUInt16(buffer, hmtxOffset + safeGlyphId * 4);
    }

    return readUInt16(buffer, hmtxOffset + (numberOfHMetrics - 1) * 4);
  }

  return {
    unitsPerEm,
    glyphIdForCodePoint: cmap.glyphIdForCodePoint,
    advanceWidthForGlyph
  };
}

function parseCmap(buffer, cmapOffset) {
  const subtables = readUInt16(buffer, cmapOffset + 2);
  let bestOffset = null;
  let bestFormat = null;

  for (let i = 0; i < subtables; i += 1) {
    const recordOffset = cmapOffset + 4 + i * 8;
    const platformId = readUInt16(buffer, recordOffset);
    const encodingId = readUInt16(buffer, recordOffset + 2);
    const subtableOffset = cmapOffset + readUInt32(buffer, recordOffset + 4);
    const format = readUInt16(buffer, subtableOffset);

    if (format === 12 && platformId === 3 && (encodingId === 10 || encodingId === 1)) {
      bestOffset = subtableOffset;
      bestFormat = format;
      break;
    }

    if (format === 4 && (bestOffset === null || platformId === 3)) {
      bestOffset = subtableOffset;
      bestFormat = format;
    }
  }

  if (bestOffset === null) {
    throw new Error('Font TTF tidak memiliki cmap format 4/12 yang didukung.');
  }

  if (bestFormat === 12) {
    return parseCmapFormat12(buffer, bestOffset);
  }

  return parseCmapFormat4(buffer, bestOffset);
}

function parseCmapFormat4(buffer, offset) {
  const segCount = readUInt16(buffer, offset + 6) / 2;
  const endCodeOffset = offset + 14;
  const startCodeOffset = endCodeOffset + segCount * 2 + 2;
  const idDeltaOffset = startCodeOffset + segCount * 2;
  const idRangeOffsetOffset = idDeltaOffset + segCount * 2;

  function glyphIdForCodePoint(codePoint) {
    if (codePoint > 0xffff) return 0;

    for (let i = 0; i < segCount; i += 1) {
      const endCode = readUInt16(buffer, endCodeOffset + i * 2);
      const startCode = readUInt16(buffer, startCodeOffset + i * 2);
      if (codePoint < startCode || codePoint > endCode) continue;

      const idDelta = readInt16(buffer, idDeltaOffset + i * 2);
      const idRangeOffset = readUInt16(buffer, idRangeOffsetOffset + i * 2);

      if (idRangeOffset === 0) {
        return (codePoint + idDelta) & 0xffff;
      }

      const glyphOffset = idRangeOffsetOffset + i * 2 + idRangeOffset + (codePoint - startCode) * 2;
      const glyph = readUInt16(buffer, glyphOffset);
      return glyph === 0 ? 0 : (glyph + idDelta) & 0xffff;
    }

    return 0;
  }

  return { glyphIdForCodePoint };
}

function parseCmapFormat12(buffer, offset) {
  const groups = readUInt32(buffer, offset + 12);
  const groupsOffset = offset + 16;

  function glyphIdForCodePoint(codePoint) {
    let low = 0;
    let high = groups - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const groupOffset = groupsOffset + mid * 12;
      const startCharCode = readUInt32(buffer, groupOffset);
      const endCharCode = readUInt32(buffer, groupOffset + 4);

      if (codePoint < startCharCode) {
        high = mid - 1;
      } else if (codePoint > endCharCode) {
        low = mid + 1;
      } else {
        return readUInt32(buffer, groupOffset + 8) + codePoint - startCharCode;
      }
    }

    return 0;
  }

  return { glyphIdForCodePoint };
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16BE(offset);
}

function readInt16(buffer, offset) {
  return buffer.readInt16BE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}
