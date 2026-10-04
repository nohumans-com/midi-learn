// Run the MIDI bridge as a macOS login agent, so MIDI Learn works in LUNA without a terminal.
//
//   npm run bridge:install     # start now and at every login; restarts it if it stops
//   npm run bridge:uninstall   # stop it and remove the agent
//   npm run bridge:status      # is it loaded, and the last lines of its log
//
// The agent is ~/Library/LaunchAgents/com.uaudio.midi-learn.bridge.plist; the log is
// ~/Library/Logs/midi-learn-bridge.log.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.uaudio.midi-learn.bridge';
const plist = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const log = join(homedir(), 'Library/Logs/midi-learn-bridge.log');
const bridge = join(dirname(fileURLToPath(import.meta.url)), 'midi-bridge.mjs');
const domain = `gui/${process.getuid()}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const launchctl = (...args) => {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stdout ?? '';
  }
};

function install() {
  if (process.platform !== 'darwin') throw new Error('The login agent is macOS only; on Windows LUNA has Web MIDI and needs no bridge.');
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(bridge)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`,
  );
  launchctl('bootout', domain, plist);
  launchctl('bootstrap', domain, plist);
  console.log(`Installed ${plist}\nThe bridge runs now and at every login. Log: ${log}`);
}

function uninstall() {
  launchctl('bootout', domain, plist);
  if (existsSync(plist)) unlinkSync(plist);
  console.log('Removed the MIDI Learn bridge agent.');
}

function status() {
  const out = launchctl('print', `${domain}/${LABEL}`);
  const state = /state = (\w+)/.exec(out)?.[1];
  console.log(existsSync(plist) ? `agent: installed, ${state ?? 'not loaded'}` : 'agent: not installed');
  if (existsSync(log)) console.log(readFileSync(log, 'utf8').trim().split('\n').slice(-12).join('\n'));
}

/** Ask every open MIDI Learn page for a health snapshot, then show what they logged. */
async function diag() {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.MIDI_LEARN_PORT ?? 8797}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  }).catch(() => {
    console.log('The bridge is not running (npm run bridge:status).');
    process.exit(1);
  });
  ws.send(JSON.stringify({ type: 'diag-request' }));
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const recent = lines.slice(-200).filter((l) => / diag | health: | hello /.test(l));
  console.log(recent.slice(-6).join('\n') || 'No page answered: is MIDI Learn open?');
}

const run = { install, uninstall, status, diag }[process.argv[2] ?? 'status'];
if (run) run();
else console.log('usage: agent.mjs install|uninstall|status|diag');
