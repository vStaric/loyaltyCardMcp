import {
  activeItems,
  type ItemProvenance,
  type MergedShoppingList,
  type MergedTodoItem,
  type MergedTodoSection,
} from '../shopping/merge.js';
import { normalizeName, type TodoItem, type TodoSection } from '../shopping/model.js';
import type { UnreadableSource } from '../sharing/unreadable.js';
import type { ShoppingService, ShoppingView } from '../shopping/shoppingService.js';
import type { ShoppingListSnapshot } from '../shopping/snapshot.js';
import {
  addItems,
  createSection,
  moveItem,
  removeItem,
  renameItem,
  renameSection,
  setChecked,
  setFootnote,
  ShoppingWriteError,
  type WriteContext,
  type WriteResult,
} from '../shopping/writer.js';
import { requireString, ToolInputError, type ToolDefinition } from './tool.js';

/**
 * The shopping-list tools (PRD-agent-connection §4.1, §7.3): one read, and the eight
 * writes a peer is allowed — which on this resource is everything.
 *
 * ## Why these are not the cards' mirror image
 * The card tools exist largely to say honestly what an agent *cannot* do. These do not
 * need to: the shopping list is already multi-writer, so an agent editing the user's
 * item is one more author publishing one more observation, exactly as their second phone
 * is. Nothing here is an agent privilege and nothing here is withheld.
 *
 * What replaces the ownership rule as this file's load-bearing concern is the **item
 * id**. Every write takes one, every write echoes one, and `list_shopping` prints them,
 * because an id a model has to guess is an id it will guess wrong.
 *
 * There is deliberately no `remove_section`. A section's tombstone only takes effect
 * once it is empty on *every* slice, and a peer's live items are not this agent's to
 * destroy — so the honest removal from here is to tombstone the items, which
 * `remove_item` does.
 */
export function shoppingTools(service: ShoppingService): readonly ToolDefinition[] {
  return [
    listShopping(service),
    addItemsTool(service),
    renameItemTool(service),
    setCheckedTool(service),
    setFootnoteTool(service),
    moveItemTool(service),
    createSectionTool(service),
    renameSectionTool(service),
    removeItemTool(service),
  ];
}

const SHARED_NOTE =
  'The shopping list is shared and multi-writer: this agent publishes its own slice and ' +
  'every device merges them, so it may edit any item on the list, including the ' +
  "user's — the same power a person you shared with has. Every write is attributed to " +
  'this agent on their screen.';

// --- read ---------------------------------------------------------------------------

