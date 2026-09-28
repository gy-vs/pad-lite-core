'use strict';

/**
 * Regression tests for undoing/redoing the "clear authorship colors" action.
 *
 * The client (undomodule) now treats clearauthorship as a normal undoable
 * edit. Its inverse changeset sets the 'author' attribute back on the
 * affected characters, which requires the server-side author check in
 * PadMessageHandler to allow restoring previously recorded authorship while
 * still rejecting any attempt to invent authorship.
 *
 * These tests drive the server over socket.io exactly like browser clients
 * would, so they cover the real USER_CHANGES validation path, the stored
 * revisions, and the export/etherpad representation.
 */

import {Builder} from '../../../static/js/Builder';
import {
  applyToAText,
  checkRep,
  cloneAText,
  deserializeOps,
  inverse,
  makeSplice,
  moveOpsToNewPool,
  prepareForWire,
  splitAttributionLines,
  splitTextLines,
} from '../../../static/js/Changeset';
import AttributeMap from '../../../static/js/AttributeMap';
import AttributePool from '../../../static/js/AttributePool';
const assert = require('assert').strict;
const common = require('../common');
const padManager = require('../../../node/db/PadManager');
const exportEtherpad = require('../../../node/utils/ExportEtherpad');

// Serializes a locally built changeset into the (changeset, wire apool) pair
// expected by a USER_CHANGES message.
const toWire = (pad: any, cs: string) => {
  checkRep(cs);
  const forWire = prepareForWire(cs, pad.pool);
  return {
    changeset: forWire.translated,
    apool: forWire.pool.toJsonable(),
  };
};

// Attribute-only changeset: sets `attribs` on every character except the
// document-terminating newline (the client excludes that final newline).
const keepWholeBodyWithAttribs = (pad: any, attribs: [string, string][]) => {
  const len = pad.text().length;
  const builder = new Builder(len);
  builder.keepText(pad.text().slice(0, -1), attribs, pad.pool);
  builder.keep(1, 1); // keep the terminating newline untouched
  return builder.toString();
};

const clearAuthorshipCS = (pad: any) =>
  keepWholeBodyWithAttribs(pad, [['author', '']]);

// Computes the inverse of a changeset the way ace2_inner + undomodule do when
// the user presses Ctrl+Z: inverse() is evaluated against the pre-change
// lines and attribution lines.
const clientInverse = (pad: any, preChangeAText: any, cs: string) => {
  const lines = splitTextLines(preChangeAText.text);
  const alines = splitAttributionLines(preChangeAText.attribs, preChangeAText.text);
  return inverse(cs, lines as any, alines as any, pad.pool);
};

// Per-character author map for the whole pad, including the final newline.
const perCharAuthors = (pad: any): string[] => {
  const out: string[] = [];
  for (const op of deserializeOps(pad.atext.attribs)) {
    const author = AttributeMap.fromString(op.attribs, pad.pool).get('author') || '';
    for (let i = 0; i < op.chars; i++) out.push(author);
  }
  assert.equal(out.length, pad.text().length, 'attribution must cover the whole document');
  return out;
};

const bodyAuthors = (pad: any) => perCharAuthors(pad).slice(0, pad.text().length - 1);

// Appends a new line at the end of the document body, attributed to
// `authorId`, as if the author typed the line into an empty pad or pressed
// Enter at the end and typed it.
const appendLineCS = (pad: any, line: string, authorId: string) => {
  const oldText = pad.text();
  if (oldText === '\n') {
    // Empty pad: replace the lone terminating newline with the line and its
    // own terminating newline.
    return makeSplice(oldText, 0, 1, `${line}\n`, [['author', authorId]], pad.pool);
  }
  return makeSplice(
      oldText,
      oldText.length - 1, // before the terminating newline
      0,
      `\n${line}`, // newline + line body; the existing terminator stays
      [['author', authorId]],
      pad.pool);
};

