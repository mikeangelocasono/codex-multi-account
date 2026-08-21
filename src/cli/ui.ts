/**
 * Terminal presentation helpers.
 *
 * Data goes to stdout so it can be piped (`cma current`, `cma list`).
 * Diagnostics go to stderr so they never corrupt that data.
 *
 * Colour is opt-out via NO_COLOR and opt-in via FORCE_COLOR, and is disabled
 * automatically when stdout is not a terminal.
 */

import { truncateForDisplay } from '../security/validation.js';

const ESC = String.fromCharCode(27);

function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

function wrap(open: string, close: string) {
  return (text: string): string =>
    colorEnabled() ? `${ESC}[${open}m${text}${ESC}[${close}m` : text;
}

export const style = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  white: wrap('97', '39'),
  orange: wrap('38;5;208', '39'),
  gray: wrap('90', '39'),
};

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Visible width, ignoring colour codes. */
export function width(text: string): number {
  return stripAnsi(text).length;
}

export function pad(text: string, size: number): string {
  const missing = size - width(text);
  return missing > 0 ? text + ' '.repeat(missing) : text;
}

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function log(line = ''): void {
  process.stderr.write(`${line}\n`);
}

export function info(message: string): void {
  log(`${style.cyan('i')} ${message}`);
}

export function success(message: string): void {
  log(`${style.green('ok')} ${message}`);
}

export function warn(message: string): void {
  log(`${style.yellow('!')}  ${message}`);
}

export function failure(message: string): void {
  log(`${style.red('x')}  ${message}`);
}

export function heading(text: string): void {
  log('');
  log(style.bold(style.white(text)));
  log('');
}

export interface TableColumn {
  header: string;
  align?: 'left' | 'right';
}

/** Fixed-width table with a dim header row. Values are sanitised before printing. */
export function renderTable(columns: TableColumn[], rows: string[][], stream = out): void {
  const widths = columns.map((column, index) =>
    Math.max(width(column.header), ...rows.map((row) => width(row[index] ?? ''))),
  );

  const headerLine = columns
    .map((column, index) => style.dim(pad(column.header.toUpperCase(), widths[index]!)))
    .join('  ');
  stream(headerLine.trimEnd());

  for (const row of rows) {
    const line = columns
      .map((column, index) => {
        const cell = row[index] ?? '';
        const size = widths[index]!;
        return column.align === 'right'
          ? ' '.repeat(Math.max(0, size - width(cell))) + cell
          : pad(cell, size);
      })
      .join('  ');
    stream(line.trimEnd());
  }
}

/** Relative day label used by session listings. */
export function relativeDay(date: Date, now = new Date()): string {
  const startOf = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${days < 14 ? '' : 's'} ago`;
  return date.toISOString().slice(0, 10);
}

/** Shorten a working directory for display without losing which project it is. */
export function shortenPath(path: string, max = 34): string {
  const clean = path.replace(/^\\\\\?\\/, '');
  if (clean.length <= max) return clean;
  const parts = clean.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-2).join('/');
  return tail.length <= max ? `...${tail}` : `...${tail.slice(-(max - 3))}`;
}

export function safe(text: unknown, max = 60): string {
  return truncateForDisplay(text, max);
}
