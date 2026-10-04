// MIDI Learn: logic that does not touch the DOM, so tests can exercise it against Luna.MockEngine.
//
// A mapping ties one MIDI source (device, message type, channel, number) to one target: a LUNA
// control (fader, pan, mute, solo, send, plugin parameter) or a command (play, record, undo...).
// Learning is the usual pair: touch a control in LUNA (its `touch_count` push, SDK fact 100) or
// pick one here, and move a knob on the controller. Whichever arrives second completes it.
//
// main.js owns the DOM and the MIDI ports; it feeds parsed messages to Mapper.midi() and renders
// Mapper.rows(). Storage is injected ({ get(key), set(key, value) }) so tests run without a browser.

const KEYS = {
  session: (uid) => `midilearn.session.${uid}`,
  globals: 'midilearn.globals',
  focus: 'midilearn.focus', // Channel Focus mappings: one controller layout for every session
  plugins: 'midilearn.plugins', // plugin maps: one map per plugin type, for whichever instance has the focus
  mighty: 'midilearn.mighty', // the Proxy: one knob that drives whatever was touched last (first called the Mighty Knob; 'mighty' in code and storage, so saved setups carry over)
  templates: 'midilearn.templates',
};

/** A touch held open this long after the last MIDI value is released (one undo step per move). */
const RELEASE_MS = 400;
/** Touches LUNA reports on a control we just wrote are ours, not the user picking a target. */
const SELF_TOUCH_MS = 1000;

/**
 * Feedback to motorized controllers (opt-in per mapping). A loop happens when a value LUNA sends
 * back is taken for the user's hand, or the controller's motor fights the user's hand, so:
 * - nothing is sent back while the user is moving that control (its writer is open) or for
 *   FEEDBACK_HOLD_MS after its last incoming value; the final value goes out once it settles;
 * - an incoming value within ±1 of what was sent less than FEEDBACK_ECHO_MS ago is the motor's
 *   echo, not a hand, and is not applied;
 * - a value equal to the last one sent, or to the last one received, is not sent again;
 * - only 7-bit CC and notes are sent: 14-bit MSB/LSB pairs make some motorized controllers
 *   (Roto-Control among them) jump to wrong positions.
 */
const FEEDBACK_HOLD_MS = 350;
const FEEDBACK_ECHO_MS = 300;
/**
 * While learning: a motor can take a second or more to travel and report where it landed, so an
 * echo of a value sent back counts for longer, and within ±2.
 */
const LEARN_ECHO_MS = 1500;
/**
 * While learning with Hold: the rest of a knob turn that just completed a mapping isn't the knob
 * for the next one. It stays ignored until it has been still this long.
 */
const LEARN_SETTLE_MS = 600;

/** LUNA's automation modes, in its own order (fact 31: the command takes the index). */
const AUTOMATION_MODES = ['off', 'read', 'write', 'touch', 'latch'];
const AUTOMATION_LABELS = { off: 'Off', read: 'Read', write: 'Write', touch: 'Touch', latch: 'Latch' };
/**
 * What an automation target does: set one mode (a button), step to the next one (a button) or
 * pick a mode by position (a knob, five zones).
 */
const AUTOMATION_ACTIONS = [...AUTOMATION_MODES, 'next', 'knob'];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Commands a button can trigger. `run` takes the session. */
const COMMANDS = [
  { id: 'togglePlayback', label: 'Play / Stop', run: (s) => s.transport.toggle() },
  { id: 'play', label: 'Play', run: (s) => s.transport.play() },
  { id: 'stop', label: 'Stop', run: (s) => s.transport.stop() },
  { id: 'toggleRecord', label: 'Record', run: (s) => s.transport.toggleRecord() },
  { id: 'returnToZero', label: 'Return to zero', run: (s) => s.transport.returnToZero() },
  { id: 'toggleLoop', label: 'Loop on / off', run: (s) => s.transport.looping.set(!s.transport.looping.value) },
  { id: 'toggleCountIn', label: 'Count-in on / off', run: (s) => s.transport.countInEnabled.set(!s.transport.countInEnabled.value) },
  { id: 'undo', label: 'Undo', run: (s) => s.undo() },
  { id: 'redo', label: 'Redo', run: (s) => s.redo() },
  { id: 'save', label: 'Save session', run: (s) => s.save() },
  { id: 'selectNextTrack', label: 'Select next track', run: (s) => selectTrack(s, 1) },
  { id: 'selectPreviousTrack', label: 'Select previous track', run: (s) => selectTrack(s, -1) },
  // Resets the parameter in focus: the one last touched in LUNA (what the Proxy follows) or last
  // moved through the Proxy or a Channel Focus knob.
  { id: 'resetFocusedParameter', label: 'Reset parameter to default', run: (s, mapper) => mapper?.resetFocused() },
];

/**
 * Move LUNA's track selection by one, in track order, stopping at the first and last track. It
 * writes the edit context's selection and its last-selected track (fact 74), which is what
 * `session.focusedTrack`, and so Channel Focus, follows.
 */
async function selectTrack(session, delta) {
  const tracks = session.visibleTracks;
  if (!tracks.length) return;
  const at = tracks.indexOf(session.focusedTrack?.value);
  const next = tracks[Math.max(0, Math.min(tracks.length - 1, (at < 0 ? 0 : at) + delta))];
  if (!next || (next === session.focusedTrack?.value && at >= 0)) return;
  await Promise.all([session.context.selectionTracks.set([next.id]), session.context.lastSelectedTrack.set(next.id)]);
}

