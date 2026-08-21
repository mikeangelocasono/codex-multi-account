#!/usr/bin/env node
/**
 * Thin launcher. All logic lives in dist/cli/main.js so the published bin
 * path never changes, and so `node bin/cma.js` works from a checkout after a
 * build without any wrapper script.
 */
import { run } from '../dist/cli/main.js';

const code = await run(process.argv.slice(2));
process.exitCode = code;