function listShopping(service: ShoppingService): ToolDefinition {
  return {
    name: 'list_shopping',
    title: 'Read the shared shopping list',
    description:
      'The shared shopping list: every section with its items, each item’s id, whether it ' +
      'is checked off, its footnote, and who wrote it. Also reports any connection whose ' +
      'list could not be read, and why — a connection that has not granted this agent the ' +
      'shopping list is named as such, never silently omitted. Every other shopping tool ' +
      'takes an id from here.',
    inputSchema: {
      type: 'object',
      properties: {
        includeChecked: {
          type: 'boolean',
          description: 'Include items already checked off. Defaults to true.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args) => renderView(await service.view(), optionalBoolean(args, 'includeChecked')),
  };
}

// --- writes -------------------------------------------------------------------------

function addItemsTool(service: ShoppingService): ToolDefinition {
  return {
    name: 'add_items',
    title: 'Add items to the shopping list',
    description:
      'Add one or more items to a section, in order, at the foot of that section. Names ' +
      'the section by id or by title; a title that matches no section creates one. ' +
      SHARED_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Section id, or its title. An unknown title creates the section.',
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Item names, in the order they should appear.',
        },
        indentLevel: {
          type: 'integer',
          minimum: 0,
          maximum: 1,
          description: 'Nest the added items one level: 0 (default) or 1.',
        },
      },
      required: ['section', 'names'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args) => {
      const section = requireString(args, 'section');
      const names = requireStringArray(args, 'names');
      const indentLevel = optionalInteger(args, 'indentLevel');
      const { value } = await service.apply((ctx) => {
        const target = resolveSection(ctx, section);
        // A title nobody holds is a section that does not exist yet, and the natural
        // reading of "add milk to Dairy" when there is no Dairy is to make one — the
        // same thing the app's Add flow does when a title is typed rather than picked.
        const created = target ? null : createSection(ctx, section);
        const base = created ? withSection(ctx, created.slice, created.value) : ctx;
        const sectionId = target?.section.id ?? created!.value.id;
        const added = addItems(
          base,
          sectionId,
          names.map((name) => ({ name, indentLevel })),
        );
        return {
          slice: added.slice,
          value: {
            section: {
              id: sectionId,
              title: target?.section.title ?? created!.value.title,
              created: created !== null,
            },
            added: added.value.map((item) => ({ id: item.id, name: item.name })),
            skippedBlankNames: names.length - added.value.length,
          },
        };
      });
      return value;
    },
  };
}

function renameItemTool(service: ShoppingService): ToolDefinition {
  return {
    name: 'rename_item',
    title: 'Rename an item',
    description: 'Change an item’s name. ' + SHARED_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The item id, as list_shopping reports it.' },
        name: { type: 'string', description: 'The new name.' },
      },
      required: ['itemId', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args) => {
      const itemId = requireString(args, 'itemId');
      const name = requireString(args, 'name');
      const { value } = await service.apply((ctx) => wrote(renameItem(ctx, itemId, name)));
      return { renamed: value };
    },
  };
}

function setCheckedTool(service: ShoppingService): ToolDefinition {
  return {
    name: 'set_checked',
    title: 'Check an item off, or uncheck it',
    description: 'Check an item off the shopping list, or uncheck it again. ' + SHARED_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The item id, as list_shopping reports it.' },
        checked: { type: 'boolean', description: 'True to check off, false to uncheck.' },
      },
      required: ['itemId', 'checked'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async (args) => {
      const itemId = requireString(args, 'itemId');
      const checked = requireBoolean(args, 'checked');
      const { value } = await service.apply((ctx) => wrote(setChecked(ctx, itemId, checked)));
      return { [checked ? 'checkedOff' : 'unchecked']: value };
    },
  };
}

function setFootnoteTool(service: ShoppingService): ToolDefinition {
  return {
    name: 'set_footnote',
    title: 'Footnote an item',
    description:
      'Pin a footnote to an item, edit it, or remove it by passing null. A footnote may ' +
      'itself be footnoted through footnoteSub, which is ignored while the item carries ' +
      'no footnote — and unpinning a footnote drops its sub-footnote with it. ' +
      SHARED_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The item id, as list_shopping reports it.' },
        text: {
          type: ['string', 'null'],
          description: 'The footnote, or null to unpin it. An empty string is a blank note.',
        },
        footnoteSub: {
          type: ['string', 'null'],
          description: 'The footnote’s own footnote, or null to clear it.',
        },
      },
      required: ['itemId', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args) => {
      const itemId = requireString(args, 'itemId');
      const text = nullableString(args, 'text');
      const sub = 'footnoteSub' in args ? nullableString(args, 'footnoteSub') : undefined;
      const { value } = await service.apply((ctx) => wrote(setFootnote(ctx, itemId, text, sub)));
      return { footnoted: value };
    },
  };
}