const AddOnLogic = {
  selectTrack,
  AUTOMATION_MODES,
  AUTOMATION_ACTIONS,

  /**
   * An automation target on one track. `action` is a mode ('off'…'latch'), 'next' or 'knob'.
   * `channel` (the track's name) lets a template find the same track in another session.
   */
  automationTarget(track, action) {
    return { kind: 'automation', channelId: track.id, channel: track.name.value ?? track.id, action, label: AddOnLogic.automationLabel(action) };
  },

  automationLabel(action) {
    if (action === 'next') return 'Next automation mode';
    if (action === 'knob') return 'Automation mode';
    return `Automation ${AUTOMATION_LABELS[action] ?? action}`;
  },

  /** The mode a knob position (0..1) selects: five equal zones. */
  automationZone(v) {
    return AUTOMATION_MODES[Math.min(AUTOMATION_MODES.length - 1, Math.floor(v * AUTOMATION_MODES.length))];
  },
  KEYS,
  COMMANDS,
  RELEASE_MS,

  /**
   * One MIDI message as plain data, or null for anything a mapping cannot use (clock, sysex,
   * aftertouch). A note-on with velocity 0 is a note-off, as the MIDI spec says.
   */
  parseMidi(bytes) {
    const [status = 0, d1 = 0, d2 = 0] = bytes;
    const kind = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    if (kind === 0xb0) return { type: 'cc', channel, number: d1, value: d2 / 127, raw: d2 };
    if (kind === 0x90 && d2 > 0) return { type: 'note', channel, number: d1, value: d2 / 127, raw: d2, on: true };
    if (kind === 0x80 || kind === 0x90) return { type: 'note', channel, number: d1, value: 0, raw: 0, on: false };
    if (kind === 0xe0) {
      const v = (d2 << 7) | d1;
      return { type: 'pitch', channel, number: 0, value: v / 16383, raw: v };
    }
    if (kind === 0xc0) return { type: 'program', channel, number: d1, value: 1, raw: d1, on: true };
    return null;
  },

  /** "C3" for note 60, the octave numbering LUNA and most controllers use. */
  noteName(n) {
    return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
  },

  /** The identity of a source; `*` stands for any device or any channel. */
  sourceKey(src) {
    return `${src.device ?? '*'}|${src.type}|${src.channel ?? '*'}|${src.number}`;
  },

  /**
   * A source typed in by hand, or undefined when it is not valid. `number` may be a note name
   * for notes ("C3"); `channel` is 1..16, or null/'' for any channel. Pitch bend has no number.
   *
   * @example
   * AddOnLogic.manualSource({ type: 'cc', number: '100', channel: '' });
   * // { device: null, type: 'cc', channel: null, number: 100 }
   */
  manualSource({ type, number, channel, device = null }) {
    if (!['cc', 'note', 'pitch', 'program'].includes(type)) return undefined;
    let n = 0;
    if (type !== 'pitch') {
      const text = String(number ?? '').trim();
      const note = /^([A-Ga-g])(#|b)?(-?\d)$/.exec(text);
      if (note && type === 'note') {
        const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[note[1].toLowerCase()];
        n = base + (note[2] === '#' ? 1 : note[2] === 'b' ? -1 : 0) + (Number(note[3]) + 2) * 12;
      } else if (/^\d+$/.test(text)) n = Number(text);
      else return undefined;
      if (type === 'program' && note === null && /^\d+$/.test(text)) n -= 1; // programs are shown 1..128
      if (n < 0 || n > 127) return undefined;
    }
    const ch = channel === null || channel === undefined || channel === '' ? null : Number(channel);
    if (ch !== null && !(Number.isInteger(ch) && ch >= 1 && ch <= 16)) return undefined;
    return { device, type, channel: ch, number: n };
  },

  /** Short label for a source: "CC 74", "Note C3", "Pitch bend". */
  sourceLabel(src) {
    if (src.type === 'cc') return `CC ${src.number}`;
    if (src.type === 'note') return `Note ${AddOnLogic.noteName(src.number)}`;
    if (src.type === 'pitch') return 'Pitch bend';
    if (src.type === 'program') return `Program ${src.number + 1}`;
    return src.type;
  },

  /** LUNA's control ids made readable: `gain` is the Fader, `pre_fader` is Pre-fader. */
  controlLabel(name) {
    const known = { gain: 'Fader', pan: 'Pan', pan_left: 'Pan L', pan_right: 'Pan R', mute: 'Mute', solo: 'Solo', pre_fader: 'Pre-fader', enabled: 'Send on' };
    if (known[name]) return known[name];
    const s = String(name ?? '').replace(/_/g, ' ');
    return s ? s[0].toUpperCase() + s.slice(1) : '?';
  },

  /**
   * The strip controls of every channel (fader, pan, mute, solo, sends, cues), loading what they
   * need, plus a list of the plugins on each channel. Each entry carries the Control and the names
   * a template uses to find it again in another session:
   * `{ path, rest, control, channel, channelId, area, name, label, switch }`.
   *
   * Plugin parameters are never read here. Reading a plugin's whole `controls` folder can hang or
   * crash LUNA (fact 101; a session full of Qi does it), so a parameter is read on its own, by
   * {@link AddOnLogic.entryAt}, when LUNA reports a touch on it or a mapping needs it.
   */
  async catalog(session, options = {}) {
    const { pluginName = () => undefined } = options;
    await session.buses.load();
    const buses = session.buses.items;
    const channels = [...session.visibleTracks, ...buses.filter((b) => !b.isMaster), ...buses.filter((b) => b.isMaster)];
    const entries = [];
    const inserts = [];
    for (const ch of channels) {
      await Promise.all([ch.loadStrip(), ch.controls.load(), ch.outputs.load(), ch.effects.load()]);
      for (const c of ch.main.controls.items) entries.push(AddOnLogic.entryOf(ch, 'Strip', c));
      const solo = ch.controls.byId('solo');
      if (solo) entries.push(AddOnLogic.entryOf(ch, 'Strip', solo));
      for (const out of ch.outputs.items) {
        if (!out.isCue && !(out.isSend && out.assigned)) continue;
        await out.controls.load();
        for (const c of out.controls.items) entries.push(AddOnLogic.entryOf(ch, AddOnLogic.outputArea(out.id), c));
      }
      inserts.push(...AddOnLogic.insertsOf(ch, pluginName));
    }
    return { entries, inserts };
  },

  /**
   * Every slot on a channel that holds a plugin, read live: inserts (`effect_N`) and the
   * `instrument`, `console` and `tape` slots alike. Live, because loading a plugin into a slot
   * changes that slot's `plugin_id` without changing the list of slots.
   */
  insertsOf(ch, pluginName = () => undefined) {
    const out = [];
    for (const fx of ch.effects.items) {
      const id = fx.pluginId.value;
      if (!id) continue;
      out.push({ channel: ch.name.value ?? ch.id, channelId: ch.id, slot: fx.id, path: fx.path, pluginId: id, pluginName: fx.pluginName.value || pluginName(id) || id, area: AddOnLogic.insertArea(fx, pluginName) });
    }
    return out;
  },

  /** "Send 2" for `send_1`, "Cue 1" for `cue_0`, "Strip" for `main`. */
  outputArea(id) {
    if (id === 'main') return 'Strip';
    const n = Number(id.slice(id.indexOf('_') + 1)) + 1;
    return `${id.startsWith('cue_') ? 'Cue' : 'Send'} ${n}`;
  },

  /** "Insert 1 · Qi". A slot's own plugin_name is null (fact 86); the plugin catalog has the name. */
  insertArea(fx, pluginName = () => undefined) {
    const plugin = fx.pluginName.value || pluginName(fx.pluginId.value) || fx.pluginId.value || fx.id;
    if (fx.id.startsWith('effect_')) return `Insert ${Number(fx.id.slice('effect_'.length)) + 1} · ${plugin}`;
    const slot = { instrument: 'Instrument', console: 'Console', tape: 'Tape' }[fx.id] ?? fx.id;
    return `${slot} · ${plugin}`;
  },

  /** A catalog entry for a loaded control. */
  entryOf(channel, area, control) {
    const plugin = control.path.includes('/effects/');
    const name = control.name.value ?? control.id;
    return {
      path: control.path,
      rest: control.path.slice(channel.path.length + 1),
      control,
      channel: channel.name.value ?? channel.id,
      channelId: channel.id,
      area,
      name: plugin ? name : control.id,
      label: plugin && name !== 'parameter' ? name : AddOnLogic.controlLabel(control.id),
      switch: control.isSwitch,
    };
  },

  /**
   * The entry for one control path under this session, reading only that control (with a
   * timeout), or undefined when the path is not a control of a known channel. This is how a
   * touched plugin parameter is learned without reading the plugin's other parameters.
   */
  async entryAt(session, path, options = {}) {
    const { pluginName, timeoutMs = 5000 } = options;
    const m = /^\/sessions\/[^/]+\/(tracks|buses)\/([^/]+)\/(.+)\/controls\/([^/]+)$/.exec(path) ?? /^\/sessions\/[^/]+\/(tracks|buses)\/([^/]+)\/()controls\/([^/]+)$/.exec(path);
    if (!m) return undefined;
    const [, kind, chId, where, id] = m;
    const ch = (kind === 'tracks' ? session.tracks : session.buses).byId(chId);
    if (!ch) return undefined;
    let control;
    let area;
    if (!where) {
      control = ch.controls.get(id);
      area = 'Strip';
    } else if (where.startsWith('effects/')) {
      await ch.effects.load();
      const fx = ch.effects.byId(where.slice('effects/'.length));
      if (!fx) return undefined;
      control = fx.controls.get(id);
      area = AddOnLogic.insertArea(fx, pluginName);
    } else if (where.startsWith('outputs/')) {
      await ch.outputs.load();
      const out = ch.outputs.byId(where.slice('outputs/'.length));
      if (!out) return undefined;
      control = out.controls.get(id);
      area = AddOnLogic.outputArea(out.id);
    } else return undefined;
    let timer;
    const ok = await Promise.race([control.load({ flatvalue: true, commands: false }).then(() => true), new Promise((r) => (timer = setTimeout(() => r(false), timeoutMs)))]);
    clearTimeout(timer);
    if (!ok) throw Object.assign(new Error(`${ch.name.value ?? chId}: ${area} did not answer`), { code: 'timeout' });
    return AddOnLogic.entryOf(ch, area, control);
  },

  /** The serialisable half of a catalog entry: what a mapping stores. */
  targetOf(entry) {
    return { kind: 'control', path: entry.path, rest: entry.rest, channel: entry.channel, area: entry.area, name: entry.name, label: entry.label };
  },

  /**
   * A Channel Focus target: where a control sits on a channel (`outputs/main/controls/gain`,
   * `effects/effect_0/controls/<id>`), not which track. It is resolved against whichever track
   * has the focus when MIDI arrives. `area` is kept so a plugin parameter only resolves on a track
   * with the same plugin in the same slot.
   */
  focusTargetOf(target) {
    if (target?.kind === 'automation') return { kind: 'automation', focus: true, action: target.action, label: target.label };
    if (!target?.rest) return undefined;
    return { kind: 'focus', rest: target.rest, area: target.area, name: target.name, label: target.label };
  },

  /** The Proxy's target: whichever control the user last touched in LUNA. */
  mightyTarget() {
    return { kind: 'mighty', label: 'Proxy' };
  },

  /** A command target. */
  commandTarget(id) {
    const c = COMMANDS.find((x) => x.id === id);
    return { kind: 'command', command: id, label: c?.label ?? id };
  },

  /**
   * Find a stored target in a catalog: by path first (same session), then by channel, area and
   * control name (a template or global mapping used in another session).
   */
  resolve(entries, target) {
    if (target.kind !== 'control') return undefined;
    return entries.find((e) => e.path === target.path) ?? entries.find((e) => e.channel === target.channel && e.area === target.area && e.name === target.name);
  },

  /** The mode a new mapping starts in: buttons toggle, knobs and faders follow. */
  defaultMode(source, target, entry) {
    if (target.kind === 'command') return 'trigger';
    if (target.kind === 'automation') return target.action === 'knob' ? 'absolute' : 'trigger';
    if (entry?.switch) return 'toggle';
    return source.type === 'note' ? 'toggle' : 'absolute';
  },

  /** Scale 0..1 into a mapping's range, honouring invert. */
  scale(mapping, v) {
    const x = mapping.invert ? 1 - v : v;
    const min = mapping.min ?? 0;
    const max = mapping.max ?? 1;
    return Math.min(1, Math.max(0, min + (max - min) * x));
  },
};

/**
 * Holds the mappings for one session plus the global ones, runs learn mode and applies MIDI.
 *
 * @example
 * const mapper = new AddOnLogic.Mapper(session, {
 *   storage: AddOnLogic.localStore(),
 *   subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }),
 *   pluginName: (id) => luna.plugins.byId(id)?.name.value,
 * });
 * await mapper.start();
 * mapper.setLearning(true);   // then touch a control in LUNA and move a knob
 * input.onmidimessage = (e) => mapper.midi(AddOnLogic.parseMidi(e.data), input.name);
 */
class Mapper {
  /**
   * `subscribe(path, handler)` delivers every engine event under `path`, recursively, and returns
   * an unsubscribe function: `(p, fn) => luna.raw.subscribe(p, fn, { recursive: true })`. It is
   * how a touch on any control reaches learn mode, plugin parameters included (fact 100).
   */
  constructor(session, { storage, subscribe, pluginName, send, feedbackHoldMs = FEEDBACK_HOLD_MS, now = () => Date.now() } = {}) {
    this.session = session;
    this.send = send; // (device, bytes) => boolean: MIDI out, for feedback; none means no feedback
    this.feedbackHoldMs = feedbackHoldMs;
    this.fb = {
      subs: new Map(), // mapping id -> unsubscribe
      sent: new Map(), // mapping id -> { raw, at } last value sent back
      heard: new Map(), // mapping id -> { raw, at } last value the controller sent
      seen: new Map(), // device-less source key -> { device, channel } where it was last heard
      timers: new Map(), // mapping id -> pending send after the hold
    };
    this.subscribe = subscribe;
    this.pluginName = pluginName;
    this.storage = storage;
    this.now = now;
    this.entries = [];
    this.inserts = [];
    this.loading = new Map(); // control path -> Promise<entry | undefined>
    this.learning = false;
    this.ready = false; // the strip scan has finished
    this.pending = { target: undefined, source: undefined };
    this.sessionMappings = [];
    this.globalMappings = [];
    this.focusMappings = [];
    this.pluginMappings = []; // plugin maps, flat: each mapping names its plugin type
    this.pluginTouched = undefined; // the insert path of the plugin whose parameter was touched last
    this.pluginLock = undefined; // an insert path that holds the plugin focus
    this.learnMode = 'map'; // 'map' (regular) or 'focus' (Channel Focus)
    this.focusLock = undefined; // a track id that holds the focus, instead of LUNA's selection
    this.mighty = null; // the Proxy mapping, if one is learned
    this.mightyPath = undefined; // the control it drives: the one touched last in LUNA
    this.mightyHold = false; // true: stay on the current control, ignore touches
    this.activity = new Map(); // mapping id -> when it last moved
    this.lastSource = undefined; // the last message seen, for the UI
    this.edges = new Map(); // source key -> last value, for rising edges
    this.writers = new Map(); // control path -> { busy, next, timer }
    this.selfTouched = new Map(); // control path -> when we last wrote it
    this.inflight = new Set(); // apply() promises not yet answered
    this.justLearned = new Map(); // source key -> when its last message arrived since it completed a mapping
    this.lastTouchPath = undefined; // the control touched last while learning
    this.justMapped = undefined; // { path, at }: a parameter just mapped, whose touch may still be trailing
    this.listeners = new Set();
    this.unsubs = [];
    this.sessionKey = undefined;
  }

  /** Called with no arguments whenever anything the UI shows has changed. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /**
   * Load the session's mappings and globals and start watching touches; learning and MIDI work
   * from here. Then scan the strip controls and read the plugin parameters mappings use.
   */
  async start() {
    await this.session.ready();
    if (!this.sessionKey) this.loadStored();
    if (this.session.focusedTrack && !this.focusFollowed) {
      this.focusFollowed = true;
      this.unsubs.push(this.session.focusedTrack.onChange(() => this.focusChanged()));
      // Plugins follow LUNA's selection directly, whatever Channel Focus's lock says.
      this.unsubs.push(this.session.focusedTrack.onChange(() => this.pluginSelectionMoved()));
    }
    if (this.subscribe && !this.subscribed) {
      this.subscribed = true;
      this.unsubs.push(this.subscribe(this.session.path, (e) => this.onEvent(e)));
    }
    this.emit();
    await this.rescan();
  }

  /** Read this session's mappings and the globals. Call once the session is ready. */
  loadStored() {
    this.sessionKey = KEYS.session(this.session.sessionPackageUid.value ?? this.session.uid);
    this.sessionMappings = this.storage.get(this.sessionKey) ?? [];
    this.globalMappings = this.storage.get(KEYS.globals) ?? [];
    this.focusMappings = this.storage.get(KEYS.focus) ?? [];
    this.mighty = this.storage.get(KEYS.mighty) ?? null;
    this.pluginMappings = this.storage.get(KEYS.plugins) ?? [];
    // Channel Focus mappings made before feedback defaulted on, and never switched either way,
    // get it now. One the user turned off (feedback: false) stays off.
    let migrated = false;
    for (const m of this.focusMappings) {
      if (m.feedback === undefined && (m.source.type === 'cc' || m.source.type === 'note')) {
        m.feedback = true;
        migrated = true;
      }
    }
    if (migrated) this.storage.set(KEYS.focus, this.focusMappings);
    this.emit();
  }

  /** Turn feedback on or off for every Channel Focus mapping at once (the section's switch). */
  setFocusFeedback(on) {
    for (const m of this.focusMappings) if (this.canFeedback(m)) m.feedback = !!on;
    this.save();
    if (on) {
      for (const m of this.focusMappings) this.fb.sent.delete(m.id);
      this.syncFeedback();
    }
    this.emit();
  }

  // ---- Plugins -----------------------------------------------------------------------------

  /** The insert at a path, with its plugin, or undefined when the slot is gone or empty. */
  /** Every plugin instance in the session right now (live: follows plugins loaded into slots). */
  liveInserts() {
    const channels = [...this.session.visibleTracks, ...this.session.buses.items];
    return channels.flatMap((ch) => AddOnLogic.insertsOf(ch, this.pluginName));
  }

  /** The plugin instance at an insert path, read live, or undefined when the slot is gone or empty. */
  insertAt(fxPath) {
    if (!fxPath) return undefined;
    const m = /^\/sessions\/[^/]+\/(tracks|buses)\/([^/]+)\/effects\/([^/]+)$/.exec(fxPath);
    const ch = m && (m[1] === 'tracks' ? this.session.tracks : this.session.buses).byId(m[2]);
    return ch ? AddOnLogic.insertsOf(ch, this.pluginName).find((i) => i.slot === m[3]) : undefined;
  }

  /**
   * The plugin instance plugin maps act on: a locked instance; else the plugin whose parameter
   * was touched last in LUNA, until another track is selected; else the first plugin with a saved
   * map on the track selected in LUNA. LUNA doesn't report which plugin windows are open, so
   * selecting a track (like Channel Focus) and touching a knob are what move the focus.
   */
  focusPlugin() {
    const locked = this.insertAt(this.pluginLock);
    if (locked) return locked;
    const touched = this.insertAt(this.pluginTouched);
    if (touched) return touched;
    const track = this.session.focusedTrack?.value;
    if (!track) return undefined;
    const mapped = new Set(this.pluginMappings.map((m) => m.target.pluginId));
    return AddOnLogic.insertsOf(track, this.pluginName).find((i) => mapped.has(i.pluginId));
  }

  /**
   * The track selected in LUNA changed: plugin maps move to that track's plugins. A plugin
   * touched on another track stops counting, so selecting a track works like Channel Focus.
   */
  pluginSelectionMoved() {
    const selected = this.session.focusedTrack?.value;
    const touched = this.insertAt(this.pluginTouched);
    if (touched && selected && touched.channelId !== selected.id) this.pluginTouched = undefined;
    this.pluginFocusChanged();
  }

  /** Hold the plugin focus on one instance (its insert path), or follow touches again. */
  setPluginLock(fxPath) {
    this.pluginLock = fxPath || undefined;
    this.pluginFocusChanged();
  }

  /** The focused plugin changed: read the parameters its map uses and re-aim feedback. */
  pluginFocusChanged() {
    const fp = this.focusPlugin();
    const key = fp ? `${fp.path}|${fp.pluginId}` : undefined;
    if (key === this.lastPluginKey) return this.emit();
    this.lastPluginKey = key;
    this.refreshFeedback();
    this.syncFeedback(); // motorized knobs jump to this instance's values, or back to what they had
    this.emit();
    // This instance's parameters may not be read yet: once they are, follow them and send them.
    const reads = this.pluginMappings.map((m) => this.ensure(this.pathFor(m.target)).catch(() => undefined));
    void Promise.all(reads).then(() => {
      if (this.lastPluginKey !== key) return;
      this.refreshFeedback();
      this.syncFeedback({ force: false }); // only what the first pass couldn't send
      this.emit();
    });
  }

  /** The plugin type and parameter behind a plugin parameter's path, for a plugin map. */
  pluginTargetOf(target) {
    if (target?.kind === 'plugin') return target;
    if (target?.kind !== 'control' || !target.path?.includes('/effects/')) return undefined;
    const fxPath = /^(.*\/effects\/[^/]+)\/controls\/([^/]+)$/.exec(target.path);
    const ins = fxPath && this.insertAt(fxPath[1]);
    if (!ins) return undefined;
    return { kind: 'plugin', pluginId: ins.pluginId, pluginName: ins.pluginName, param: fxPath[2], label: target.label };
  }

  /** Mappings of the focused plugin's map: the layer that owns its knobs right now. */
  activePluginMappings() {
    const fp = this.focusPlugin();
    return fp ? this.pluginMappings.filter((m) => m.target.pluginId === fp.pluginId) : [];
  }

  /** Feedback on or off for every mapping in one plugin's map (or all maps). */
  setPluginFeedback(on, pluginId) {
    for (const m of this.pluginMappings) if (!pluginId || m.target.pluginId === pluginId) m.feedback = !!on;
    this.save();
    if (on) this.syncFeedback();
    this.emit();
  }

  /** Delete one plugin's whole map. */
  deletePluginMap(pluginId) {
    this.pluginMappings = this.pluginMappings.filter((m) => m.target.pluginId !== pluginId);
    this.save();
    this.syncFeedback();
    this.emit();
  }

  /** Saved plugin maps: one per plugin type, with how many controls each has. */
  pluginMaps() {
    const maps = new Map();
    for (const m of this.pluginMappings) {
      const id = m.target.pluginId;
      if (!maps.has(id)) maps.set(id, { pluginId: id, pluginName: m.target.pluginName, count: 0 });
      maps.get(id).count++;
    }
    return [...maps.values()];
  }

  // ---- Proxy -------------------------------------------------------------------------

  /**
   * Point the Proxy at a control the user touched in LUNA (fact 100). Touches MIDI Learn
   * caused itself never move it. With feedback on, the control's value goes straight back, so
   * a motorized knob turns to it before the user does.
   */
  async retargetMighty(path) {
    if (!this.mighty || this.mightyHold || path === this.mightyPath) return;
    let entry;
    try {
      entry = await this.ensure(path);
    } catch {
      return;
    }
    if (!entry || this.mightyHold) return;
    this.mightyPath = entry.path;
    this.fb.sent.delete(this.mighty.id);
    this.fb.heard.delete(this.mighty.id);
    this.refreshFeedback();
    this.feedback(this.mighty.id, { force: true });
    this.emit();
  }

  /**
   * Put the parameter in focus back to LUNA's default for it (fact 92), as one undo step. The
   * parameter in focus is the one last touched in LUNA, or last moved through the Proxy or a
   * Channel Focus knob. Returns the entry it reset, or undefined when there's nothing in focus.
   */
  async resetFocused() {
    const path = this.focusedPath ?? this.mightyPath;
    if (!path) return undefined;
    const entry = await this.ensure(path).catch(() => undefined);
    if (!entry) return undefined;
    this.selfTouched.set(path, this.now()); // its touch is ours: don't retarget anything
    await entry.control.resetToDefault();
    this.lastReset = { label: entry.label, where: `${entry.channel} · ${entry.area}` };
    this.emit();
    return entry;
  }

  /** Keep the Proxy on its current control (true), or let it follow touches again. */
  setMightyHold(on) {
    this.mightyHold = !!on;
    this.emit();
  }

  // ---- Channel Focus ----------------------------------------------------------------------

  /** The track Channel Focus mappings act on: the locked one, else the one selected in LUNA. */
  focusTrack() {
    const locked = this.focusLock && this.session.tracks.byId(this.focusLock);
    return locked || this.session.focusedTrack?.value;
  }

  /** Hold the focus on one track (an id), or follow LUNA's selection again (undefined). */
  setFocusLock(trackId) {
    this.focusLock = trackId || undefined;
    this.focusChanged();
  }

  /** The focus moved: read the new track's controls the focus mappings use and re-aim feedback. */
  focusChanged() {
    const focusId = this.focusTrack()?.id;
    if (focusId === this.lastFocusId) return this.emit();
    this.lastFocusId = focusId;
    this.refreshFeedback();
    this.syncFeedback(); // motorized knobs jump to the new track's values
    // A plugin parameter on the new track may not be read yet: send it once it is.
    const reads = this.focusMappings.map((m) => this.ensure(this.pathFor(m.target)).catch(() => undefined));
    void Promise.all(reads).then(() => {
      if (this.lastFocusId !== focusId) return;
      this.refreshFeedback();
      this.syncFeedback({ force: false }); // only what the first pass couldn't send
    });
    this.onFocusMoved?.(this.focusTrack());
    this.pluginFocusChanged();
  }

  onEvent(e) {
    if (!e.path.endsWith('/touch_count') || typeof e.data !== 'number' || e.data <= 0) return;
    const path = e.path.slice(0, -'/touch_count'.length);
    // A knob turned in a plugin's window focuses that plugin, while learning or not.
    if (!this.isOwnTouch(path)) {
      const fx = /^(.*\/effects\/[^/]+)\/controls\/[^/]+$/.exec(path)?.[1];
      if (fx && fx !== this.pluginTouched) {
        this.pluginTouched = fx;
        this.pluginFocusChanged();
      }
    }
    if (this.learning) return void this.touchedPath(path);
    if (this.isOwnTouch(path)) return;
    this.focusedPath = path; // the parameter "in focus", for Reset parameter to default
    void this.retargetMighty(path);
  }

  /** A touch MIDI Learn caused by writing that control, rather than the user's mouse. */
  isOwnTouch(path) {
    const mine = this.selfTouched.get(path);
    return this.writers.has(path) || (mine !== undefined && this.now() - mine < SELF_TOUCH_MS);
  }

  /** Re-read the strip controls (tracks, sends or plugins changed), then the mapped plugin parameters. */
  async rescan() {
    const { entries, inserts } = await AddOnLogic.catalog(this.session, { pluginName: this.pluginName });
    const kept = this.entries.filter((e) => e.path.includes('/effects/') && entries.every((x) => x.path !== e.path));
    this.entries = [...entries, ...kept];
    this.inserts = inserts;
    this.ready = true;
    this.emit();
    this.lastFocusId = this.focusTrack()?.id;
    this.lastPluginKey = undefined; // inserts may have changed under the plugin focus
    for (const m of this.all()) if (['control', 'focus', 'plugin'].includes(m.target.kind) && !this.entryFor(m.target)) await this.ensure(this.pathFor(m.target)).catch(() => {});
    this.refreshFeedback();
    this.syncFeedback();
    this.emit();
  }

  /** The entry for a control path, reading that one control when it is not known yet. */
  ensure(path) {
    if (!path) return Promise.resolve(undefined);
    const known = this.entries.find((e) => e.path === path);
    if (known) return Promise.resolve(known);
    if (!this.loading.has(path)) {
      const p = AddOnLogic.entryAt(this.session, path, { pluginName: this.pluginName })
        .then((entry) => {
          if (entry && !this.entries.some((e) => e.path === entry.path)) {
            this.entries.push(entry);
            this.refreshFeedback();
          }
          this.emit();
          return entry;
        })
        .finally(() => this.loading.delete(path));
      this.loading.set(path, p);
    }
    return this.loading.get(path);
  }

  /** The track an automation target acts on: the focused one for Channel Focus, else its own (by id, then name). */
  trackFor(target) {
    if (target.kind !== 'automation') return undefined;
    if (target.focus) return this.focusTrack();
    return this.session.tracks.byId(target.channelId) ?? this.session.visibleTracks.find((t) => (t.name.value ?? t.id) === target.channel);
  }

  /** A stored target's entry in this session, if it is loaded. */
  entryFor(target) {
    if (target.kind === 'plugin') {
      const path = this.pathFor(target);
      return path ? this.entries.find((e) => e.path === path) : undefined;
    }
    if (target.kind === 'mighty') return this.mightyPath ? this.entries.find((e) => e.path === this.mightyPath) : undefined;
    if (target.kind === 'focus') {
      const path = this.pathFor(target);
      const entry = path && this.entries.find((e) => e.path === path);
      // A plugin parameter counts only where the same plugin sits in the same slot.
      return entry && entry.area === target.area ? entry : undefined;
    }
    return AddOnLogic.resolve(this.entries, target);
  }

  /**
   * Where a stored target lives in this session: its own path, or the same control on the
   * channel of the same name (a template or global mapping from another session).
   */
  pathFor(target) {
    if (target.kind === 'plugin') {
      const fp = this.focusPlugin();
      return fp && fp.pluginId === target.pluginId ? `${fp.path}/controls/${target.param}` : undefined;
    }
    if (target.kind === 'mighty') return this.mightyPath;
    if (target.kind === 'focus') {
      const track = this.focusTrack();
      return track ? `${track.path}/${target.rest}` : undefined;
    }
    if (target.kind !== 'control') return undefined;
    if (this.session.path && target.path?.startsWith(`${this.session.path}/`)) return target.path;
    if (!target.rest) return undefined;
    const channels = [...this.session.tracks.items, ...this.session.buses.items];
    const ch = channels.find((c) => (c.name.value ?? c.id) === target.channel);
    return ch ? `${ch.path}/${target.rest}` : undefined;
  }

  /** LUNA reports a touch on a control: in learn mode, that is the target the user picked. */
  async touchedPath(path) {
    if (!this.learning) return;
    // A plugin editor keeps reporting touches for a moment after a gesture. The trailing touches
    // of the parameter just mapped mustn't make it the target again.
    if (this.justMapped?.path === path && this.now() - this.justMapped.at < LEARN_SETTLE_MS) {
      this.justMapped.at = this.now();
      return;
    }
    this.lastTouchPath = path;
    const mine = this.selfTouched.get(path);
    if (mine !== undefined && this.now() - mine < SELF_TOUCH_MS) return;
    if (this.writers.has(path)) return;
    try {
      const entry = await this.ensure(path);
      if (!this.learning) return;
      if (!entry) return this.onLearnNote?.(`touched ${path}: not a control MIDI Learn can map`);
      const ok = this.pick(AddOnLogic.targetOf(entry));
      this.onLearnNote?.(`touched ${entry.channel} · ${entry.area} · ${entry.label} while learning (${this.learnMode}): ${ok === false ? 'not usable in this section' : 'picked'}`);
    } catch (e) {
      this.lastError = { message: e.message ?? String(e) };
      this.emit();
    }
  }

  /** Start or stop learning; `mode` 'focus' learns a Channel Focus mapping. */
  setLearning(on, mode = 'map', { latch = false } = {}) {
    this.justLearned.clear(); // the settle guards only span one continuous learn
    this.justMapped = undefined;
    this.lastTouchPath = undefined;
    this.learning = on;
    this.learnMode = on ? mode : 'map';
    // Latch: keep learning after each mapping, for several in a row. The Proxy is one knob, so
    // there is nothing to latch there.
    this.latch = on && latch && mode !== 'mighty';
    // The Proxy needs only a source: its target is whatever gets touched later.
    this.pending = { target: on && mode === 'mighty' ? AddOnLogic.mightyTarget() : undefined, source: undefined };
    this.emit();
  }

  /**
   * Hold (called latch in code): keep learning after each mapping, so the user can map one
   * control after another. Can be switched while learning. The Proxy is one knob: no hold.
   */
  setHold(on) {
    this.latch = !!on && this.learnMode !== 'mighty';
    this.emit();
  }

  /** Choose a target, from LUNA or from the add-on's own list. Completes a learn when a source waits. */
  pick(target) {
    if (this.learnMode === 'mighty') return false; // nothing to pick: it follows touches
    if (this.learnMode === 'plugin') {
      // A plugin map learns a parameter of a plugin type, from any instance of it.
      target = this.pluginTargetOf(target);
      if (!target) return false;
    }
    if (this.learnMode === 'focus') {
      // Channel Focus learns where a control sits, from whichever track it was touched on.
      // Commands aren't per channel, so they can't be focus-learned.
      target = target.kind === 'focus' ? target : AddOnLogic.focusTargetOf(target);
      if (!target) return false;
    }
    if (!this.learning) this.justLearned.clear(); // a fresh learn
    this.learning = true;
    this.pending.target = target;
    this.complete();
    this.emit();
  }

  /**
   * Feed one parsed MIDI message from `device`. In learn mode it becomes the pending source;
   * otherwise every mapping it matches is applied.
   */
  midi(msg, device) {
    if (!msg) return;
    const source = { device: device ?? null, type: msg.type, channel: msg.channel, number: msg.number };
    this.lastSource = { ...source, value: msg.value, raw: msg.raw, at: this.now() };
    if (this.learning) {
      const now = this.now();
      // The rest of the turn that just made a mapping isn't the knob for the next one: a turn is
      // a stream of messages, and only a fresh turn (after a pause) or another knob counts.
      const key = AddOnLogic.sourceKey(source);
      const last = this.justLearned.get(key);
      if (last !== undefined) {
        if (now - last < LEARN_SETTLE_MS) {
          this.justLearned.set(key, now);
          this.emit();
          return;
        }
        this.justLearned.delete(key);
      }
      // A motorized knob's echo of a value we just sent back isn't the user turning it.
      const echo = this.all().some((m) => {
        const sent = this.fb.sent.get(m.id);
        return sent && this.matches(m.source, source) && now - sent.at < LEARN_ECHO_MS && Math.abs(sent.raw - msg.raw) <= 2;
      });
      // A note-off or a button's release should not stand in for the press the user made.
      if (!echo && !(msg.type === 'note' && !msg.on)) {
        this.pending.source = source;
        this.complete();
      }
      this.emit();
      return;
    }
    const key = AddOnLogic.sourceKey(source);
    const prev = this.edges.get(key) ?? 0;
    this.edges.set(key, msg.value);
    this.fb.seen.set(AddOnLogic.sourceKey({ ...source, device: null, channel: null }), { device: source.device, channel: source.channel });
    // The focused plugin's map is a layer on top: where it uses a source, it alone gets it.
    const layer = this.activePluginMappings().filter((m) => this.matches(m.source, source));
    const targets = layer.length ? layer : this.all().filter((m) => m.scope !== 'plugin' && this.matches(m.source, source));
    for (const m of targets) {
      if (m.feedback) {
        // The motor's echo of a value we just sent is not the user's hand.
        const sent = this.fb.sent.get(m.id);
        if (sent && this.now() - sent.at < FEEDBACK_ECHO_MS && Math.abs(sent.raw - msg.raw) <= 1) continue;
        this.fb.heard.set(m.id, { raw: msg.raw, at: this.now() });
      }
      this.activity.set(m.id, this.now());
      const p = this.apply(m, msg, prev).catch((e) => this.fail(m, e));
      this.inflight.add(p);
      p.finally(() => this.inflight.delete(p));
    }
    this.emit();
  }

  matches(a, b) {
    return (a.device === null || a.device === b.device) && (a.channel === null || a.channel === b.channel) && a.type === b.type && a.number === b.number;
  }

  fail(mapping, e) {
    this.lastError = { id: mapping.id, message: e?.code ?? e?.message ?? String(e) };
    this.emit();
  }

  /**
   * Use a typed-in source (from {@link AddOnLogic.manualSource}) instead of waiting for MIDI.
   * Completes the mapping when a target is picked; returns whether it did.
   */
  assign(source) {
    if (!source) return false;
    this.learning = true;
    this.pending.source = source;
    const had = this.pending.target !== undefined;
    this.complete();
    this.emit();
    return had;
  }

  /** When both a target and a source are waiting, store the mapping and leave learn mode. */
  complete() {
    const { target, source } = this.pending;
    if (!target || !source) return;
    const focus = target.kind === 'focus' || (target.kind === 'automation' && target.focus === true);
    const mighty = target.kind === 'mighty';
    const plugin = target.kind === 'plugin';
    const entry = target.kind === 'plugin' ? this.entryFor(target) : focus ? this.entries.find((e) => e.rest === target.rest && e.area === target.area) : AddOnLogic.resolve(this.entries, target);
    const mapping = {
      id: `m${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      source,
      target,
      mode: AddOnLogic.defaultMode(source, target, entry),
      min: 0,
      max: 1,
      invert: false,
      scope: plugin ? 'plugin' : mighty ? 'mighty' : focus ? 'focus' : 'session',
    };
    if (plugin) {
      // A plugin map is a layer over the others: the same knob can mean different parameters for
      // different plugins, so only this plugin's map gives up the source.
      mapping.mode = entry?.switch ? 'toggle' : 'absolute';
      if (source.type === 'cc' || source.type === 'note') mapping.feedback = true;
      const key = AddOnLogic.sourceKey(source);
      this.pluginMappings = this.pluginMappings.filter((m) => !(m.target.pluginId === target.pluginId && (AddOnLogic.sourceKey(m.source) === key || m.target.param === target.param)));
      this.pluginMappings.push(mapping);
      this.lastLearned = mapping.id;
      this.pending = { target: undefined, source: undefined };
      this.justLearned.set(AddOnLogic.sourceKey(source), this.now());
      this.justMapped = this.lastTouchPath ? { path: this.lastTouchPath, at: this.now() } : undefined;
      if (!this.latch) {
        this.learning = false;
        this.learnMode = 'map';
      }
      this.save();
      void this.ensure(this.pathFor(target)).catch(() => {});
      return;
    }
    if (mighty) {
      mapping.mode = 'absolute';
      mapping.feedback = true; // motorized knobs follow each new target
    }
    // Channel Focus is a dedicated channel controller: its knobs should follow the focused track.
    if (focus && (source.type === 'cc' || source.type === 'note')) mapping.feedback = true;
    // One source drives one target, across regular and Channel Focus mappings: learning a source
    // again moves it.
    const key = AddOnLogic.sourceKey(source);
    const other = (m) => AddOnLogic.sourceKey(m.source) !== key;
    this.sessionMappings = this.sessionMappings.filter(other);
    this.globalMappings = this.globalMappings.filter(other);
    this.focusMappings = this.focusMappings.filter(other);
    if (mighty) {
      this.fb.sent.delete(this.mighty?.id);
      this.mighty = mapping;
    } else {
      if (this.mighty && !other(this.mighty)) this.mighty = null;
      (focus ? this.focusMappings : this.sessionMappings).push(mapping);
    }
    this.lastLearned = mapping.id;
    this.pending = { target: undefined, source: undefined };
    this.justLearned.set(AddOnLogic.sourceKey(source), this.now());
    this.justMapped = this.lastTouchPath ? { path: this.lastTouchPath, at: this.now() } : undefined;
    if (!this.latch) {
      this.learning = false;
      this.learnMode = 'map';
    }
    this.save();
    if (focus) void this.ensure(this.pathFor(target)).catch(() => {});
  }

  /** Session mappings shadow global ones on the same source. */
  all() {
    const keys = new Set(this.sessionMappings.map((m) => AddOnLogic.sourceKey(m.source)));
    const globals = this.globalMappings.filter((m) => !keys.has(AddOnLogic.sourceKey(m.source)));
    for (const m of globals) keys.add(AddOnLogic.sourceKey(m.source));
    const focus = this.focusMappings.filter((m) => !keys.has(AddOnLogic.sourceKey(m.source)));
    for (const m of focus) keys.add(AddOnLogic.sourceKey(m.source));
    const mighty = this.mighty && !keys.has(AddOnLogic.sourceKey(this.mighty.source)) ? [this.mighty] : [];
    return [...this.sessionMappings, ...globals, ...focus, ...mighty, ...this.pluginMappings];
  }

  find(id) {
    return this.sessionMappings.find((m) => m.id === id) ?? this.globalMappings.find((m) => m.id === id) ?? this.focusMappings.find((m) => m.id === id) ?? (this.mighty?.id === id ? this.mighty : undefined) ?? this.pluginMappings.find((m) => m.id === id);
  }

  save() {
    this.refreshFeedback();
    this.storage.set(this.sessionKey, this.sessionMappings);
    this.storage.set(KEYS.globals, this.globalMappings);
    this.storage.set(KEYS.focus, this.focusMappings);
    this.storage.set(KEYS.mighty, this.mighty);
    this.storage.set(KEYS.plugins, this.pluginMappings);
  }

  /** Change a mapping's mode, min, max, invert, source device or scope ('session' | 'global'). */
  update(id, patch) {
    const m = this.find(id);
    if (!m) return;
    const { source, ...rest } = patch;
    Object.assign(m, rest);
    if (source) m.source = { ...m.source, ...source };
    if (m.scope === 'plugin') {
      // Within one plugin's map, a source drives one parameter.
      const key = AddOnLogic.sourceKey(m.source);
      if (source) this.pluginMappings = this.pluginMappings.filter((x) => x === m || x.target.pluginId !== m.target.pluginId || AddOnLogic.sourceKey(x.source) !== key);
      this.save();
      if (rest.feedback === true) {
        this.fb.sent.delete(id);
        this.feedback(id, { force: true });
      }
      return this.emit();
    }
    // A source drives one target: moving this mapping onto another's source replaces that one.
    const key = AddOnLogic.sourceKey(m.source);
    const others = (x) => x.id === id || !(source && AddOnLogic.sourceKey(x.source) === key);
    this.sessionMappings = this.sessionMappings.filter(others);
    this.globalMappings = this.globalMappings.filter(others);
    this.focusMappings = this.focusMappings.filter(others);
    if (this.mighty && this.mighty !== m && !others(this.mighty)) this.mighty = null;
    if (m.scope === 'focus' || m.scope === 'mighty') {
      this.save();
      if (rest.feedback === true) {
        this.fb.sent.delete(id);
        this.feedback(id, { force: true });
      }
      return this.emit();
    }
    // Edited in place: a mapping keeps its position, so the list doesn't reorder under the mouse.
    // Only a change of scope moves it, to the other list.
    const home = m.scope === 'global' ? this.globalMappings : this.sessionMappings;
    const away = m.scope === 'global' ? this.sessionMappings : this.globalMappings;
    if (away.includes(m)) away.splice(away.indexOf(m), 1);
    if (!home.includes(m)) home.push(m);
    this.save();
    if (rest.feedback === true) {
      this.fb.sent.delete(id);
      this.feedback(id, { force: true });
    }
    this.emit();
  }

  remove(id) {
    this.sessionMappings = this.sessionMappings.filter((m) => m.id !== id);
    this.globalMappings = this.globalMappings.filter((m) => m.id !== id);
    this.focusMappings = this.focusMappings.filter((m) => m.id !== id);
    if (this.mighty?.id === id) this.mighty = null;
    this.pluginMappings = this.pluginMappings.filter((m) => m.id !== id);
    this.save();
    this.emit();
  }

  clearSession() {
    this.sessionMappings = [];
    this.save();
    this.emit();
  }

  /** What the UI lists: every mapping with its resolved control, or `missing`. */
  rows() {
    return this.all().map((m) => {
      const entry = this.entryFor(m.target);
      const command = m.target.kind === 'command';
      if (m.target.kind === 'plugin') {
        const fp = this.focusPlugin();
        const active = fp?.pluginId === m.target.pluginId;
        return {
          mapping: m,
          entry,
          source: AddOnLogic.sourceLabel(m.source),
          channel: m.source.channel,
          device: m.source.device,
          target: entry?.label ?? m.target.label,
          where: active ? `${m.target.pluginName} · ${fp.channel} · ${fp.area.split(' · ')[0]}` : m.target.pluginName,
          display: entry?.control.display.value ?? '',
          missing: false,
          missingWhy: '',
          plugin: true,
          active,
          focus: false,
          global: false,
          movedAt: this.activity.get(m.id) ?? 0,
        };
      }
      if (m.target.kind === 'automation') {
        const track = this.trackFor(m.target);
        const mode = track?.automationMode.value;
        return {
          mapping: m,
          entry: undefined,
          track,
          source: AddOnLogic.sourceLabel(m.source),
          channel: m.source.channel,
          device: m.source.device,
          target: m.target.label,
          where: m.target.focus ? 'Automation' : `${track?.name.value ?? m.target.channel} · Automation`,
          display: mode ? AUTOMATION_LABELS[mode] ?? mode : '',
          missing: !track && this.ready,
          missingWhy: m.target.focus ? 'no focused track' : 'not in this session',
          automation: true,
          focus: m.scope === 'focus',
          global: m.scope === 'global',
          movedAt: this.activity.get(m.id) ?? 0,
        };
      }
      if (m.target.kind === 'mighty') {
        return {
          mapping: m,
          entry,
          source: AddOnLogic.sourceLabel(m.source),
          channel: m.source.channel,
          device: m.source.device,
          target: entry?.label ?? 'Nothing yet',
          where: entry ? `${entry.channel} · ${entry.area}` : 'Click any control in LUNA',
          display: entry?.control.display.value ?? '',
          missing: false,
          missingWhy: '',
          mighty: true,
          hold: this.mightyHold,
          focus: false,
          global: false,
          movedAt: this.activity.get(m.id) ?? 0,
        };
      }
      if (m.target.kind === 'focus') {
        const track = this.focusTrack();
        const name = track?.name.value ?? 'no track';
        return {
          mapping: m,
          entry,
          source: AddOnLogic.sourceLabel(m.source),
          channel: m.source.channel,
          device: m.source.device,
          target: entry?.label ?? m.target.label,
          where: m.target.area,
          display: entry?.control.display.value ?? '',
          missing: !entry && this.ready && !this.loading.has(this.pathFor(m.target)),
          missingWhy: `not on ${name}`,
          focus: true,
          global: false,
          movedAt: this.activity.get(m.id) ?? 0,
        };
      }
      return {
        mapping: m,
        entry,
        source: AddOnLogic.sourceLabel(m.source),
        channel: m.source.channel,
        device: m.source.device,
        target: command ? m.target.label : entry?.label ?? m.target.label,
        where: command ? 'Command' : `${entry?.channel ?? m.target.channel} · ${entry?.area ?? m.target.area}`,
        display: entry?.control.display.value ?? '',
        missing: !command && !entry && this.ready && !this.loading.has(this.pathFor(m.target)),
        missingWhy: 'not in this session',
        focus: false,
        global: m.scope === 'global',
        movedAt: this.activity.get(m.id) ?? 0,
      };
    });
  }

  // ---- Applying MIDI ---------------------------------------------------------------------

  async apply(m, msg, prev) {
    const rising = msg.value >= 0.5 && prev < 0.5;
    // A button target (a command, an automation mode) fires on the press in Follow, or on every
    // change in Toggle: a latching button sends 127 on one press and 0 on the next, and each of
    // those is a press. ('trigger', the older name, is Follow.)
    const pressed = m.mode === 'toggle' ? msg.value !== prev : rising;
    if (m.target.kind === 'command') {
      if (!pressed) return;
      const cmd = COMMANDS.find((c) => c.id === m.target.command);
      if (cmd) await cmd.run(this.session, this);
      return;
    }
    if (m.target.kind === 'automation') return this.applyAutomation(m, msg, pressed);
    const entry = this.entryFor(m.target);
    if (!entry) {
      void this.ensure(this.pathFor(m.target)).catch(() => {});
      return;
    }
    const control = entry.control;
    if (m.target.kind === 'mighty' || m.target.kind === 'focus') this.focusedPath = entry.path;
    if (m.mode === 'toggle') {
      if (!rising) return;
      this.selfTouched.set(entry.path, this.now());
      if (control.isSwitch) return control.toggle();
      const lo = m.min ?? 0;
      const hi = m.max ?? 1;
      return control.normalized.set((control.normalized.value ?? 0) >= (lo + hi) / 2 ? lo : hi);
    }
    if (control.isSwitch) {
      const on = AddOnLogic.scale(m, msg.value) >= 0.5;
      if (on === control.on) return;
      this.selfTouched.set(entry.path, this.now());
      return control.toggle();
    }
    this.write(entry, AddOnLogic.scale(m, msg.value));
  }

  /** Set a track's automation mode from a button (on the press) or a knob (when it enters a new zone). */
  async applyAutomation(m, msg, rising) {
    const track = this.trackFor(m.target);
    if (!track) return;
    const now = track.automationMode.value;
    const { action } = m.target;
    let next;
    if (action === 'knob') next = AddOnLogic.automationZone(AddOnLogic.scale(m, msg.value));
    else if (!rising) return;
    else if (action === 'next') next = AUTOMATION_MODES[(AUTOMATION_MODES.indexOf(now) + 1) % AUTOMATION_MODES.length];
    else next = action;
    if (next && next !== now) await track.setAutomationMode(next);
  }

  /**
   * A continuous write: touch on the first value, send the latest value whenever the previous
   * write has been answered (so a fast knob never queues a backlog), release after a quiet gap.
   * That makes one undo step and one automation pass per move (fact 78).
   */
  write(entry, value) {
    const control = entry.control;
    let w = this.writers.get(entry.path);
    if (!w) {
      w = { busy: undefined, next: undefined, timer: undefined };
      this.writers.set(entry.path, w);
      control.begin();
    }
    this.selfTouched.set(entry.path, this.now());
    w.next = value;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => void this.release(entry.path), RELEASE_MS);
    if (!w.busy) w.busy = this.drain(w, control);
  }

  async drain(w, control) {
    try {
      while (w.next !== undefined) {
        const v = w.next;
        w.next = undefined;
        await control.normalized.set(v).catch(() => {});
      }
    } finally {
      w.busy = undefined;
    }
  }

  async release(path) {
    const w = this.writers.get(path);
    if (!w) return;
    clearTimeout(w.timer);
    this.writers.delete(path);
    await w.busy;
    const entry = this.entries.find((e) => e.path === path);
    entry?.control.end();
  }

  /** Release every open touch now (the session is going away, or a test wants it settled). */
  async flush() {
    await Promise.all([...this.writers.keys()].map((p) => this.release(p)));
  }

  /** Resolves once every write and command MIDI has started is answered. */
  async settled() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
    await Promise.all([...this.writers.values()].map((w) => w.busy));
    // Control.end() sends its release without returning the request, so give it a turn to go out.
    await new Promise((r) => setTimeout(r, 0));
  }

  async dispose() {
    for (const u of this.fb.subs.values()) u();
    this.fb.subs.clear();
    for (const t of this.fb.timers.values()) clearTimeout(t);
    this.fb.timers.clear();
    await this.flush();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.listeners.clear();
    this.learning = false;
  }

  // ---- Feedback to motorized controllers ------------------------------------------------------

  /** Whether a mapping can send its value back: a control target driven by a CC or a note. */
  canFeedback(m) {
    if (m.target.kind === 'automation' && m.target.action === 'next') return false; // nothing to show
    return ['control', 'focus', 'mighty', 'automation', 'plugin'].includes(m.target.kind) && (m.source.type === 'cc' || m.source.type === 'note');
  }

  /** Follow the controls of every mapping with feedback on; drop the rest. Cheap when none are. */
  refreshFeedback() {
    const want = new Map();
    if (this.send) {
      for (const m of this.all()) {
        if (!m.feedback || !this.canFeedback(m)) continue;
        const watch = this.feedbackWatch(m);
        if (watch) want.set(m.id, watch);
      }
    }
    for (const [id, unsub] of this.fb.subs) {
      if (want.get(id) && this.fb.subs.get(id).path === want.get(id).path) continue;
      unsub();
      this.fb.subs.delete(id);
    }
    for (const [id, watch] of want) {
      if (this.fb.subs.has(id)) continue;
      const fire = () => this.feedback(id);
      const stops = watch.props.map((p) => p.onChange(fire));
      const unsub = () => stops.forEach((stop) => stop());
      unsub.path = watch.path;
      this.fb.subs.set(id, unsub);
    }
  }

  /** What a feedback mapping follows: its control's value, or its track's automation mode. */
  feedbackWatch(m) {
    if (m.target.kind === 'automation') {
      const track = this.trackFor(m.target);
      return track && { path: `${track.path}#automation_mode`, props: [track.automationMode] };
    }
    const entry = this.entryFor(m.target);
    return entry && { path: entry.path, props: [entry.control.normalized, entry.control.real] };
  }

  /** Send every feedback mapping's current value, so the knobs move to where LUNA is. */
  syncFeedback({ force = true } = {}) {
    for (const id of this.fb.subs.keys()) this.feedback(id, { force });
  }

  /** The 0..127 a mapping's control is at, through the mapping's range and invert; undefined if unknown. */
  feedbackValue(m, entry) {
    const c = entry.control;
    if (c.isSwitch || m.mode === 'toggle') {
      const on = c.isSwitch ? c.on : (c.normalized.value ?? 0) >= ((m.min ?? 0) + (m.max ?? 1)) / 2;
      return (m.invert ? !on : on) ? 127 : 0;
    }
    const n = c.normalized.value;
    if (typeof n !== 'number') return undefined;
    const lo = m.min ?? 0;
    const hi = m.max ?? 1;
    if (hi === lo) return undefined;
    let v = Math.min(1, Math.max(0, (n - lo) / (hi - lo)));
    if (m.invert) v = 1 - v;
    return Math.round(v * 127);
  }

  /** Send one mapping's value back to its controller, unless the user's hand is on it (see top of file). */
  feedback(id, { force = false } = {}) {
    const m = this.find(id);
    if (!m || !m.feedback || !this.send || !this.canFeedback(m)) return false;
    // While the focused plugin's map owns a knob, nothing below it moves that knob.
    if (m.scope !== 'plugin') {
      const key = AddOnLogic.sourceKey({ ...m.source, device: null });
      if (this.activePluginMappings().some((p) => AddOnLogic.sourceKey({ ...p.source, device: null }) === key)) return false;
    }
    const automation = m.target.kind === 'automation';
    const entry = automation ? undefined : this.entryFor(m.target);
    const track = automation ? this.trackFor(m.target) : undefined;
    if (!entry && !track) return false;
    const now = this.now();
    if (!force) {
      if (entry && this.writers.has(entry.path)) return this.feedbackLater(id);
      const heard = this.fb.heard.get(id);
      if (heard && now - heard.at < this.feedbackHoldMs) return this.feedbackLater(id);
    }
    const raw = automation ? this.automationFeedback(m, track) : this.feedbackValue(m, entry);
    if (raw === undefined) return false;
    if (!force) {
      if (this.fb.sent.get(id)?.raw === raw) return false;
      if (this.fb.heard.get(id)?.raw === raw) return false;
    }
    const seen = this.fb.seen.get(AddOnLogic.sourceKey({ ...m.source, device: null, channel: null }));
    const device = m.source.device ?? seen?.device;
    if (!device) return false; // "any input" and never heard: no idea where to send it
    const ch = (m.source.channel ?? seen?.channel ?? 1) - 1;
    const bytes = m.source.type === 'cc' ? [0xb0 | ch, m.source.number, raw] : raw >= 64 ? [0x90 | ch, m.source.number, 127] : [0x80 | ch, m.source.number, 0];
    if (!this.send(device, bytes)) return false;
    this.fb.sent.set(id, { raw, at: now });
    return true;
  }

  /** A mode button lights (127) when its track is in that mode; the knob sits in the mode's zone. */
  automationFeedback(m, track) {
    const mode = track.automationMode.value;
    if (!mode) return undefined;
    if (m.target.action === 'knob') {
      const i = AUTOMATION_MODES.indexOf(mode);
      let v = (i + 0.5) / AUTOMATION_MODES.length; // the middle of its zone
      const lo = m.min ?? 0;
      const hi = m.max ?? 1;
      v = hi === lo ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
      return Math.round((m.invert ? 1 - v : v) * 127);
    }
    const on = mode === m.target.action;
    return (m.invert ? !on : on) ? 127 : 0;
  }

  /** Try again once the user has let go. */
  feedbackLater(id) {
    if (!this.fb.timers.has(id)) {
      this.fb.timers.set(
        id,
        setTimeout(() => {
          this.fb.timers.delete(id);
          this.feedback(id);
        }, this.feedbackHoldMs + 20),
      );
    }
    return false;
  }

  // ---- Templates ---------------------------------------------------------------------------

  templates() {
    return this.storage.get(KEYS.templates) ?? [];
  }

  /** Save the session's mappings under a name, replacing a template of that name. */
  saveTemplate(name) {
    const clean = String(name ?? '').trim();
    if (!clean) return false;
    const list = this.templates().filter((t) => t.name !== clean);
    // A template is the whole controller layout: every mode.
    const copy = (list) => list.map((m) => ({ ...m }));
    list.push({
      name: clean,
      saved: this.now(),
      mappings: copy(this.sessionMappings),
      globals: copy(this.globalMappings),
      focus: copy(this.focusMappings),
      mighty: this.mighty ? { ...this.mighty } : null,
      plugins: copy(this.pluginMappings),
    });
    list.sort((a, b) => a.name.localeCompare(b.name));
    this.storage.set(KEYS.templates, list);
    this.emit();
    return true;
  }

  /**
   * Load a template's mappings into this session. Targets are found again by track, area and
   * control name; ones this session lacks stay listed as missing until such a control appears.
   * `replace` clears the session's mappings first; otherwise a template mapping replaces one on
   * the same source.
   */
  applyTemplate(name, { replace = false } = {}) {
    const t = this.templates().find((x) => x.name === name);
    if (!t) return 0;
    if (replace) {
      this.sessionMappings = [];
      if (t.globals) this.globalMappings = [];
      if (t.focus) this.focusMappings = [];
      if (t.plugins) this.pluginMappings = [];
    }
    let n = 0;
    const fresh = (src) => `${src.id}_${(n++).toString(36)}${this.now().toString(36)}`;
    const merge = (list, items, scope) => {
      for (const src of items ?? []) {
        const key = AddOnLogic.sourceKey(src.source);
        const same = scope === 'plugin' ? (m) => m.target.pluginId === src.target.pluginId && AddOnLogic.sourceKey(m.source) === key : (m) => AddOnLogic.sourceKey(m.source) === key;
        list = list.filter((m) => !same(m));
        list.push({ ...src, scope, id: fresh(src) });
      }
      return list;
    };
    this.globalMappings = merge(this.globalMappings, t.globals, 'global');
    this.focusMappings = merge(this.focusMappings, t.focus, 'focus');
    this.pluginMappings = merge(this.pluginMappings, t.plugins, 'plugin');
    if (t.mighty) {
      this.mighty = { ...t.mighty, scope: 'mighty', id: fresh(t.mighty) };
    }
    for (const src of t.mappings ?? []) {
      const entry = this.entryFor(src.target);
      const target = entry ? AddOnLogic.targetOf(entry) : src.target;
      if (!entry && target.kind === 'control') void this.ensure(this.pathFor(target)).catch(() => {});
      const key = AddOnLogic.sourceKey(src.source);
      this.sessionMappings = this.sessionMappings.filter((m) => AddOnLogic.sourceKey(m.source) !== key);
      this.sessionMappings.push({ ...src, target, scope: 'session', id: fresh(src) });
    }
    this.save();
    this.syncFeedback();
    this.emit();
    return n;
  }

  deleteTemplate(name) {
    this.storage.set(
      KEYS.templates,
      this.templates().filter((t) => t.name !== name),
    );
    this.emit();
  }

  /** Templates and globals as one JSON document, for backing up or sharing. */
  exportAll() {
    return { format: 'midi-learn', version: 1, templates: this.templates(), globals: this.globalMappings, focus: this.focusMappings, mighty: this.mighty, plugins: this.pluginMappings };
  }

  /** Merge an exported document: templates by name, globals by source. */
  importAll(doc) {
    if (!doc || doc.format !== 'midi-learn') throw new Error('Not a MIDI Learn file');
    const byName = new Map(this.templates().map((t) => [t.name, t]));
    for (const t of doc.templates ?? []) byName.set(t.name, t);
    this.storage.set(KEYS.templates, [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
    for (const g of doc.globals ?? []) {
      const key = AddOnLogic.sourceKey(g.source);
      this.globalMappings = this.globalMappings.filter((m) => AddOnLogic.sourceKey(m.source) !== key);
      this.globalMappings.push({ ...g, scope: 'global' });
    }
    if (doc.mighty) this.mighty = { ...doc.mighty, scope: 'mighty' };
    for (const pm of doc.plugins ?? []) {
      const key = AddOnLogic.sourceKey(pm.source);
      this.pluginMappings = this.pluginMappings.filter((m) => !(m.target.pluginId === pm.target.pluginId && AddOnLogic.sourceKey(m.source) === key));
      this.pluginMappings.push({ ...pm, scope: 'plugin' });
    }
    for (const f of doc.focus ?? []) {
      const key = AddOnLogic.sourceKey(f.source);
      this.focusMappings = this.focusMappings.filter((m) => AddOnLogic.sourceKey(m.source) !== key);
      this.focusMappings.push({ ...f, scope: 'focus' });
    }
    this.save();
    this.emit();
  }
}

AddOnLogic.Mapper = Mapper;

/** Storage over localStorage, which may be missing or throw (private windows, some webviews). */
AddOnLogic.localStore = () => ({
  get(key) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {}
  },
});

/** Storage over a Map, for tests. */
AddOnLogic.memoryStore = (map = new Map()) => ({
  map,
  get: (k) => (map.has(k) ? JSON.parse(map.get(k)) : undefined),
  set: (k, v) => map.set(k, JSON.stringify(v)),
});

globalThis.AddOnLogic = AddOnLogic;
