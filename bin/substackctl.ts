#!/usr/bin/env node
import { runCliWithUpdateNotice } from '../src/cli.js';
import { createRealEnv } from '../src/env/real.js';

process.exitCode = await runCliWithUpdateNotice(process.argv.slice(2), createRealEnv());