function moveItemTool(service: ShoppingService): ToolDefinition {
  return {
    name: 'move_item',
    title: 'Move or nest an item',
    description:
      'Move an item to a position within its section, and/or nest it one level under the ' +
      'row above. Positions are zero-based over the section’s visible items as ' +
      'list_shopping reports them; an index past the end means the end. ' +
      SHARED_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The item id, as list_shopping reports it.' },
        toIndex: {
          type: 'integer',
          minimum: 0,
          description: 'Zero-based position within the section.',
        },
        indentLevel: { type: 'integer', minimum: 0, maximum: 1, description: '0 or 1.' },
      },
      required: ['itemId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args) => {
      const itemId = requireString(args, 'itemId');
      const toIndex = optionalInteger(args, 'toIndex');
      const indentLevel = optionalInteger(args, 'indentLevel');
      const { value } = await service.apply((ctx) =>
        wrote(moveItem(ctx, itemId, { toIndex, indentLevel })),
      );
      return {
        moved: value,
        note:
          'Positions on a shared list are relative to the merged order. Read list_shopping ' +
          'again to see where the row actually landed.',
      };
    },
  };
}

function createSectionTool(service: ShoppingService): ToolDefinition {
  return {
    name: 'create_section',
    title: 'Create a shopping-list section',
    description: 'Create a new section at the foot of the shopping list. ' + SHARED_NOTE,
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'The section title.' } },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args) => {
      const title = requireString(args, 'title');
      const { value } = await service.apply((ctx) => {
        const created = createSection(ctx, title);
        return { slice: created.slice, value: renderSection(created.value) };
      });
      return { created: value };
    },
  };
}

function renameSectionTool(service: ShoppingService): ToolDefinition {
  return {
    name: 'rename_section',
    title: 'Rename a shopping-list section',
    description: 'Change a section’s title. Names it by id or by its current title. ' + SHARED_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Section id, or its current title.' },
        title: { type: 'string', description: 'The new title.' },
      },
      required: ['section', 'title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args) => {
      const section = requireString(args, 'section');
      const title = requireString(args, 'title');
      const { value } = await service.apply((ctx) => {
        const target = resolveSection(ctx, section);
        if (!target) throw new ShoppingWriteError('no_such_section', `no section “${section}”`);
        const renamed = renameSection(ctx, target.section.id, title);
        return { slice: renamed.slice, value: renderSection(renamed.value) };
      });
      return { renamed: value };
    },
  };
}

function removeItemTool(service: ShoppingService): ToolDefinition {
  return {
    name: 'remove_item',
    title: 'Remove an item from the shopping list',
    description:
      'Remove an item. The row is tombstoned rather than deleted, which is what makes the ' +
      'removal survive: a deleted row leaves the other authors’ live copies unopposed and ' +
      'the item returns on the next merge. It stays in the list’s history and the user can ' +
      'restore it. ' +
      SHARED_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The item id, as list_shopping reports it.' },
      },
      required: ['itemId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async (args) => {
      const itemId = requireString(args, 'itemId');
      const { value } = await service.apply((ctx) => wrote(removeItem(ctx, itemId)));
      return { removed: value, note: 'Tombstoned, not deleted — it stays in the list’s history.' };
    },
  };
}

// --- shared plumbing ----------------------------------------------------------------

/** The write's own report of the row it touched. */
function wrote(result: WriteResult<TodoItem>): WriteResult<Record<string, unknown>> {
  return { slice: result.slice, value: renderItem(result.value) };
}

/**
 * A context that can see a section this very call has just created — otherwise the add
 * that follows refuses on a section it made a moment ago.
 */
function withSection(
  ctx: WriteContext,
  own: ShoppingListSnapshot,
  section: TodoSection,
): WriteContext {
  return {
    ...ctx,
    own,
    merged: { ...ctx.merged, sections: [...ctx.merged.sections, { section, items: [] }] },
  };
}

/**
 * The section a string names: an id first, then a title, matched the way the app matches
 * names — trimmed, whitespace-collapsed, casefolded — so "dairy" finds "Dairy".
 */
function resolveSection(ctx: WriteContext, ref: string): MergedTodoSection | null {
  const byId = ctx.merged.sections.find((s) => s.section.id === ref);
  if (byId) return byId;
  const wanted = normalizeName(ref);
  return ctx.merged.sections.find((s) => normalizeName(s.section.title) === wanted) ?? null;
}

