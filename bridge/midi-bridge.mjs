// MIDI Learn bridge: relays this computer's MIDI inputs to the add-on over a local WebSocket.
//
// LUNA's macOS webview has no Web MIDI, and LUNA does not hand an Add On the MIDI it receives,
// so the page cannot hear a controller by itself there. Run this next to LUNA:
//
//   npm run bridge            # ws://127.0.0.1:8797
//
// Messages to the page:  { type: 'inputs', inputs: ['nanoKONTROL2', ...] }
//                        { type: 'midi', device: 'nanoKONTROL2', data: [176, 7, 64] }
// From the page:         { type: 'send', device: 'nanoKONTROL2', data: [176, 7, 64] } feedback,
//                        sent to the output named like that input
// It listens on loopback only, opens every input, and follows devices being plugged in.

import midi from '@julusian/midi';

// Timestamp every log line, so a page's reports can be lined up with what the user did.
for (const level of ['log', 'warn', 'error']) {
  const write = console[level].bind(console);
  console[level] = (...args) => write(new Date().toISOString().slice(11, 23), ...args);
}
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MIDI_LEARN_PORT ?? 8797);
const SCAN_MS = 2000;

// A disk copy of the page's settings (session mappings, globals, templates, prefs). LUNA's webview
// storage is shared by every Add On and can be cleared; this file outlives it.
const STATE_DIR = process.env.MIDI_LEARN_STATE_DIR ?? join(homedir(), 'Library/Application Support/MIDI Learn');
const STATE_FILE = join(STATE_DIR, 'state.json');
let state = {};
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
} catch {}
let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  }, 250);
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
const open = new Map(); // name -> midi.Input
const outs = new Map(); // name -> midi.Output, opened on first send (feedback to motorized controllers)
const said = new Map(); // name -> when its MIDI was last logged

function names() {
  const probe = new midi.Input();
  const list = [];
  for (let i = 0; i < probe.getPortCount(); i++) list.push(probe.getPortName(i));
  probe.closePort();
  return list;
}

function outputNames() {
  const probe = new midi.Output();
  const list = [];
  for (let i = 0; i < probe.getPortCount(); i++) list.push(probe.getPortName(i));
  probe.closePort();
  return list;
}

/**
 * The output for an input's name: the same name (most USB controllers, Roto-Control included),
 * else one that starts with it, else contains it.
 */
function outputFor(device) {
  if (outs.has(device)) return outs.get(device);
  const names = outputNames();
  const index = [(n) => n === device, (n) => n.startsWith(device), (n) => n.includes(device)].reduce((found, test) => (found >= 0 ? found : names.findIndex(test)), -1);
  if (index < 0) return undefined;
  const out = new midi.Output();
  try {
    out.openPort(index);
  } catch (e) {
    console.warn(`midi-learn bridge: could not open output ${names[index]}: ${e.message}`);
    return undefined;
  }
  console.log(`midi-learn bridge: feedback output for ${device}: ${names[index]}`);
  outs.set(device, out);
  return out;
}

const sentSaid = new Map(); // device -> when a send was last logged
function sendTo(device, data) {
  const out = outputFor(device);
  if (!out) return false;
  out.sendMessage(data);
  // One line per device and control every 2 s, so each knob's feedback shows up in the log.
  const key = `${device}|${data[0]}|${data[1]}`;
  const now = Date.now();
  if (now - (sentSaid.get(key) ?? 0) > 2000) {
    sentSaid.set(key, now);
    console.log(`midi-learn bridge: feedback to ${device}: [${data.join(', ')}]`);
  }
  return true;
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(text);
}

function scan() {
  const now = names();
  let changed = false;
  for (const [name, input] of open) {
    if (now.includes(name)) continue;
    input.closePort();
    open.delete(name);
    changed = true;
    // Its output is likely gone with it; reopen by name next time.
    outs.get(name)?.closePort();
    outs.delete(name);
  }
  now.forEach((name, index) => {
    if (open.has(name)) return;
    const input = new midi.Input();
    input.ignoreTypes(true, true, true); // sysex, timing, active sensing
    input.on('message', (_delta, data) => {
      // Log a device's MIDI at most every 2 s, to tell "never arrived" from "arrived, not mapped".
      const now = Date.now();
      if (now - (said.get(name) ?? 0) > 2000) {
        said.set(name, now);
        console.log(`midi-learn bridge: midi from ${name}: [${data.join(', ')}] to ${wss.clients.size} page(s)`);
      }
      broadcast({ type: 'midi', device: name, data });
    });
    try {
      input.openPort(index);
      open.set(name, input);
      changed = true;
    } catch (e) {
      console.warn(`midi-learn bridge: could not open ${name}: ${e.message}`);
    }
  });
  if (changed) {
    console.log(`midi-learn bridge: ${open.size} input(s): ${[...open.keys()].join(', ') || 'none'}`);
    broadcast({ type: 'inputs', inputs: [...open.keys()] });
  }
}

// The page says hello with what it sees (user agent, Web MIDI, whether it is inside LUNA), so the
// log shows whether LUNA's window reached the bridge at all.
wss.on('connection', (ws, req) => {
  const from = req.headers.origin || 'no origin';
  console.log(`midi-learn bridge: page connected (${from})`);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'hello') console.log(`midi-learn bridge: hello ${JSON.stringify(msg)}`);
      else if (msg.type === 'send' && typeof msg.device === 'string' && Array.isArray(msg.data) && msg.data.length <= 3) sendTo(msg.device, msg.data);
      else if (msg.type === 'save' && typeof msg.key === 'string' && msg.key.startsWith('midilearn.')) {
        if (msg.value === null) delete state[msg.key];
        else state[msg.key] = msg.value;
        saveState();
      }
      else if (msg.type === 'log') console.log(`midi-learn page: ${msg.text}`);
      else if (msg.type === 'diag-request') broadcast({ type: 'diag' }); // npm run bridge:diag
    } catch {}
  });
  ws.on('close', () => console.log(`midi-learn bridge: page left (${from})`));
  ws.send(JSON.stringify({ type: 'state', items: state }));
  ws.send(JSON.stringify({ type: 'inputs', inputs: [...open.keys()] }));
});
wss.on('listening', () => console.log(`midi-learn bridge on ws://127.0.0.1:${PORT}`));
wss.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `midi-learn bridge: port ${PORT} is taken (is a bridge already running?)` : e.message);
  process.exit(1);
});

scan();
setInterval(scan, SCAN_MS);
const quit = () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  }
  for (const input of open.values()) input.closePort();
  for (const out of outs.values()) out.closePort();
  process.exit(0);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
