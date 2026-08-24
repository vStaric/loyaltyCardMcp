/**
 * Read every seeded account back from the server and compare against what was written.
 *
 * This is the half that matters: seeding proves a write was accepted, not that the
 * account reads back as the tier it was built to be.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAgent } from './dist/index.js';

const WORK = '/tmp/claude-1000/-home-dev-pale-mayor/147e8695-8fb3-4f77-84e0-2bc516039138/scratchpad/accounts';
const ledger = JSON.parse(readFileSync(join(WORK, 'ledger.json'), 'utf8'));

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const names = Object.keys(ledger).filter(
  (n) => !n.includes('-peer-') && !n.endsWith('-agent') && (only.length === 0 || only.includes(n)),
);

const pad = (s, n) => String(s).padEnd(n);
process.stdout.write(
  `${pad('account', 14)} ${pad('cards', 12)} ${pad('todo cards', 12)} ${pad('items', 14)} ${pad('conns', 7)} notes\n`,
);
process.stdout.write(`${'-'.repeat(86)}\n`);

for (const name of names) {
  const entry = ledger[name];
  const notes = [];
  try {
    const agent = await openAgent(
      { configDir: join(WORK, name), baseUrl: entry.api, displayName: null },
      process.env,
    );

    const cardsView = await agent.cards.view();
    const cards = cardsView.cards ?? [];
    const own = cards.filter((c) => c.provenance?.own ?? true);

    const shop = await agent.shopping.view();
    // `list` is the merged view (own + every peer's slice). Reading `merged`/`sections`
    // here returned a confident 0 on every account while the rows were plainly present
    // in `own` — a wrong selector, not an empty account.
    const sections = shop.list?.sections ?? [];
    const liveSections = sections.filter((s) => !s.section?.deletedAt);
    let live = 0;
    let cleared = 0;
    for (const s of sections) {
      for (const wrapped of s.items ?? []) {
        const it = wrapped.item ?? wrapped;
        if (it.clearedDate) cleared++;
        else live++;
      }
    }

    const roster = agent.roster.load();
    const conns = roster.connections?.length ?? 0;

    const expCards = entry.cards ? entry.cards.live : 0;
    const expItems = entry.todo ? entry.todo.items - entry.todo.cleared : 0;
    const expConns = (entry.peers?.length ?? 0) + (entry.mcp ? 1 : 0);

    if (own.length !== expCards) notes.push(`cards ${own.length}≠${expCards}`);
    if (live !== expItems) notes.push(`live items ${live}≠${expItems}`);
    if (conns !== expConns) notes.push(`conns ${conns}≠${expConns}`);
    if (entry.failed) notes.push(`seed: ${entry.failed}`);

    process.stdout.write(
      `${pad(name, 14)} ${pad(`${own.length}/${expCards}`, 12)} ${pad(`${liveSections.length}`, 12)} ${pad(`${live} live ${cleared} cl`, 14)} ${pad(`${conns}/${expConns}`, 7)} ${notes.join('; ') || 'ok'}\n`,
    );
  } catch (err) {
    process.stdout.write(`${pad(name, 14)} READ FAILED: ${err?.name}: ${err?.message}\n`);
  }
}
