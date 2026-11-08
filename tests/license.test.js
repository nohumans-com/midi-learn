// Gumroad licence keys, against a fake Gumroad. `npm test`.
import { describe, expect, it } from 'vitest';

await import('../license.js');
const L = globalThis.AddOnLicense;
const config = { productId: 'PROD', buyUrl: '', maxUses: 2, recheckDays: 7 };

const memory = () => {
  const map = new Map();
  return { get: (k) => (map.has(k) ? JSON.parse(map.get(k)) : undefined), set: (k, v) => map.set(k, JSON.stringify(v)) };
};

/** A Gumroad that knows one key. Records each call so tests can see what was sent. */
const gumroad = ({ uses = 0, purchase = {}, down = false } = {}) => {
  const calls = [];
  const fetch = async (url, { body }) => {
    if (down) throw new Error('offline');
    const p = Object.fromEntries(body);
    calls.push(p);
    if (p.product_id !== 'PROD' || p.license_key !== 'AAAA-BBBB') return { json: async () => ({ success: false, message: 'That license does not exist.' }) };
    if (p.increment_uses_count === 'true') uses++;
    return { json: async () => ({ success: true, uses, purchase }) };
  };
  return { fetch, calls, get uses() { return uses; } };
};

describe('licence', () => {
  it('cleans a pasted key', () => {
    expect(L.clean('  aaaa-bbbb \n')).toBe('AAAA-BBBB');
  });

  it('accepts a good key, keeps it, and counts one use', async () => {
    const g = gumroad();
    const lic = L.manager({ store: memory(), fetch: g.fetch, config });
    expect(lic.licensed).toBe(false);
    expect(await lic.activate('aaaa-bbbb')).toEqual({ ok: true });
    expect(lic.licensed).toBe(true);
    expect(g.uses).toBe(1);
    expect(g.calls[0]).toMatchObject({ product_id: 'PROD', license_key: 'AAAA-BBBB', increment_uses_count: 'false' });
  });

  it('refuses a key Gumroad does not know, and stores nothing', async () => {
    const lic = L.manager({ store: memory(), fetch: gumroad().fetch, config });
    const res = await lic.activate('NOPE');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/isn't valid/);
    expect(lic.licensed).toBe(false);
  });

  it('refuses a refunded or charged-back purchase', async () => {
    for (const purchase of [{ refunded: true }, { chargebacked: true }, { subscription_cancelled_at: '2026-01-01' }]) {
      const lic = L.manager({ store: memory(), fetch: gumroad({ purchase }).fetch, config });
      expect((await lic.activate('AAAA-BBBB')).ok).toBe(false);
    }
  });

  it("doesn't use up a seat on a key with none left", async () => {
    const g = gumroad({ uses: 2 });
    const lic = L.manager({ store: memory(), fetch: g.fetch, config });
    const res = await lic.activate('AAAA-BBBB');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/already in use on 2/);
    expect(g.uses).toBe(2);
  });

  it('says so when Gumroad cannot be reached, and does not activate', async () => {
    const lic = L.manager({ store: memory(), fetch: gumroad({ down: true }).fetch, config });
    const res = await lic.activate('AAAA-BBBB');
    expect(res).toMatchObject({ ok: false, offline: true });
    expect(lic.licensed).toBe(false);
  });

  it('rechecks on a schedule, keeps the key offline, drops it once Gumroad refuses', async () => {
    let t = 0;
    const store = memory();
    const g = gumroad();
    const lic = L.manager({ store, fetch: g.fetch, config, now: () => t });
    await lic.activate('AAAA-BBBB');
    expect(lic.due()).toBe(false);
    t = 8 * 86400000;
    expect(lic.due()).toBe(true);

    const offline = L.manager({ store, fetch: gumroad({ down: true }).fetch, config, now: () => t });
    expect((await offline.recheck()).offline).toBe(true);
    expect(offline.licensed).toBe(true);

    expect((await lic.recheck()).ok).toBe(true);
    expect(lic.due()).toBe(false);
    expect(g.uses).toBe(1); // rechecks never count a use

    const refunded = L.manager({ store, fetch: gumroad({ purchase: { refunded: true } }).fetch, config, now: () => t });
    expect((await refunded.recheck()).ok).toBe(false);
    expect(refunded.licensed).toBe(false);
  });

  it('knows the placeholder product id', () => {
    expect(L.isPlaceholder({ productId: 'PLACEHOLDER_PRODUCT_ID' })).toBe(true);
    expect(L.isPlaceholder(config)).toBe(false);
  });
});
