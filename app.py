from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import unicodedata
from io import BytesIO
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, cast
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd
from flask import Flask, abort, jsonify, render_template, request, send_file, send_from_directory
from openpyxl import load_workbook
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


BASE_DIR = Path(__file__).resolve().parent
try:
    _sb_create_client = __import__("supabase").create_client
    _SUPABASE_LIB = True
except ImportError:
    _sb_create_client = None
    _SUPABASE_LIB = False

DATA_DIR = Path(os.environ.get("APP_DATA_DIR", str(BASE_DIR / "data")))
STATIC_DIR = BASE_DIR / "static"
IMAGES_DIR = STATIC_DIR / "images"
STATIC_UPLOADS_DIR = IMAGES_DIR / "uploads"
UPLOADS_DIR = DATA_DIR / "uploads"
UPLOAD_MEDIA_PREFIX = "media/uploads/"
SUPABASE_STORAGE_BUCKET = os.environ.get("SUPABASE_STORAGE_BUCKET", "product-images")
EXCEL_PATH = DATA_DIR / "products.xlsx"
STOCK_PATH = DATA_DIR / "stock.json"
HISTORY_PATH = DATA_DIR / "history.json"
ALERTS_PATH = DATA_DIR / "alerts_dismissed.json"
CUSTOM_PRODUCTS_PATH = DATA_DIR / "custom_products.json"
DELETED_PRODUCTS_PATH = DATA_DIR / "deleted_products.json"
ORDERS_PATH = DATA_DIR / "orders.json"
PLACEHOLDER_IMAGE = "images/no_image.png"
LOW_STOCK_THRESHOLD = 5
REORDER_THRESHOLD = 3
APP_TIMEZONE_NAME = os.environ.get("APP_TIMEZONE", "Europe/Paris")
try:
    APP_TIMEZONE = ZoneInfo(APP_TIMEZONE_NAME)
except ZoneInfoNotFoundError:
    APP_TIMEZONE = timezone.utc

PRODUCT_NAME_KEYS = {"product_name", "nom_produit", "nomproduit", "name", "product"}
IMAGE_KEYS = {"image", "photo_produit", "photoproduit", "image_path", "image_filename"}
CATEGORY_KEYS = {"category", "categorie"}
SUPPLIER_KEYS = {"supplier", "fournisseur"}

app = Flask(__name__)
# ── Supabase / persistent-DB layer (optional) ────────────────────────────────
# Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars on Render to enable DB
# storage.  Falls back to local JSON files when the vars are absent (local dev).
SUPABASE_URL: str = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY: str = os.environ.get("SUPABASE_SERVICE_KEY", "")
USE_DB: bool = bool(_SUPABASE_LIB and SUPABASE_URL and SUPABASE_KEY)
_sb_client: Any = None



def local_now() -> datetime:
    return datetime.now(APP_TIMEZONE)


