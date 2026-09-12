#!/usr/bin/env node
/**
 * generate-fixtures.mjs - synthetic SchemaGraph fixtures (work package R01, CTQ-01/07/09/14).
 *
 * Writes deterministic, entirely synthetic schema snapshots that satisfy the canonical
 * contract in skill/references/schema-contract.md, pass build_explorer.normalize() and
 * schema-diff-logic.parseSchemaSnapshot(), and exercise the explorer's code paths:
 * composite keys, composite FK groups sharing a constraintId, junction tables, declared
 * versus inferred evidence, cycles, self references, views, tables without a primary key,
 * unknown-versus-measured row counts, sampled column profiling, and hostile identifiers.
 *
 * Nothing here is derived from a real database. Every name comes from the word lists in
 * this file; every number comes from a seeded mulberry32 generator. Never replace these
 * fixtures with customer data (see fixtures/README.md).
 *
 * Usage:
 *   node scripts/generate-fixtures.mjs [--out <dir>] [--large]
 *
 * --out    destination directory (default: fixtures/ next to this script's parent)
 * --large  also write schemas/large.json (1,200 tables; git-ignored, above the 2 MB cap)
 *
 * Node 22+, no dependencies.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------------------

/** mulberry32: a small, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) { this.next = mulberry32(seed); }
  /** Integer in [min, max], inclusive. */
  int(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  pick(items) { return items[Math.floor(this.next() * items.length)]; }
  chance(probability) { return this.next() < probability; }
  /** Log-uniform integer in [min, max]; spreads magnitudes instead of values. */
  logInt(min, max) {
    const low = Math.log(min), high = Math.log(max + 1);
    return Math.min(max, Math.max(min, Math.floor(Math.exp(low + this.next() * (high - low)))));
  }
  /** Fisher-Yates shuffle of a copy. */
  shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  sample(items, count) { return this.shuffle(items).slice(0, count); }
}

// ---------------------------------------------------------------------------------------
// Vocabulary (synthetic; no real company, product or customer names)
// ---------------------------------------------------------------------------------------

export const TYPES = {
  CORE: 'Core master entity',
  TRANSACTION: 'Transaction / operational',
  ASSOCIATION: 'Association / detail',
  REFERENCE: 'Configuration / reference',
  AUDIT: 'Audit / integration state',
  VIEW: 'Reporting view',
};

const GENERATED_AT = '2026-01-01T00:00:00Z';
const SOURCE_FILE = 'synthetic/schema.json';

/**
 * Domain word lists. Position drives the role for the medium layout:
 * 0-1 core, 2-3 reference, then transaction with association at p%7==5 and audit at p%7==6
 * (p = index - 4), last table = integration state.
 */
const DOMAINS = [
  { name: 'Identity', schema: 'identity', nouns: ['tenant', 'user', 'role', 'permission', 'session', 'invitation', 'login_attempt', 'api_key', 'device', 'user_group', 'login_audit', 'password_reset', 'consent', 'profile', 'preference', 'sso_link', 'role_permission', 'access_audit', 'mfa_factor', 'identity_sync'] },
  { name: 'Catalog', schema: 'catalog', nouns: ['category', 'product', 'tax_class', 'unit_of_measure', 'price_list', 'price', 'variant', 'attribute', 'attribute_value', 'product_collection', 'catalog_audit', 'brand', 'collection', 'media_asset', 'bundle', 'bundle_item', 'product_barcode', 'sync_audit', 'availability_rule', 'catalog_sync'] },
  { name: 'Ordering', schema: 'ordering', nouns: ['order', 'cart', 'discount', 'coupon', 'order_line', 'cart_item', 'quote', 'quote_line', 'coupon_redemption', 'order_tag', 'order_audit', 'order_note', 'order_status_change', 'return_request', 'return_line', 'payment_intent', 'address_snapshot', 'checkout_audit', 'checkout_session', 'order_export'] },
  { name: 'Fulfillment', schema: 'fulfillment', nouns: ['warehouse', 'shipment', 'carrier', 'service_level', 'shipment_line', 'package', 'tracking_event', 'pick_list', 'pick_task', 'route_stop', 'dispatch_audit', 'delivery_attempt', 'dock', 'route', 'manifest', 'shipping_label', 'packing_slip', 'handling_audit', 'fulfillment_hold', 'fulfillment_sync'] },
  { name: 'Billing', schema: 'billing', nouns: ['invoice', 'subscription', 'tax_rate', 'billing_period', 'invoice_line', 'payment', 'refund', 'credit_note', 'ledger_entry', 'statement_line', 'billing_audit', 'account_balance', 'tax_line', 'dunning_step', 'statement', 'payout', 'fee_allocation', 'payment_audit', 'adjustment', 'billing_sync'] },
  { name: 'Support', schema: 'support', nouns: ['ticket', 'agent', 'queue', 'sla_policy', 'ticket_message', 'sla_breach', 'satisfaction_survey', 'knowledge_article', 'article_revision', 'ticket_tag', 'ticket_audit', 'attachment', 'escalation', 'canned_response', 'business_hour', 'holiday', 'ticket_watcher', 'agent_audit', 'ticket_merge', 'support_sync'] },
  { name: 'Analytics', schema: 'analytics', nouns: ['metric_definition', 'dashboard', 'dimension', 'segment', 'metric_value', 'fact_daily_sale', 'fact_session', 'cohort', 'funnel', 'dashboard_report', 'query_audit', 'funnel_step', 'funnel_result', 'report', 'report_schedule', 'dashboard_widget', 'segment_rule', 'export_audit', 'experiment', 'analytics_sync'] },
  { name: 'Platform', schema: 'platform', nouns: ['integration', 'job', 'setting', 'feature_flag', 'job_run', 'job_log', 'webhook', 'webhook_delivery', 'flag_rule', 'integration_scope', 'platform_audit', 'setting_override', 'api_client', 'rate_limit', 'secret_ref', 'integration_event', 'outbox_message', 'delivery_audit', 'health_check', 'platform_sync'] },
  { name: 'Procurement', schema: 'procurement', nouns: ['supplier', 'purchase_order', 'spend_category', 'approval_policy', 'purchase_order_line', 'receipt', 'receipt_line', 'supplier_contact', 'contract', 'supplier_category', 'procurement_audit', 'contract_term', 'rfq', 'rfq_response', 'approval', 'approval_step', 'requisition', 'approval_audit', 'requisition_line', 'procurement_sync'] },
  { name: 'Inventory', schema: 'inventory', nouns: ['stock_item', 'bin', 'zone', 'adjustment_reason', 'stock_level', 'stock_movement', 'reservation', 'cycle_count', 'cycle_count_line', 'item_zone', 'movement_audit', 'lot', 'serial_number', 'replenishment_rule', 'transfer', 'transfer_line', 'kit_component', 'count_audit', 'inventory_snapshot', 'inventory_sync'] },
  { name: 'Marketing', schema: 'marketing', nouns: ['campaign', 'audience', 'channel', 'template_kind', 'campaign_step', 'audience_member', 'template', 'send', 'send_event', 'campaign_audience', 'send_audit', 'landing_page', 'form', 'form_submission', 'promotion', 'promotion_rule', 'referral', 'promotion_audit', 'ab_test', 'marketing_sync'] },
  { name: 'Compliance', schema: 'compliance', nouns: ['policy', 'control', 'regulation', 'retention_rule', 'policy_version', 'control_test', 'evidence', 'finding', 'remediation', 'policy_control', 'review_audit', 'risk', 'risk_assessment', 'vendor_assessment', 'data_map', 'legal_hold', 'dsar_request', 'access_review_audit', 'training_completion', 'compliance_sync'] },
  { name: 'Scheduling', schema: 'scheduling', nouns: ['calendar', 'resource', 'resource_group', 'recurrence_rule', 'event', 'event_attendee', 'availability', 'booking', 'booking_slot', 'resource_calendar', 'booking_audit', 'reminder', 'timezone_override', 'blackout', 'shift', 'shift_assignment', 'roster', 'shift_audit', 'waitlist_entry', 'scheduling_sync'] },
  { name: 'Messaging', schema: 'messaging', nouns: ['conversation', 'participant', 'notification_kind', 'digest_rule', 'message', 'thread', 'reaction', 'read_receipt', 'notification', 'conversation_participant', 'delivery_audit_log', 'notification_preference', 'channel_binding', 'push_delivery', 'email_delivery', 'sms_delivery', 'mention', 'bounce_audit', 'block_list_entry', 'messaging_sync'] },
];

