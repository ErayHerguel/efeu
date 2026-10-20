import { getSchema, type JSONContent } from '@tiptap/core';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import { createExtensions } from '../editor/extensions';

/** Name des Fragments, das auch die Collaboration-Erweiterung von TipTap verwendet. */
export const FIELD = 'default';

let schema: Schema | null = null;
const editorSchema = (): Schema => (schema ??= getSchema(createExtensions('schema')));

export const encode = (bytes: Uint8Array): string => toBase64(bytes);
export const decode = (text: string): Uint8Array => fromBase64(text);

export function openDoc(state: string | null): Y.Doc {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, decode(state));
  return doc;
}

/**
 * Überträgt einen gespeicherten Seiteninhalt in das Y.Doc. Es werden nur die Unterschiede eingespielt,
 * damit gleichzeitige Änderungen anderer Geräte an anderen Stellen erhalten bleiben.
 * Liefert false, wenn der Inhalt nicht zum Schema passt (dann bleibt das Y.Doc unverändert).
 */
export function foldJson(doc: Y.Doc, json: JSONContent): boolean {
  let node: PMNode;
  try {
    node = PMNode.fromJSON(editorSchema(), json);
  } catch (err) {
    console.error('Seiteninhalt passt nicht zum Schema, nicht abgeglichen', err);
    return false;
  }
  doc.transact(() => updateYFragment(doc, doc.getXmlFragment(FIELD), node, { mapping: new Map(), isOMark: new Map() }));
  return true;
}

/** Aktueller Inhalt des Y.Doc als TipTap-JSON, oder null, wenn er ungültig wäre. */
export function docJson(doc: Y.Doc): { json: JSONContent; node: PMNode } | null {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FIELD)) as JSONContent;
  if (!json.content?.length) json.content = [{ type: 'paragraph' }];
  try {
    return { json, node: PMNode.fromJSON(editorSchema(), json) };
  } catch (err) {
    console.error('Zusammengeführter Seiteninhalt ungültig, nicht gespeichert', err);
    return null;
  }
}

/** Update mit allem, was die Cloud laut Zustandsvektor noch nicht hat. */
export function pendingUpdate(doc: Y.Doc, acked: string): Uint8Array {
  return acked ? Y.encodeStateAsUpdate(doc, decode(acked)) : Y.encodeStateAsUpdate(doc);
}

/** Ein Update ohne Inhalt (nur Kopf: keine Strukturen, leere Löschmenge). */
export const isEmptyUpdate = (update: Uint8Array): boolean => update.length <= 2;
