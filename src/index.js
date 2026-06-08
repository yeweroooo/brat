import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import emojiRegex from 'emoji-regex';
import { createTtfAdvanceMeasurer, fitTextToBox } from './textFit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const SOURCE_FONT_PATH = path.join(__dirname, 'assets', 'arial_narrow.woff');
const APPLE_EMOJI_DIR = path.join(
  path.dirname(require.resolve('emoji-datasource-apple/package.json')),
  'img',
  'apple',
  '64'
);
const RUNTIME_FONT_DIR = path.join(os.tmpdir(), 'brat-sharp', 'fonts');
const RUNTIME_FONT_PATH = path.join(RUNTIME_FONT_DIR, 'arial_narrow.ttf');
const RUNTIME_FONT_CONFIG = path.join(RUNTIME_FONT_DIR, 'fonts.conf');
const FONT_CACHE_DIR = path.join(os.tmpdir(), 'brat-sharp', 'fontcache');
const REFERENCE_SIZE = 1024;
const FIT_MARGIN = 0.5;
const EMOJI_WIDTH_RATIO = 1.02;
const EMOJI_SIZE_RATIO = 0.95;
const EMOJI_BASELINE_RATIO = 0.86;
const emojiImageCache = new Map();

export const layouts = Object.freeze({
  full: {
    overlayWidth: 1024,
    overlayHeight: 1024,
    padding: 56,
    maxFontSize: 300,
    minFontSize: 8,
    blur: 3.2,
    strokeWidth: 1.1,
    baseline: 0.88,
    verticalAlign: 'middle',
    preferSingleLineRatio: 0.8
  },
  web: {
    overlayWidth: 500,
    overlayHeight: 300,
    padding: 20,
    maxFontSize: 170,
    minFontSize: 8,
    blur: 2.4,
    strokeWidth: 0.6,
    baseline: 0.88,
    verticalAlign: 'top',
    preferSingleLineRatio: 0
  }
});

const DEFAULT_THEME = Object.freeze({
  background: '#ffffff',
  color: '#000000',
  fontFamily: 'Arial Narrow',
  fontWeight: 600
});

export function normalizeRenderOptions(options = {}) {
  const text = String(options.text ?? '').trim();
  if (!text) {
    throw new Error('The "text" option is required.');
  }

  const size = Number.parseInt(String(options.size ?? 1024), 10);
  if (!Number.isFinite(size) || size < 256 || size > 4096) {
    throw new Error('The "size" option must be a number from 256 to 4096.');
  }

  const layout = String(options.layout ?? 'full').toLowerCase();
  if (!Object.hasOwn(layouts, layout)) {
    throw new Error(`The "layout" option must be one of: ${Object.keys(layouts).join(', ')}.`);
  }

  let blur;
  if (options.blur !== undefined) {
    blur = Number.parseFloat(String(options.blur));
    if (!Number.isFinite(blur) || blur < 0 || blur > 24) {
      throw new Error('The "blur" option must be a number from 0 to 24.');
    }
  }

  return {
    text,
    out: options.out ?? 'output/brat.png',
    size,
    layout,
    blur
  };
}

export async function renderBrat(options) {
  const normalized = normalizeRenderOptions(options);
  await ensureOutputDir(normalized.out);

  const svg = await createBratSvg(normalized);
  const { default: sharp } = await import('sharp');
  await sharp(Buffer.from(svg)).png().toFile(normalized.out);

  const stats = await stat(normalized.out);
  return {
    path: normalized.out,
    size: stats.size,
    width: normalized.size,
    height: normalized.size,
    layout: normalized.layout,
    blur: normalized.blur ?? layouts[normalized.layout].blur,
    text: normalized.text
  };
}