/** Attribute vocabulary: name, type, and whether the column is NOT NULL when present. */
const ATTRIBUTES = [
  ['label', 'String(120)', true], ['description', 'Text', false], ['notes', 'Text', false], ['status', 'String(32)', true],
  ['code', 'String(32)', true], ['sort_order', 'Integer', true], ['is_active', 'Boolean', true], ['is_default', 'Boolean', true],
  ['starts_at', 'DateTime', false], ['ends_at', 'DateTime', false], ['amount', 'Numeric(12,2)', true], ['quantity', 'Integer', true],
  ['unit_price', 'Numeric(12,2)', false], ['currency_code', 'String(3)', true], ['external_ref', 'String(64)', false],
  ['payload', 'JSONB', false], ['version', 'Integer', true], ['locale', 'String(16)', false], ['timezone', 'String(64)', false],
  ['priority', 'SmallInteger', false], ['score', 'Numeric(6,2)', false], ['weight_grams', 'Integer', false], ['rating', 'SmallInteger', false],
  ['comment', 'Text', false], ['title', 'String(255)', true], ['summary', 'Text', false], ['reason', 'String(255)', false],
  ['category', 'String(64)', false], ['tags', 'JSONB', false], ['metadata', 'JSONB', false], ['checksum', 'String(64)', false],
  ['sequence_no', 'BigInteger', true], ['retry_count', 'Integer', true], ['last_error', 'Text', false], ['processed_at', 'DateTime', false],
  ['archived_at', 'DateTime', false], ['approved_at', 'DateTime', false], ['due_at', 'DateTime', false], ['completed_at', 'DateTime', false],
  ['cancelled_at', 'DateTime', false], ['email', 'String(255)', true], ['phone', 'String(32)', false], ['display_name', 'String(120)', true],
  ['first_name', 'String(80)', false], ['last_name', 'String(80)', false], ['slug', 'String(120)', true], ['color', 'String(16)', false],
  ['icon', 'String(64)', false], ['url', 'String(2048)', false], ['ip_address', 'String(45)', false], ['user_agent', 'Text', false],
  ['country_code', 'String(2)', false], ['postal_code', 'String(16)', false], ['city', 'String(120)', false], ['line1', 'String(255)', false],
  ['line2', 'String(255)', false], ['latitude', 'Numeric(9,6)', false], ['longitude', 'Numeric(9,6)', false], ['expires_at', 'DateTime', false],
  ['attempts', 'Integer', true], ['max_attempts', 'Integer', false], ['threshold', 'Numeric(10,2)', false], ['unit', 'String(16)', false],
  ['source_system', 'String(64)', false], ['batch_id', 'String(64)', false], ['error_code', 'String(32)', false], ['http_status', 'SmallInteger', false],
  ['duration_ms', 'Integer', false], ['byte_size', 'BigInteger', false], ['file_name', 'String(255)', false], ['mime_type', 'String(128)', false],
  ['hash_sha256', 'String(64)', false], ['total', 'Numeric(14,2)', true], ['subtotal', 'Numeric(14,2)', false], ['tax_total', 'Numeric(14,2)', false],
  ['discount_total', 'Numeric(14,2)', false], ['balance', 'Numeric(14,2)', false], ['effective_date', 'Date', false], ['expiry_date', 'Date', false],
  ['week_start', 'Date', false], ['is_deleted', 'Boolean', true], ['deleted_at', 'DateTime', false], ['row_version', 'Integer', true],
  ['created_by', 'Integer', false], ['updated_by', 'Integer', false],
];
const ATTRIBUTE_BY_NAME = new Map(ATTRIBUTES.map(([name, type, required]) => [name, { name, type, required }]));
const REFERENCE_ATTRIBUTES = ['code', 'label', 'sort_order', 'is_active', 'description'];
const CHECKED = { quantity: 'quantity >= 0', amount: 'amount >= 0', rating: 'rating >= 0 AND rating <= 5' };

// ---------------------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------------------

