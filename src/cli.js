#!/usr/bin/env node
import { parseArgs } from 'node:util';
import process from 'node:process';
import { layouts, renderBrat } from './index.js';

function printHelp() {
  console.log(`
brat-sharp

Generate brat-style square PNG images with Sharp. No browser and no scraper.

Usage:
  brat-sharp --text "your text" --out output/brat.png
  node src/cli.js "your text"

Options:
  --text, -t <text>      Text to render. Positional text is also supported.
  --out, -o <file>       Output PNG path. Default: output/brat.png.
  --size, -s <px>        Square output size from 256 to 4096. Default: 1024.
  --layout, -l <name>    Layout preset: ${Object.keys(layouts).join(', ')}. Default: full.
  --blur <px>            Override text blur from 0 to 24.
  --help, -h             Show this help message.
`);
}

function readCli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      text: { type: 'string', short: 't' },
      out: { type: 'string', short: 'o', default: 'output/brat.png' },
      size: { type: 'string', short: 's', default: '1024' },
      layout: { type: 'string', short: 'l', default: 'full' },
      blur: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false }
    }
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  return {
    ...values,
    text: values.text ?? positionals.join(' ')
  };
}

try {
  const result = await renderBrat(readCli());
  console.log(`OK: ${result.path} (${result.size.toLocaleString('en-US')} bytes)`);
  console.log(`Layout: ${result.layout} | Blur: ${result.blur} | Size: ${result.width}x${result.height} | Text: ${result.text}`);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
