# MIDI Learn

A LUNA Add On that maps any MIDI controller to anything LUNA can control: faders, pans, mutes,
solos, sends, cue mixes, plugin parameters, and commands (play, record, loop, undo, save...).

**Where it opens:** in LUNA's side browser, the right-hand panel beside Media, Markers and
Lyrics. Choose **Add Ons → Browsers → MIDI Learn** on the Timeline or Mixer page; choosing it
again closes the panel. LUNA saves which browser Add On is showing with the session and shows it
again when the session reopens.

- When the panel switches to Media, Markers or Lyrics, MIDI Learn keeps running hidden, so
  mappings keep working.
- When **another browser Add On** takes the panel, LUNA reloads MIDI Learn's page, and its
  mappings stop until you show MIDI Learn again.
- After changing `manifest.json`, restart LUNA: this build doesn't rescan the Add Ons folder.
  The manifest carries both `name` and the older `title` so LUNA builds from before the rename
  still show it; `ua-builder pack` warns about `title`, and that's expected.

**Learn:** each section (Click & Turn, Mappings, Channel Focus) has its own **Learn** button. Press it
(or `L` for Mappings), touch a control in LUNA or pick one from the Parameters list, then move a
knob, fader or pad. You can do the last two in either order. A learn bar opens at the top of that
section while it learns. Turn on **Hold** (next to **Learn** while it learns) (or Shift-click / right-click **Learn**) to keep
learning after each mapping, so you can map one parameter after another. You can click as many
parameters as you like before turning a knob; the last one clicked is mapped. Turn Hold off, press
the red **Holding** button, **Stop** or `Esc` to finish.

**Automation modes:** each track in the Parameters list has an Automation group:
- **Automation Off / Read / Write / Touch / Latch:** a button sets that mode on the press.
- **Next automation mode:** a button that steps through Off → Read → Write → Touch → Latch and
  wraps.
- **Automation mode:** a knob with five zones, one per mode.

They also work as Channel Focus mappings, acting on the focused track. With Feedback on, a mode
button sends 127 when its track is in that mode, so button lights follow, and the knob turns to
the current mode's zone. LUNA doesn't report touches on its automation buttons, so pick these
from the Parameters list rather than by clicking in LUNA.

**Or type it:** after picking a parameter, choose CC, Note or Bend in the learn bar's MIDI box, type the
number (a note can be `60` or `C3`), pick a channel or leave it on Any, and press Enter or
Assign. A typed source listens to every input. A mapping's MIDI can also be retyped in its edit
panel (the chevron).

The Learn and Parameters sections fold away from their headers.

- **Session mappings** are saved inside the LUNA session itself (`session.preferences`), so they
  come back when you reopen it, and travel with the session file to another machine. Mappings
  made before 0.3.0 sat in this machine's storage, keyed by the session's package uid; the first
  time such a session opens, they move into it.