export async function createBratSvg(options) {
  const normalized = normalizeRenderOptions(options);
  await prepareFontConfig();

  const fontBuffer = await readFile(RUNTIME_FONT_PATH);
  const measurePlainText = createTtfAdvanceMeasurer(fontBuffer);
  const measureText = createEmojiAwareMeasurer(measurePlainText);
  const theme = scaleLayout(normalized.layout, normalized.size, normalized.blur);
  let fitted = fitTextToBox(normalized.text, {
    width: theme.contentWidth,
    height: theme.contentHeight,
    minFontSize: theme.minFontSize,
    maxFontSize: theme.maxFontSize,
    lineHeight: 1,
    multiLine: true,
    measureText
  });

  if (theme.preferSingleLineRatio > 0) {
    const singleLine = fitTextToBox(normalized.text, {
      width: theme.contentWidth,
      height: theme.contentHeight,
      minFontSize: theme.minFontSize,
      maxFontSize: theme.maxFontSize,
      lineHeight: 1,
      multiLine: false,
      measureText
    });

    if (singleLine.fontSize >= fitted.fontSize * theme.preferSingleLineRatio) {
      fitted = singleLine;
    }
  }

  const blockTop = theme.verticalAlign === 'middle'
    ? theme.contentY + (theme.contentHeight - fitted.blockHeight) / 2
    : theme.contentY;

  const renderedLines = [];
  for (let index = 0; index < fitted.lines.length; index += 1) {
    const line = fitted.lines[index];
    const y = blockTop + (index + theme.baseline) * fitted.lineHeightPx;
    const naturalWidth = measureText(line, fitted.fontSize);
    const justify = fitted.lines.length > 1
      && !containsEmoji(line)
      && splitLineWords(line).length > 1
      && naturalWidth < theme.contentWidth - FIT_MARGIN;

    if (justify) {
      renderedLines.push(renderJustifiedLine({
        line,
        x: theme.contentX,
        y,
        width: theme.contentWidth,
        fontSize: fitted.fontSize,
        measureText
      }));
      continue;
    }

    renderedLines.push(await renderEmojiAwareLine({
      line,
      x: theme.contentX,
      y,
      fontSize: fitted.fontSize,
      measurePlainText
    }));
  }

  const lines = renderedLines.join('\n      ');

  return `
<svg width="${normalized.size}" height="${normalized.size}" viewBox="0 0 ${normalized.size} ${normalized.size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="bratBlur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${formatNumber(theme.blur)}" />
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="${DEFAULT_THEME.background}" />
  <g font-family="${DEFAULT_THEME.fontFamily}"
     font-weight="${DEFAULT_THEME.fontWeight}"
     font-size="${formatNumber(fitted.fontSize)}px"
     fill="${DEFAULT_THEME.color}"
     stroke="${DEFAULT_THEME.color}"
     stroke-width="${formatNumber(theme.strokeWidth)}"
     paint-order="stroke fill"
     stroke-linejoin="round"
     text-anchor="start"
     filter="url(#bratBlur)">
      ${lines}
  </g>
</svg>
`;
}

function scaleLayout(layout, size, blurOverride) {
  const config = layouts[layout];
  const scale = size / REFERENCE_SIZE;
  const outerWidth = config.overlayWidth * scale;
  const outerHeight = config.overlayHeight * scale;
  const padding = config.padding * scale;
  const blur = blurOverride ?? config.blur;

  return {
    ...config,
    scale,
    outerWidth,
    outerHeight,
    padding,
    contentX: (size - outerWidth) / 2 + padding,
    contentY: (size - outerHeight) / 2 + padding,
    contentWidth: outerWidth - padding * 2,
    contentHeight: outerHeight - padding * 2,
    minFontSize: Math.max(1, Math.round(config.minFontSize * scale)),
    maxFontSize: Math.max(1, Math.round(config.maxFontSize * scale)),
    blur: blur * scale,
    strokeWidth: config.strokeWidth * scale,
    baseline: config.baseline
  };
}

