import type { TodoItem, TodoSection } from '../src/shopping/model.js';
import { SHOPPING_SCHEMA, type ShoppingListSnapshot } from '../src/shopping/snapshot.js';
import type { AuthorSlice } from '../src/shopping/merge.js';

/**
 * Row builders for the shopping-list tests.
 *
 * Every field is spelled out with its documented default so a test says only what it is
 * about — a merge test that had to name eleven fields to talk about one stamp would bury
 * the thing it is pinning.
 */

export function section(id: string, over: Partial<TodoSection> = {}): TodoSection {
  return {
    id,
    title: id,
    createdAt: 1_000,
    titleChangedAt: null,
    deletedAt: null,
    sortOrder: 0,
    ...over,
  };
}

export function item(id: string, sectionId: string, over: Partial<TodoItem> = {}): TodoItem {
  return {
    id,
    sectionId,
    name: id,
    addedDate: 1_000,
    checkedOffDate: null,
    clearedDate: null,
    stateChangedAt: null,
    layoutChangedAt: null,
    sortOrder: 0,
    footnote: null,
    footnoteSub: null,
    indentLevel: 0,
    ...over,
  };
}

export function snapshot(
  sections: readonly TodoSection[],
  items: readonly TodoItem[],
): ShoppingListSnapshot {
  return { v: SHOPPING_SCHEMA, sections, items };
}

export function slice(
  authorUuid: string,
  sections: readonly TodoSection[],
  items: readonly TodoItem[],
  over: Partial<AuthorSlice> = {},
): AuthorSlice {
  return {
    authorUuid,
    displayName: null,
    snapshot: snapshot(sections, items),
    ...over,
  };
}

/**
 * Two uuids whose ordering is fixed and obvious, because half the merge's tiebreaks turn
 * on which author uuid is greater and a test that leaves that to chance passes for the
 * wrong reason.
 */
export const LOW_UUID = '00000000-0000-4000-8000-000000000001';
export const HIGH_UUID = 'ffffffff-0000-4000-8000-00000000000f';