- **Save with this session:** Channel Focus, Plugins and Click & Turn are one layout shared by every
  session until their **Save with this session** switch is on. Then that section's mappings live
  in the session instead, so a different session can have a different layout. Switching it off
  goes back to the shared layout (which takes the session's copy if it has none of its own).
  Global mappings, templates and the other settings stay on the machine.
- **Global mappings** work in every session. Open a mapping (the chevron) and switch on Global.
  A session mapping on the same MIDI source wins over a global one.
- **Templates** (top bar) save your whole controller layout, every section: this session's
  mappings, global mappings, Channel Focus, Click & Turn and plugin maps. **Load** merges one in.
  **Replace** clears those sections first. Session mappings are found again by track name, area
  (Strip, Send 2, Insert 1 · UA 1176) and control name. A target the session doesn't have stays
  listed, struck through, until a matching control appears. Export and Import move templates and
  everything global between machines as one JSON file.
- **Modes:** Follow (a knob or fader sets the value, within an optional range, and can be
  inverted; the range is set in MIDI steps, 0–127, by dragging its two caps or with the arrow
  keys, Shift for 10) or Toggle (each press flips it). Buttons mapped to commands and automation
  modes have the same choice: **Follow** fires on the press (a button that sends 127, then 0 on
  release), **Toggle** fires on every press of a latching button (127 on one press, 0 on the next,
  like a Roto-Control button set to TOGGLE).
  Each knob move is one touch, so LUNA makes one undo step and one automation pass per move.
- **Background:** the swatch at top right picks the room colour, as in Tik. The text flips to
  white on dark colours.

## Channel Focus

A second set of mappings that act on **one track at a time**, the focused track, like a dedicated
channel strip on your controller. Learn the fader, pan, mute, a send or a plugin parameter once,
and the same knobs then control whichever track you select in LUNA.

- **Learn:** press **Learn** in the Channel Focus header, then touch the control in LUNA, on any
  track, or pick it from the Parameters list, and move a knob. In either order, as with regular
  learn. The Parameter card is tagged "Channel Focus" while you do it. Commands can't be focus
  mappings, since they aren't per track.
- **Which track:** the track selected in LUNA (`session.focusedTrack`), shown in the header.
  Map the **Select next track** and **Select previous track** commands (in Parameters → Commands)
  to two buttons to step the focus from your controller. They stop at the first and last track.
- **Reset parameter to default** (a command) puts the parameter in focus back to LUNA's default,
  as one undo step. The parameter in focus is the one you last touched in LUNA, or last moved with
  Click & Turn or a Channel Focus knob. Use
  the header menu to **lock** the focus to one track; choose "Selected" to follow again.
- **Plugin parameters** apply only when the focused track has the same plugin in the same insert
  slot. Otherwise the row is struck through, "not on <track>", and nothing on that track moves.
- **Feedback** is on by default here: selecting another track (in LUNA, or with Select next /
  previous track) sends that track's values, so motorized knobs jump to it. The **Feedback**
  switch in the section header turns it on or off for every Channel Focus mapping at once.
- Channel Focus mappings are one controller layout shared by every session. They're included in
  Export and Import. One MIDI source drives one thing: learning a source as a focus mapping moves
  it out of the regular mappings, and the other way round.

## Plugins

Plugin maps: one map per plugin **type** (UA 1176, Pro-Q 4…), used by **whichever instance of that
plugin is in focus**, in any session. Map your knobs to a plugin once, and they control every
instance of it.

- **Focus:** like Channel Focus, **selecting a track** puts its plugin with a map in focus.
  Turning a knob in another plugin's window switches to that instance until you select another
  track. Opening a plugin window alone can't: LUNA reports touches, but not which plugin windows
  are open. The section's menu can **lock** one instance. Plugins follow LUNA's selection even
  when Channel Focus is locked.
- **Learn:** press **Learn** in the Plugins header, turn a knob in the plugin's window, then one
  on your controller. Turn on **Hold** (next to **Learn** while it learns) to map several parameters in a row.
- **A layer:** while a plugin with a map is in focus, its knobs win. The same knobs fall back to
  your other mappings when it isn't, so eight knobs can mean something different for every plugin.
  Within one plugin's map, a knob drives one parameter.
- **Feedback** is on by default: focusing another instance sends its values, so motorized knobs
  jump to them, and the layer below doesn't move those knobs meanwhile.
- **Saved maps** lists every plugin with a map. **×** deletes a map (press it twice).
- Maps are stored in `midilearn.plugins`, shared by every session, and included in templates and
  Export.

## Click & Turn

One knob that drives **whatever you last clicked or dragged in LUNA**: a fader, a pan, a send,
a mute or a plugin parameter.

- **Learn:** press **Learn** in Click & Turn header and move a knob, or type its CC in the learn bar
  and press Assign. There's one Click & Turn, shared by every session.
- **Following:** each control you touch in LUNA becomes its target (LUNA reports touches,
  SDK fact 100). The card shows the control, where it is, and its live value. Changes MIDI Learn
  makes itself, through any mapping, never move it.
- **With a motorized controller:** Feedback is on by default. When the target changes, its current
  value is sent to the knob at once, so the Roto-Control turns to the DAW's value before you
  touch it. The usual guards apply: your hand wins, motor echoes are ignored, and nothing is sent
  twice.
- **Pin** keeps it on the current control while you click around.
- **Hover** isn't supported: LUNA doesn't expose what the mouse is over, only what's touched. It
  could follow hover if LUNA published the control under the mouse.
- Plugin parameters are read one at a time when touched, never the whole plugin (fact 101).

## Feedback to motorized controllers (opt-in)

Turn on **Feedback** in a mapping's edit panel (the chevron) and MIDI Learn sends LUNA's value back
to the controller. Motorized knobs (Roto-Control and similar) then follow mouse moves,
automation and session recall, and button lights follow switches such as mute. It's off for
every mapping until you turn it on; a "↔" on the row shows it's on.

What gets sent: a CC mapping sends that CC (0–127, through the mapping's range and invert); a
switch sends 0 or 127; a note mapping sends note on or off. It goes back to the input the knob was
learned from (or last heard on, for "Any input"), through the output with the same name.

How loops are avoided. These are the usual causes of motorized controllers fighting the host:
- **Your hand wins.** Nothing is sent back while you're moving that control, or for 350 ms after
  its last value. Once you let go, a correction goes out only if LUNA ended somewhere else.
- **Motor echoes are ignored.** A value within ±1 of what was just sent, arriving within 300 ms,
  is the controller reporting its motor, not your hand, so it isn't written to LUNA. Without
  this, automation playback would move the knob and the knob would write the automation back.
- **No repeats.** A value equal to the last one sent, or the last one received, isn't sent again.
- **7-bit only.** 14-bit MSB/LSB pairs make some motorized controllers, Roto-Control among
  them, jump to wrong positions, so feedback sends plain CC.

Roto-Control setup: use MIDI mode, set each knob's resolution to COARSE in Roto-Setup, and match
its channel and CC to the mapping (or learn the mapping from the knob). The Roto-Control also
checks touch on its own side; its LOCK button turns that off.

## MIDI in and out

The page takes MIDI from the best source it finds, one at a time (the MIDI chip's tooltip says which):

1. **LUNA** (`Luna.MidiInput`, `Luna.SendMidi`): every message in order, and feedback out of the
   device. Needs a LUNA that publishes MIDI ports to Add Ons (SDK facts 123 to 125); LUNA 3.1.1 does
   not.
2. **Web MIDI**, where the browser has it (Chrome, Edge, LUNA on Windows). LUNA's macOS webview has none.
3. **The helper** (`npm run bridge`, or the macOS installer): carries every input and the feedback
   out. This is what a Mac with LUNA 3.1.1 uses.
4. **LUNA's last-controller values**, which every LUNA publishes for each device. Knobs and faders
   work with nothing installed, but there is no feedback, LUNA coalesces fast moves, and a repeat of
   an identical message (the same button value twice) is not a change, so it is missed.

The MIDI chip at top left picks one input or listens to all of them. The same hardware has
different names in different sources (LUNA says "Roto-Control (2)" and "IAC IAC Bus 1", the helper
"Roto-Control" and "IAC Bus 1"), so a mapping's device matches on the name without the "(2)" and
without a driver prefix: mappings keep working whichever source is live.

Feedback goes out the same way: through LUNA's output port when it has one, else Web MIDI, else the
helper.

### The helper

`npm run bridge` (and `npm run bridge:install`) start it. It also keeps a log
(`~/Library/Logs/midi-learn-bridge.log`, since LUNA's window has no console) and a disk copy of the
settings (`~/Library/Application Support/MIDI Learn/state.json`). Open the page with `?nobridge` to
try it without the helper.

## Run

```sh
npm install
npm test                         # against Luna.MockEngine, no LUNA needed
npm run bridge                   # optional: a log and a disk copy of the settings
npx ua-builder serve             # http://localhost:8790/ ; LUNA must be running
open "http://localhost:8790/?demo"   # an in-page mock session, to try the page without LUNA;
                                     # it never reads or writes your saved settings or sends MIDI out
npx ua-builder install           # link into LUNA's Add Ons folder; appears under Add Ons > Browsers
```

| File | Purpose |
|---|---|
| `logic.js` | Parsing, the control catalog, learn mode, applying MIDI, storage, templates. No DOM. |
| `main.js` | MIDI in and out (the SDK), the page, the background picker. |
| `bridge/midi-bridge.mjs` | The optional local helper (log, disk copy of the settings). |
| `installer/` | Builds the macOS `.pkg` (Add On + self-contained bridge). |
| `tests/` | Vitest against the mock engine. |
| `vendor/luna.global.js` | The SDK bundle, **patched** (see below). |
| `patches/ua-builder-sdk-load-retry.patch` | The SDK change that bundle carries, as a source diff. |
| `scripts/vendor-sdk.mjs` | Vendors the installed SDK's bundle with that change applied. |

## Share it (macOS installer)

```sh
npm run installer          # -> .build/MIDI Learn <version>.pkg
```

MIDI no longer needs the helper, so the `.lunaaddon` (`npm run pack`) is enough to share. The `.pkg`
still installs the helper too, for its log and disk copy, without Node or npm. It puts the Add On in LUNA's Add Ons folder (replacing any earlier MIDI Learn, a
`npm run install-addon` symlink included) and installs the bridge with its own Node runtime
(official nodejs.org build, universal) in `/Library/Application Support/MIDI Learn`, started at
every login by `/Library/LaunchAgents/com.uaudio.midi-learn.bridge.plist`. That agent has the same
label as `npm run bridge:install`'s, so on a machine with both only one runs. To remove it:
`sudo "/Library/Application Support/MIDI Learn/uninstall.sh"`.

The package is not signed with a Developer ID, so macOS blocks it on first open: the recipient
opens it, then clicks **Open Anyway** in System Settings > Privacy & Security. The build checks
the vendored bundle still carries its patch and starts the packaged bridge on arm64 and x86_64.
`installer/` holds the sources: `build.sh`, the pkg scripts, the agent and the uninstaller.

## The vendored SDK is patched

`vendor/luna.global.js` is SDK 0.2.1 (`@uaudio/luna-builder-sdk`) plus one fix that
isn't in the SDK yet. In the released SDK, a load that fails is remembered: `Session.ready()`,
`Node.load()` and `Collection.load()` keep returning the same error. LUNA can time a read out
while it's still opening a session, so switching sessions could leave the page on "No session
open" for good. With the patch, the next call tries again.

Don't refresh the bundle until the SDK includes this fix, or session switching breaks again.
`npx ua-builder pack` refreshes it unless given `--no-vendor`, so make the `.lunaaddon` with
`npm run pack`, which passes that flag. `npm test` checks that the bundle carries the patch,
matches the manifest's `sdk_version`, and that `npm run pack` keeps it.

The SDK now ships prebuilt, in `~/Library/Application Support/LUNA Builder SDK` (set
`LUNA_BUILDER_SDK` to use another folder), so the fix is applied to the built bundle:

```sh
npm run vendor   # vendor/luna.global.js = the installed SDK's bundle + the fix
```

It stops without writing if one of its three edits no longer finds its anchor, and says so
when the SDK already forgets failed loads: then vendor the plain bundle and delete `patches/`
and the script.

## How learning finds the control you touched

The page subscribes to the whole session and watches for any control's `touch_count` to rise.
LUNA pushes that to every client when a control is grabbed (SDK `docs/EVIDENCE.md` fact 100,
measured on a mixer fader). The page then reads that one control, so a plugin knob is learned
without reading the plugin's other parameters.

Plugin parameters are never read in bulk. Reading a plugin's whole parameter list can hang or
crash LUNA, and a session full of Qi does it (fact 101). So plugins appear in the Parameters list
as "touch a knob in its window while learning", and a parameter joins the list once it's learned.

## Not checked against a live LUNA yet

- That a touch on a **plugin's own editor** (Qi, a UAD plugin, an AU) raises that parameter's
  `touch_count` the way a mixer fader does. If one doesn't, its knobs can't be learned by touch.
- Whether a single Qi parameter reads quickly. A read that takes more than 5 s is abandoned, and
  the page says so.
- **Storage:** session mappings (and any section with Save with this session on) are in the
  session, in the `com.uaudio.midi-learn` preference context. Everything else (global mappings,
  templates, the shared layouts, the colour, the MIDI choice) is in the page's `localStorage`.
  On macOS each Add On has its own, kept across launches while the manifest `id` stays the same;
  the optional helper's disk copy fills in anything it loses. Session preferences need a LUNA that
  has them; without, session mappings stay in `localStorage` as before.
- Relative (endless) encoders, 14-bit CC pairs, NRPN and soft takeover are not supported yet.
  An endless encoder that sends 1 or 127 will jump.

The page logs to the bridge (`npm run bridge:status`): learn on and off, the scan result, and
any error. LUNA's window has no console, so this log is the way to see what it's doing.
