/**
 * SQLite schema. Twin of schema-pg.ts — table and column names must stay
 * identical; only the dialect-specific column builders differ. Both schemas
 * stay within the SQLite∩Postgres subset: text, integer, plain indexes.
 *
 * Portability conventions:
 * - ids: uuid strings
 * - timestamps: ISO-8601 text
 * - booleans: integer 0/1
 * - EAV values: text, cast on read per the property's declared datatype
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const accessKeys = sqliteTable(
  "access_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    keyHash: text("key_hash").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("access_keys_key_hash_idx").on(t.keyHash)],
);

export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  keywords: text("keywords").notNull().default(""),
  context: text("context").notNull().default(""),
  personal: integer("personal").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(), // 'space' | 'bundle'
    resourceId: text("resource_id").notNull(),
    capability: text("capability").notNull(),
    effect: text("effect").notNull(), // 'allow' | 'deny'
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("grants_lookup_idx").on(t.userId, t.resourceId, t.capability)],
);

export const bundles = sqliteTable("bundles", {
  id: text("id").primaryKey(),
  spaceId: text("space_id")
    .notNull()
    .references(() => spaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  docs: text("docs").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const itemTypes = sqliteTable("item_types", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundles.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const properties = sqliteTable("properties", {
  id: text("id").primaryKey(),
  itemTypeId: text("item_type_id")
    .notNull()
    .references(() => itemTypes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  datatype: text("datatype").notNull(), // 'text' | 'number' | 'boolean' | 'date'
  required: integer("required").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundles.id, { onDelete: "cascade" }),
  itemTypeId: text("item_type_id")
    .notNull()
    .references(() => itemTypes.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const itemValues = sqliteTable(
  "item_values",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    propertyId: text("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
  },
  (t) => [
    index("item_values_prop_value_idx").on(t.propertyId, t.value),
    index("item_values_item_idx").on(t.itemId),
  ],
);

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundles.id, { onDelete: "cascade" }),
  spaceId: text("space_id").notNull(),
  ownerId: text("owner_id").notNull(),
  status: text("status").notNull(), // 'reserved' | 'finalized'
  name: text("name").notNull().default(""),
  mimeType: text("mime_type").notNull().default(""),
  size: integer("size").notNull().default(0),
  storageKey: text("storage_key").notNull(),
  uploadConsumed: integer("upload_consumed").notNull().default(0),
  createdAt: text("created_at").notNull(),
  finalizedAt: text("finalized_at"),
});

export const hooks = sqliteTable("hooks", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundles.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  params: text("params").notNull().default("[]"), // JSON: declared parameter specs
  transportEncrypted: text("transport_encrypted").notNull(), // AES-GCM blob, never returned
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const userDocs = sqliteTable("user_docs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull().default(""),
  autoload: integer("autoload").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
