/* LunaSkin: remembers which look an Add On wears and applies it to <html>.
 *   LunaSkin.init({ key: 'com.nohumans.tik.skin', get, set })   // before first paint
 *   LunaSkin.skin            -> 'luna' | 'default'
 *   LunaSkin.set('luna')     -> applies, saves, calls LunaSkin.onchange
 *   LunaSkin.looksRow(onPick)-> a <div class="looks"> with a Default | LUNA segment to drop in a popover
 * Applying sets data-skin on <html>, and also data-tone="dark" and data-panel="dark" so Add Ons that
 * already key their dark colourway on those attributes follow. "default" removes data-skin and
 * restores whatever the Add On set before, so its own colourway is untouched. */
(() => {
  const root = document.documentElement;
  const S = { skin: 'default', key: 'luna-skin', saved: undefined, onchange: undefined };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  function apply() {
    if (S.skin === 'luna') {
      // A page shipped with data-skin="luna" in its <html> had no colourway of its own to remember.
      S.saved ??= root.dataset.skin === 'luna' ? { tone: undefined, panel: undefined } : { tone: root.dataset.tone, panel: root.dataset.panel };
      root.dataset.skin = 'luna'; root.dataset.tone = 'dark'; root.dataset.panel = 'dark';
    } else {
      delete root.dataset.skin;
      S.saved ??= { tone: undefined, panel: undefined };
      { // hand back what the Add On had
        for (const [k, v] of Object.entries(S.saved)) v === undefined ? delete root.dataset[k] : (root.dataset[k] = v);
        S.saved = undefined;
      }
    }
    S.onchange?.(S.skin);
  }
  S.init = (o = {}) => {
    S.key = o.key ?? S.key;
    S.get = o.get ?? ((k) => store.get(k));
    S.save = o.set ?? ((k, v) => store.set(k, v));
    // LUNA is the default look; only an explicit choice of the other one keeps it away.
    S.skin = ['default', 'apple'].includes(S.get(S.key)) ? 'default' : 'luna';
    apply();
  };
  S.set = (name) => { S.skin = name === 'luna' ? 'luna' : 'default'; (S.save ?? store.set)(S.key, S.skin); apply(); };
  S.looksRow = (onPick) => {
    const row = document.createElement('div');
    row.className = 'looks';
    row.innerHTML = 'Look<div class="segments" role="group" aria-label="Look"></div>';
    const paint = () => row.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.skin === S.skin)));
    for (const [k, label] of [['default', 'Default'], ['luna', 'LUNA']]) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.skin = k; b.textContent = label;
      b.onclick = () => { S.set(k); paint(); onPick?.(k); };
      row.querySelector('.segments').appendChild(b);
    }
    paint();
    return row;
  };
  globalThis.LunaSkin = S;
})();