describe(__filename, function () {
  let agent: any;
  let padId: string;
  let pad: any;
  let socketA: any;
  let socketB: any;
  let authorA: string;
  let authorB: string;
  let rev: number;

  const connectClient = async () => {
    const res = await agent.get(`/p/${padId}`).expect(200);
    const socket = await common.connect(res);
    const {data: clientVars} = await common.handshake(socket, padId);
    return {socket, userId: clientVars.userId};
  };

  // Drains queued socket messages until it finds the wanted COLLABROOM data
  // type (or a badChangeset disconnect). Broadcasts (e.g. NEW_CHANGES from the
  // other client) are skipped.
  const waitForCollabData = (socket: any, wantType: string, timeoutMs = 5000) =>
    new Promise<any>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.off('message', onMessage);
          reject(new Error(`timed out waiting for ${wantType}`));
        }
      }, timeoutMs);
      const onMessage = (msg: any) => {
        if (msg?.disconnect === 'badChangeset') {
          settled = true;
          clearTimeout(timer);
          socket.off('message', onMessage);
          reject(new Error('badChangeset'));
          return;
        }
        if (msg?.type === 'COLLABROOM' && msg.data?.type === wantType) {
          settled = true;
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(msg.data);
        }
      };
      socket.on('message', onMessage);
    });

  // Sends a USER_CHANGES and waits for ACCEPT_COMMIT; returns the new rev.
  const commit = async (socket: any, baseRev: number, cs: string): Promise<number> => {
    const waiting = waitForCollabData(socket, 'ACCEPT_COMMIT');
    await common.sendMessage(socket, {
      type: 'COLLABROOM',
      component: 'pad',
      data: {type: 'USER_CHANGES', baseRev, ...toWire(pad, cs)},
    });
    const data = await waiting;
    assert.equal(data.newRev, baseRev + 1);
    return data.newRev;
  };

  // Sends a USER_CHANGES that the server must reject by sending a
  // badChangeset disconnect message.
  const commitExpectBadChangeset = async (socket: any, baseRev: number, cs: string) => {
    await assert.rejects(
      (async () => {
        const waiting = waitForCollabData(socket, 'ACCEPT_COMMIT');
        await common.sendMessage(socket, {
          type: 'COLLABROOM',
          component: 'pad',
          data: {type: 'USER_CHANGES', baseRev, ...toWire(pad, cs)},
        });
        await waiting;
      })(),
      /badChangeset/);
  };

  before(async function () {
    agent = await common.init();
  });

  beforeEach(async function () {
    padId = common.randomString();
    pad = await padManager.getPad(padId, '\n');
    await pad.setText('\n'); // getPad('\n') yields '\n\n'; normalize like the other suites.
    assert.equal(pad.text(), '\n');

    ({socket: socketA, userId: authorA} = await connectClient());
    ({socket: socketB, userId: authorB} = await connectClient());
    assert.notEqual(authorA, authorB);
    rev = pad.getHeadRevisionNumber();
  });

  afterEach(async function () {
    if (socketA != null) socketA.close();
    if (socketB != null) socketB.close();
    socketA = null;
    socketB = null;
    await pad.remove();
    pad = null;
  });

  // Classic two-author document:
  //   line 1 "alpha line" by A, line 2 "bravo line" by B.
  const seedTwoAuthorPad = async () => {
    const insertAlpha = appendLineCS(pad, 'alpha line', authorA);
    rev = await commit(socketA, rev, insertAlpha);

    const insertBravo = appendLineCS(pad, 'bravo line', authorB);
    rev = await commit(socketB, rev, insertBravo);

    assert.equal(pad.text(), 'alpha line\nbravo line\n');
    const runs = bodyAuthors(pad);
    const alphaBodyLen = 'alpha line'.length;
    assert(runs.slice(0, alphaBodyLen).every((a) => a === authorA));
    assert(runs.slice(alphaBodyLen + 1).every((a) => a === authorB));
  };

  it('multi-author: undo restores each author without changing text', async function () {
    this.timeout(30000);
    await seedTwoAuthorPad();

    const beforeClear = {text: pad.text(), runs: bodyAuthors(pad)};
    const preClearAText = cloneAText(pad.atext);

    // A clears authorship colors for the whole document.
    const clearCS = clearAuthorshipCS(pad);
    const clearRev = rev + 1;
    rev = await commit(socketA, rev, clearCS);
    assert(bodyAuthors(pad).every((a) => a === ''), 'colors must be cleared');
    // B receives the clear broadcast.
    assert.equal((await waitForCollabData(socketB, 'NEW_CHANGES')).newRev, clearRev);

    // A presses Ctrl+Z. The client submits the inverse computed against the
    // document state before the clear.
    const undoCS = clientInverse(pad, preClearAText, clearCS);
    const undoRev = rev + 1;
    rev = await commit(socketA, rev, undoCS);

    // Text must be unchanged...
    assert.equal(pad.text(), beforeClear.text);
    // ...and every character must carry its original author again.
    assert.deepEqual(bodyAuthors(pad), beforeClear.runs);

    // B must also see the restoration broadcast; applying its changeset to a
    // fresh copy of the pad must yield the same restored attribution, which is
    // exactly what every connected client converges to.
    const undoMsg = await waitForCollabData(socketB, 'NEW_CHANGES');
    assert.equal(undoMsg.newRev, undoRev);
    const bView = await pad.getInternalRevisionAText(clearRev);
    const wirePool = new AttributePool().fromJsonable(undoMsg.apool);
    const undoOnB = moveOpsToNewPool(undoMsg.changeset, wirePool, pad.pool);
    const afterUndoOnB = applyToAText(undoOnB, bView, pad.pool);
    assert.equal(afterUndoOnB.text, beforeClear.text);
    const bRuns: string[] = [];
    for (const op of deserializeOps(afterUndoOnB.attribs)) {
      const author = AttributeMap.fromString(op.attribs, pad.pool).get('author') || '';
      for (let i = 0; i < op.chars; i++) bRuns.push(author);
    }
    assert.deepEqual(bRuns.slice(0, bRuns.length - 1), beforeClear.runs);
  });

  it('multi-author: redo clears the colors again without changing text', async function () {
    this.timeout(30000);
    await seedTwoAuthorPad();

    const beforeClear = {text: pad.text(), runs: bodyAuthors(pad)};
    const preClearAText = cloneAText(pad.atext);

    const clearCS = clearAuthorshipCS(pad);
    rev = await commit(socketA, rev, clearCS);
    const undoCS = clientInverse(pad, preClearAText, clearCS);
    rev = await commit(socketA, rev, undoCS);
    assert.deepEqual(bodyAuthors(pad), beforeClear.runs);

    // Ctrl+Y re-applies the same attribute-only clear changeset.
    rev = await commit(socketA, rev, clearAuthorshipCS(pad));
    assert.equal(pad.text(), beforeClear.text);
    assert(bodyAuthors(pad).every((a) => a === ''));
  });

  it('single-author: undo restores the author colors', async function () {
    this.timeout(30000);

    const insert = appendLineCS(pad, 'solo line', authorA);
    rev = await commit(socketA, rev, insert);
    const beforeClear = {text: pad.text(), runs: bodyAuthors(pad)};
    const preClearAText = cloneAText(pad.atext);

    const clearCS = clearAuthorshipCS(pad);
    rev = await commit(socketA, rev, clearCS);
    assert(bodyAuthors(pad).every((a) => a === ''));

    const undoCS = clientInverse(pad, preClearAText, clearCS);
    rev = await commit(socketA, rev, undoCS);
    assert.equal(pad.text(), beforeClear.text);
    assert(bodyAuthors(pad).every((a) => a === authorA));
  });

  it('restored authorship survives a reload and is present in export/etherpad', async function () {
    this.timeout(30000);
    await seedTwoAuthorPad();
    const preClearAText = cloneAText(pad.atext);

    const clearCS = clearAuthorshipCS(pad);
    rev = await commit(socketA, rev, clearCS);
    const undoCS = clientInverse(pad, preClearAText, clearCS);
    rev = await commit(socketA, rev, undoCS);
    const restoredRuns = bodyAuthors(pad);

    // A freshly loaded pad instance (new object, same dirty database) must
    // show the same restored attribution.
    const reloadedPad = await padManager.getPad(padId, null);
    assert.equal(reloadedPad.text(), pad.text());
    assert.deepEqual(bodyAuthors(reloadedPad), restoredRuns);

    // The .etherpad export embeds the pad record (including the current
    // atext); verify the exported head state carries the restored authors.
    const raw = await exportEtherpad.getPadRaw(padId, padId);
    const exportedPad = raw[`pad:${padId}`];
    assert.equal(exportedPad.atext.text, pad.text());
    const exportAuthors: string[] = [];
    for (const op of deserializeOps(exportedPad.atext.attribs)) {
      const author = AttributeMap.fromString(op.attribs, reloadedPad.pool).get('author') || '';
      for (let i = 0; i < op.chars; i++) exportAuthors.push(author);
    }
    assert.deepEqual(exportAuthors.slice(0, exportAuthors.length - 1), restoredRuns);
  });

  it('security: cannot attribute freshly written text to another author',
      async function () {
        this.timeout(30000);
        await seedTwoAuthorPad();

        // Attacker A writes a brand new line (correctly attributed to A),
        // then tries to tag it with B's author ID through a kept-text op.
        // The new characters were inserted by A, so the restoration rule
        // must reject the commit.
        const evilInsert = appendLineCS(pad, 'forged line', authorA);
        rev = await commit(socketA, rev, evilInsert);
        const textAfterInsert = pad.text();

        const forgery = (() => {
          const len = pad.text().length;
          const forgedLen = 'forged line\n'.length;
          const b = new Builder(len);
          b.keep(len - forgedLen - 1); // before the forged line
          b.keep(forgedLen - 1, 0, [['author', authorB]], pad.pool); // body of forged line
          b.keep(1, 1, [['author', authorB]], pad.pool); // its newline
          b.keep(1, 1); // document-terminating newline
          return b.toString();
        })();
        await commitExpectBadChangeset(socketA, rev, forgery);

        // The rejected commit must not have modified the pad.
        assert.equal(pad.text(), textAfterInsert);
        assert(bodyAuthors(pad).slice(-'forged line'.length - 1)
            .every((a) => a === authorA));
      });

  it('security: one foreign author id cannot cover a mixed-author range',
      async function () {
        this.timeout(30000);
        await seedTwoAuthorPad();

        // A single attribute value restored over the whole body touches both
        // A's and B's characters; only B ever wrote B's id, so restoring B
        // over A's line is a forgery and must be rejected.
        const bothLines = (() => {
          const b = new Builder(pad.text().length);
          b.keepText(pad.text().slice(0, -1), [['author', authorB]], pad.pool);
          b.keep(1, 1);
          return b.toString();
        })();
        await commitExpectBadChangeset(socketA, rev, bothLines);
      });

  it('security: insert ops with a foreign author id stay forbidden',
      async function () {
        this.timeout(30000);
        await seedTwoAuthorPad();

        // Inserting text while claiming B's identity must keep being rejected
        // outright, regardless of the restoration allowance for '=' ops.
        const oldLen = pad.text().length;
        const evil = new Builder(oldLen)
            .keep(oldLen - 2, 0)
            .keep(1, 1) // after the last existing newline
            .insert('hijack\n', [['author', authorB]], pad.pool)
            .toString();
        await commitExpectBadChangeset(socketA, rev, evil);
      });

  it('security: stale baseRev cannot move another author id onto rewritten text',
      async function () {
        this.timeout(30000);
        await seedTwoAuthorPad();
        const preClearAText = cloneAText(pad.atext);

        // A clears colors...
        const clearCS = clearAuthorshipCS(pad);
        const clearRev = await commit(socketA, rev, clearCS);

        // ...and B rewrites A's first line with new text attributed to B
        // before A's undo commit reaches the server.
        const rewrite = (() => {
          const b = new Builder(pad.text().length);
          b.remove('alpha line'.length);
          b.insert('rewritten!!', [['author', authorB]], pad.pool);
          return b.toString();
        })();
        const afterRewriteRev = await commit(socketB, clearRev, rewrite);

        // A submits the undo with the stale baseRev (the clear revision).
        // After rebasing, the restored '=' attribute cannot survive onto B's
        // replacement characters (follow() drops it), so B's new text must
        // remain attributed to B whether or not the commit is accepted.
        const undoCS = clientInverse(pad, preClearAText, clearCS);
        const [, result] = await Promise.allSettled([
          waitForCollabData(socketA, 'ACCEPT_COMMIT'),
          common.sendMessage(socketA, {
            type: 'COLLABROOM',
            component: 'pad',
            data: {type: 'USER_CHANGES', baseRev: clearRev, ...toWire(pad, undoCS)},
          }),
        ]);
        assert.equal(result.status, 'fulfilled');
        assert.equal(pad.getHeadRevisionNumber(), afterRewriteRev + 1);
        assert(bodyAuthors(pad).slice(0, 'rewritten!!'.length)
            .every((a) => a === authorB));
      });
});