def normalize_header(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def slugify(value: str) -> str:
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-") or "product"


def ensure_data_files() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    # Seed catalog Excel into persistent data dir on first boot (Render disk).
    seed_excel = BASE_DIR / "data" / "products.xlsx"
    if not EXCEL_PATH.exists() and seed_excel.exists():
        shutil.copy2(seed_excel, EXCEL_PATH)

    seed_uploads_dir = BASE_DIR / "data" / "uploads"
    if seed_uploads_dir.exists():
        for seed_file in seed_uploads_dir.iterdir():
            if not seed_file.is_file():
                continue
            target_file = UPLOADS_DIR / seed_file.name
            if not target_file.exists():
                shutil.copy2(seed_file, target_file)

    if not STOCK_PATH.exists():
        STOCK_PATH.write_text("{}\n", encoding="utf-8")

    if not HISTORY_PATH.exists():
        HISTORY_PATH.write_text("[]\n", encoding="utf-8")

    if not ALERTS_PATH.exists():
        ALERTS_PATH.write_text("{}\n", encoding="utf-8")

    if not CUSTOM_PRODUCTS_PATH.exists():
        CUSTOM_PRODUCTS_PATH.write_text("[]\n", encoding="utf-8")

    if not DELETED_PRODUCTS_PATH.exists():
        DELETED_PRODUCTS_PATH.write_text("[]\n", encoding="utf-8")

    if not ORDERS_PATH.exists():
        ORDERS_PATH.write_text("[]\n", encoding="utf-8")


def ensure_static_assets() -> None:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    preferred_logo = BASE_DIR / "logo.png"
    fallback_logo = BASE_DIR / "Gestion Stock logo.png"
    root_logo = preferred_logo if preferred_logo.exists() else fallback_logo
    static_logo = IMAGES_DIR / "logo.png"
    if root_logo.exists():
        should_sync_logo = (
            not static_logo.exists()
            or root_logo.stat().st_size != static_logo.stat().st_size
            or root_logo.stat().st_mtime_ns != static_logo.stat().st_mtime_ns
        )
        if should_sync_logo:
            shutil.copy2(root_logo, static_logo)


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default

    try:
        with path.open("r", encoding="utf-8") as file:
            return json.load(file)
    except (json.JSONDecodeError, OSError):
        return default


def write_json(path: Path, payload: Any) -> None:
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def _get_sb() -> Any:
    """Return (or lazily create) the Supabase client."""
    global _sb_client
    if _sb_client is None:
        if _sb_create_client is None:
            raise RuntimeError("Supabase client library is not available.")
        _sb_client = _sb_create_client(SUPABASE_URL, SUPABASE_KEY)
    return _sb_client


def _storage_api_url(path: str) -> str:
    return f"{SUPABASE_URL.rstrip('/')}/storage/v1/{path.lstrip('/')}"


def ensure_supabase_storage_bucket() -> None:
    if not USE_DB or not SUPABASE_URL or not SUPABASE_KEY:
        return

    payload = json.dumps(
        {
            "id": SUPABASE_STORAGE_BUCKET,
            "name": SUPABASE_STORAGE_BUCKET,
            "public": True,
        }
    ).encode("utf-8")
    request_obj = Request(_storage_api_url("bucket"), data=payload, method="POST")
    request_obj.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    request_obj.add_header("apikey", SUPABASE_KEY)
    request_obj.add_header("Content-Type", "application/json")

    try:
        with urlopen(request_obj, timeout=20):
            return
    except HTTPError as exc:
        if exc.code not in {400, 409}:
            raise
    except URLError:
        return


def upload_file_to_supabase_storage(file_name: str, file_bytes: bytes, content_type: str) -> None:
    if not USE_DB or not SUPABASE_URL or not SUPABASE_KEY or not file_name:
        return

    ensure_supabase_storage_bucket()
    bucket_name = quote(SUPABASE_STORAGE_BUCKET, safe="")
    object_name = quote(file_name, safe="")
    request_obj = Request(_storage_api_url(f"object/{bucket_name}/{object_name}"), data=file_bytes, method="POST")
    request_obj.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    request_obj.add_header("apikey", SUPABASE_KEY)
    request_obj.add_header("Content-Type", content_type or "application/octet-stream")
    request_obj.add_header("x-upsert", "true")

    with urlopen(request_obj, timeout=20):
        return


def download_file_from_supabase_storage(file_name: str) -> bytes | None:
    if not USE_DB or not SUPABASE_URL or not file_name:
        return None

    bucket_name = quote(SUPABASE_STORAGE_BUCKET, safe="")
    object_name = quote(file_name, safe="")
    request_obj = Request(_storage_api_url(f"object/public/{bucket_name}/{object_name}"), method="GET")

    try:
        with urlopen(request_obj, timeout=20) as response:
            return response.read()
    except (HTTPError, URLError):
        return None


def cache_uploaded_file(file_name: str) -> Path | None:
    if not file_name:
        return None

    local_path = (UPLOADS_DIR / file_name).resolve()
    uploads_root = UPLOADS_DIR.resolve()
    if uploads_root in local_path.parents and local_path.exists():
        return local_path

    file_bytes = download_file_from_supabase_storage(file_name)
    if not file_bytes:
        return None

    try:
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(file_bytes)
    except OSError:
        return None

    return local_path if local_path.exists() else None


def delete_file_from_supabase_storage(file_name: str) -> None:
    if not USE_DB or not SUPABASE_URL or not SUPABASE_KEY or not file_name:
        return

    bucket_name = quote(SUPABASE_STORAGE_BUCKET, safe="")
    object_name = quote(file_name, safe="")
    request_obj = Request(_storage_api_url(f"object/{bucket_name}/{object_name}"), method="DELETE")
    request_obj.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    request_obj.add_header("apikey", SUPABASE_KEY)

    try:
        with urlopen(request_obj, timeout=20):
            return
    except (HTTPError, URLError):
        return


def _read_alerts() -> dict[str, int]:
    """Read the dismissed-alerts map from DB or local file."""
    if USE_DB:
        rows = _get_sb().table("alerts_dismissed").select("product_id,dismissed_stock").execute().data or []
        return {r["product_id"]: int(r["dismissed_stock"]) for r in rows}
    return read_json(ALERTS_PATH, {})


def resolve_image(image_value: Any) -> str:
    if image_value is None:
        return PLACEHOLDER_IMAGE

    try:
        if pd.isna(image_value):
            return PLACEHOLDER_IMAGE
    except TypeError:
        pass

    raw_value = str(image_value).strip().replace("\\", "/").lstrip("/")
    if not raw_value or raw_value.casefold() in {"nan", "none", "null"}:
        return PLACEHOLDER_IMAGE

    if raw_value.startswith(("http://", "https://")):
        return raw_value

    file_name = Path(raw_value).name
    upload_prefixes = (UPLOAD_MEDIA_PREFIX, "images/uploads/", "uploads/")
    if raw_value.startswith(upload_prefixes) and file_name:
        return f"{UPLOAD_MEDIA_PREFIX}{file_name}"

    candidates = [raw_value]
    if raw_value.startswith("static/"):
        candidates.append(raw_value.removeprefix("static/"))
    if file_name and not raw_value.startswith(upload_prefixes):
        candidates.extend([f"images/{file_name}", file_name])

    for candidate in candidates:
        relative_path = candidate.removeprefix("/")
        if (STATIC_DIR / relative_path).exists():
            return relative_path

    return PLACEHOLDER_IMAGE


def get_static_image_path(relative_path: str) -> Path:
    candidate = (STATIC_DIR / relative_path).resolve()
    static_root = STATIC_DIR.resolve()
    if static_root not in candidate.parents and candidate != static_root:
        return STATIC_DIR / PLACEHOLDER_IMAGE
    return candidate


def get_image_file_path(image_reference: str) -> Path:
    resolved_reference = resolve_image(image_reference)
    if resolved_reference.startswith(UPLOAD_MEDIA_PREFIX):
        file_name = Path(resolved_reference).name
        candidate = (UPLOADS_DIR / file_name).resolve()
        uploads_root = UPLOADS_DIR.resolve()
        if uploads_root in candidate.parents and candidate.exists():
            return candidate

        cached_path = cache_uploaded_file(file_name)
        if cached_path and cached_path.exists():
            return cached_path

        return get_static_image_path(PLACEHOLDER_IMAGE)
    return get_static_image_path(resolved_reference)


def delete_uploaded_image_file(image_reference: str) -> None:
    file_name = Path(str(image_reference or "").strip().replace("\\", "/")).name
    if not file_name:
        return

    for directory in (UPLOADS_DIR, STATIC_UPLOADS_DIR):
        root = directory.resolve()
        candidate = (directory / file_name).resolve()
        if root in candidate.parents and candidate.exists():
            candidate.unlink(missing_ok=True)

    delete_file_from_supabase_storage(file_name)


def identify_column(columns: dict[str, str], aliases: set[str]) -> str | None:
    for normalized, original in columns.items():
        if normalized in aliases:
            return original
    return None


def find_uploaded_image_reference(supplier: str, product_name: str) -> str:
    supplier_slug = slugify(supplier)
    product_slug = slugify(product_name)
    valid_extensions = {".png", ".jpg", ".jpeg", ".webp"}
    prefixes = tuple(
        prefix for prefix in [
            f"{supplier_slug}-{product_slug}-",
            f"{product_slug}-",
        ]
        if prefix
    )

    if not prefixes:
        return ""

    matches: list[Path] = []
    for directory in (UPLOADS_DIR, STATIC_UPLOADS_DIR):
        if not directory.exists():
            continue

        for candidate in directory.iterdir():
            if not candidate.is_file() or candidate.suffix.lower() not in valid_extensions:
                continue
            if candidate.name.lower().startswith(prefixes):
                matches.append(candidate)

    if not matches:
        return ""

    latest_match = max(matches, key=lambda path: path.stat().st_mtime_ns)
    return f"{UPLOAD_MEDIA_PREFIX}{latest_match.name}"


def find_matching_catalog_image_reference(supplier: str, product_name: str) -> str:
    if not EXCEL_PATH.exists():
        return ""

    supplier_key = normalize_header(supplier)
    product_key = normalize_header(product_name)
    if not supplier_key or not product_key:
        return ""

    try:
        catalog_items = load_catalog_products(EXCEL_PATH.stat().st_mtime_ns)
    except Exception:
        return ""

    for item in catalog_items:
        item_supplier = normalize_header(item.get("supplier", ""))
        item_name = normalize_header(item.get("name", ""))
        if item_supplier != supplier_key or item_name != product_key:
            continue

        resolved_image = resolve_image(item.get("image", PLACEHOLDER_IMAGE))
        if resolved_image != PLACEHOLDER_IMAGE:
            return resolved_image

    return ""


def load_custom_products() -> list[dict[str, Any]]:
    deduped: dict[str, dict[str, Any]] = {}

    if USE_DB:
        rows = _get_sb().table("custom_products").select("id,name,supplier,category,image").execute().data or []
        repaired_images: dict[str, str] = {}

        for row in rows:
            if not row.get("id") or not row.get("name") or not row.get("supplier"):
                continue

            product_id = str(row["id"])
            product_name = str(row["name"])
            supplier_name = str(row["supplier"])
            stored_image = str(row.get("image") or PLACEHOLDER_IMAGE)
            if stored_image == PLACEHOLDER_IMAGE:
                recovered_image = find_uploaded_image_reference(supplier_name, product_name)
                if not recovered_image:
                    recovered_image = find_matching_catalog_image_reference(supplier_name, product_name)
                if recovered_image:
                    stored_image = recovered_image
                    repaired_images[product_id] = recovered_image

            deduped[product_id] = {
                "id": product_id,
                "name": product_name,
                "supplier": supplier_name,
                "category": str(row.get("category") or ""),
                "image": stored_image,
                "source": "custom",
            }

        if repaired_images:
            sb = _get_sb()
            for product_id, image_reference in repaired_images.items():
                try:
                    sb.table("custom_products").update({"image": image_reference}).eq("id", product_id).execute()
                except Exception:
                    pass

        return list(deduped.values())

    products = read_json(CUSTOM_PRODUCTS_PATH, [])
    if not isinstance(products, list):
        return []

    repaired = False

    for product in products:
        if not isinstance(product, dict):
            continue
        if not product.get("id") or not product.get("name") or not product.get("supplier"):
            continue

        stored_image = str(product.get("image", PLACEHOLDER_IMAGE) or PLACEHOLDER_IMAGE)
        if stored_image == PLACEHOLDER_IMAGE:
            recovered_image = find_uploaded_image_reference(str(product["supplier"]), str(product["name"]))
            if not recovered_image:
                recovered_image = find_matching_catalog_image_reference(str(product["supplier"]), str(product["name"]))
            if recovered_image:
                stored_image = recovered_image
                product["image"] = recovered_image
                repaired = True

        deduped[str(product["id"])] = {
            "id": str(product["id"]),
            "name": str(product["name"]),
            "supplier": str(product["supplier"]),
            "category": str(product.get("category", "")),
            "image": stored_image,
            "source": "custom",
        }

    if repaired:
        write_json(CUSTOM_PRODUCTS_PATH, products)

    return list(deduped.values())


def save_custom_products(products: list[dict[str, Any]]) -> None:
    if USE_DB:
        sb = _get_sb()
        sb.table("custom_products").delete().neq("id", "").execute()
        if products:
            rows = [
                {
                    "id": p["id"],
                    "name": p["name"],
                    "supplier": p["supplier"],
                    "category": p.get("category", ""),
                    "image": p.get("image", PLACEHOLDER_IMAGE),
                }
                for p in products
            ]
            sb.table("custom_products").insert(rows).execute()
        return
    write_json(CUSTOM_PRODUCTS_PATH, products)


def load_deleted_products() -> set[str]:
    if USE_DB:
        rows = _get_sb().table("deleted_products").select("product_id").execute().data or []
        return {str(r["product_id"]) for r in rows if r.get("product_id")}
    deleted = read_json(DELETED_PRODUCTS_PATH, [])
    if not isinstance(deleted, list):
        return set()
    return {str(item) for item in deleted if item}


def save_deleted_products(product_ids: set[str]) -> None:
    if USE_DB:
        sb = _get_sb()
        sb.table("deleted_products").delete().neq("product_id", "").execute()
        if product_ids:
            sb.table("deleted_products").insert([{"product_id": pid} for pid in product_ids]).execute()
        return
    write_json(DELETED_PRODUCTS_PATH, sorted(product_ids))


def load_orders() -> list[dict[str, Any]]:
    raw_orders = read_json(ORDERS_PATH, [])
    if not isinstance(raw_orders, list):
        return []

    orders: list[dict[str, Any]] = []
    for item in raw_orders:
        if not isinstance(item, dict) or not item.get("product_id"):
            continue

        try:
            order_quantity = int(item.get("order_quantity", 1))
        except (TypeError, ValueError):
            order_quantity = 1

        order_type = str(item.get("order_type", "")).strip() or "carton"
        status = str(item.get("status", "pending")).strip().lower() or "pending"
        if status not in {"pending", "ordered"}:
            status = "pending"

        orders.append(
            {
                "product_id": str(item["product_id"]),
                "order_type": order_type,
                "order_quantity": max(1, order_quantity),
                "status": status,
                "created_at": str(item.get("created_at", "")),
                "updated_at": str(item.get("updated_at", "")),
            }
        )

    return orders


def save_orders(orders: list[dict[str, Any]]) -> None:
    write_json(ORDERS_PATH, orders)


def remove_order_for_product(product_id: str) -> None:
    orders = load_orders()
    remaining_orders = [order for order in orders if order["product_id"] != product_id]
    if len(remaining_orders) != len(orders):
        save_orders(remaining_orders)


def build_order_list(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    order_records = load_orders()
    product_lookup = {product["id"]: product for product in products}
    items: list[dict[str, Any]] = []

    for order in order_records:
        product = product_lookup.get(order["product_id"])
        if product is None:
            continue

        stock = int(product["stock"])
        items.append(
            {
                "id": product["id"],
                "product_id": product["id"],
                "name": product["name"],
                "supplier": product["supplier"],
                "image": product["image"],
                "current_stock": stock,
                "configured": True,
                "needs_reorder": 0 < stock <= REORDER_THRESHOLD,
                "order_type": order["order_type"],
                "order_quantity": order["order_quantity"],
                "status": order["status"],
                "updated_at": order["updated_at"],
            }
        )

    items.sort(
        key=lambda item: (
            0 if item["needs_reorder"] else 1,
            0 if item["status"] == "pending" else 1,
            item["current_stock"],
            item["name"].lower(),
        )
    )
    return items


@lru_cache(maxsize=1)
def load_catalog_products(excel_mtime: int) -> list[dict[str, Any]]:
    _ = excel_mtime
    workbook = pd.ExcelFile(EXCEL_PATH)
    row_images = extract_embedded_images(excel_mtime)
    catalog: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for sheet_name in workbook.sheet_names:
        frame = pd.read_excel(EXCEL_PATH, sheet_name=sheet_name)
        if frame.empty:
            continue

        columns = {normalize_header(column): column for column in frame.columns}
        name_column = identify_column(columns, PRODUCT_NAME_KEYS)
        if not name_column:
            continue

        image_column = identify_column(columns, IMAGE_KEYS)
        category_column = identify_column(columns, CATEGORY_KEYS)
        supplier_column = identify_column(columns, SUPPLIER_KEYS)

        for row_index, row in frame.iterrows():
            raw_name = row.get(name_column)
            if pd.isna(raw_name):
                continue

            product_name = str(raw_name).strip()
            if not product_name:
                continue

            supplier_name = str(row.get(supplier_column) or sheet_name).strip() if supplier_column else sheet_name
            category_name = ""
            if category_column:
                category_value = row.get(category_column)
                if not pd.isna(category_value):
                    category_name = str(category_value).strip()

            product_id = slugify(f"{supplier_name}-{product_name}")
            if product_id in seen_ids:
                suffix = 2
                while f"{product_id}-{suffix}" in seen_ids:
                    suffix += 1
                product_id = f"{product_id}-{suffix}"

            seen_ids.add(product_id)
            image_value = row.get(image_column) if image_column else ""
            sheet_key = str(sheet_name)
            row_number = int(cast(Any, row_index)) + 2
            embedded_image = row_images.get((sheet_key, row_number), "")
            resolved_image = resolve_image(image_value)
            if resolved_image == PLACEHOLDER_IMAGE and embedded_image:
                resolved_image = embedded_image

            catalog.append(
                {
                    "id": product_id,
                    "name": product_name,
                    "supplier": supplier_name,
                    "category": category_name,
                    "image": resolved_image,
                }
            )

    catalog.sort(key=lambda item: (item["supplier"].lower(), item["name"].lower()))
    return catalog


def load_products() -> list[dict[str, Any]]:
    if USE_DB:
        rows = _get_sb().table("stock").select("product_id,quantity").execute().data or []
        stock_map: dict[str, int] = {r["product_id"]: int(r["quantity"]) for r in rows}
    else:
        stock_map = read_json(STOCK_PATH, {})
    deleted_ids = load_deleted_products()
    products: list[dict[str, Any]] = []

    catalog_items: list[dict[str, Any]] = []
    if EXCEL_PATH.exists():
        excel_mtime = EXCEL_PATH.stat().st_mtime_ns
        catalog_items = load_catalog_products(excel_mtime)

    all_items = catalog_items + load_custom_products()
    for catalog_item in all_items:
        if catalog_item["id"] in deleted_ids:
            continue
        products.append(
            {
                **catalog_item,
                "image": resolve_image(catalog_item.get("image", PLACEHOLDER_IMAGE)),
                "stock": int(stock_map.get(catalog_item["id"], 0)),
            }
        )

    return products


@lru_cache(maxsize=1)
def extract_embedded_images(excel_mtime: int) -> dict[tuple[str, int], str]:
    _ = excel_mtime
    extracted: dict[tuple[str, int], str] = {}
    output_dir = IMAGES_DIR / "excel"
    output_dir.mkdir(parents=True, exist_ok=True)

    workbook = load_workbook(EXCEL_PATH)
    for worksheet in workbook.worksheets:
        for image_index, image in enumerate(getattr(worksheet, "_images", []), start=1):
            anchor = getattr(image, "anchor", None)
            if not anchor or not hasattr(anchor, "_from"):
                continue

            row_number = int(anchor._from.row) + 1
            col_number = int(anchor._from.col) + 1

            extension = str(getattr(image, "format", "png") or "png").lower()
            if extension == "jpeg":
                extension = "jpg"
            if extension not in {"png", "jpg", "gif", "bmp"}:
                extension = "png"

            file_name = f"{slugify(worksheet.title)}-r{row_number}-c{col_number}-{image_index}.{extension}"
            file_path = output_dir / file_name

            if not file_path.exists():
                try:
                    file_path.write_bytes(image._data())
                except Exception:
                    continue

            extracted[(worksheet.title, row_number)] = f"images/excel/{file_name}"

    return extracted


def list_suppliers(products: list[dict[str, Any]]) -> list[str]:
    unique = {product["supplier"].strip() for product in products if product["supplier"].strip()}
    return sorted(unique, key=lambda value: value.lower())


def low_stock_products(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    dismissed = _read_alerts()
    alerts = []
    for product in products:
        stock = int(product["stock"])
        if stock <= 0 or stock > LOW_STOCK_THRESHOLD:
            continue
        dismissed_stock = dismissed.get(product["id"])
        if isinstance(dismissed_stock, int) and dismissed_stock == stock:
            continue
        alerts.append(product)

    alerts.sort(key=lambda item: (item["stock"], item["name"].lower()))
    return alerts


def create_unique_product_id(supplier: str, product_name: str) -> str:
    base_id = slugify(f"{supplier}-{product_name}")
    existing_ids = {product["id"] for product in load_products()}
    if base_id not in existing_ids:
        return base_id

    suffix = 2
    while f"{base_id}-{suffix}" in existing_ids:
        suffix += 1
    return f"{base_id}-{suffix}"


def save_uploaded_image(uploaded_file: Any, supplier: str, product_name: str) -> str:
    extension = Path(str(uploaded_file.filename)).suffix.lower()
    if extension not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise ValueError("Format image non supporte.")

    safe_name = f"{slugify(supplier)}-{slugify(product_name)}-{int(local_now().timestamp())}{extension}"
    file_bytes = uploaded_file.read()
    if not file_bytes:
        raise ValueError("Image vide ou illisible.")

    target_path = UPLOADS_DIR / safe_name
    target_path.write_bytes(file_bytes)

    legacy_target = STATIC_UPLOADS_DIR / safe_name
    try:
        shutil.copy2(target_path, legacy_target)
    except OSError:
        pass

    if USE_DB:
        content_type = str(getattr(uploaded_file, "mimetype", "") or mimetypes.guess_type(safe_name)[0] or "application/octet-stream")
        try:
            upload_file_to_supabase_storage(safe_name, file_bytes, content_type)
        except Exception:
            pass

    return f"{UPLOAD_MEDIA_PREFIX}{safe_name}"


def clear_dismissal_if_stock_changed(product_id: str, new_stock: int) -> None:
    if USE_DB:
        rows = _get_sb().table("alerts_dismissed").select("dismissed_stock").eq("product_id", product_id).execute().data or []
        if rows:
            dismissed_stock = rows[0].get("dismissed_stock")
            if isinstance(dismissed_stock, int) and dismissed_stock != new_stock:
                _get_sb().table("alerts_dismissed").delete().eq("product_id", product_id).execute()
        return
    dismissed = read_json(ALERTS_PATH, {})
    dismissed_stock = dismissed.get(product_id)
    if isinstance(dismissed_stock, int) and dismissed_stock != new_stock:
        dismissed.pop(product_id, None)
        write_json(ALERTS_PATH, dismissed)


def cleanup_deleted_product(product_id: str) -> None:
    if USE_DB:
        sb = _get_sb()
        sb.table("stock").delete().eq("product_id", product_id).execute()
        sb.table("alerts_dismissed").delete().eq("product_id", product_id).execute()
        remove_order_for_product(product_id)
        return
    stock_map = read_json(STOCK_PATH, {})
    if product_id in stock_map:
        stock_map.pop(product_id, None)
        write_json(STOCK_PATH, stock_map)
    dismissed = read_json(ALERTS_PATH, {})
    if product_id in dismissed:
        dismissed.pop(product_id, None)
        write_json(ALERTS_PATH, dismissed)
    remove_order_for_product(product_id)


def remove_custom_product_if_needed(product_id: str) -> None:
    custom_products = load_custom_products()
    remaining_products: list[dict[str, Any]] = []
    removed_image = ""

    for product in custom_products:
        if product["id"] == product_id:
            removed_image = str(product.get("image", ""))
            continue
        remaining_products.append(product)

    if len(remaining_products) != len(custom_products):
        save_custom_products(remaining_products)
        if removed_image and removed_image != PLACEHOLDER_IMAGE:
            delete_uploaded_image_file(removed_image)


def update_custom_product_image(product_id: str, new_image_path: str) -> bool:
    custom_products = load_custom_products()
    updated = False
    previous_image = ""

    for product in custom_products:
        if product["id"] != product_id:
            continue
        previous_image = str(product.get("image", ""))
        product["image"] = new_image_path
        updated = True
        break

    if not updated:
        return False

    save_custom_products(custom_products)
    if previous_image and previous_image != new_image_path and previous_image != PLACEHOLDER_IMAGE:
        delete_uploaded_image_file(previous_image)

    return True


def draw_product_line(pdf: canvas.Canvas, y: float, product: dict[str, Any]) -> float:
    image_path = get_image_file_path(product["image"])
    if not image_path.exists():
        image_path = get_image_file_path(PLACEHOLDER_IMAGE)

    try:
        pdf.drawImage(ImageReader(str(image_path)), 28, y - 44, width=34, height=34, preserveAspectRatio=True)
    except Exception:
        pass

    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(70, y - 10, product["name"][:85])
    pdf.setFont("Helvetica", 9)
    pdf.drawString(70, y - 22, f"Fournisseur: {product['supplier']}")
    pdf.drawString(70, y - 34, f"Stock actuel: {product['stock']}")
    return y - 50


def build_stock_pdf(alerts: list[dict[str, Any]]) -> BytesIO:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    _, page_height = A4

    y = page_height - 36
    now_text = local_now().strftime("%Y-%m-%d %H:%M")
    title = "Stock Alert Report"
    pdf.setFont("Helvetica-Bold", 14)
    pdf.drawString(28, y, title)
    y -= 16
    pdf.setFont("Helvetica", 9)
    pdf.drawString(28, y, f"Genere le: {now_text}")
    y -= 18

    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(28, y, f"Alertes de stock actives ({len(alerts)})")
    y -= 14

    if not alerts:
        pdf.setFont("Helvetica", 9)
        pdf.drawString(28, y, "Aucune alerte active.")
        y -= 20
    else:
        for product in alerts:
            if y < 70:
                pdf.showPage()
                y = page_height - 36
                pdf.setFont("Helvetica-Bold", 14)
                pdf.drawString(28, y, title)
                y -= 20

            y = draw_product_line(pdf, y, product)

    pdf.save()
    buffer.seek(0)
    return buffer


def draw_order_line(pdf: canvas.Canvas, y: float, order: dict[str, Any]) -> float:
    image_path = get_image_file_path(order["image"])
    if not image_path.exists():
        image_path = get_image_file_path(PLACEHOLDER_IMAGE)

    try:
        pdf.drawImage(ImageReader(str(image_path)), 28, y - 40, width=30, height=30, preserveAspectRatio=True)
    except Exception:
        pass

    status_text = "Commande envoyee" if order.get("status") == "ordered" else "A commander"
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(66, y - 9, str(order["name"])[:84])
    pdf.setFont("Helvetica", 9)
    pdf.drawString(66, y - 21, f"Stock: {order['current_stock']}   Type: {order['order_type']}   Qte: {order['order_quantity']}")
    pdf.drawString(66, y - 33, f"Statut: {status_text}")
    return y - 44


def build_orders_pdf(orders: list[dict[str, Any]]) -> BytesIO:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    _, page_height = A4

    def draw_header(current_y: float) -> float:
        now_text = local_now().strftime("%Y-%m-%d %H:%M")
        pdf.setFont("Helvetica-Bold", 14)
        pdf.drawString(28, current_y, "Order List Report")
        current_y -= 16
        pdf.setFont("Helvetica", 9)
        pdf.drawString(28, current_y, f"Genere le: {now_text}")
        return current_y - 18

    y = draw_header(page_height - 36)
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(28, y, f"Commandes enregistrees ({len(orders)})")
    y -= 16

    if not orders:
        pdf.setFont("Helvetica", 9)
        pdf.drawString(28, y, "Aucune commande enregistree.")
        y -= 20
    else:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for order in orders:
            grouped.setdefault(str(order.get("supplier") or "Autres"), []).append(order)

        for supplier in sorted(grouped, key=str.casefold):
            supplier_orders = grouped[supplier]
            if y < 90:
                pdf.showPage()
                y = draw_header(page_height - 36)

            pdf.setFont("Helvetica-Bold", 11)
            pdf.drawString(28, y, f"{supplier} ({len(supplier_orders)})")
            y -= 12

            for order in supplier_orders:
                if y < 70:
                    pdf.showPage()
                    y = draw_header(page_height - 36)
                    pdf.setFont("Helvetica-Bold", 11)
                    pdf.drawString(28, y, f"{supplier} ({len(supplier_orders)})")
                    y -= 12
                y = draw_order_line(pdf, y, order)

            y -= 6

    pdf.save()
    buffer.seek(0)
    return buffer


def logo_path() -> str:
    candidates = ["images/logo.png", "images/saikoon.png", "images/saikoon_logo.png"]
    for relative in candidates:
        if (STATIC_DIR / relative).exists():
            return relative
    return PLACEHOLDER_IMAGE


def append_history(product: dict[str, Any], previous_stock: int, new_stock: int) -> None:
    entry = {
        "product_id": product["id"],
        "product_name": product["name"],
        "supplier": product["supplier"],
        "previous_stock": previous_stock,
        "new_stock": new_stock,
        "updated_at": local_now().astimezone(timezone.utc).isoformat(),
    }
    if USE_DB:
        _get_sb().table("history").insert(entry).execute()
    else:
        history = read_json(HISTORY_PATH, [])
        history.append(entry)
        write_json(HISTORY_PATH, history)


@app.get("/")
def index() -> str:
    ensure_data_files()
    ensure_static_assets()
    products = load_products()
    suppliers = list_suppliers(products)
    alerts = low_stock_products(products)
    orders = build_order_list(products)
    return render_template(
        "index.html",
        suppliers=suppliers,
        alerts=alerts,
        orders=orders,
        low_stock_threshold=LOW_STOCK_THRESHOLD,
        reorder_threshold=REORDER_THRESHOLD,
        logo_src=logo_path(),
        excel_missing=not EXCEL_PATH.exists(),
    )


@app.get("/api/suppliers")
def get_suppliers():
    ensure_data_files()
    ensure_static_assets()
    products = load_products()
    return jsonify({"suppliers": list_suppliers(products)})


@app.get("/api/products")
def get_products():
    ensure_data_files()
    ensure_static_assets()
    supplier = request.args.get("supplier", "").strip()
    if not supplier:
        return jsonify({"products": []})

    products = [item for item in load_products() if item["supplier"].casefold() == supplier.casefold()]
    products.sort(key=lambda item: item["name"].lower())
    return jsonify({"products": products})


@app.get("/api/alerts")
def get_alerts():
    ensure_data_files()
    ensure_static_assets()
    supplier = request.args.get("supplier", "").strip()
    products = load_products()
    if supplier:
        products = [item for item in products if item["supplier"].casefold() == supplier.casefold()]

    return jsonify({"alerts": low_stock_products(products), "threshold": LOW_STOCK_THRESHOLD})


@app.delete("/api/alerts/<product_id>")
def dismiss_alert(product_id: str):
    ensure_data_files()
    ensure_static_assets()

    products = load_products()
    product = next((item for item in products if item["id"] == product_id), None)
    if product is None:
        abort(404, description="Produit introuvable.")

    stock = int(product["stock"])
    if stock <= 0 or stock > LOW_STOCK_THRESHOLD:
        abort(400, description="Alerte non active pour ce produit.")

    if USE_DB:
        _get_sb().table("alerts_dismissed").upsert({"product_id": product_id, "dismissed_stock": stock}).execute()
    else:
        dismissed = read_json(ALERTS_PATH, {})
        dismissed[product_id] = stock
        write_json(ALERTS_PATH, dismissed)

    return jsonify({"id": product_id, "dismissed": True})


@app.delete("/api/alerts")
def dismiss_all_alerts():
    ensure_data_files()
    ensure_static_assets()

    supplier = request.args.get("supplier", "").strip()
    products = load_products()
    if supplier:
        products = [item for item in products if item["supplier"].casefold() == supplier.casefold()]

    active_alerts = low_stock_products(products)
    if USE_DB:
        rows = [{"product_id": p["id"], "dismissed_stock": int(p["stock"])} for p in active_alerts]
        if rows:
            _get_sb().table("alerts_dismissed").upsert(rows).execute()
    else:
        dismissed = read_json(ALERTS_PATH, {})
        for product in active_alerts:
            dismissed[product["id"]] = int(product["stock"])
        write_json(ALERTS_PATH, dismissed)

    return jsonify({"dismissed_count": len(active_alerts)})


@app.get("/api/orders")
def get_orders():
    ensure_data_files()
    ensure_static_assets()
    supplier = request.args.get("supplier", "").strip()
    products = load_products()
    if supplier:
        products = [item for item in products if item["supplier"].casefold() == supplier.casefold()]

    return jsonify({"orders": build_order_list(products), "threshold": REORDER_THRESHOLD})


@app.delete("/api/orders")
def delete_all_orders():
    ensure_data_files()
    ensure_static_assets()

    supplier = request.args.get("supplier", "").strip()
    orders = load_orders()
    if not supplier:
        removed_count = len(orders)
        save_orders([])
        return jsonify({"removed_count": removed_count})

    products = load_products()
    supplier_product_ids = {
        item["id"]
        for item in products
        if item["supplier"].casefold() == supplier.casefold()
    }
    removed_count = sum(1 for item in orders if item["product_id"] in supplier_product_ids)
    remaining_orders = [item for item in orders if item["product_id"] not in supplier_product_ids]
    save_orders(remaining_orders)
    return jsonify({"removed_count": removed_count})


@app.post("/api/orders")
def upsert_order():
    ensure_data_files()
    ensure_static_assets()

    payload = request.get_json(silent=True) or {}
    product_id = str(payload.get("product_id", "")).strip()
    order_type = str(payload.get("order_type", "")).strip()
    order_quantity = payload.get("order_quantity")

    if not product_id:
        abort(400, description="Produit obligatoire.")
    if not order_type:
        abort(400, description="Type de commande obligatoire.")
    if not isinstance(order_quantity, int) or order_quantity <= 0:
        abort(400, description="La quantite a commander doit etre un entier positif.")

    products = load_products()
    product = next((item for item in products if item["id"] == product_id), None)
    if product is None:
        abort(404, description="Produit introuvable.")

    orders = load_orders()
    timestamp = local_now().astimezone(timezone.utc).isoformat()
    existing_order = next((item for item in orders if item["product_id"] == product_id), None)

    if existing_order is None:
        orders.append(
            {
                "product_id": product_id,
                "order_type": order_type,
                "order_quantity": order_quantity,
                "status": "pending",
                "created_at": timestamp,
                "updated_at": timestamp,
            }
        )
    else:
        existing_order["order_type"] = order_type
        existing_order["order_quantity"] = order_quantity
        existing_order["status"] = str(existing_order.get("status", "pending") or "pending")
        existing_order["updated_at"] = timestamp

    save_orders(orders)
    updated_orders = build_order_list(products)
    selected_order = next((item for item in updated_orders if item["product_id"] == product_id), None)
    return jsonify({"saved": True, "order": selected_order, "threshold": REORDER_THRESHOLD})


@app.patch("/api/orders/<product_id>")
def update_order_status(product_id: str):
    ensure_data_files()
    ensure_static_assets()

    payload = request.get_json(silent=True) or {}
    status = str(payload.get("status", "pending")).strip().lower() or "pending"
    if status not in {"pending", "ordered"}:
        abort(400, description="Statut de commande non supporte.")

    orders = load_orders()
    order = next((item for item in orders if item["product_id"] == product_id), None)
    if order is None:
        abort(404, description="Commande introuvable.")

    order["status"] = status
    order["updated_at"] = local_now().astimezone(timezone.utc).isoformat()
    save_orders(orders)

    products = load_products()
    updated_orders = build_order_list(products)
    selected_order = next((item for item in updated_orders if item["product_id"] == product_id), None)
    return jsonify({"saved": True, "order": selected_order, "threshold": REORDER_THRESHOLD})


@app.delete("/api/orders/<product_id>")
def delete_order(product_id: str):
    ensure_data_files()
    ensure_static_assets()

    orders = load_orders()
    remaining_orders = [item for item in orders if item["product_id"] != product_id]
    if len(remaining_orders) == len(orders):
        abort(404, description="Commande introuvable.")

    save_orders(remaining_orders)
    return jsonify({"removed": True, "product_id": product_id})


@app.post("/api/products")
def create_product():
    ensure_data_files()
    ensure_static_assets()

    name = request.form.get("name", "").strip()
    supplier = request.form.get("supplier", "").strip()
    category = request.form.get("category", "").strip()
    initial_stock = 0
    uploaded_file = request.files.get("image")

    if not name:
        abort(400, description="Nom de produit obligatoire.")
    if not supplier:
        abort(400, description="Fournisseur obligatoire.")

    image_path = find_matching_catalog_image_reference(supplier, name) or PLACEHOLDER_IMAGE
    if uploaded_file is not None and uploaded_file.filename:
        try:
            image_path = save_uploaded_image(uploaded_file, supplier, name)
        except ValueError as exc:
            abort(400, description=str(exc))

    product_id = create_unique_product_id(supplier, name)
    custom_products = load_custom_products()
    custom_products.append(
        {
            "id": product_id,
            "name": name,
            "supplier": supplier,
            "category": category,
            "image": image_path,
            "source": "custom",
        }
    )
    save_custom_products(custom_products)

    deleted_ids = load_deleted_products()
    if product_id in deleted_ids:
        deleted_ids.discard(product_id)
        save_deleted_products(deleted_ids)

    # Reset caches so the new product appears immediately.
    load_catalog_products.cache_clear()
    extract_embedded_images.cache_clear()

    if USE_DB:
        _get_sb().table("stock").upsert({"product_id": product_id, "quantity": initial_stock}).execute()
    else:
        stock_map = read_json(STOCK_PATH, {})
        stock_map[product_id] = initial_stock
        write_json(STOCK_PATH, stock_map)

    return jsonify(
        {
            "id": product_id,
            "name": name,
            "supplier": supplier,
            "category": category,
            "image": image_path,
            "stock": initial_stock,
        }
    )


@app.delete("/api/products/<product_id>")
def delete_product(product_id: str):
    ensure_data_files()
    ensure_static_assets()

    products = load_products()
    product = next((item for item in products if item["id"] == product_id), None)
    if product is None:
        abort(404, description="Produit introuvable.")

    deleted_ids = load_deleted_products()
    deleted_ids.add(product_id)
    save_deleted_products(deleted_ids)

    cleanup_deleted_product(product_id)
    remove_custom_product_if_needed(product_id)

    return jsonify({
        "id": product_id,
        "name": product.get("name", ""),
        "supplier": product.get("supplier", ""),
        "deleted": True,
    })


@app.post("/api/products/<product_id>/image")
def update_product_image(product_id: str):
    ensure_data_files()
    ensure_static_assets()

    uploaded_file = request.files.get("image")
    if uploaded_file is None or not uploaded_file.filename:
        abort(400, description="Photo obligatoire.")

    products = load_products()
    product = next((item for item in products if item["id"] == product_id), None)
    if product is None:
        abort(404, description="Produit introuvable.")
    if product.get("source") != "custom":
        abort(400, description="Seuls les produits ajoutes manuellement peuvent changer de photo.")

    try:
        image_path = save_uploaded_image(uploaded_file, product["supplier"], product["name"])
    except ValueError as exc:
        abort(400, description=str(exc))

    if not update_custom_product_image(product_id, image_path):
        abort(404, description="Produit introuvable.")

    return jsonify({"id": product_id, "image": image_path, "updated": True})


@app.get("/media/uploads/<path:filename>")
def serve_uploaded_media(filename: str):
    ensure_data_files()

    safe_name = Path(filename).name
    file_path = (UPLOADS_DIR / safe_name).resolve()
    uploads_root = UPLOADS_DIR.resolve()
    if uploads_root not in file_path.parents:
        abort(404, description="Image introuvable.")

    if not file_path.exists():
        cached_path = cache_uploaded_file(safe_name)
        if cached_path is None or not cached_path.exists():
            abort(404, description="Image introuvable.")

    mime_type = mimetypes.guess_type(safe_name)[0]
    return send_from_directory(UPLOADS_DIR, safe_name, conditional=True, mimetype=mime_type)


@app.get("/api/export/pdf")
def export_pdf():
    ensure_data_files()
    ensure_static_assets()

    all_products = load_products()
    supplier = request.args.get("supplier", "").strip()
    if supplier:
        all_products = [item for item in all_products if item["supplier"].casefold() == supplier.casefold()]

    alerts = low_stock_products(all_products)
    alerts.sort(key=lambda item: (item["stock"], item["name"].lower()))
    pdf_data = build_stock_pdf(alerts)
    timestamp = local_now().strftime("%Y%m%d_%H%M")
    file_name = f"stock_report_{timestamp}.pdf"

    return send_file(
        pdf_data,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=file_name,
    )


@app.get("/api/export/orders/pdf")
def export_orders_pdf():
    ensure_data_files()
    ensure_static_assets()

    all_products = load_products()
    supplier = request.args.get("supplier", "").strip()
    if supplier:
        all_products = [item for item in all_products if item["supplier"].casefold() == supplier.casefold()]

    orders = build_order_list(all_products)
    pdf_data = build_orders_pdf(orders)
    timestamp = local_now().strftime("%Y%m%d_%H%M")
    file_name = f"order_report_{timestamp}.pdf"

    return send_file(
        pdf_data,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=file_name,
    )


@app.post("/api/products/<product_id>/stock")
def update_stock(product_id: str):
    ensure_data_files()
    ensure_static_assets()
    payload = request.get_json(silent=True) or {}
    quantity = payload.get("quantity")

    if not isinstance(quantity, int) or quantity < 0:
        abort(400, description="La quantite doit etre un entier positif.")

    products = load_products()
    product = next((item for item in products if item["id"] == product_id), None)
    if product is None:
        abort(404, description="Produit introuvable.")

    if USE_DB:
        sb = _get_sb()
        rows = sb.table("stock").select("quantity").eq("product_id", product_id).execute().data or []
        previous_stock = int(rows[0]["quantity"]) if rows else 0
        sb.table("stock").upsert({"product_id": product_id, "quantity": quantity}).execute()
    else:
        stock_map = read_json(STOCK_PATH, {})
        previous_stock = int(stock_map.get(product_id, 0))
        stock_map[product_id] = quantity
        write_json(STOCK_PATH, stock_map)
    clear_dismissal_if_stock_changed(product_id, quantity)
    append_history(product, previous_stock, quantity)

    return jsonify(
        {
            "id": product_id,
            "stock": quantity,
            "is_low_stock": 0 < quantity <= LOW_STOCK_THRESHOLD,
            "needs_reorder": 0 < quantity <= REORDER_THRESHOLD,
            "threshold": LOW_STOCK_THRESHOLD,
            "reorder_threshold": REORDER_THRESHOLD,
        }
    )


if __name__ == "__main__":
    ensure_data_files()
    ensure_static_assets()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    app.run(debug=True, host=host, port=port)