async function prepareFontConfig() {
  await mkdir(RUNTIME_FONT_DIR, { recursive: true });
  await mkdir(FONT_CACHE_DIR, { recursive: true });

  const woffBuffer = await readFile(SOURCE_FONT_PATH);
  const ttfBuffer = convertWoffToTtf(woffBuffer);
  await writeIfChanged(RUNTIME_FONT_PATH, ttfBuffer);

  const fontConfig = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${xmlEscape(RUNTIME_FONT_DIR)}</dir>
  <cachedir>${xmlEscape(FONT_CACHE_DIR)}</cachedir>
</fontconfig>
`;
  await writeIfChanged(RUNTIME_FONT_CONFIG, fontConfig);
  process.env.FONTCONFIG_FILE = RUNTIME_FONT_CONFIG;
}

async function writeIfChanged(filePath, content) {
  try {
    const existing = await readFile(filePath);
    const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (existing.equals(next)) return;
  } catch {
    // Missing runtime files are created below.
  }

  await writeFile(filePath, content);
}

function convertWoffToTtf(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'wOFF') {
    throw new Error('Font source must be a WOFF file.');
  }

  const flavor = readUInt32(buffer, 4);
  const numTables = readUInt16(buffer, 12);
  const tableRecords = [];
  let outputTableDataLength = 0;

  for (let i = 0, offset = 44; i < numTables; i += 1, offset += 20) {
    const record = {
      tag: buffer.toString('ascii', offset, offset + 4),
      offset: readUInt32(buffer, offset + 4),
      compLength: readUInt32(buffer, offset + 8),
      origLength: readUInt32(buffer, offset + 12),
      checksum: readUInt32(buffer, offset + 16)
    };
    tableRecords.push(record);
    outputTableDataLength += pad4(record.origLength);
  }

  const maxPower = 2 ** Math.floor(Math.log2(numTables));
  const searchRange = maxPower * 16;
  const entrySelector = Math.log2(maxPower);
  const rangeShift = numTables * 16 - searchRange;
  const output = Buffer.alloc(12 + numTables * 16 + outputTableDataLength);

  let headOffset = 0;
  output.writeUInt32BE(flavor, headOffset);
  headOffset += 4;
  output.writeUInt16BE(numTables, headOffset);
  headOffset += 2;
  output.writeUInt16BE(searchRange, headOffset);
  headOffset += 2;
  output.writeUInt16BE(entrySelector, headOffset);
  headOffset += 2;
  output.writeUInt16BE(rangeShift, headOffset);
  headOffset += 2;

  let tableDataOffset = 12 + numTables * 16;
  for (const record of tableRecords) {
    let tableData = buffer.subarray(record.offset, record.offset + record.compLength);
    if (record.compLength !== record.origLength) {
      tableData = inflateSync(tableData);
    }
    if (tableData.length !== record.origLength) {
      throw new Error(`Font table ${record.tag} is invalid.`);
    }

    output.write(record.tag, headOffset, 4, 'ascii');
    headOffset += 4;
    output.writeUInt32BE(record.checksum, headOffset);
    headOffset += 4;
    output.writeUInt32BE(tableDataOffset, headOffset);
    headOffset += 4;
    output.writeUInt32BE(record.origLength, headOffset);
    headOffset += 4;
    tableData.copy(output, tableDataOffset);
    tableDataOffset += pad4(record.origLength);
  }

  return output;
}

async function ensureOutputDir(filePath) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

function renderJustifiedLine({ line, x, y, width, fontSize, measureText }) {
  const words = splitLineWords(line);
  const wordsWidth = words.reduce((total, word) => total + measureText(word, fontSize), 0);
  const gap = words.length > 1 ? (width - wordsWidth) / (words.length - 1) : 0;
  let cursor = x;

  return words.map((word) => {
    const text = renderTextChunk(word, cursor, y);
    cursor += measureText(word, fontSize) + gap;
    return text;
  }).join('');
}

function createEmojiAwareMeasurer(measurePlainText) {
  return function measureEmojiAwareText(text, fontSize) {
    return tokenizeEmoji(text).reduce((width, token) => {
      if (token.type === 'emoji') return width + fontSize * EMOJI_WIDTH_RATIO;
      return width + measurePlainText(token.value, fontSize);
    }, 0);
  };
}

async function renderEmojiAwareLine({ line, x, y, fontSize, measurePlainText }) {
  const tokens = tokenizeEmoji(line);
  let cursor = x;
  const parts = [];

  for (const token of tokens) {
    if (token.type !== 'emoji') {
      if (token.value) {
        parts.push(renderTextChunk(token.value, cursor, y));
        cursor += measurePlainText(token.value, fontSize);
      }
      continue;
    }

    const dataUri = await getAppleEmojiDataUri(token.value);
    if (!dataUri) {
      parts.push(renderTextChunk(token.value, cursor, y));
      cursor += measurePlainText(token.value, fontSize);
      continue;
    }

    const imageSize = fontSize * EMOJI_SIZE_RATIO;
    const imageY = y - fontSize * EMOJI_BASELINE_RATIO;
    parts.push(
      `<image x="${formatNumber(cursor)}" y="${formatNumber(imageY)}" width="${formatNumber(imageSize)}" height="${formatNumber(imageSize)}" href="${dataUri}" preserveAspectRatio="xMidYMid meet" />`
    );
    cursor += fontSize * EMOJI_WIDTH_RATIO;
  }

  return parts.join('');
}

function renderTextChunk(text, x, y) {
  return `<text x="${formatNumber(x)}" y="${formatNumber(y)}">${escapeHtml(text)}</text>`;
}

function tokenizeEmoji(text) {
  const source = String(text ?? '');
  const regex = emojiRegex();
  const tokens = [];
  let lastIndex = 0;

  for (const match of source.matchAll(regex)) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: source.slice(lastIndex, match.index) });
    }
    tokens.push({ type: 'emoji', value: match[0] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) {
    tokens.push({ type: 'text', value: source.slice(lastIndex) });
  }

  return tokens.length > 0 ? tokens : [{ type: 'text', value: source }];
}

function containsEmoji(text) {
  return emojiRegex().test(String(text ?? ''));
}

async function getAppleEmojiDataUri(emoji) {
  const candidates = emojiFilenameCandidates(emoji);

  for (const filename of candidates) {
    const cached = emojiImageCache.get(filename);
    if (cached !== undefined) return cached;

    const imagePath = path.join(APPLE_EMOJI_DIR, filename);
    try {
      await access(imagePath);
      const image = await readFile(imagePath);
      const dataUri = `data:image/png;base64,${image.toString('base64')}`;
      emojiImageCache.set(filename, dataUri);
      return dataUri;
    } catch {
      emojiImageCache.set(filename, null);
    }
  }

  return null;
}

function emojiFilenameCandidates(emoji) {
  const codepoints = [...emoji].map((char) => char.codePointAt(0).toString(16));
  const exact = `${codepoints.join('-')}.png`;
  const withoutTextPresentation = `${codepoints.filter((codepoint) => codepoint !== 'fe0f').join('-')}.png`;
  const withEmojiPresentation = codepoints.includes('fe0f')
    ? exact
    : `${codepoints.flatMap((codepoint) => needsEmojiPresentation(codepoint) ? [codepoint, 'fe0f'] : [codepoint]).join('-')}.png`;

  return [...new Set([exact, withEmojiPresentation, withoutTextPresentation])];
}

function needsEmojiPresentation(codepoint) {
  return codepoint.length <= 4 && !codepoint.startsWith('1f') && !codepoint.startsWith('e0');
}

function splitLineWords(line) {
  return String(line).trim().split(/\s+/).filter(Boolean);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlEscape(str) {
  return escapeHtml(str);
}

function formatNumber(value) {
  return Number.parseFloat(value.toFixed(3)).toString();
}

function pad4(value) {
  return (value + 3) & ~3;
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16BE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}
