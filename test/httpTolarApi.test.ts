import { beforeAll, describe, expect, it } from 'vitest';
import type { Envelope } from '../src/crypto/envelope.js';
import { initSodium, type SodiumCrypto } from '../src/crypto/sodium.js';
import {
  BadSignatureError,
  HttpError,
  KeyMismatchError,
  NetworkError,
  PayloadTooLargeError,
  RateLimitedError,
  StaleVersionError,
} from '../src/sync/apiError.js';
import { HttpTolarApi } from '../src/sync/httpTolarApi.js';
import {
  RequestSigner,
  SIG_HEADER_SIG,
  SIG_HEADER_UUID,
  SIG_HEADER_VER,
  canonicalMessage,
} from '../src/sync/requestSigner.js';

/**
 * The REST client against a recording fake `fetch`.
 *
 * Two things here are contracts rather than implementation details, and both are the
 * kind that fail silently on the wire: **which** calls carry a per-request signature
 * (an envelope write authenticates from inside and must not), and that the signature
 * covers *exactly* the bytes sent — the server hashes what it receives, so a body
 * reformatted after signing is rejected as a bad signature with no hint why.
 */
const BASE = 'https://tolar.example/';
const ACCOUNT = '0b6b3c2a-1f4d-4e8a-9c2b-7a1f0e5d6c3b';

interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
}

let sodium: SodiumCrypto;
let signerKeys: { publicKey: Uint8Array; secretKey: Uint8Array };

beforeAll(async () => {
  sodium = await initSodium();
  signerKeys = sodium.ed25519KeyPairFromSeed(new Uint8Array(32).fill(3));
});

/** Build an API bound to a fake transport that replays `responses` in order. */
function apiWith(responses: Array<{ status: number; body?: string | Uint8Array }>) {
  const calls: Recorded[] = [];
  let i = 0;
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      method: init?.method ?? 'GET',
      url: input instanceof URL ? input : new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: body ? new Uint8Array(body as ArrayBuffer) : null,
    });
    const next = responses[i++] ?? { status: 500 };
    const payload = next.body ?? '';
    return new Response(typeof payload === 'string' ? payload : payload, { status: next.status });
  };
  const signer = new RequestSigner(ACCOUNT, signerKeys.secretKey, sodium);
  return { api: new HttpTolarApi(BASE, signer, { fetch: fakeFetch }), calls };
}

const signed = (call: Recorded) => SIG_HEADER_SIG in call.headers;

const envelope: Envelope = {
  data: { iv: 'IVIV', ciphertext: 'CTCT', tag: 'TAGTAG' },
  keys: { [ACCOUNT]: 'WRAP' },
  signature: { by: ACCOUNT, ver: 2, sig: 'U0lH' },
};

