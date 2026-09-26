'use strict';

// Tests that clearing authorship colors is an undoable, redoable edit for every participant, and
// that the server-side relaxation needed to restore another author's color cannot be abused to
// forge authorship.

const assert = require('assert').strict;
const common = require('../common');
const padManager = require('../../../node/db/PadManager');

import AttributePool from '../../../static/js/AttributePool';
import {
  applyToAText,
  checkRep,
  deserializeOps,
  inverse,
  makeSplice,
  pack,
  splitAttributionLines,
  subattribution,
} from '../../../static/js/Changeset';
import AttributeMap from '../../../static/js/AttributeMap';
import {Builder} from '../../../static/js/Builder';
import {SmartOpAssembler} from '../../../static/js/SmartOpAssembler';
import Op from '../../../static/js/Op';

// Builds an attribute-only changeset that sets the 'author' attribute on every non-newline
// character in [start, end). This is what the editor sends for "clear authorship colors" and for
// undoing/redoing it.
const setAuthorOnRange = (atext: any, start: number, end: number, authorId: string,
    pool: AttributePool): string => {
  const lines: string[] = atext.text.match(/[^\n]*\n/g);
  const builder = new Builder(atext.text.length);
  let pos = 0;
  for (const line of lines) {
    const lineEnd = pos + line.length;
    const rangeStart = Math.max(start, pos);
    // The line marker (final '\n') never carries an inline author attribute.
    const rangeEnd = Math.min(end, lineEnd - 1);
    if (rangeStart < rangeEnd) {
      const before = rangeStart - pos;
      if (before > 0) builder.keep(before, 0);
      const cover = rangeEnd - rangeStart;
      builder.keep(cover, 0, new AttributeMap(pool).set('author', authorId).toString());
      const after = (lineEnd - 1) - rangeEnd;
      if (after > 0) builder.keep(after, 0);
      builder.keep(1, 1);
    } else {
      builder.keep(line.length, 1);
    }
    pos = lineEnd;
  }
  return checkRep(builder.toString());
};

// Builds a changeset that deletes the first non-newline character and stamps `authorId` on all
// surviving characters. Used to prove foreign-author restoration must never be combined with text
// changes.
const deleteAndStampAuthor = (atext: any, authorId: string, pool: AttributePool): string => {
  const n = atext.text.length;
  const pos = atext.text.search(/[^\n]/);
  assert.ok(pos >= 0, 'test setup expected at least one non-newline character');
  const attribs = new AttributeMap(pool).set('author', authorId).toString();
  const rest = atext.text.slice(pos + 1);
  const assem = new SmartOpAssembler();
  if (pos > 0) {
    const lead = new Op('=');
    lead.chars = pos;
    lead.lines = (atext.text.slice(0, pos).match(/\n/g) || []).length;
    lead.attribs = attribs;
    assem.append(lead);
  }
  const del = new Op('-');
  del.chars = 1;
  assem.append(del);
  const keep = new Op('=');
  keep.chars = rest.length;
  keep.lines = (rest.match(/\n/g) || []).length;
  keep.attribs = attribs;
  assem.append(keep);
  assem.endDocument();
  // The char bank holds inserted ('+') text only; a pure deletion has an empty bank.
  return checkRep(pack(n, n - 1, assem.toString(), ''));
};

// Returns the author id recorded on the first non-newline character of `atext` ('' if none).
const firstAuthor = (atext: any, pool: AttributePool): string => {
  const pos = atext.text.search(/[^\n]/);
  if (pos < 0) return '';
  for (const op of deserializeOps(subattribution(atext.attribs, pos, pos + 1))) {
    return AttributeMap.fromString(op.attribs, pool).get('author') || '';
  }
  return '';
};

// Inverse of a clear/restore changeset. Following the editor's convention (see
// doRepApplyChangeset), the line/attribution arguments describe the document BEFORE the changeset
// was applied; the returned changeset applies to the AFTER document to restore it.
const invert = (cs: string, beforeAText: any, pool: AttributePool): string => inverse(
    cs,
    {get: (i: number) => beforeAText.text.match(/[^\n]*\n/g)[i]} as any,
    {get: (i: number) => splitAttributionLines(beforeAText.attribs, beforeAText.text)[i]} as any,
    pool);

