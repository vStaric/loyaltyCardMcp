import { BARCODE_FORMATS, hasAnyPhoto, type Card } from '../cards/card.js';
import type { CardService, CardsView, UnreadableSource } from '../cards/cardService.js';
import type { MergedCard } from '../merge/cardMerge.js';
import { requireString, optionalString, type ToolDefinition } from './tool.js';

/**
 * The card tools (PRD-agent-connection §7.3): read every card that has been shared
 * with this agent, and manage the ones it authored.
 *
 * ## The one rule these tools exist to state honestly
 * A card belongs to the account that created it. This agent may add cards, and edit or
 * delete **its own**; it cannot edit or delete the user's, because `cards/{uuid}` is a
 * single blob signed by its author and the server would reject the write. So every
 * card in a result carries `editableByThisAgent`, and an attempt to change somebody
 * else's fails loudly, naming the owner.
 *
 * An agent that reported a successful edit which did not happen would be worse than
 * one that refuses — hence no silent no-ops anywhere in this file.
 */
export function cardTools(service: CardService): readonly ToolDefinition[] {
  return [
    listCards(service),
    getCard(service),
    addCard(service),
    updateCard(service),
    deleteCard(service),
  ];
}

const OWNERSHIP_NOTE =
  'Cards belong to the account that created them: this agent can read every card shared ' +
  'with it and can add its own, but it cannot edit or delete a card the user authored — ' +
  'not a policy, a property of the format. A human peer cannot edit yours either.';

function listCards(service: CardService): ToolDefinition {
  return {
    name: 'list_cards',
    title: 'List loyalty cards',
    description:
      'Every loyalty card visible to this agent: the ones it added, plus the ones each ' +
      'connected account shares with it, deduplicated by barcode. Also reports any ' +
      'connection whose cards could not be read, and why — a connection that has not ' +
      'granted this agent its cards is named as such, never silently omitted. ' +
      OWNERSHIP_NOTE,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async () => renderView(await service.view()),
  };
}

function getCard(service: CardService): ToolDefinition {
  return {
    name: 'get_card',
    title: 'Get one loyalty card',
    description:
      'One card in full, by id, including its barcode value and format. ' + OWNERSHIP_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The card id, as list_cards reports it.' },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args) => {
      const cardId = requireString(args, 'cardId');
      const { view, card } = await service.get(cardId);
      if (!card) {
        return {
          found: false,
          cardId,
          // The refusals travel with the miss: "no such card" means something different
          // when a connection's whole list was unreadable, and the caller cannot tell
          // the two apart without being told.
          unreadable: view.unreadable.map(renderUnreadable),
          message: unreadableHint(view, `No card with id ${cardId} is visible to this agent.`),
        };
      }
      return { found: true, card: renderCard(card) };
    },
  };
}

function addCard(service: CardService): ToolDefinition {
  return {
    name: 'add_card',
    title: 'Add a loyalty card',
    description:
      "Add a card. It lands in this agent's own card list and appears in the connected " +
      "account's grid badged as shared by this agent, deduplicated by barcode like any " +
      "other peer's card — the same thing that happens when a person adds one. This " +
      'agent can edit and delete the cards it added this way.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the card is called, e.g. the retailer name.' },
        notes: { type: 'string', description: 'Optional free text.' },
        barcodeValue: {
          type: 'string',
          description: 'The code printed on the card. Requires barcodeFormat.',
        },
        barcodeFormat: {
          type: 'string',
          enum: [...BARCODE_FORMATS],
          description: 'The symbology of barcodeValue. Required whenever a value is given.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args) => {
      const card = await service.add({
        title: requireString(args, 'title'),
        notes: optionalString(args, 'notes') ?? null,
        barcodeValue: optionalString(args, 'barcodeValue') ?? null,
        barcodeFormat: optionalString(args, 'barcodeFormat') ?? null,
      });
      return {
        added: renderCard({ card, provenance: { kind: 'own' } }),
        note:
          "Published to this agent's own card list. It shows in the account's grid " +
          'attributed to this agent.',
      };
    },
  };
}

function updateCard(service: CardService): ToolDefinition {
  return {
    name: 'update_card',
    title: 'Edit a card this agent added',
    description:
      'Change a card THIS AGENT added. Fields left out are unchanged; passing null to ' +
      'notes or barcodeValue clears it. ' +
      OWNERSHIP_NOTE +
      " Calling this on the user's card fails and says whose card it is.",
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The card id, as list_cards reports it.' },
        title: { type: 'string' },
        notes: { type: ['string', 'null'] },
        barcodeValue: { type: ['string', 'null'] },
        barcodeFormat: { type: ['string', 'null'], enum: [...BARCODE_FORMATS, null] },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: async (args) => {
      const cardId = requireString(args, 'cardId');
      const card = await service.update(cardId, {
        // A title is the one field with no "clear it" state — a card without one has
        // nothing to show in the grid — so `null` is refused here rather than in the
        // service, where the caller would get a vaguer message.
        ...pick('title', requireStringIfPresent(args, 'title')),
        ...pick('notes', optionalString(args, 'notes')),
        ...pick('barcodeValue', optionalString(args, 'barcodeValue')),
        ...pick('barcodeFormat', optionalString(args, 'barcodeFormat')),
      });
      return { updated: renderCard({ card, provenance: { kind: 'own' } }) };
    },
  };
}

