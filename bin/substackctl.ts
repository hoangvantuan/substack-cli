#!/usr/bin/env node
import { runCli } from '../src/cli.js';
import { createRealEnv } from '../src/env/real.js';

process.exitCode = await runCli(process.argv.slice(2), createRealEnv());