describe(__filename, function () {
  let agent: any;
  let pad: any;
  let padId: string;

  before(async function () {
    agent = await common.init();
  });

  let socketA: any;
  let socketB: any;
  let authorA: string;
  let authorB: string;
  let rev: number;
  // One pool per socket, mirroring the client's local attribute pool.
  let poolA: AttributePool;
  let poolB: AttributePool;

  beforeEach(async function () {
    padId = common.randomString();
    assert(!await padManager.doesPadExist(padId));
    pad = await padManager.getPad(padId, '\n');

    const connectAs = async () => {
      const res = await agent.get(`/p/${padId}`).expect(200);
      const socket = await common.connect(res);
      const {data: clientVars} = await common.handshake(socket, padId);
      return {socket, author: clientVars.userId, baseRev: clientVars.collab_client_vars.rev};
    };
    const aConn = await connectAs();
    socketA = aConn.socket; authorA = aConn.author; rev = aConn.baseRev;
    ({socket: socketB, author: authorB} = await connectAs());
    assert.notEqual(authorA, authorB);
    poolA = new AttributePool();
    poolB = new AttributePool();
  });

  afterEach(async function () {
    if (socketA != null) socketA.close();
    socketA = null;
    if (socketB != null) socketB.close();
    socketB = null;
    if (pad != null) await pad.remove();
    pad = null;
  });

  // Submits an already-canonical changeset (built against `pool`) for the given socket. Both
  // sockets share the pad room, so NEW_CHANGES broadcasts are drained while waiting for the
  // submitter's own ACCEPT_COMMIT.
  const submit = async (socket: any, pool: AttributePool, changeset: string, baseRev: number) => {
    const acceptP = (async () => {
      for (;;) {
        const msg = await common.waitForSocketEvent(socket, 'message');
        if (msg?.data?.type === 'ACCEPT_COMMIT') {
          assert.equal(msg.data.newRev, baseRev + 1);
          return msg.data.newRev;
        }
        if (msg?.disconnect != null) throw new Error(`socket disconnected: ${msg.disconnect}`);
        // Any other message (e.g. NEW_CHANGES broadcast) is irrelevant for this assertion.
      }
    })();
    await Promise.all([
      acceptP,
      common.sendUserChanges(socket, {baseRev, changeset, apool: pool.toJsonable()}),
    ]);
    return pad.getHeadRevisionNumber();
  };

  const expectRejected = async (socket: any, pool: AttributePool, changeset: string,
      baseRev: number) => {
    const rejectP = (async () => {
      for (;;) {
        const msg = await common.waitForSocketEvent(socket, 'message');
        if (msg?.disconnect != null) {
          assert.deepEqual(msg, {disconnect: 'badChangeset'});
          return;
        }
        if (msg?.data?.type === 'ACCEPT_COMMIT') throw new Error('changeset was accepted');
      }
    })();
    await Promise.all([
      rejectP,
      common.sendUserChanges(socket, {baseRev, changeset, apool: pool.toJsonable()}),
    ]);
  };

  it('clear authorship can be undone and redone, restoring every author', async function () {
    // All changesets are built against the pad's server-side pool, just like the editor would after
    // its pool has caught up with the server, so local and stored atexts compare directly.
    const pool = pad.pool;

    // Author A writes the first line, author B writes the second line.
    let atext = await pad.getInternalRevisionAText(rev);
    let cs = makeSplice(atext.text, atext.text.length - 1, 0, 'alpha line\n',
        [['author', authorA]], pool);
    atext = applyToAText(cs, atext, pool);
    rev = await submit(socketA, pool, cs, rev);

    atext = await pad.getInternalRevisionAText(rev);
    cs = makeSplice(atext.text, atext.text.length - 1, 0, 'bravo line\n',
        [['author', authorB]], pool);
    atext = applyToAText(cs, atext, pool);
    rev = await submit(socketB, pool, cs, rev);

    assert.match(atext.text, /alpha line\nbravo line/);
    assert.ok(atext.text.endsWith('\n'));
    const authoredAText = atext;

    // A clears authorship for the whole document.
    atext = await pad.getInternalRevisionAText(rev);
    const clearCs = setAuthorOnRange(atext, 0, atext.text.length - 1, '', pool);
    const clearedAText = applyToAText(clearCs, atext, pool);
    rev = await submit(socketA, pool, clearCs, rev);
    assert.equal(clearedAText.text, authoredAText.text); // text unchanged
    assert.equal(firstAuthor(clearedAText, pool), '');
    assert.notEqual(clearedAText.attribs, authoredAText.attribs);

    // A undoes the clear. The restore (inverse of the clear) puts back both authors, B's included.
    const restoreCs = invert(clearCs, authoredAText, pool);
    const restoredAText = applyToAText(restoreCs, clearedAText, pool);
    rev = await submit(socketA, pool, restoreCs, rev);

    // Persisted result is exactly the pre-clear attribution; text never changed.
    assert.equal(restoredAText.text, authoredAText.text);
    assert.equal(restoredAText.attribs, authoredAText.attribs);
    const stored = await pad.getInternalRevisionAText(rev);
    assert.equal(stored.text, authoredAText.text);
    assert.equal(stored.attribs, authoredAText.attribs);
    assert.equal(firstAuthor(stored, pool), authorA);

    // A pad reopened from the database still carries the restored attribution.
    padManager.unloadPad(padId);
    const reopened = await padManager.getPad(padId);
    const reopenedAText = await reopened.getInternalRevisionAText(
        reopened.getHeadRevisionNumber());
    assert.equal(reopenedAText.text, authoredAText.text);
    assert.equal(reopenedAText.attribs, authoredAText.attribs);
    // Reload `pad` reference for subsequent calls.
    pad = reopened;

    // A redoes the clear: redo replays the original forward changeset (the undo module stores it
    // directly), which is itself already canonical for the unchanged-length document.
    rev = await submit(socketA, pad.pool, clearCs, rev);
    const finalAText = await pad.getInternalRevisionAText(rev);
    assert.equal(finalAText.text, authoredAText.text);
    assert.equal(firstAuthor(finalAText, pad.pool), '');
  });

  it('cannot claim a foreign author for newly typed text', async function () {
    // A types a line under B's author id on a '+' op: must be rejected outright.
    const atext = await pad.getInternalRevisionAText(rev);
    const forgedInsert = makeSplice(atext.text, 0, 0, 'forgery\n',
        [['author', authorB]], poolA);
    await expectRejected(socketA, poolA, forgedInsert, rev);
  });

  it('cannot put a foreign author on text the foreign author never wrote', async function () {
    // A writes a line under A's own name, then tries an attribute-only change labeling it with
    // B's id. The characters never belonged to B, so provenance validation must reject it.
    let atext = await pad.getInternalRevisionAText(rev);
    const insertCs = makeSplice(atext.text, 0, 0, 'mine\n', [['author', authorA]], poolA);
    atext = applyToAText(insertCs, atext, poolA);
    rev = await submit(socketA, poolA, insertCs, rev);

    atext = await pad.getInternalRevisionAText(rev);
    const stealCs = setAuthorOnRange(atext, 0, 4, authorB, poolA);
    await expectRejected(socketA, poolA, stealCs, rev);

    // The rejected changeset must not have altered the pad.
    assert.equal(pad.getHeadRevisionNumber(), rev);
  });

  it('foreign-author restore cannot be combined with text changes', async function () {
    // B writes a line. A then sends a changeset that deletes a character while stamping B's author
    // on the survivors. Text edits may never carry foreign attribution.
    let atext = await pad.getInternalRevisionAText(rev);
    const insertCs = makeSplice(atext.text, atext.text.length - 1, 0, 'bravo line\n',
        [['author', authorB]], poolB);
    atext = applyToAText(insertCs, atext, poolB);
    rev = await submit(socketB, poolB, insertCs, rev);

    atext = await pad.getInternalRevisionAText(rev);
    const evilCs = deleteAndStampAuthor(atext, authorB, poolA);
    await expectRejected(socketA, poolA, evilCs, rev);
  });

  it('cannot label freshly inserted unauthored text with another author after a clear', async function () {
    // B writes a line and A clears authorship, then A inserts brand-new text (submitted without an
    // author attribute, as a raw client can do) into the cleared document. An undo-style restore
    // that covers the new text with B's id must be rejected: the new text never belonged to B.
    let atext = await pad.getInternalRevisionAText(rev);
    let cs = makeSplice(atext.text, atext.text.length - 1, 0, 'bravo line\n',
        [['author', authorB]], poolB);
    atext = applyToAText(cs, atext, poolB);
    rev = await submit(socketB, poolB, cs, rev);

    atext = await pad.getInternalRevisionAText(rev);
    cs = setAuthorOnRange(atext, 0, atext.text.length - 1, '', poolA);
    const clearedAText = applyToAText(cs, atext, poolA);
    rev = await submit(socketA, poolA, cs, rev);

    // Raw insertion with no author attribute: accepted, the text stays unattributed.
    atext = clearedAText;
    cs = makeSplice(atext.text, 0, 0, 'x');
    const withInsert = applyToAText(cs, atext, poolA);
    rev = await submit(socketA, poolA, cs, rev);
    assert.equal(firstAuthor(withInsert, pad.pool), '');

    // Try to restore B's color over a range that now includes the new character.
    const stealCs = setAuthorOnRange(
        await pad.getInternalRevisionAText(rev), 0, 1, authorB, poolA);
    await expectRejected(socketA, poolA, stealCs, rev);
  });
});