describe('HttpTolarApi — signing responsibilities', () => {
  it('signs a user PUT over exactly the bytes it sends', async () => {
    const { api, calls } = apiWith([{ status: 200, body: '{"ver":1}' }]);
    const ver = await api.putUser(ACCOUNT, { signKey: 'SK', encKey: 'EK' }, 1);

    expect(ver).toBe(1);
    const call = calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url.pathname).toBe(`/api/user/${ACCOUNT}`);
    expect(call.headers[SIG_HEADER_UUID]).toBe(ACCOUNT);
    expect(call.headers[SIG_HEADER_VER]).toBe('1');
    // The signature must verify against the body the transport actually carried.
    const sig = new Uint8Array(Buffer.from(call.headers[SIG_HEADER_SIG]!, 'base64'));
    expect(
      sodium.verifyDetached(
        canonicalMessage('PUT', call.url.pathname, 1, call.body!),
        sig,
        signerKeys.publicKey,
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(call.body!).toString('utf8'))).toEqual({
      signKey: 'SK',
      encKey: 'EK',
    });
  });

  it('leaves envelope writes unsigned — they authenticate from inside', async () => {
    const { api, calls } = apiWith([
      { status: 200, body: '{"ver":2}' },
      { status: 200, body: '{"ver":3}' },
      { status: 200, body: '{"ver":4}' },
    ]);
    await api.putCards(ACCOUNT, envelope);
    await api.putShare(ACCOUNT, envelope);
    await api.putShoppingSlice('list-1', ACCOUNT, envelope);

    expect(calls.map(signed)).toEqual([false, false, false]);
    expect(calls[0]!.url.pathname).toBe(`/api/cards/${ACCOUNT}`);
    expect(calls[1]!.url.pathname).toBe(`/api/share/${ACCOUNT}`);
    // The slice id is one path segment, colons intact — it is the resource id the
    // envelope signature is bound to.
    expect(calls[2]!.url.pathname).toBe(`/api/shoppinglist/list-1::${ACCOUNT}`);
  });

  it('leaves the permissionless reads and posts unsigned', async () => {
    const { api, calls } = apiWith([
      { status: 404 },
      { status: 200, body: '{"listId":"l","slices":[]}' },
      { status: 200, body: '{"id":9}' },
      { status: 404 },
    ]);
    await api.getUser(ACCOUNT);
    await api.getShoppingList('l');
    await api.postRequestShare(ACCOUNT, {
      requesterUuid: ACCOUNT,
      requesterSignKey: 'SK',
      requesterEncKey: 'EK',
    });
    await api.postPairingResolve('4F9K-2C7X');

    expect(calls.map(signed)).toEqual([false, false, false, false]);
  });

  it('signs the private reads and the pairing mint at ver 0 over an empty body', async () => {
    const { api, calls } = apiWith([
      { status: 200, body: '{"originUuid":"o","requests":[]}' },
      { status: 404 },
      { status: 200, body: '{"code":"4F9K-2C7X"}' },
    ]);
    await api.getRequestShare(ACCOUNT);
    await api.getShareResponse(7);
    await api.postPairingCode({ uuid: ACCOUNT, encKeyFingerprint: 'FP' });

    expect(calls.map(signed)).toEqual([true, true, true]);
    for (const call of calls) expect(call.headers[SIG_HEADER_VER]).toBe('0');
    // A signed GET carries no body at all, and its signature hashes the empty one.
    expect(calls[0]!.body).toBeNull();
    const sig = new Uint8Array(Buffer.from(calls[0]!.headers[SIG_HEADER_SIG]!, 'base64'));
    expect(
      sodium.verifyDetached(
        canonicalMessage('GET', `/api/requestShare/${ACCOUNT}`, 0, new Uint8Array(0)),
        sig,
        signerKeys.publicKey,
      ),
    ).toBe(true);
  });

  it('sends the agent kind claim only when there is one', async () => {
    const { api, calls } = apiWith([
      { status: 200, body: '{"id":1}' },
      { status: 200, body: '{"id":2}' },
    ]);
    await api.postRequestShare(ACCOUNT, {
      requesterUuid: ACCOUNT,
      requesterSignKey: 'SK',
      requesterEncKey: 'EK',
      kind: 'agent',
    });
    await api.postRequestShare(ACCOUNT, {
      requesterUuid: ACCOUNT,
      requesterSignKey: 'SK',
      requesterEncKey: 'EK',
    });

    expect(JSON.parse(Buffer.from(calls[0]!.body!).toString('utf8')).kind).toBe('agent');
    expect(JSON.parse(Buffer.from(calls[1]!.body!).toString('utf8'))).not.toHaveProperty('kind');
  });
});