export function pluralize(noun) {
  if (/[^aeiou]y$/.test(noun)) return noun.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(noun)) return noun + 'es';
  return noun + 's';
}
export function classNameOf(name) {
  return name.split(/[^A-Za-z0-9À-￿]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('');
}
const column = (name, type, nullable, extra = {}) => ({ name, type, pk: false, fk: '', nullable: nullable === '' ? '' : nullable ? 'True' : 'False', index: false, unique: false, ...extra });

// ---------------------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------------------

class GraphBuilder {
  constructor(rng) {
    this.rng = rng;
    this.tables = [];
    this.links = [];
    this.byId = new Map();
    this.names = new Set();
    this.line = 1;
  }

  uniqueName(base) {
    let name = base, n = 2;
    while (this.names.has(name)) name = `${base}_${n++}`;
    this.names.add(name);
    return name;
  }

  addTable({ schema, name, domain, type, role, kind, definition, columns = [], primaryKey, indexes = [], uniques = [], checks = [] }) {
    const id = `${schema}.${name}`;
    if (this.byId.has(id)) throw new Error(`duplicate table id ${id}`);
    const table = {
      id, schema, name, className: classNameOf(name), domain, type, role, kind, definition,
      file: SOURCE_FILE, line: this.line, columns, primaryKey: primaryKey || [], indexes, uniques, checks,
    };
    this.line += columns.length + 2;
    this.tables.push(table);
    this.byId.set(id, table);
    return table;
  }

  hasColumn(table, name) { return table.columns.some(c => c.name === name); }
  columnOf(table, name) { return table.columns.find(c => c.name === name); }
  addColumn(table, col) {
    if (this.hasColumn(table, col.name)) return null;
    table.columns.push(col);
    return col;
  }
  /** Ordered primary key; single or composite. Mirrors the normalized shape. */
  setPrimaryKey(table, names) {
    table.primaryKey = names;
    for (const col of table.columns) col.pk = names.includes(col.name);
  }
  addIndex(table, columns, { unique = false, partial = false, where } = {}) {
    if (columns.some(name => !this.hasColumn(table, name))) throw new Error(`${table.id}: index on unknown column`);
    const entry = { name: `ix_${table.name}_${columns.join('_')}`.slice(0, 63), columns, unique };
    if (partial) { entry.partial = true; entry.where = where; }
    if (table.indexes.some(i => i.name === entry.name)) return;
    table.indexes.push(entry);
    this.columnOf(table, columns[0]).index = true;
  }
  addUnique(table, columns) {
    if (columns.some(name => !this.hasColumn(table, name))) throw new Error(`${table.id}: unique on unknown column`);
    const name = `uq_${table.name}_${columns.join('_')}`.slice(0, 63);
    if (table.uniques.some(u => u.name === name)) return;
    table.uniques.push({ name, columns });
    if (columns.length === 1) this.columnOf(table, columns[0]).unique = true;
  }
  addCheck(table, columnName) {
    if (CHECKED[columnName] && this.hasColumn(table, columnName) && !table.checks.some(c => c.name === `ck_${table.name}_${columnName}`)) {
      table.checks.push({ name: `ck_${table.name}_${columnName}`, definition: CHECKED[columnName] });
    }
  }

  /** Declared FK: one link per column pair; composite pairs share the constraintId. */
  declare(source, pairs, target, { constraintId, ondelete, indexed = true } = {}) {
    const id = constraintId || `fk_${source.name}_${pairs.map(([c]) => c).join('_')}`.slice(0, 63);
    for (const [col, targetCol] of pairs) {
      const sourceCol = this.columnOf(source, col);
      if (!sourceCol) throw new Error(`${source.id}: FK column ${col} missing`);
      if (!this.hasColumn(target, targetCol)) throw new Error(`${target.id}: FK target column ${targetCol} missing`);
      sourceCol.fk = `${target.id}.${targetCol}`;
      const link = { source: source.id, column: col, target: target.id, targetColumn: targetCol, kind: 'declared FK', constraintId: id };
      if (ondelete) link.ondelete = ondelete;
      this.links.push(link);
    }
    if (indexed && !source.primaryKey.includes(pairs[0][0])) this.addIndex(source, pairs.map(([c]) => c));
    return id;
  }
  /** Inferred by naming: evidence only; the target may be absent. */
  infer(source, col, targetId, targetCol = 'id') {
    if (!this.hasColumn(source, col)) throw new Error(`${source.id}: inferred column ${col} missing`);
    this.links.push({ source: source.id, column: col, target: targetId, targetColumn: targetCol, kind: 'inferred by naming' });
  }

  /** Attribute columns drawn from the vocabulary; never duplicates and never clashes. */
  addAttributes(table, count, pool = ATTRIBUTES) {
    const wanted = this.rng.sample(pool, Math.min(count, pool.length));
    for (const [name, type, required] of wanted) {
      if (this.hasColumn(table, name)) continue;
      const nullable = required ? false : this.rng.chance(0.65);
      this.addColumn(table, column(name, type, nullable));
      this.addCheck(table, name);
    }
  }
  addTimestamps(table) {
    this.addColumn(table, column('created_at', 'DateTime', false));
    this.addColumn(table, column('updated_at', 'DateTime', false));
  }

  toGraph({ key, name, dialect, basis, variant }) {
    const tables = this.tables.map(t => {
      const out = { id: t.id, schema: t.schema, name: t.name, className: t.className, domain: t.domain, type: t.type };
      if (t.kind) out.kind = t.kind;
      if (t.definition !== undefined) out.definition = t.definition;
      out.file = t.file; out.line = t.line;
      out.pk = t.primaryKey.join(', ');
      out.primaryKey = t.primaryKey;
      out.allColumns = t.columns.map(c => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk, nullable: c.nullable, index: c.index, unique: c.unique, ...(c.extra || {}) }));
      out.indexes = t.indexes; out.uniques = t.uniques; out.checks = t.checks;
      for (const extra of ['rowCount', 'rowCountLowerBound', 'profiling']) if (t[extra] !== undefined) out[extra] = t[extra];
      return out;
    });
    const links = [...this.links];
    const sha256 = createHash('sha256').update(JSON.stringify({ tables, links })).digest('hex');
    return {
      project: { name, key, dialect },
      source: { file: SOURCE_FILE, commit: `synthetic-${variant}`, sha256, generated: GENERATED_AT, basis },
      tables,
      links,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Parametric synthesis (medium, many-domains, large)
// ---------------------------------------------------------------------------------------

function roleFor(index, count) {
  if (index < 2) return 'core';
  if (index < 4 && count >= 6) return 'reference';
  if (index === count - 1 && count >= 8) return 'sync';
  const p = index - 4;
  if (p >= 0 && p % 7 === 5) return 'association';
  if (p >= 0 && p % 7 === 6) return 'audit';
  return 'transaction';
}
const ROLE_TYPE = { core: TYPES.CORE, reference: TYPES.REFERENCE, transaction: TYPES.TRANSACTION, association: TYPES.ASSOCIATION, audit: TYPES.AUDIT, sync: TYPES.AUDIT };

/** Table names for a domain of any size: nouns first, then prefixed/suffixed variants. */
function domainNames(domain, count) {
  const prefixes = ['', 'archived_', 'staging_', 'daily_', 'monthly_', 'legacy_', 'pending_', 'regional_'];
  const suffixes = ['', '_history', '_snapshot', '_log', '_event', '_summary', '_queue', '_link'];
  const names = [];
  for (let round = 0; names.length < count; round++) {
    const prefix = prefixes[Math.floor(round / suffixes.length) % prefixes.length];
    const suffix = suffixes[round % suffixes.length];
    for (const noun of domain.nouns) {
      if (names.length >= count) break;
      if (round === 0) names.push(noun);
      else if (prefix || suffix) names.push(`${prefix}${noun}${suffix}`);
    }
    if (round > prefixes.length * suffixes.length + 2) throw new Error(`cannot name ${count} tables in ${domain.name}`);
  }
  return names;
}

/**
 * Generic multi-domain synthesis.
 * options.tablesPerDomain: array of counts (one per domain used)
 * options.columnScale: multiplies attribute counts (1 = medium density)
 * options.extras: { junctionDomains, noPkDomains, views, tenantScoped, scc, selfRef, oneToOne, inferredEvery }
 */
export function synthesize(options) {
  const { seed, tablesPerDomain, columnScale = 1, extras = {} } = options;
  const rng = new Rng(seed);
  const b = new GraphBuilder(rng);
  const domains = DOMAINS.slice(0, tablesPerDomain.length);
  const scale = n => Math.max(1, Math.round(n * columnScale));
  const perDomain = [];

  // Pass 1: skeletons with primary keys and attributes.
  domains.forEach((domain, d) => {
    const count = tablesPerDomain[d];
    const names = domainNames(domain, count);
    const list = [];
    for (let i = 0; i < count; i++) {
      const role = roleFor(i, count);
      const noun = names[i];
      const name = b.uniqueName(pluralize(noun));
      const table = b.addTable({ schema: domain.schema, name, domain: domain.name, type: ROLE_TYPE[role], role });
      table.noun = noun;
      list.push(table);
      if (role === 'association') continue; // keys are assigned once the FK targets exist
      const pkType = role === 'transaction' && rng.chance(0.08) ? 'UUID' : role === 'transaction' ? 'BigInteger' : 'Integer';
      b.addColumn(table, column('id', pkType, false));
      b.setPrimaryKey(table, ['id']);
      if (role === 'core') {
        b.addColumn(table, column('name', 'String(200)', false));
        b.addAttributes(table, scale(rng.int(9, 14)));
        b.addTimestamps(table);
        if (b.hasColumn(table, 'slug')) b.addUnique(table, ['slug']);
        else b.addUnique(table, ['name']);
      } else if (role === 'reference') {
        for (const attr of REFERENCE_ATTRIBUTES.slice(0, scale(rng.int(3, 5)))) {
          const a = ATTRIBUTE_BY_NAME.get(attr);
          b.addColumn(table, column(a.name, a.type, !a.required));
        }
        b.addUnique(table, ['code']);
      } else if (role === 'transaction') {
        b.addAttributes(table, scale(rng.int(9, 20)));
        b.addTimestamps(table);
        b.addIndex(table, ['created_at']);
        if (b.hasColumn(table, 'status')) b.addIndex(table, ['status', 'created_at']);
      } else if (role === 'audit' || role === 'sync') {
        b.addAttributes(table, scale(rng.int(6, 11)));
        b.addColumn(table, column('recorded_at', 'DateTime', false));
        b.addIndex(table, ['recorded_at']);
      }
    }
    perDomain.push(list);
  });

  const identity = perDomain[0];
  const tenants = identity[0], users = identity[1];
  const compositeTargets = new Set(); // tables whose PK is composite: never a single-column FK target

  // Pass 2: tenant-scoped composite keys (medium only).
  for (const [d, t] of extras.tenantScoped || []) {
    const table = perDomain[d][t];
    if (!table || table.role !== 'transaction') throw new Error('tenantScoped requires a transaction table');
    b.addColumn(table, column('tenant_id', 'Integer', false));
    table.columns.sort((x, y) => (x.name === 'id' ? -1 : y.name === 'id' ? 1 : x.name === 'tenant_id' ? -1 : y.name === 'tenant_id' ? 1 : 0));
    b.setPrimaryKey(table, ['tenant_id', 'id']);
    b.declare(table, [['tenant_id', 'id']], tenants, { constraintId: `fk_${table.name}_tenant` });
    if (!b.hasColumn(table, 'code')) b.addColumn(table, column('code', 'String(32)', false));
    b.addUnique(table, ['tenant_id', 'code']);
    compositeTargets.add(table.id);
    // Two children with composite FKs sharing one constraintId each; the first also gets a composite PK.
    for (const offset of [1, 2]) {
      const child = perDomain[d][t + offset];
      if (!child || child.role !== 'transaction') throw new Error('tenantScoped children must be transaction tables');
      b.addColumn(child, column('tenant_id', 'Integer', false));
      b.addColumn(child, column(`${table.noun}_id`, b.columnOf(table, 'id').type, false));
      if (offset === 1) { b.setPrimaryKey(child, ['tenant_id', 'id']); compositeTargets.add(child.id); }
      b.declare(child, [['tenant_id', 'tenant_id'], [`${table.noun}_id`, 'id']], table, { constraintId: `fk_${child.name}_${table.noun}` });
    }
  }

  // Pass 3: declared foreign keys.
  domains.forEach((domain, d) => {
    const list = perDomain[d];
    const pool = list.filter(t => ['core', 'transaction'].includes(t.role) && t.primaryKey.length === 1 && !compositeTargets.has(t.id));
    for (const table of list) {
      if (table.role === 'core') {
        if (table !== tenants && d === 0 || d > 0 && rng.chance(0.6)) {
          b.addColumn(table, column('tenant_id', 'Integer', false));
          b.declare(table, [['tenant_id', 'id']], tenants);
        }
        continue;
      }
      if (table.role === 'reference') continue;
      const targets = pool.filter(t => t !== table && list.indexOf(t) < list.indexOf(table));
      if (table.role === 'association') {
        const isJunction = (extras.junctionDomains || []).includes(d) && !list.some(t => t.junction);
        const candidates = pool.filter(t => t !== table && t.primaryKey.length === 1 && b.columnOf(t, 'id').type !== 'UUID');
        const [a, c] = rng.sample(candidates.length >= 2 ? candidates : [tenants, users], 2);
        const aCol = `${a.noun}_id`, cCol = a.noun === c.noun ? `${c.noun}_2_id` : `${c.noun}_id`;
        if (isJunction) {
          table.junction = true;
          const junctionName = b.uniqueName(`${a.noun}_${pluralize(c.noun)}`);
          b.names.delete(table.name); table.name = junctionName; table.className = classNameOf(junctionName);
          b.byId.delete(table.id); table.id = `${table.schema}.${junctionName}`; b.byId.set(table.id, table);
          b.addColumn(table, column(aCol, b.columnOf(a, 'id').type, false));
          b.addColumn(table, column(cCol, b.columnOf(c, 'id').type, false));
          b.setPrimaryKey(table, [aCol, cCol]);
          b.addColumn(table, column('created_at', 'DateTime', false));
          if (rng.chance(0.5)) b.addColumn(table, column('position', 'Integer', true));
          compositeTargets.add(table.id);
          b.declare(table, [[aCol, 'id']], a, { indexed: false });
          b.declare(table, [[cCol, 'id']], c);
        } else {
          b.addColumn(table, column('id', 'Integer', false));
          b.setPrimaryKey(table, ['id']);
          b.addColumn(table, column(aCol, b.columnOf(a, 'id').type, false));
          b.addColumn(table, column(cCol, b.columnOf(c, 'id').type, rng.chance(0.3)));
          b.addAttributes(table, scale(rng.int(2, 5)));
          b.addTimestamps(table);
          b.declare(table, [[aCol, 'id']], a);
          b.declare(table, [[cCol, 'id']], c, { indexed: rng.chance(0.6) });
        }
        continue;
      }
      if (table.role === 'transaction' && targets.length && rng.chance(0.42)) {
        const target = rng.pick(targets);
        const col = `${target.noun}_id`;
        if (b.addColumn(table, column(col, b.columnOf(target, 'id').type, rng.chance(0.3)))) {
          b.declare(table, [[col, 'id']], target, { indexed: rng.chance(0.8), ondelete: rng.chance(0.3) ? 'CASCADE' : undefined });
        }
        if (rng.chance(0.1)) {
          const other = rng.pick(targets.filter(t => t !== target));
          if (other) {
            const otherCol = `${other.noun}_id`;
            if (b.addColumn(table, column(otherCol, b.columnOf(other, 'id').type, true))) { b.declare(table, [[otherCol, 'id']], other); }
          }
        }
      }
      if (table.role === 'transaction' && d > 0 && rng.chance(0.05)) {
        if (b.addColumn(table, column('user_id', 'Integer', true))) { b.declare(table, [['user_id', 'id']], users, { indexed: false }); }
      }
    }
  });

  // Pass 4: inferred-by-naming evidence (no declared constraint), one per audit table, a few on transactions.
  domains.forEach((domain, d) => {
    const list = perDomain[d];
    const core = list[0];
    for (const table of list) {
      if (table.role === 'audit' || table.role === 'sync' && rng.chance(0.5)) {
        const col = `${core.noun}_id`;
        if (!b.hasColumn(table, col) && core.primaryKey.length === 1) { b.addColumn(table, column(col, b.columnOf(core, 'id').type, true)); b.infer(table, col, core.id); }
      }
    }
    if (extras.inferredEvery) {
      for (const table of list.filter(t => t.role === 'transaction')) {
        if (rng.chance(extras.inferredEvery) && list[1].primaryKey.length === 1) {
          const col = `${list[1].noun}_id`;
          if (!b.hasColumn(table, col)) { b.addColumn(table, column(col, b.columnOf(list[1], 'id').type, true)); b.infer(table, col, list[1].id); }
        }
      }
    }
  });

  // Pass 5: structural extras.
  if (extras.selfRef) {
    const table = perDomain[extras.selfRef[0]][extras.selfRef[1]];
    b.addColumn(table, column('parent_id', b.columnOf(table, 'id').type, true));
    b.declare(table, [['parent_id', 'id']], table, { constraintId: `fk_${table.name}_parent` });
  }
  if (extras.scc) {
    const ring = extras.scc.map(([d, t]) => perDomain[d][t]);
    ring.forEach((table, i) => {
      const target = ring[(i + 1) % ring.length];
      const col = `${target.noun}_id`;
      if (!b.addColumn(table, column(col, b.columnOf(target, 'id').type, true))) throw new Error(`scc column ${col} already exists on ${table.id}`);
      b.declare(table, [[col, 'id']], target, { constraintId: `fk_${table.name}_${target.noun}_ring` });
    });
  }
  if (extras.oneToOne) {
    const [d, t] = extras.oneToOne;
    const table = perDomain[d][t];
    b.addColumn(table, column('user_id', 'Integer', false));
    b.addUnique(table, ['user_id']);
    b.declare(table, [['user_id', 'id']], users, { constraintId: `fk_${table.name}_user`, indexed: false });
    table.oneToOneParent = users.id;
  }
  for (const [d, t] of extras.noPkDomains ? extras.noPkDomains.map(d => [d, perDomain[d].findIndex(x => x.role === 'audit')]) : []) {
    const table = perDomain[d][t];
    table.columns = table.columns.filter(c => c.name !== 'id');
    b.setPrimaryKey(table, []);
    table.noPrimaryKey = true;
  }
  for (const [d, t] of extras.partialIndexes || []) {
    const table = perDomain[d][t];
    if (!b.hasColumn(table, 'deleted_at')) b.addColumn(table, column('deleted_at', 'DateTime', true));
    b.addIndex(table, ['deleted_at', 'created_at'].filter(c => b.hasColumn(table, c)), { partial: true, where: 'deleted_at IS NULL' });
  }
  for (const [d, t] of extras.views || []) {
    const base = perDomain[d][t];
    const cols = base.columns.filter(c => c.name !== 'id').slice(0, rng.int(5, 9));
    const view = b.addTable({ schema: base.schema, name: b.uniqueName(`v_${base.name}_summary`), domain: base.domain, type: TYPES.VIEW, role: 'view', kind: 'view',
      definition: `SELECT ${['id', ...cols.map(c => c.name)].map(n => `t.${n}`).join(', ')}\nFROM ${base.schema}.${base.name} AS t\nWHERE t.created_at >= CURRENT_DATE - INTERVAL '30 days'`,
      columns: [column('id', b.columnOf(base, 'id').type, false), ...cols.map(c => column(c.name, c.type, c.nullable === 'True'))] });
    view.viewOf = base.id;
  }
  return b;
}

// ---------------------------------------------------------------------------------------
// Measurements (medium-measured)
// ---------------------------------------------------------------------------------------

const SAMPLE_CAP = 10000;
const SEED_ROW_CAP = 200;
const UNKNOWN_SEED_ROWS = 10;

/** Number of rows the SQL seed inserts for a table (see fixtures/README.md). */
export function seedRowCount(table) {
  if (typeof table.rowCount === 'number') return Math.min(table.rowCount, SEED_ROW_CAP);
  if (typeof table.rowCountLowerBound === 'number') return SEED_ROW_CAP;
  return UNKNOWN_SEED_ROWS;
}

function fkGroups(builder, table) {
  const groups = new Map();
  for (const link of builder.links) {
    if (link.source !== table.id || link.kind !== 'declared FK') continue;
    const key = link.constraintId || `${link.column}>${link.targetColumn}`;
    const group = groups.get(key) || { id: key, key: `${table.id}|${key}`, source: table, target: builder.byId.get(link.target), pairs: [] };
    group.pairs.push([link.column, link.targetColumn]);
    groups.set(key, group);
  }
  return [...groups.values()];
}
const inbound = builder => {
  const set = new Set();
  for (const link of builder.links) if (link.kind === 'declared FK' && link.source !== link.target) set.add(link.target);
  return set;
};

/** Parents first; cycle-closing FK groups are reported so the SQL emitter can defer them. */
function topologicalOrder(builder) {
  const base = builder.tables.filter(t => t.kind !== 'view');
  const state = new Map(), order = [], deferred = new Set();
  const visit = table => {
    if (state.get(table.id) === 'done') return;
    state.set(table.id, 'active');
    for (const group of fkGroups(builder, table)) {
      if (group.target === table) continue;
      if (state.get(group.target.id) === 'active') { deferred.add(group.key); continue; }
      visit(group.target);
    }
    state.set(table.id, 'done');
    order.push(table);
  };
  for (const table of base) visit(table);
  return { order, deferred };
}

function profileValue(col, kind, sampleSize) {
  const t = col.type;
  if (kind === 'min') {
    if (/^(Integer|BigInteger|SmallInteger)$/.test(t)) return col.pk ? 1 : 0;
    if (/^Numeric/.test(t)) return 0;
    if (t === 'Boolean') return false;
    if (t === 'DateTime') return '2025-01-03T08:15:00Z';
    if (t === 'Date') return '2025-01-03';
    return `${col.name}-1`;
  }
  if (/^(Integer|BigInteger|SmallInteger)$/.test(t)) return col.pk ? sampleSize : 999;
  if (/^Numeric/.test(t)) return 999.99;
  if (t === 'Boolean') return true;
  if (t === 'DateTime') return '2025-12-30T22:40:00Z';
  if (t === 'Date') return '2025-12-30';
  return `${col.name}-${sampleSize}`;
}

/** Adds rowCount / rowCountLowerBound / profiling in place. Unknown stays absent, never zero. */
export function measure(builder, seed) {
  const rng = new Rng(seed);
  const base = builder.tables.filter(t => t.kind !== 'view');
  const referenced = inbound(builder);
  const leaves = base.filter(t => !referenced.has(t.id) && !t.oneToOneParent);
  const zeros = new Set(rng.sample(leaves, 6));
  const users = builder.byId.get(base.find(t => t.oneToOneParent)?.oneToOneParent);
  const boundCandidates = base.filter(t => !zeros.has(t) && t !== users && !t.oneToOneParent && t.primaryKey.some(c => !builder.columnOf(t, c).fk));
  const lowerBounds = new Set(rng.sample(boundCandidates, 10));
  const remaining = base.filter(t => !zeros.has(t) && !lowerBounds.has(t) && !t.oneToOneParent);
  const measuredCount = Math.round(builder.tables.length * 0.8) - zeros.size;
  const measured = new Set(rng.sample(remaining.filter(t => t !== users), measuredCount - 1));
  measured.add(users);

  const { order } = topologicalOrder(builder);
  for (const table of order) {
    if (zeros.has(table)) table.rowCount = 0;
    else if (lowerBounds.has(table)) table.rowCountLowerBound = SAMPLE_CAP;
    else if (measured.has(table)) table.rowCount = rng.chance(0.87) ? rng.logInt(1, 200) : rng.logInt(201, 5000000);
    if (table.oneToOneParent) {
      const parent = builder.byId.get(table.oneToOneParent);
      if (typeof parent.rowCount === 'number') table.rowCount = parent.rowCount;
      else if (typeof parent.rowCountLowerBound === 'number') table.rowCountLowerBound = parent.rowCountLowerBound;
    }
    // A PK made only of FK columns cannot exceed the product of its parents' seeded rows.
    const groups = fkGroups(builder, table);
    const pkFromFks = table.primaryKey.length > 0 && table.primaryKey.every(c => groups.some(g => g.pairs.some(([col]) => col === c)));
    if (pkFromFks) {
      const product = groups.filter(g => g.pairs.some(([col]) => table.primaryKey.includes(col))).reduce((acc, g) => acc * Math.max(1, seedRowCount(g.target)), 1);
      if (seedRowCount(table) > product) { delete table.rowCountLowerBound; table.rowCount = product; }
    }
  }

  // Sampled column profiling on roughly half the columns of measured tables (~40 % overall).
  let sampleValueSlots = 3;
  for (const table of base) {
    const rows = typeof table.rowCount === 'number' ? table.rowCount : typeof table.rowCountLowerBound === 'number' ? SAMPLE_CAP : null;
    if (!rows) continue;
    const sampleSize = Math.min(rows, SAMPLE_CAP);
    let profiled = 0;
    for (const col of table.columns) {
      if (!rng.chance(0.46)) continue;
      const nullFraction = col.nullable === 'False' ? 0 : Math.round(rng.next() * 600) / 1000;
      const nonNull = Math.max(1, Math.round(sampleSize * (1 - nullFraction)));
      const distinctCount = col.pk || col.unique ? nonNull : col.type === 'Boolean' ? Math.min(2, nonNull) : Math.max(1, Math.min(nonNull, rng.logInt(1, nonNull)));
      col.extra = { ...(col.extra || {}), profiling: { nullFraction, distinctCount, min: profileValue(col, 'min', sampleSize), max: profileValue(col, 'max', sampleSize), sampleSize, sampled: true, scope: 'sampled' } };
      profiled++;
      if (sampleValueSlots > 0 && col.pk && table.primaryKey.length === 1 && col.type !== 'UUID' && sampleSize >= 3) {
        col.extra.profiling.sampleValues = [1, 2, 3];
        sampleValueSlots--;
      }
    }
    if (profiled) table.profiling = { sampleSize, sampled: true };
  }
  // Functional dependencies observed in a sample, on three tables, for the Normalization Lens.
  const fdTables = base.filter(t => t.profiling && t.columns.some(c => c.name === 'status') && t.columns.some(c => c.name === 'category')).slice(0, 3);
  for (const table of fdTables) {
    table.profiling.functionalDependencies = [{ determinant: 'category', dependent: 'status', distinctDeterminant: 12, distinctPair: 12, sampleSize: table.profiling.sampleSize }];
  }
}

// ---------------------------------------------------------------------------------------
// SQL seed emitter (minimal DDL + deterministic inserts; PostgreSQL and SQLite)
// ---------------------------------------------------------------------------------------

const DIALECTS = {
  postgresql: {
    schemas: true,
    deferredConstraints: true,
    type(t) {
      const m = /^String\((\d+)\)$/.exec(t);
      if (m) return `varchar(${m[1]})`;
      if (/^Numeric\(/.test(t)) return t.toLowerCase();
      return { Integer: 'integer', BigInteger: 'bigint', SmallInteger: 'smallint', Text: 'text', Boolean: 'boolean', DateTime: 'timestamp', Date: 'date', UUID: 'uuid', JSONB: 'jsonb' }[t] || 'text';
    },
    bool: v => (v ? 'TRUE' : 'FALSE'),
    header: ['BEGIN;'],
    footer: ['COMMIT;'],
  },
  sqlite: {
    schemas: false,
    deferredConstraints: false,
    type(t) {
      if (/^String\(|^Text$|^DateTime$|^Date$|^UUID$|^JSONB$/.test(t)) return 'TEXT';
      if (/^Numeric\(/.test(t)) return 'NUMERIC';
      return 'INTEGER';
    },
    bool: v => (v ? '1' : '0'),
    header: ['PRAGMA foreign_keys = ON;', 'BEGIN;'],
    footer: ['COMMIT;'],
  },
};

const quote = id => `"${id.replaceAll('"', '""')}"`;
const literal = v => v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
const base26 = (n, width) => { let s = ''; for (let i = 0; i < width; i++) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
const uuidOf = key => { const h = createHash('sha256').update(key).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function attributeValue(table, col, i, dialect) {
  const t = col.type, name = col.name;
  if (name === 'rating') return i % 6;
  if (name === 'priority') return i % 5;
  if (name === 'http_status') return 200 + (i % 4) * 100;
  if (/^(Integer|BigInteger|SmallInteger)$/.test(t)) return (i * 31 + name.length * 7) % 1000;
  if (/^Numeric/.test(t)) return Number((((i * 137) % 100000) / 100).toFixed(2));
  if (t === 'Boolean') return { raw: dialect.bool((i + name.length) % 3 !== 0) };
  if (t === 'DateTime') { const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (i * 61 + name.length) * 60000); return d.toISOString().slice(0, 19).replace('T', ' '); }
  if (t === 'Date') { const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000); return d.toISOString().slice(0, 10); }
  if (t === 'UUID') return uuidOf(`${table.id}.${name}.${i}`);
  if (t === 'JSONB') return `{"seq": ${i + 1}}`;
  const m = /^String\((\d+)\)$/.exec(t);
  const width = m ? Number(m[1]) : 255;
  const text = `${name}${i + 1}`;
  return text.length <= width ? text : base26(i, width);
}

/**
 * CREATE TABLE in FK dependency order, then deterministic inserts (rowCount rows up to 200,
 * 10 for tables without a measurement, 0 where rowCount is 0), then deferred cycle edges.
 */
export function seedSql(builder, dialectName, variant) {
  const dialect = DIALECTS[dialectName];
  const { order, deferred } = topologicalOrder(builder);
  const qualified = t => (dialect.schemas ? `${quote(t.schema)}.${quote(t.name)}` : quote(t.name));
  const out = [
    `-- Synthetic seed for the ${variant} fixture, generated by scripts/generate-fixtures.mjs (${dialectName}).`,
    '-- Do not edit by hand: run "npm run fixtures" to regenerate.',
    '-- Tables whose declared rowCount exceeds 200 receive exactly 200 rows; tables without a',
    '-- measurement receive 10; rowCount 0 receives none. Counts above 200 are declared in the',
    '-- JSON snapshot, not measured from this seed (see fixtures/README.md).',
    ...(dialect.schemas ? [] : ['-- SQLite has no schemas: tables use their bare, globally unique names.']),
    ...dialect.header,
    '',
  ];
  if (dialect.schemas) {
    for (const schema of [...new Set(order.map(t => t.schema))].sort()) out.push(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)};`);
    out.push('');
  }
  const laterConstraints = [];
  for (const table of order) {
    const lines = table.columns.map(c => `  ${quote(c.name)} ${dialect.type(c.type)}${c.nullable === 'False' ? ' NOT NULL' : ''}`);
    if (table.primaryKey.length) lines.push(`  CONSTRAINT ${quote(`pk_${table.name}`)} PRIMARY KEY (${table.primaryKey.map(quote).join(', ')})`);
    for (const u of table.uniques) lines.push(`  CONSTRAINT ${quote(u.name)} UNIQUE (${u.columns.map(quote).join(', ')})`);
    for (const ck of table.checks) lines.push(`  CONSTRAINT ${quote(ck.name)} CHECK (${ck.definition})`);
    for (const group of fkGroups(builder, table)) {
      const clause = `CONSTRAINT ${quote(group.id)} FOREIGN KEY (${group.pairs.map(([c]) => quote(c)).join(', ')}) REFERENCES ${qualified(group.target)} (${group.pairs.map(([, c]) => quote(c)).join(', ')})`;
      if (deferred.has(group.key) && dialect.deferredConstraints) laterConstraints.push(`ALTER TABLE ${qualified(table)} ADD ${clause};`);
      else lines.push(`  ${clause}`);
    }
    out.push(`CREATE TABLE ${qualified(table)} (\n${lines.join(',\n')}\n);`);
    for (const ix of table.indexes) {
      const where = ix.partial ? ` WHERE ${ix.where}` : '';
      out.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quote(ix.name)} ON ${qualified(table)} (${ix.columns.map(quote).join(', ')})${where};`);
    }
    out.push('');
  }
  out.push(...laterConstraints, ...(laterConstraints.length ? [''] : []));

  // Rows: parents first; deferred edges are NULL on insert and set by UPDATE afterwards.
  const rows = new Map();
  const updates = [];
  for (const table of order) {
    const count = seedRowCount(table);
    const groups = fkGroups(builder, table);
    const groupOf = new Map();
    for (const g of groups) for (const [c] of g.pairs) groupOf.set(c, g);
    const pkGroups = groups.filter(g => g.pairs.some(([c]) => table.primaryKey.includes(c)));
    const pkFromFks = table.primaryKey.length > 0 && table.primaryKey.every(c => groupOf.has(c));
    const uniqueGroups = new Set(groups.filter(g => table.uniques.some(u => u.columns.length === g.pairs.length && g.pairs.every(([c]) => u.columns.includes(c)))));
    const insertColumns = table.columns.filter(c => c.pk || groupOf.has(c) || groupOf.has(c.name) || c.nullable === 'False');
    const tableRows = [];
    for (let i = 0; i < count; i++) {
      const row = {};
      const parentIndex = new Map();
      let radix = i;
      for (const g of groups) {
        if (g.target === table) { parentIndex.set(g, i === 0 ? null : Math.floor(((i - 1) * 7919) % i)); continue; }
        const parentRows = rows.get(g.target.id) || [];
        if (deferred.has(g.key)) { const later = seedRowCount(g.target); parentIndex.set(g, later > 0 ? i % later : null); continue; }
        if (!parentRows.length) {
          if (g.pairs.some(([c]) => builder.columnOf(table, c).nullable === 'False')) throw new Error(`${table.id}: NOT NULL FK ${g.id} references empty ${g.target.id}`);
          parentIndex.set(g, null); continue;
        }
        if (pkFromFks && pkGroups.includes(g)) { parentIndex.set(g, radix % parentRows.length); radix = Math.floor(radix / parentRows.length); }
        else if (uniqueGroups.has(g)) { if (i >= parentRows.length) throw new Error(`${table.id}: one-to-one seed exceeds ${g.target.id}`); parentIndex.set(g, i); }
        else parentIndex.set(g, (i * 7 + groups.indexOf(g) * 13) % parentRows.length);
      }
      if (pkFromFks && radix > 0) throw new Error(`${table.id}: composite key space exhausted at row ${i}`);
      for (const col of insertColumns) {
        const g = groupOf.get(col.name);
        if (g) {
          const idx = parentIndex.get(g);
          const targetCol = g.pairs.find(([c]) => c === col.name)[1];
          if (g.target === table) row[col.name] = idx === null ? null : tableRows[idx][targetCol];
          else if (idx === null) row[col.name] = null;
          else if (deferred.has(g.key)) { row[col.name] = null; updates.push({ table, i, col, value: () => rows.get(g.target.id)[idx][targetCol] }); }
          else row[col.name] = rows.get(g.target.id)[idx][targetCol];
        } else if (col.pk && table.primaryKey.length === 1 || col.name === 'id') {
          row[col.name] = col.type === 'UUID' ? uuidOf(`${table.id}.id.${i}`) : i + 1;
        } else row[col.name] = attributeValue(table, col, i, dialect);
      }
      tableRows.push(row);
    }
    rows.set(table.id, tableRows);
    if (!tableRows.length) { out.push(`-- ${qualified(table)}: rowCount 0, no rows seeded.`, ''); continue; }
    const names = insertColumns.map(c => quote(c.name)).join(', ');
    for (let start = 0; start < tableRows.length; start += 100) {
      const chunk = tableRows.slice(start, start + 100).map(r => `(${insertColumns.map(c => { const v = r[c.name]; return v && typeof v === 'object' && 'raw' in v ? v.raw : literal(v); }).join(', ')})`);
      out.push(`INSERT INTO ${qualified(table)} (${names}) VALUES\n${chunk.join(',\n')};`);
    }
    out.push('');
  }
  for (const u of updates) {
    const row = rows.get(u.table.id)[u.i];
    const where = u.table.primaryKey.map(c => `${quote(c)} = ${literal(row[c])}`).join(' AND ');
    out.push(`UPDATE ${qualified(u.table)} SET ${quote(u.col.name)} = ${literal(u.value())} WHERE ${where};`);
  }
  if (updates.length) out.push('');
  out.push(...dialect.footer, '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------
// Hand-shaped fixtures (small, edge-cases, hostile, empty, contract cases)
// ---------------------------------------------------------------------------------------

const basisText = variant => `Synthetic fixture "${variant}" generated by scripts/generate-fixtures.mjs from word lists and a seeded PRNG. Entity classifications are curated in the generator, not inferred. No live database or customer schema was inspected.`;

export function buildSmall() {
  const b = new GraphBuilder(new Rng(11));
  const t = (schema, name, domain, type, columns, pk, extra = {}) => {
    const table = b.addTable({ schema, name, domain, type, role: 'hand', columns, ...extra });
    b.setPrimaryKey(table, pk);
    return table;
  };
  const organizations = t('accounts', 'organizations', 'Accounts', TYPES.CORE, [column('id', 'Integer', false), column('name', 'String(200)', false), column('primary_contact_id', 'Integer', true), column('created_at', 'DateTime', false)], ['id']);
  const contacts = t('accounts', 'contacts', 'Accounts', TYPES.CORE, [column('id', 'Integer', false), column('organization_id', 'Integer', false), column('email', 'String(255)', false), column('display_name', 'String(120)', false), column('phone', 'String(32)', true)], ['id']);
  const addresses = t('accounts', 'addresses', 'Accounts', TYPES.ASSOCIATION, [column('id', 'Integer', false), column('contact_id', 'Integer', false), column('line1', 'String(255)', false), column('city', 'String(120)', true), column('country_code', 'String(2)', false)], ['id']);
  const catalogs = t('reference', 'catalogs', 'Reference', TYPES.REFERENCE, [column('id', 'Integer', false), column('code', 'String(32)', false), column('label', 'String(120)', false)], ['id']);
  const products = t('reference', 'products', 'Reference', TYPES.REFERENCE, [column('catalog_id', 'Integer', false), column('sku', 'String(64)', false), column('title', 'String(255)', false), column('unit_price', 'Numeric(12,2)', false), column('is_active', 'Boolean', false)], ['catalog_id', 'sku']);
  const currencies = t('reference', 'currencies', 'Reference', TYPES.REFERENCE, [column('code', 'String(3)', false), column('label', 'String(120)', false), column('minor_units', 'SmallInteger', false)], ['code']);
  const tags = t('reference', 'tags', 'Reference', TYPES.REFERENCE, [column('id', 'Integer', false), column('code', 'String(32)', false), column('label', 'String(120)', false)], ['id']);
  const orders = t('sales', 'orders', 'Sales', TYPES.TRANSACTION, [column('id', 'BigInteger', false), column('organization_id', 'Integer', false), column('currency_code', 'String(3)', false), column('status', 'String(32)', false), column('total', 'Numeric(14,2)', false), column('placed_at', 'DateTime', false), column('notes', 'Text', true)], ['id']);
  const orderLines = t('sales', 'order_lines', 'Sales', TYPES.TRANSACTION, [column('order_id', 'BigInteger', false), column('line_no', 'Integer', false), column('catalog_id', 'Integer', false), column('sku', 'String(64)', false), column('quantity', 'Integer', false), column('unit_price', 'Numeric(12,2)', false)], ['order_id', 'line_no']);
  const invoices = t('sales', 'invoices', 'Sales', TYPES.TRANSACTION, [column('id', 'BigInteger', false), column('order_id', 'BigInteger', false), column('contact_id', 'Integer', true), column('issued_on', 'Date', false), column('amount', 'Numeric(14,2)', false), column('status', 'String(32)', false)], ['id']);
  const payments = t('sales', 'payments', 'Sales', TYPES.TRANSACTION, [column('id', 'BigInteger', false), column('invoice_id', 'BigInteger', false), column('amount', 'Numeric(14,2)', false), column('received_at', 'DateTime', false), column('reference', 'String(64)', true)], ['id']);
  const orderTags = t('sales', 'order_tags', 'Sales', TYPES.ASSOCIATION, [column('order_id', 'BigInteger', false), column('tag_id', 'Integer', false), column('created_at', 'DateTime', false)], ['order_id', 'tag_id']);

  b.addUnique(contacts, ['email']); b.addUnique(catalogs, ['code']); b.addUnique(tags, ['code']);
  b.addIndex(orders, ['status', 'placed_at']); b.addIndex(invoices, ['issued_on']);
  b.addCheck(orderLines, 'quantity'); b.addCheck(payments, 'amount');
  // The cycle: organizations -> contacts -> organizations.
  b.declare(organizations, [['primary_contact_id', 'id']], contacts, { constraintId: 'fk_organizations_primary_contact' });
  b.declare(contacts, [['organization_id', 'id']], organizations, { constraintId: 'fk_contacts_organization', ondelete: 'CASCADE' });
  b.declare(addresses, [['contact_id', 'id']], contacts);
  b.declare(products, [['catalog_id', 'id']], catalogs, { indexed: false });
  b.declare(orders, [['organization_id', 'id']], organizations);
  b.declare(orders, [['currency_code', 'code']], currencies, { indexed: false });
  b.declare(orderLines, [['order_id', 'id']], orders, { indexed: false });
  // The composite FK: two column pairs sharing one constraintId.
  b.declare(orderLines, [['catalog_id', 'catalog_id'], ['sku', 'sku']], products, { constraintId: 'fk_order_lines_product' });
  b.declare(invoices, [['order_id', 'id']], orders);
  b.declare(payments, [['invoice_id', 'id']], invoices);
  b.declare(orderTags, [['order_id', 'id']], orders, { indexed: false });
  b.declare(orderTags, [['tag_id', 'id']], tags);
  b.infer(invoices, 'contact_id', contacts.id);
  return b.toGraph({ key: 'small-sqlite', name: 'Small Fixture', dialect: 'sqlite', basis: basisText('small'), variant: 'small' });
}

export function buildEdgeCases() {
  const b = new GraphBuilder(new Rng(13));
  const sixty = 'a_sixty_character_identifier_used_to_probe_layout_limits_xyz';
  if (sixty.length !== 60) throw new Error(`identifier length ${sixty.length}`);
  const sixtyCol = 'column_with_exactly_sixty_characters_in_its_identifier_abcde';
  if (sixtyCol.length !== 60) throw new Error(`column length ${sixtyCol.length}`);
  const add = (schema, name, domain, type, columns, pk, extra = {}) => { const table = b.addTable({ schema, name, domain, type, role: 'hand', columns, ...extra }); b.setPrimaryKey(table, pk); return table; };

  add('solo', 'heartbeats', 'Solo', TYPES.AUDIT, [column('id', 'Integer', false), column('observed_at', 'DateTime', false)], ['id']);
  add('core', 'sequence_anchors', 'Core', TYPES.REFERENCE, [column('id', 'Integer', false)], ['id']);
  const long = add('core', sixty, 'Core', TYPES.TRANSACTION, [column('id', 'Integer', false), column(sixtyCol, 'Text', true), column('status', 'String(32)', '')], ['id']);
  b.addIndex(long, [sixtyCol]);
  const unicode = add('core', 'übersicht_kunden', 'Core', TYPES.CORE, [column('id', 'Integer', false), column('straße', 'String(255)', true), column('都市', 'String(120)', ''), column('ciudad_señalada', 'String(120)', false), column('Ελληνικά', 'Text', true)], ['id']);
  b.addUnique(unicode, ['ciudad_señalada']);
  const salesEvents = add('sales', 'events', 'Sales', TYPES.TRANSACTION, [column('id', 'BigInteger', false), column('customer_id', 'Integer', false), column('legacy_customer_id', 'Integer', true), column('payload', 'JSONB', ''), column('occurred_at', 'DateTime', false)], ['id']);
  const auditEvents = add('audit', 'events', 'Audit', TYPES.AUDIT, [column('id', 'BigInteger', false), column('actor', 'String(120)', ''), column('action', 'String(64)', false), column('recorded_at', 'DateTime', false)], ['id']);
  b.addIndex(auditEvents, ['recorded_at']);
  const noPk = add('audit', 'raw_imports', 'Audit', TYPES.AUDIT, [column('batch_id', 'String(64)', false), column('line', 'Text', ''), column('imported_at', 'DateTime', false), column('checksum', 'Unknown', '')], []);
  b.addIndex(noPk, ['batch_id']);
  b.declare(salesEvents, [['customer_id', 'id']], unicode, { constraintId: 'fk_sales_events_customer' });
  // Unresolved inferred target: the referenced table is not in scope.
  b.infer(salesEvents, 'legacy_customer_id', 'legacy.customers');
  b.infer(auditEvents, 'id', salesEvents.id);
  const graph = b.toGraph({ key: 'edge-cases', name: 'Edge Cases', dialect: 'postgresql', basis: basisText('edge-cases'), variant: 'edge-cases' });
  // Legacy null nullability: accepted by normalize() and parseSchemaSnapshot alike.
  graph.tables.find(t => t.id === 'audit.events').allColumns[1].nullable = null;
  return graph;
}

export function buildHostile() {
  const b = new GraphBuilder(new Rng(17));
  const img = '<img src=x onerror=alert(1)>';
  const js = 'javascript:alert(document.domain)';
  const long120 = 'x'.repeat(100) + '_twenty_more_chars__';
  if (long120.length !== 120) throw new Error(`hostile identifier length ${long120.length}`);
  const add = (schema, name, domain, type, columns, pk, extra = {}) => { const table = b.addTable({ schema, name, domain, type, role: 'hand', columns, ...extra }); b.setPrimaryKey(table, pk); return table; };

  const markup = add('hostile', img, '__proto__', 'constructor', [
    column('id', 'Integer', false),
    column('__proto__', 'Text', true),
    column("=cmd|' /C calc'!A0", 'String(64)', true),
    column('+SUM(1)', 'Integer', true),
    column('-1+1', 'Integer', ''),
    column('@import', 'Text', true),
    column('"quoted" \\backslash', 'Text', true),
    column(js, 'String(2048)', true),
    column('<svg onload=alert(1)>', 'String(64)', ''),
    column('</script><script>alert(1)</script>', 'Text', true),
    column(long120, 'Text', true),
    column('constructor', 'JSONB', true),
  ], ['id']);
  markup.className = '</script><script>alert(1)</script>__ICON_DATA__ __SCHEMA_DATA__';
  markup.file = js;
  markup.indexes.push({ name: '</style><style>body{display:none}</style>', columns: ['+SUM(1)'], unique: false });
  markup.uniques.push({ name: '=HYPERLINK("http://example.invalid","click")', columns: ['-1+1'] });
  markup.checks.push({ name: 'ck_injection', definition: "1=1; DROP TABLE users; --" });
  const proto = add('hostile', 'constructor', 'toString', 'hasOwnProperty', [column('id', 'Integer', false), column('valueOf', 'Text', true), column('__defineGetter__', 'Text', true)], ['id']);
  const longTable = add('hostile', long120, '__proto__', TYPES.TRANSACTION, [column('id', 'Integer', false), column('owner_id', 'Integer', true), column('proto_id', 'Integer', true), column("O'Brien \\ \"Quote\"", 'Text', '')], ['id']);
  const view = add('hostile', 'v_<b>bold</b>', 'toString', TYPES.VIEW, [column('id', 'Integer', false), column('label', 'Text', true)], [], { kind: 'view', definition: `</script>${img}<style>*{display:none}</style>` });
  view.file = js;
  b.declare(longTable, [['owner_id', 'id']], markup, { constraintId: `fk_<b>bold</b>_${img}`, ondelete: `'; DROP TABLE x; --` });
  b.declare(longTable, [['proto_id', 'id']], proto, { constraintId: '__proto__' });
  b.infer(view, 'id', markup.id);
  const graph = b.toGraph({ key: 'hostile', name: `${img} Hostile "Fixture" \\ =cmd|' /C calc'!A0`, dialect: 'postgresql', basis: `${js} =cmd|' /C calc'!A0 +SUM(1) ${img} </script><script>alert(1)</script>`, variant: 'hostile' });
  graph.source.file = js;
  graph.source.commit = '=1+1';
  graph.tables.find(t => t.id === markup.id).allColumns[1].typeBasis = `${img} typeBasis`;
  return graph;
}

export const buildEmpty = () => ({
  project: { name: 'Empty Fixture', key: 'empty', dialect: 'postgresql' },
  source: { file: SOURCE_FILE, commit: 'synthetic-empty', sha256: createHash('sha256').update('empty').digest('hex'), generated: GENERATED_AT, basis: basisText('empty') },
  tables: [],
  links: [],
});

/** The three builders both contract corpora share, so a case added to either reads the same. */
function contractHelpers() {
  const base = (key, tables, links = [], extra = {}) => ({ project: { name: `Contract ${key}`, key, dialect: 'postgresql' }, source: { file: SOURCE_FILE, commit: 'synthetic-contract', sha256: 'not-recorded', generated: GENERATED_AT, basis: basisText(`contract/${key}`) }, tables, links, ...extra });
  const col = (name, type = 'Integer', extra = {}) => ({ name, type, pk: false, fk: '', nullable: 'False', index: false, unique: false, ...extra });
  const tbl = (id, columns, extra = {}) => { const [schema, name] = id.split('.'); return { id, schema, name, className: classNameOf(name), domain: 'Contract', type: TYPES.CORE, file: SOURCE_FILE, line: 1, pk: '', primaryKey: [], allColumns: columns, indexes: [], uniques: [], checks: [], ...extra }; };
  return { base, col, tbl };
}

/**
 * Contract cases: five valid graphs and six invalid ones with the normalize() error substring.
 *
 * An invalid case records what each validation stage says about it, and carries at least one of:
 *
 * - `$expectedError`: a fragment of the message `normalize()` raises, the semantic oracle's words.
 * - `$structuralError`: the instance path the JSON Schema stage reports, which prefixes its
 *   message as `<instance path>: <message>`. The path is recorded rather than the message so the
 *   corpus does not break when `jsonschema` rephrases one.
 *
 * A validator that runs the schema first and `normalize()` second therefore reports
 * `$structuralError` when it is present, and `$expectedError` otherwise.
 */
export function buildContractCases() {
  const { base, col, tbl } = contractHelpers();
  const valid = {
    'composite-primary-key': base('composite-primary-key', [tbl('w.items', [col('tenant_id', 'Integer', { pk: true }), col('id', 'Integer', { pk: true }), col('label', 'Text')], { pk: 'tenant_id, id', primaryKey: ['tenant_id', 'id'] })]),
    'composite-fk-group': base('composite-fk-group', [
      tbl('w.items', [col('tenant_id', 'Integer', { pk: true }), col('id', 'Integer', { pk: true })], { pk: 'tenant_id, id', primaryKey: ['tenant_id', 'id'] }),
      tbl('w.moves', [col('id', 'Integer', { pk: true }), col('tenant_id'), col('item_id')], { pk: 'id', primaryKey: ['id'] }),
    ], [
      { source: 'w.moves', column: 'tenant_id', target: 'w.items', targetColumn: 'tenant_id', kind: 'declared FK', constraintId: 'fk_moves_item' },
      { source: 'w.moves', column: 'item_id', target: 'w.items', targetColumn: 'id', kind: 'declared FK', constraintId: 'fk_moves_item' },
    ]),
    'legacy-flags': base('legacy-flags', [tbl('w.legacy', [
      { name: 'id', type: 'Integer', pk: 'True', nullable: 'False', index: 'False', unique: 'False' },
      { name: 'code', type: 'Text', pk: 'False', nullable: null, index: 'True', unique: 'True' },
      { name: 'note', type: 'Text', nullable: null },
    ], { pk: 'id', primaryKey: ['id'] })]),
    'view-with-definition': base('view-with-definition', [
      tbl('w.orders', [col('id', 'Integer', { pk: true }), col('total', 'Numeric(12,2)')], { pk: 'id', primaryKey: ['id'] }),
      tbl('w.v_order_totals', [col('id'), col('total', 'Numeric(12,2)')], { kind: 'view', type: TYPES.VIEW, definition: 'SELECT id, total FROM w.orders' }),
    ]),
    'external-stub': base('external-stub', [
      tbl('w.orders', [col('id', 'Integer', { pk: true }), col('customer_id')], { pk: 'id', primaryKey: ['id'] }),
      tbl('crm.customers', [col('id', 'Integer', { pk: true })], { pk: 'id', primaryKey: ['id'], type: 'External stub', domain: 'External', stub: true }),
    ], [{ source: 'w.orders', column: 'customer_id', target: 'crm.customers', targetColumn: 'id', kind: 'declared FK', constraintId: 'fk_orders_customer' }]),
  };
  const oneTable = [tbl('w.items', [col('id', 'Integer', { pk: true })], { pk: 'id', primaryKey: ['id'] })];
  const invalid = {
    'missing-project-key': { ...base('x', oneTable), project: { name: 'No key', dialect: 'postgresql' }, $expectedError: 'project.name and a stable lowercase project.key are required', $structuralError: 'project' },
    'uppercase-project-key': { ...base('Upper-Case', oneTable), $expectedError: 'project.name and a stable lowercase project.key are required', $structuralError: 'project/key' },
    'duplicate-table-id': { ...base('duplicate-table-id', [...oneTable, tbl('w.items', [col('id')])]), $expectedError: 'Each table needs a unique nonempty string id' },
    'duplicate-column-name': { ...base('duplicate-column-name', [tbl('w.items', [col('id', 'Integer', { pk: true }), col('id', 'Text')], { pk: 'id', primaryKey: ['id'] })]), $expectedError: 'duplicate or invalid column name' },
    'unresolved-declared-fk': { ...base('unresolved-declared-fk', [tbl('w.moves', [col('id', 'Integer', { pk: true }), col('item_id')], { pk: 'id', primaryKey: ['id'] })], [{ source: 'w.moves', column: 'item_id', target: 'w.items', targetColumn: 'id', kind: 'declared FK' }]), $expectedError: 'Unresolved declared FK target: w.items.id' },
    'link-kind-fk': { ...base('link-kind-fk', [...oneTable, tbl('w.moves', [col('id', 'Integer', { pk: true }), col('item_id')], { pk: 'id', primaryKey: ['id'] })], [{ source: 'w.moves', column: 'item_id', target: 'w.items', targetColumn: 'id', kind: 'fk' }]), $expectedError: 'Relationship kind must distinguish declared FK from inferred by naming', $structuralError: 'links/0/kind' },
  };
  return { valid, invalid };
}

/**
 * Contract v1 cases (work package C01) for the fields Part B2 promoted: `contractVersion`,
 * `profiling.status`, `rowCountLowerBound`, `sampleValues` and the integer `line`. They live in
 * their own corpus directory because they exercise the JSON Schema's structural rules, while
 * `contract/{valid,invalid}` exercises the semantic rules of `normalize()`. Both validators walk
 * both trees. The `$expectedError` and `$structuralError` fields mean what they mean in
 * `buildContractCases()` above.
 */
export function buildContractV1Cases() {
  const { base, col, tbl } = contractHelpers();
  const oneTable = [tbl('w.items', [col('id', 'Integer', { pk: true })], { pk: 'id', primaryKey: ['id'] })];
  const sampled = { sampleSize: 4, sampled: true, scope: 'sampled' };
  const valid = {
    'contract-version-1-1': {
      ...base('contract-version-1-1', [tbl('w.items', [col('id', 'Integer', { pk: true })], { pk: 'id', primaryKey: ['id'], futureTableField: 'A v1.0 reader ignores this field.' })]),
      contractVersion: '1.1',
      futureGraphField: { note: 'A v1.0 reader ignores this field.' },
    },
    'profiling-status-incomplete': base('profiling-status-incomplete', [
      tbl('w.events', [
        col('id', 'Integer', { pk: true }),
        col('payload', 'Text', { nullable: '', profiling: { nullFraction: 0.25, distinctCount: 3, min: 'alpha', max: 'gamma', ...sampled } }),
      ], { pk: 'id', primaryKey: ['id'], rowCount: null, rowCountLowerBound: 4, sampleSize: 4, sampled: true, profiling: { status: 'incomplete', reason: 'The per-table time budget was reached before the remaining columns were read.', ...sampled } }),
      tbl('w.audit', [col('id', 'Integer', { pk: true })], { pk: 'id', primaryKey: ['id'], rowCount: 0, rowCountExact: true, sampleSize: 0, sampled: true, profiling: { status: 'complete', sampleSize: 0, sampled: true, scope: 'sampled' } }),
    ]),
    'sample-values-three': base('sample-values-three', [tbl('w.labels', [
      col('id', 'Integer', { pk: true }),
      col('code', 'Text', { profiling: { distinctCount: 3, sampleSize: 3, sampled: true, scope: 'sampled', sampleValues: ['alpha', 'beta', 'gamma'] } }),
      col('score', 'Integer', { sampleValues: [1, 2, 3] }),
    ], { pk: 'id', primaryKey: ['id'], rowCount: 3, rowCountExact: true, sampleSize: 3, sampled: true })]),
  };
  const invalid = {
    'contract-version-2-0': { ...base('contract-version-2-0', oneTable), contractVersion: '2.0', $expectedError: 'contractVersion 2.0 is not compatible with contract version 1.0', $structuralError: 'contractVersion' },
    'line-as-string': { ...base('line-as-string', [tbl('w.items', [col('id', 'Integer', { pk: true })], { pk: 'id', primaryKey: ['id'], line: '12' })]), $expectedError: 'line must be a non-negative integer', $structuralError: 'tables/0/line' },
    'sample-values-four': { ...base('sample-values-four', [tbl('w.items', [col('id', 'Integer', { pk: true, profiling: { ...sampled, sampleValues: [1, 2, 3, 4] } })], { pk: 'id', primaryKey: ['id'] })]), $structuralError: 'tables/0/allColumns/0/profiling/sampleValues' },
    'negative-row-count-lower-bound': { ...base('negative-row-count-lower-bound', [tbl('w.items', [col('id', 'Integer', { pk: true })], { pk: 'id', primaryKey: ['id'], rowCount: null, rowCountLowerBound: -1 })]), $structuralError: 'tables/0/rowCountLowerBound' },
  };
  return { valid, invalid };
}

// ---------------------------------------------------------------------------------------
// Fixture set
// ---------------------------------------------------------------------------------------

const MEDIUM_LAYOUT = {
  seed: 20260101,
  tablesPerDomain: [20, 20, 20, 20, 19, 19, 19, 18],
  columnScale: 1,
  extras: {
    junctionDomains: [0, 1, 5, 6],
    noPkDomains: [2, 3, 4, 7],
    tenantScoped: [[1, 4], [2, 4], [4, 4]],
    scc: [[2, 0], [4, 0], [3, 1]],
    selfRef: [1, 0],
    oneToOne: [0, 13],
    partialIndexes: [[5, 4], [7, 6]],
    views: [[6, 5], [6, 6], [4, 5], [2, 6], [5, 4]],
    inferredEvery: 0.06,
  },
};

const mediumBuilder = () => synthesize(MEDIUM_LAYOUT);

export function buildFixtureSet({ large = false } = {}) {
  const medium = mediumBuilder().toGraph({ key: 'medium', name: 'Medium Fixture', dialect: 'postgresql', basis: basisText('medium'), variant: 'medium' });
  const measuredBuilder = mediumBuilder();
  measure(measuredBuilder, 424242);
  const measured = measuredBuilder.toGraph({ key: 'medium-measured', name: 'Medium Fixture (measured)', dialect: 'postgresql', basis: `${basisText('medium-measured')} Row counts and column statistics are synthetic measurements attached for testing; absent values are unknown, not zero.`, variant: 'medium-measured' });
  const manyDomains = synthesize({ seed: 7, tablesPerDomain: [5, 4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 4, 4], columnScale: 0.7, extras: { junctionDomains: [0], inferredEvery: 0.2 } })
    .toGraph({ key: 'many-domains', name: 'Many Domains Fixture', dialect: 'postgresql', basis: basisText('many-domains'), variant: 'many-domains' });
  const contract = buildContractCases();
  const files = {
    'schemas/small.json': buildSmall(),
    'schemas/medium.json': medium,
    'schemas/medium-measured.json': measured,
    'schemas/edge-cases.json': buildEdgeCases(),
    'schemas/many-domains.json': manyDomains,
    'schemas/hostile.json': buildHostile(),
    'schemas/empty.json': buildEmpty(),
  };
  for (const [name, graph] of Object.entries(contract.valid)) files[`contract/valid/${name}.json`] = graph;
  for (const [name, graph] of Object.entries(contract.invalid)) files[`contract/invalid/${name}.json`] = graph;
  const contractV1 = buildContractV1Cases();
  for (const [name, graph] of Object.entries(contractV1.valid)) files[`contract/v1/valid/${name}.json`] = graph;
  for (const [name, graph] of Object.entries(contractV1.invalid)) files[`contract/v1/invalid/${name}.json`] = graph;
  const text = Object.fromEntries(Object.entries(files).map(([path, graph]) => [path, JSON.stringify(graph, null, 2) + '\n']));
  text['sql/pg/seed.sql'] = seedSql(measuredBuilder, 'postgresql', 'medium-measured');
  text['sql/sqlite/seed.sql'] = seedSql(measuredBuilder, 'sqlite', 'medium-measured');
  if (large) {
    const counts = Array.from({ length: 14 }, (_, i) => (i < 10 ? 86 : 85));
    const graph = synthesize({ seed: 99, tablesPerDomain: counts, columnScale: 0.82, extras: { junctionDomains: [0, 3, 7, 11], inferredEvery: 0.1, noPkDomains: [2, 9] } })
      .toGraph({ key: 'large', name: 'Large Fixture', dialect: 'postgresql', basis: basisText('large'), variant: 'large' });
    text['schemas/large.json'] = JSON.stringify(graph) + '\n';
  }
  return text;
}

export function writeFixtures(outDir, options = {}) {
  const written = [];
  for (const [rel, content] of Object.entries(buildFixtureSet(options))) {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    written.push({ path: rel, bytes: statSync(path).size });
  }
  return written;
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let outDir = join(root, 'fixtures'), large = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outDir = resolve(argv[++i]);
    else if (argv[i] === '--large') large = true;
    else { console.error(`Unknown argument ${argv[i]}. Usage: node scripts/generate-fixtures.mjs [--out <dir>] [--large]`); process.exit(2); }
  }
  const written = writeFixtures(outDir, { large });
  const cap = 2 * 1024 * 1024;
  for (const { path, bytes } of written) {
    const flag = bytes > cap ? (path === 'schemas/large.json' ? '  (git-ignored: above the 2 MB cap)' : '  EXCEEDS 2 MB CAP') : '';
    console.log(`${String(bytes).padStart(9)} bytes  ${path}${flag}`);
  }
  const oversize = written.filter(w => w.bytes > cap && w.path !== 'schemas/large.json');
  if (oversize.length) { console.error(`${oversize.length} committed fixture(s) exceed the 2 MB cap.`); process.exit(1); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));
