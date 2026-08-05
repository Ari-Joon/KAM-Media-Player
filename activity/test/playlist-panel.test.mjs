/**
 * The playlists panel and the track context menu, against a minimal DOM.
 *
 * These are worth testing headlessly because the two rules that matter are
 * structural rather than visual: another member's private playlist must never
 * reach the panel, and every action must send identity rather than a
 * descriptor. Both are assertions about what is in the DOM and what goes on the
 * wire, and neither needs a browser.
 *
 * The DOM here is the smallest thing the two classes actually touch. A real
 * headless browser would test more, but it would also mean a dependency and a
 * download for a file whose whole job is to check two invariants.
 */
import assert from 'node:assert/strict';

// --- A very small DOM ------------------------------------------------------

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = new Set();
    this.attributes = {};
    this._text = '';
    this.hidden = false;
    this.value = '';
    this.readOnly = false;
    this.disabled = false;
  }

  get className() { return [...this.classList].join(' '); }

  set className(value) {
    this.classList = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  prepend(node) { node.parent = this; this.children.unshift(node); }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  getAttribute(name) { return this.attributes[name] ?? null; }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeChild() {}

  getBoundingClientRect() { return { width: 190, height: 140, top: 0, left: 0 }; }

  /** Fire a listener, as a click or a key would. */
  async fire(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      await handler({ stopPropagation() {}, preventDefault() {}, ...event });
    }
  }

  /** Every node beneath this one, this one included. */
  *walk() {
    yield this;
    for (const child of this.children) yield* child.walk();
  }

  /** First descendant matching a predicate. */
  find(predicate) {
    for (const node of this.walk()) if (predicate(node)) return node;
    return null;
  }

  findAll(predicate) {
    return [...this.walk()].filter(predicate);
  }
}

const byId = new Map();
for (const id of ['playlist-panel', 'playlist-mine', 'playlist-others', 'playlist-status',
  'playlist-close', 'track-menu']) {
  byId.set(id, new Node('div'));
}

const documentListeners = new Map();
globalThis.document = {
  getElementById: (id) => byId.get(id) ?? null,
  createElement: (tag) => new Node(tag),
  addEventListener: (type, handler) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(handler);
  },
};
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 720,
  addEventListener() {},
};

// --- A fake server ---------------------------------------------------------

const sent = [];
let view = {
  mine: {
    public: { name: 'Shared stuff', tracks: [{ provider: 'youtube', providerId: 'a', title: 'Alpha' }], visibility: 'public', slot: 'public' },
    private: { name: 'Just me', tracks: [], visibility: 'private', slot: 'private' },
  },
  others: [{
    user: { id: '2', username: 'grace', avatarUrl: null },
    name: 'Graces mix',
    visibility: 'public',
    tracks: [{ provider: 'youtube', providerId: 'b', title: 'Beta' }],
  }],
};

globalThis.fetch = async (url, options = {}) => {
  sent.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
  if ((options.method ?? 'GET') === 'GET') {
    return { ok: true, json: async () => view };
  }
  const body = JSON.parse(options.body);
  if (body.action === 'rename') return { ok: true, json: async () => ({ renamed: true, name: 'Cleaned name' }) };
  if (body.action === 'add') return { ok: true, json: async () => ({ added: true }) };
  if (body.action === 'remove') return { ok: true, json: async () => ({ removed: true }) };
  return { ok: false, json: async () => ({ error: 'no' }) };
};

const { PlaylistPanel, TrackMenu } = await import('../client/playlists.js');

const notices = [];
const queued = [];
const nexted = [];

const panel = new PlaylistPanel({
  guildId: 'g1',
  authHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer t' }),
  enqueue: async (track) => { queued.push(track); },
  notify: (message) => notices.push(message),
});

let passed = 0;
const check = (name, run) => { run(); passed += 1; };

await panel.open();

const mine = byId.get('playlist-mine');
const others = byId.get('playlist-others');

check('the viewer sees both of their own playlists, marked', () => {
  const cards = mine.findAll((n) => n.classList.has('playlist'));
  assert.equal(cards.length, 2);
  assert.ok(cards[0].classList.has('is-public'));
  assert.ok(cards[1].classList.has('is-private'));

  // Marked by a word, not only by colour or a glyph.
  const badges = mine.findAll((n) => n.classList.has('badge')).map((n) => n.textContent);
  assert.ok(badges.some((text) => /Public/.test(text)));
  assert.ok(badges.some((text) => /Private/.test(text)));
});

