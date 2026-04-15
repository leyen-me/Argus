'use strict';

const { spawnSync } = require('child_process');
const electronPath = require('electron');

const env = { ...process.env, ARGUS_ENABLE_LLM: '1' };
const result = spawnSync(electronPath, ['.'], { stdio: 'inherit', env, shell: false });
process.exit(result.status ?? 1);