describe('HttpTolarApi — the shapes coming back', () => {
  it('reads an envelope back verbatim', async () => {
    const { api } = apiWith([
      {
        status: 200,
        body: JSON.stringify({
          data: { iv: 'IVIV', ciphertext: 'CTCT', tag: 'TAGTAG' },
          keys: { [ACCOUNT]: 'WRAP' },
          signature: { by: ACCOUNT, ver: 2, sig: 'U0lH' },
        }),
      },
    ]);
    expect(await api.getCards(ACCOUNT)).toEqual(envelope);
  });

  it('omits an empty key map, which the server reads as absent', async () => {
    const { api, calls } = apiWith([{ status: 200, body: '{"ver":1}' }]);
    await api.putCards(ACCOUNT, { data: envelope.data, keys: {} });
    const sent = JSON.parse(Buffer.from(calls[0]!.body!).toString('utf8'));
    expect(sent).not.toHaveProperty('keys');
    expect(sent).not.toHaveProperty('signature');
  });

  it('maps a 404 to null for the resources that may not exist yet', async () => {
    const { api } = apiWith([{ status: 404 }, { status: 404 }, { status: 404 }, { status: 404 }]);
    expect(await api.getUser(ACCOUNT)).toBeNull();
    expect(await api.getCards(ACCOUNT)).toBeNull();
    expect(await api.getShare(ACCOUNT)).toBeNull();
    expect(await api.getBlob('deadbeef')).toBeNull();
  });

  it('treats an unwritten shopping list as empty rather than missing', async () => {
    const { api } = apiWith([{ status: 200, body: '{"listId":"l"}' }]);
    expect(await api.getShoppingList('l')).toEqual({ listId: 'l', slices: [] });
  });

  it('reads a pending share response as pending, never as a decline', async () => {
    const { api } = apiWith([{ status: 200, body: '{"requestId":7,"status":"pending"}' }]);
    const view = await api.getShareResponse(7);
    expect(view).toEqual({
      requestId: 7,
      status: 'pending',
      response: null,
      respondedAt: null,
    });
  });

  it('treats an unresolvable pairing code as one indistinguishable null', async () => {
    // Unknown, expired and spent are one 404 by design, so a guesser cannot learn that
    // a code existed. The client must not claim to know which happened.
    const { api } = apiWith([{ status: 404 }]);
    expect(await api.postPairingResolve('4F9K-2C7X')).toBeNull();
  });

  it('returns blob bytes without going through text', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 255]);
    const { api } = apiWith([{ status: 200, body: bytes }]);
    expect(Array.from((await api.getBlob('deadbeef'))!)).toEqual(Array.from(bytes));
  });

  it('treats an already-erased account as the erase having succeeded', async () => {
    const { api, calls } = apiWith([{ status: 404 }]);
    await expect(api.deleteUser(ACCOUNT)).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('DELETE');
    expect(signed(calls[0]!)).toBe(true);
  });
});

describe('HttpTolarApi — error mapping', () => {
  it.each([
    [401, BadSignatureError],
    [403, KeyMismatchError],
    [409, StaleVersionError],
    [413, PayloadTooLargeError],
    [429, RateLimitedError],
  ])('maps %i onto its typed error', async (status, expected) => {
    const { api } = apiWith([{ status, body: '{"error":"whatever"}' }]);
    await expect(api.putCards(ACCOUNT, envelope)).rejects.toBeInstanceOf(expected);
  });

  it('carries the status and server code on anything else', async () => {
    const { api } = apiWith([{ status: 503, body: '{"error":"unavailable"}' }]);
    await expect(api.putCards(ACCOUNT, envelope)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
    await expect(api.putCards(ACCOUNT, envelope)).rejects.toBeInstanceOf(HttpError);
  });

  it('survives an error body that is not the documented JSON', async () => {
    const { api } = apiWith([{ status: 500, body: '<html>gateway</html>' }]);
    await expect(api.getShoppingList('l')).rejects.toMatchObject({ status: 500, code: null });
  });

  it('reports a malformed success body as a network failure, not a silent shape', async () => {
    const { api } = apiWith([{ status: 200, body: '{"ver":"not a number"}' }]);
    await expect(api.putCards(ACCOUNT, envelope)).rejects.toBeInstanceOf(NetworkError);
  });

  it('reports a transport failure as a network failure', async () => {
    const failing: typeof globalThis.fetch = async () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    const api = new HttpTolarApi(BASE, new RequestSigner(ACCOUNT, signerKeys.secretKey, sodium), {
      fetch: failing,
    });
    await expect(api.getUser(ACCOUNT)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('HttpTolarApi — url building', () => {
  it('trims a trailing slash and keeps the signed path equal to the sent path', async () => {
    const { api, calls } = apiWith([{ status: 200, body: '{"ver":1}' }]);
    await api.putUser(ACCOUNT, { signKey: 'SK', encKey: 'EK' }, 1);
    expect(calls[0]!.url.toString()).toBe(`https://tolar.example/api/user/${ACCOUNT}`);
  });

  it('encodes a path segment so a hostile id cannot retarget the request', async () => {
    const { api, calls } = apiWith([{ status: 404 }]);
    await api.getUser('../../admin?x=1');
    expect(calls[0]!.url.pathname).toBe('/api/user/..%2F..%2Fadmin%3Fx%3D1');
    expect(calls[0]!.url.search).toBe('');
  });
});
