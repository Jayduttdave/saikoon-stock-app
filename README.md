# SAIKOON Stock Management

A restaurant inventory and purchase-order management system built with Flask, Supabase and Vercel.

## Features

- Stock management
- Supplier-based product catalog
- Product search
- Low-stock alerts
- Stock quantity adjustments
- Custom product creation
- Product image uploads
- Product deletion
- Purchase/order management
- Supplier-based order lists
- Stock PDF export
- Order PDF export
- Responsive web interface

## Production Architecture

### Frontend / UI
- HTML5
- Vanilla CSS (custom design system)
- Vanilla JavaScript

### Backend
- Python 3.12
- Flask
- Vercel Python serverless deployment (`@vercel/python`)

### Database
- Supabase PostgreSQL

### Storage
- Supabase Storage
- Public `product-images` bucket for catalog and uploaded media

### Production Hosting
- Vercel Serverless Platform

### Legacy / Fallback Environment
- Render remains available as a fallback environment but is not the primary production deployment.

## Data Architecture

The application uses Supabase PostgreSQL as its persistent cloud database:

- `products`: Contains the master catalog products.
- `custom_products`: Contains user-created and custom product records.
- `stock`: Contains live inventory quantities per product.
- `history`: Contains audit records of all stock adjustments over time.
- `alerts_dismissed`: Tracks dismissed low-stock alerts and their dismissed threshold.
- `deleted_products`: Contains intentionally deleted product IDs (soft-deletion filtering).
- `orders`: Contains purchase and supplier order records.
- **Product Images:** Stored in Supabase Storage (`product-images` bucket).
- **Stateless Filesystem:** Vercel does NOT rely on persistent local filesystem storage.

Uploaded custom product images are streamed directly from memory into Supabase Storage in serverless mode, ensuring zero dependency on local disk persistence.

## Vercel Compatibility

The application codebase is fully optimized for Vercel serverless execution:

- **Zero Persistent Filesystem Dependency:** No local writable storage is required on Vercel.
- **In-Memory PDF Generation:** Both Stock PDF and Orders PDF are generated entirely in memory via ReportLab and streamed to the client.
- **Database-Backed Catalog:** Product catalog is queried directly from Supabase.
- **Database-Backed Orders:** Orders are queried and updated in Supabase.
- **Cloud Object Storage:** All product and uploaded images are served from Supabase Storage CDN.
- **Decoupled Uploads:** Custom product images are uploaded directly from memory to Supabase Storage.
- **Render Compatibility Preserved:** Dual-mode architecture (`USE_DB` vs local JSON fallback) ensures backward compatibility with Render.

## Environment Variables

Configure the following environment variables in your deployment environment (Vercel project settings or local `.env`):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `APP_TIMEZONE`

> **IMPORTANT:** All secrets and credentials must be configured strictly through secure environment variables and must **never** be committed to Git.

## Deployment

The standard production deployment flow:

```
GitHub (main branch)
        ↓
      Vercel
        ↓
    Production
```

Manual deployment via Vercel CLI:
```bash
npx vercel --prod
```

> **Note:** Production deployments should normally be handled automatically through the connected GitHub / Vercel integration workflow once configured.

## Development

To run the application locally using the existing virtual environment:

1. Activate your local virtual environment:
   ```bash
   # On Windows (PowerShell)
   .venv\Scripts\Activate.ps1

   # On macOS/Linux
   source .venv/bin/activate
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Configure environment variables in a local `.env` file (ensure `.env` is ignored by Git).

4. Start the development server:
   ```bash
   python app.py
   ```

5. Open [http://127.0.0.1:5000](http://127.0.0.1:5000) in your browser.

## Migration Notes

The application was successfully migrated from a Render/local-filesystem architecture to:

- **Hosting:** Vercel Serverless
- **Database:** Supabase PostgreSQL
- **Asset Storage:** Supabase Storage

All production data (master catalog, custom products, live inventory, stock history, active orders, dismissed alerts, and product images) was preserved during the migration.