check('own names are editable and other people\'s are not', () => {
  const ownNames = mine.findAll((n) => n.classList.has('playlist-name'));
  assert.equal(ownNames.length, 2);
  assert.ok(ownNames.every((input) => input.readOnly === false));

  const theirs = others.findAll((n) => n.classList.has('playlist-name'));
  assert.equal(theirs.length, 1);
  // Readonly rather than disabled: a disabled input leaves the tab order and
  // stops being announced, and the name is still worth reading.
  assert.equal(theirs[0].readOnly, true);
  assert.equal(theirs[0].disabled, false);
});

check('another member\'s card names its owner', () => {
  assert.ok(others.find((n) => n.textContent === 'grace'));
});

check('a rename sends only a name, and takes the server\'s answer', async () => {
  const input = mine.findAll((n) => n.classList.has('playlist-name'))[1];
  input.value = '  Late  night  ';
  await input.fire('blur');
  const call = sent.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.body.action, 'rename');
  assert.equal(call.body.slot, 'private');
  // No track, no visibility: there is no request shape here that publishes a
  // private playlist.
  assert.equal(call.body.track, undefined);
  assert.equal(call.body.visibility, undefined);
  assert.equal(input.value, 'Cleaned name');
});

// --- The context menu ------------------------------------------------------

const menu = new TrackMenu({
  enqueue: async (track) => { queued.push(track); },
  playNext: async (track) => { nexted.push(track); },
  playlists: panel,
  notify: (message) => notices.push(message),
});

const menuElement = byId.get('track-menu');
menu.open({ provider: 'youtube', providerId: 'z', title: 'Zeta' }, 100, 100);

check('the menu offers queueing, playing next, and both playlists by name', () => {
  const labels = menuElement.findAll((n) => n.tagName === 'BUTTON').map((n) => n.textContent);
  assert.equal(labels.length, 4);
  assert.ok(labels[0].includes('Add to queue'));
  assert.ok(labels[1].includes('Play next'));
  // Named, not "public" and "private": the whole point of renaming is that the
  // user recognises their own playlist.
  assert.ok(labels[2].includes('Shared stuff'));
  assert.ok(labels[3].includes('Just me'));
});

check('the menu is kept inside the viewport', () => {
  menu.open({ provider: 'youtube', providerId: 'z', title: 'Zeta' }, 1275, 715);
  // 1280 wide, a 190 wide menu, 6px margin.
  assert.equal(menuElement.style.left, `${1280 - 190 - 6}px`);
  assert.equal(menuElement.style.top, `${720 - 140 - 6}px`);
});

await (async () => {
  const buttons = menuElement.findAll((n) => n.tagName === 'BUTTON');
  await buttons[0].fire('click');
  await buttons[1].fire('click');
  await buttons[3].fire('click');
})();

check('menu actions reach the right handlers', () => {
  assert.equal(queued.at(-1).providerId, 'z');
  assert.equal(nexted.at(-1).providerId, 'z');
});

check('saving sends identity only, never a descriptor', () => {
  const add = sent.filter((call) => call.body?.action === 'add').at(-1);
  assert.equal(add.body.slot, 'private');
  assert.deepEqual(Object.keys(add.body.track).sort(), ['provider', 'providerId']);
  // A title would be harmless; a url would not. Asserting the exact key set is
  // what stops one being added later without anyone noticing.
  assert.equal(add.body.track.title, undefined);
});

check('the menu closes when an action is taken', () => {
  assert.equal(menuElement.hidden, true);
});

// --- The invariant that matters --------------------------------------------

// Defence in depth. The server decides what another member's card contains and
// never sends a private one - `test/playlists.test.mjs` asserts that. What is
// asserted here is the second line: that nothing in *this* file makes another
// person's playlist editable, whatever arrives. An earlier draft keyed
// editability off `visibility` rather than off whose card it is, which would
// have handed an edit box to anyone the server mislabelled.
view = {
  mine: view.mine,
  others: [{
    user: { id: '2', username: 'grace', avatarUrl: null },
    name: 'Graces mix',
    visibility: 'private',
    tracks: [{ provider: 'youtube', providerId: 'b', title: 'Beta' }],
  }],
};
await panel.refresh();

check('another member\'s card is never editable, however it is labelled', () => {
  const theirs = others.findAll((n) => n.classList.has('playlist-name'));
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].readOnly, true);
  // No remove buttons either: those edit a playlist just as much as the name.
  assert.equal(others.findAll((n) => n.classList.has('drop')).length, 0);
});

check('the viewer\'s own cards do carry remove buttons', () => {
  // The mirror of the assertion above - without this, a bug that removed every
  // control everywhere would pass the previous check.
  assert.ok(mine.findAll((n) => n.classList.has('drop')).length > 0);
});

console.log(`playlist panel: ${passed}/${passed} pass (marking, rename, menu, placement, identity)`);
