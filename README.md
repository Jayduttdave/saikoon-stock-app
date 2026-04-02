# Saikoon Kitchen Stock System

Simple stock management for daily kitchen operations.

Designed for:
- Android tablet in kitchen
- iPhone for owner
- PC for management

No login required.

## 1. What This App Does

- Shows products by supplier
- Lets you update stock quantity quickly
- Shows active stock alerts
- Lets you dismiss one alert or clear all alerts
- Exports stock alerts to PDF
- Syncs updates across devices every few seconds

## 2. Daily Owner Workflow (Login-Free)

1. Open the app URL on phone or tablet
2. Select supplier
3. Change quantity with plus, minus, or typing
4. Wait 1 to 2 seconds for auto-save and sync
5. Check alert panel for active stock items
6. Use Export PDF when needed

Notes:
- Quantity saves automatically
- Other devices update without manual refresh in normal use

## 3. Alert Behavior

- Product appears in alerts when stock is above 0
- If an alert is dismissed, it stays hidden after refresh
- If stock changes later, the alert can reappear
- Clear all alerts hides all current alerts for that view

## 4. Cross-Device Use

Use one public URL from Render after deployment.
All devices must open the same URL.

Example:
- Phone: same Render URL
- Tablet: same Render URL
- PC: same Render URL

## 5. Data Stored by the App

Important files:
- data/products.xlsx (catalog source)
- data/stock.json (current stock)
- data/history.json (stock change history)
- data/alerts_dismissed.json (dismissed alerts state)
- data/custom_products.json (custom product records)
- data/deleted_products.json (deleted product ids)

## 6. Backup Plan (Recommended)

Backup frequency:
- Daily end of shift
- Extra backup before any big update

Backup steps:
1. Copy the full data folder to a safe location
2. Keep date in folder name, example: backup-2026-04-02
3. Keep at least last 14 backups

Minimum critical backup files:
- data/stock.json
- data/history.json
- data/alerts_dismissed.json
- data/custom_products.json
- data/deleted_products.json

## 7. Recovery Plan

If data is lost or corrupted:
1. Stop the app
2. Replace current files in data folder with backup copy
3. Start app again
4. Check stock values and alerts

If products catalog is missing:
1. Restore data/products.xlsx
2. Restart app

## 8. Render Hosting Notes

This project includes Render configuration in render.yaml.

Current setup:
- Python web service
- Gunicorn start command
- Persistent disk path set with APP_DATA_DIR=/var/data

Important:
- Persistent disk is required so stock is not lost between deploys
- Keep plan at level that supports persistent disk

## 9. Local Run (Development)

From project folder:
1. Create and activate virtual environment
2. Install dependencies from requirements.txt
3. Start app with python app.py
4. Open http://127.0.0.1:5000

For phone testing on same Wi-Fi:
- Open http://YOUR_PC_IPV4:5000

## 10. Troubleshooting Quick List

If app is not updating on another device:
- Wait 2 to 3 seconds for sync poll
- Ensure both devices use same app URL
- Check internet connection

If logo does not update:
- Hard refresh browser once

If app does not start:
- Verify Python environment is active
- Verify requirements are installed
- Check terminal error output

## 11. Handoff Checklist for Owner

- Open URL on iPhone and Android tablet
- Confirm supplier list loads
- Confirm quantity update saves and syncs
- Confirm alert dismiss works and persists
- Confirm PDF export downloads
- Confirm daily backup routine is understood

---
Prepared for Saikoon Kitchen, Torcy Bay 2.
