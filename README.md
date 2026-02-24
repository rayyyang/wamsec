# WamSEC — SEC Filings Research

A BamSEC-style SEC filing explorer with table extraction, document comparison, and full-text search.

**Live site:** [pplxsec.com](https://www.pplxsec.com/)

## Features

- **Company Search** — Fuzzy search across 10,000+ SEC-registered companies by ticker or name
- **Filing Browser** — Browse all SEC filings (10-K, 10-Q, 8-K, etc.) by company with date filters
- **Document Viewer** — Clean, readable rendering of SEC filing HTML with XBRL tags stripped
- **Table Detection & Extraction** — Auto-detect all tables in a filing, export to CSV/Excel
- **Merge Tables** — Intelligent table merging for filings with split tables
- **Similar Tables** — Find the same table across different filings/periods using Jaccard similarity
- **Full-Text Search** — Search across all SEC filings via EDGAR EFTS
- **Filing Comparison** — Side-by-side diff view of filing changes between periods
- **Screening Tools** — Recent filings by form type, company-level search, and filing alerts
- **PDF Access** — Direct PDF rendering of filings via Fiscal.ai API
- **XBRL Financials** — Structured financial data from SEC XBRL APIs

## Architecture

```
wamsec/
├── index.html              # SPA shell
├── app.js                  # Main application (hash router, all page rendering, SEC data logic)
├── style.css               # Full stylesheet
├── embedded_data.js        # Pre-loaded company data for demo/fast loading
├── company_tickers.js      # 10,382 companies ticker-to-CIK lookup
├── tables_index.js         # Pre-computed table signatures for "Similar Tables" feature
├── filing_cache/            # Cached filing HTML as JS files
├── cgi-bin/
│   └── api.py              # Python CGI backend (17 endpoints)
├── cloudflare-worker.js    # Cloudflare Worker proxy (pplxsec.com → pplx.app)
└── README.md
```

### Frontend

Single-page application using vanilla HTML/CSS/JS (no framework). Uses a hash router with ~25 routes. Key external dependencies loaded via CDN:

- **DOMPurify** — HTML sanitization for SEC filing content
- **diff_match_patch** — Filing comparison/diff feature
- **SheetJS (xlsx)** — Excel export for extracted tables
- **Cloudflare Web Analytics** — Usage tracking

### Backend

Python 3 CGI script (`cgi-bin/api.py`) with 17 endpoints that proxy requests to:

- **SEC EDGAR APIs** — `data.sec.gov`, `efts.sec.gov`, `www.sec.gov`
- **Fiscal.ai API** — Company profiles, financials, filing PDFs
- **SQLite** — Local table signatures DB for similar-tables feature

The Cloudflare Worker (`sec-proxy.perplexity-ai.workers.dev`) handles CORS proxying for direct SEC.gov requests from the browser.

### Key Technical Details

- SEC EDGAR requires a `User-Agent` header and blocks browser CORS — all EDGAR calls go through the CGI backend or Cloudflare Worker
- Filing HTML is gzip-compressed + base64-encoded for efficient transfer (~2MB → ~256KB)
- XBRL inline tags (`ix:*`) are stripped server-side for clean rendering
- Table similarity uses 60% header Jaccard + 40% row-label Jaccard overlap, with a 0.25 threshold
- Similar Tables feature runs client-side in production using pre-computed `tables_index.js`

## API Keys

The following API keys are used:

- **Fiscal.ai** — `FISCAL_API_KEY` in both `app.js` and `cgi-bin/api.py`

## Deployment

The site is deployed as a static site on Perplexity's internal hosting (`pplx.app`), with a Cloudflare Worker proxying the custom domain `pplxsec.com`.

## History

Originally built Feb 19–20, 2026 as a BamSEC clone, renamed to WamSEC. Reconstructed from the live site and Slack build thread on Feb 24, 2026.
