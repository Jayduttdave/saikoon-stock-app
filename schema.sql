-- Run this in the Supabase SQL Editor (https://app.supabase.com → your project → SQL Editor)
-- before deploying to Render.

-- Stock quantities per product
CREATE TABLE IF NOT EXISTS stock (
    product_id TEXT PRIMARY KEY,
    quantity   INTEGER NOT NULL DEFAULT 0
);

-- History of stock changes (append-only)
CREATE TABLE IF NOT EXISTS history (
    id             BIGSERIAL PRIMARY KEY,
    product_id     TEXT    NOT NULL,
    product_name   TEXT    NOT NULL,
    supplier       TEXT    NOT NULL,
    previous_stock INTEGER NOT NULL,
    new_stock      INTEGER NOT NULL,
    updated_at     TEXT    NOT NULL
);

-- Dismissed low-stock alerts (product_id → stock value at dismiss time)
CREATE TABLE IF NOT EXISTS alerts_dismissed (
    product_id     TEXT    PRIMARY KEY,
    dismissed_stock INTEGER NOT NULL
);

-- Manually added products (not from the Excel catalog)
CREATE TABLE IF NOT EXISTS custom_products (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    supplier TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    image    TEXT NOT NULL DEFAULT 'images/no_image.png'
);

-- Products hidden/deleted by the user
CREATE TABLE IF NOT EXISTS deleted_products (
    product_id TEXT PRIMARY KEY
);