function deleteCard(service: CardService): ToolDefinition {
  return {
    name: 'delete_card',
    title: 'Delete a card this agent added',
    description:
      "Delete a card THIS AGENT added. It disappears from the account's grid on their " +
      'next sync. ' +
      OWNERSHIP_NOTE +
      " Calling this on the user's card fails and says whose card it is.",
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The card id, as list_cards reports it.' },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: async (args) => {
      const card = await service.remove(requireString(args, 'cardId'));
      return { deleted: renderCard({ card, provenance: { kind: 'own' } }) };
    },
  };
}

/** A string argument that may be absent, but may not be null or empty when present. */
function requireStringIfPresent(args: Record<string, unknown>, key: string): string | undefined {
  return args[key] === undefined ? undefined : requireString(args, key);
}

/** `{ key: value }` when the caller said something about `key`, `{}` when they did not. */
function pick<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function renderView(view: CardsView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    cards: view.cards.map(renderCard),
    unreadable: view.unreadable.map(renderUnreadable),
  };
  const hint = unreadableHint(view, 'No cards are visible to this agent.');
  if (view.cards.length === 0) out.message = hint;
  return out;
}

/**
 * The sentence to put in front of an empty (or short) result.
 *
 * "You have no cards" and "you did not give me your cards" are different answers, and
 * only one of them is this agent's to make. When a connection withheld the cards scope
 * the refusal leads; anything else falls back to `plain`.
 */
function unreadableHint(view: CardsView, plain: string): string {
  if (view.connectionCount === 0) {
    return (
      `${plain} This agent has no connections yet — nobody has accepted it. Pairing is an ` +
      'operator step: `tolar-mcp pair`, then accept the request with `tolar-mcp accept`.'
    );
  }
  const ungranted = view.unreadable.filter((u) => u.reason === 'not_granted');
  if (ungranted.length > 0) {
    const who = ungranted.map((u) => u.displayName ?? u.uuid).join(', ');
    return (
      `${plain} This is not the whole picture: ${who} has not granted this agent the ` +
      'cards resource, so their card list is published with no key this agent can open. ' +
      'Granting it is a checkbox on their connection in the app — nothing here can ask for it.'
    );
  }
  if (view.unreadable.length > 0) {
    return `${plain} ${view.unreadable.length} connection(s) could not be read — see "unreadable".`;
  }
  return plain;
}

function renderUnreadable(source: UnreadableSource): Record<string, unknown> {
  return {
    account: source.displayName ?? source.uuid,
    uuid: source.uuid,
    reason: source.reason,
    detail: source.detail,
  };
}

function renderCard(merged: MergedCard): Record<string, unknown> {
  const { card, provenance } = merged;
  const own = provenance.kind === 'own';
  return {
    id: card.id,
    title: card.title,
    notes: card.notes,
    barcodeValue: card.barcodeValue,
    barcodeFormat: card.barcodeFormat,
    createdAt: isoOf(card.createdAt),
    updatedAt: isoOf(card.updatedAt),
    addedBy: own
      ? 'this agent'
      : (provenance.displayName ?? provenance.authorUuid) +
        (provenance.connectionKind === 'agent' ? ' (an AI agent)' : ''),
    // Stated on every card rather than left to be inferred from `addedBy`: this is the
    // fact a caller needs before it plans an edit, and the one it must not guess at.
    editableByThisAgent: own,
    photos: photoSummary(card),
  };
}

/**
 * Which image slots the card names.
 *
 * Presence, not bytes: this peer carries photo pointers through a re-publish but cannot
 * open a blob — the app's image format is its own port, filed as lcm-gll. Saying "there
 * is a front photo here" is true and useful; pretending there is no photo because we
 * cannot read it would not be.
 */
function photoSummary(card: Card): Record<string, unknown> {
  return {
    front: card.photos.front !== null,
    back: card.photos.back !== null,
    logo: card.photos.logo !== null,
    note: hasAnyPhoto(card.photos)
      ? 'This agent can see that a photo exists but cannot read its contents.'
      : undefined,
  };
}

function isoOf(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}
