// gzip + base64 payload codec used for every Firestore payload (store.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packPayload, unpackPayload } from '../js/store.js';

test('payload codec: round trip, Thai text, much smaller than the JSON', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ k: `O${i}|P|PL${i % 50}|`, o: `EDTO${236000 + i}`, s: 'บริษัท ทดสอบ', dd: '2026-10-15 07:35', rf: '000000000000000000000000' }));
  const json = JSON.stringify(rows);
  const { body, enc } = await packPayload(json);
  assert.equal(enc, 'gz');
  assert.ok(body.length < json.length * 0.2, `compressed ${body.length} vs ${json.length}`);
  assert.equal(await unpackPayload(body, enc), json);
  assert.equal(await unpackPayload('{"a":1}', ''), '{"a":1}'); // old, uncompressed saves
});