// --- rendering ----------------------------------------------------------------------

function renderView(view: ShoppingView, includeChecked = true): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sections: view.list.sections.map((section) => renderSectionWithItems(section, includeChecked)),
    unreadable: view.unreadable.map(renderUnreadable),
  };
  const hint = unreadableHint(view, 'The shared shopping list is empty.');
  if (view.list.sections.length === 0) out.message = hint;
  return out;
}

function renderSectionWithItems(
  section: MergedTodoSection,
  includeChecked: boolean,
): Record<string, unknown> {
  const items = activeItems(section).filter(
    (entry) => includeChecked || entry.item.checkedOffDate === null,
  );
  return {
    ...renderSection(section.section),
    // The index is what `move_item` takes, so it is reported rather than left to be
    // counted — a model counting rows in a rendered list will miscount a filtered one.
    items: items.map((entry, index) => ({ index, ...renderItem(entry.item, entry.provenance) })),
  };
}

function renderSection(section: TodoSection): Record<string, unknown> {
  return { id: section.id, title: section.title };
}

function renderItem(item: TodoItem, provenance?: ItemProvenance): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    name: item.name,
    checkedOff: item.checkedOffDate !== null,
    indentLevel: item.indentLevel,
  };
  if (item.footnote !== null) out.footnote = item.footnote;
  if (item.footnoteSub !== null) out.footnoteSub = item.footnoteSub;
  if (item.clearedDate !== null) out.removed = true;
  if (provenance) out.writtenBy = describeAuthor(provenance);
  return out;
}

/**
 * Who the winning observation of this row came from.
 *
 * "This agent" is what `own` means here, and it is true of a row this agent has merely
 * *acted on* — checking off the user's milk makes our observation the winning one. The
 * item is still theirs; what changed is who last touched it, which is exactly what a
 * provenance badge says on their screen too.
 */
function describeAuthor(provenance: ItemProvenance): string {
  if (provenance.kind === 'own') return 'this agent';
  const who = provenance.displayName ?? provenance.authorUuid;
  return provenance.connectionKind === 'agent' ? `${who} (an AI agent)` : who;
}

function renderUnreadable(source: UnreadableSource): Record<string, unknown> {
  return {
    account: source.displayName ?? source.uuid,
    uuid: source.uuid,
    reason: source.reason,
    detail: source.detail,
  };
}

/**
 * The sentence to put in front of an empty result.
 *
 * "Your list is empty" and "you did not give me your list" are different answers, and
 * only one of them is this agent's to make.
 */
function unreadableHint(view: ShoppingView, plain: string): string {
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
      'shopping list, so their slice is published with no key this agent can open. ' +
      'Granting it is a checkbox on their connection in the app — nothing here can ask for it.'
    );
  }
  if (view.unreadable.length > 0) {
    return `${plain} ${view.unreadable.length} connection(s) could not be read — see "unreadable".`;
  }
  return plain;
}

// --- argument decoding --------------------------------------------------------------
//
// The caller is a model, and a model will pass a string where a boolean belongs. Each of
// these refuses by naming the parameter, which is what lets the caller fix the call
// rather than guess at it.

function requireBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolInputError(`${key} must be a number`);
  }
  return value;
}

/** A string that may be explicitly null — `null` clears, absent is the caller's silence. */
function nullableString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string or null`);
  return value;
}

function requireStringArray(args: Record<string, unknown>, key: string): readonly string[] {
  const value = args[key];
  // A single name where a list belongs is the commonest mistake and is unambiguous, so
  // it is accepted rather than refused — this tool's job is the list, not the grammar.
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ToolInputError(`${key} must be an array of strings`);
  }
  return value as readonly string[];
}

export type { MergedShoppingList, MergedTodoItem };
