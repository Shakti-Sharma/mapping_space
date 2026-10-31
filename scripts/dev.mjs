// Runs API server and Vite dev server together without extra dependencies.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  spawn(npm, ['--prefix', 'server', 'run', 'dev'], { stdio: 'inherit', env: { ...process.env, MS_DEV: '1' } }),
  spawn(npm, ['--prefix', 'client', 'run', 'dev'], { stdio: 'inherit' }),
];
const stop = () => { procs.forEach((p) => p.kill()); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', stop));
