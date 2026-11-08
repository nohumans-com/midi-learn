// MIDI Learn: licence keys from Gumroad. No DOM, so `npm test` covers it.
//
// A buyer gets a key on the Gumroad receipt (the product's "Generate a unique license key per sale"
// setting). The page checks it against Gumroad's public verify endpoint, which needs the product id
// but no access token, so nothing secret ships in the Add On. This is a speed bump for honest
// people, not copy protection: the page is readable JavaScript.
//
//   const lic = AddOnLicense.manager({ store, fetch });
//   lic.licensed                     // true once a key has been accepted on this machine
//   await lic.activate(key)          // { ok: true } or { ok: false, reason: '...' }
//   await lic.recheck()              // every few days; a key Gumroad now rejects stops working

const AddOnLicense = {};

AddOnLicense.config = {
  // The product's id from the License key block on its Content tab in Gumroad (not a secret).
  productId: 'NjsANKj1pyagXmH-N6MnMg==',
  // Where the "Buy" button goes.
  buyUrl: 'https://levperrey.gumroad.com/l/midi-learn',
  // Machines one key may activate (Gumroad counts each activation as a "use").
  maxUses: 3,
  // Days between checks that the key is still good (refunds, chargebacks, cancelled subscriptions).
  recheckDays: 7,
};

AddOnLicense.VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';
AddOnLicense.STORE_KEY = 'midilearn.license';

/** Is the id still the template's, i.e. has no real product been set up yet? */
AddOnLicense.isPlaceholder = (config = AddOnLicense.config) => /^PLACEHOLDER/.test(config.productId);

/** Gumroad keys look like 8-8-8-8 hex; accept what a person pastes (spaces, lower case). */
AddOnLicense.clean = (raw) => String(raw ?? '').trim().replace(/\s+/g, '').toUpperCase();

/** Why a purchase no longer counts, or '' when it does. */
AddOnLicense.purchaseProblem = (purchase = {}) => {
  if (purchase.refunded) return 'This purchase was refunded.';
  if (purchase.chargebacked) return 'This purchase was charged back.';
  if (purchase.subscription_cancelled_at || purchase.subscription_failed_at) return 'This subscription has ended.';
  return '';
};

/**
 * Ask Gumroad about a key. Resolves to { ok, offline, uses, reason }:
 *   ok       Gumroad knows the key and the purchase still counts.
 *   offline  Gumroad could not be reached (no network, blocked): says nothing about the key.
 */
AddOnLicense.verify = async (key, { fetch = globalThis.fetch, config = AddOnLicense.config, count = false } = {}) => {
  const body = new URLSearchParams({ product_id: config.productId, license_key: key, increment_uses_count: String(count) });
  let data;
  try {
    // A 404 with a JSON body is Gumroad's "no such key", so read the body whatever the status.
    const res = await fetch(AddOnLicense.VERIFY_URL, { method: 'POST', body });
    data = await res.json();
  } catch {
    return { ok: false, offline: true, reason: "Couldn't reach Gumroad. Check your internet connection and try again." };
  }
  if (!data?.success) return { ok: false, reason: "That key isn't valid for MIDI Learn. Copy it from your Gumroad receipt." };
  const problem = AddOnLicense.purchaseProblem(data.purchase);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, uses: data.uses ?? 0 };
};

/** The licence on this machine: what is stored, and the calls that change it. */
AddOnLicense.manager = ({ store, fetch, config = AddOnLicense.config, now = () => Date.now() }) => {
  const read = () => store.get(AddOnLicense.STORE_KEY);
  const api = {
    get licensed() {
      return !!read()?.key;
    },
    get key() {
      return read()?.key ?? '';
    },
    /** Check a typed key and, if it is good and has a seat free, keep it. */
    async activate(raw) {
      const key = AddOnLicense.clean(raw);
      if (!key) return { ok: false, reason: 'Enter the license key from your Gumroad receipt.' };
      // Look first without counting, so a refused key doesn't use up one of its machines.
      const peek = await AddOnLicense.verify(key, { fetch, config, count: false });
      if (!peek.ok) return peek;
      const already = read()?.key === key;
      if (!already && peek.uses >= config.maxUses) {
        return { ok: false, reason: `This key is already in use on ${peek.uses} computers. Write to the seller to move it.` };
      }
      if (!already) {
        const counted = await AddOnLicense.verify(key, { fetch, config, count: true });
        if (!counted.ok) return counted;
      }
      store.set(AddOnLicense.STORE_KEY, { key, activatedAt: now(), checkedAt: now() });
      return { ok: true };
    },
    /** Is it time to look again? */
    due() {
      const saved = read();
      return !!saved && now() - (saved.checkedAt ?? 0) > config.recheckDays * 86400000;
    },
    /** Look again. Only an answer from Gumroad that says no removes the key; being offline never does. */
    async recheck() {
      const saved = read();
      if (!saved) return { ok: false };
      const res = await AddOnLicense.verify(saved.key, { fetch, config, count: false });
      if (res.offline) return res;
      if (res.ok) store.set(AddOnLicense.STORE_KEY, { ...saved, checkedAt: now() });
      else store.set(AddOnLicense.STORE_KEY, null);
      return res;
    },
    /** Forget the key on this machine (it keeps its use on Gumroad's count). */
    clear() {
      store.set(AddOnLicense.STORE_KEY, null);
    },
  };
  return api;
};

globalThis.AddOnLicense = AddOnLicense;
