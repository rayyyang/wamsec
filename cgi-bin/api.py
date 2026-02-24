#!/usr/bin/env python3
"""
WamSEC / pplxsec.com — CGI Backend API
cgi-bin/api.py

Reconstructed from Slack thread context (thread ts: 1771608786.614579, channel D0AC0BAQMC6).
Original written Feb 20, 2026 by Computer subagent. The code was written directly to the
workspace filesystem and was never pasted inline in the thread. This reconstruction is based
on exhaustive evidence gathered from:
  - Thread action references ("Reading/Writing/Editing bamsec/cgi-bin/api.py")
  - app.js endpoint calls (apiFetch paths and param shapes)
  - Thread narrative descriptions ("13 endpoints", endpoint names, behaviors)
  - CGI webserver skill conventions (env vars, stdin, stdout)
  - fiscal.ai API patterns confirmed from thread
  - EDGAR EFTS URL patterns confirmed from app.js

Endpoints (PATH_INFO based routing):
  GET  /companies/search?q=<query>      — fuzzy company search via SEC company_tickers.json
  GET  /companies/profile?ticker=<T>   — company profile via fiscal.ai
  GET  /companies/filings?ticker=<T>   — filing list via fiscal.ai
  GET  /edgar/filings?ticker=<T>       — filing list via EDGAR submissions API
  GET  /financials?ticker=<T>          — financials via fiscal.ai
  GET  /ratios?ticker=<T>              — ratios via fiscal.ai
  GET  /stock?ticker=<T>               — stock prices via fiscal.ai
  GET  /shares?ticker=<T>              — shares outstanding via fiscal.ai
  GET  /segments?ticker=<T>            — segments/KPIs via fiscal.ai
  GET  /search?q=<q>&forms=<f>&page=N  — EDGAR full-text search via EFTS
  GET  /filing/doc?filingId=<id>       — filing document from EDGAR
  GET  /filing/index?filingId=<id>&cik=<cik> — filing index from EDGAR
  GET  /filing/pdf?filingId=<id>&ticker=<T>  — PDF redirect to fiscal.ai
  GET  /edgar/proxy?url=<encoded_url>  — EDGAR CORS bypass proxy
  GET  /edgar/document?cik=<cik>&accession=<acc>&filename=<fn> — full filing HTML (gzip+b64)
  GET  /tables/similar?headers=<j>&row_labels=<j>&ticker=<T>   — similar tables lookup (GET)
  POST /tables/find-similar             — similar tables lookup (POST, JSON body)
"""

import os
import sys
import json
import gzip
import base64
import urllib.request
import urllib.parse
import urllib.error
import re

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
FISCAL_API_KEY = "1b665ff8-a5e1-4332-9604-1cd00bb65355"
FISCAL_BASE = "https://api.fiscal.ai/v2"
COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
COMPANY_TICKERS_CACHE = "company_tickers.json"
TABLES_DB = "tables.db"


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────
def send_json(data, status=200):
    """Write CGI response headers + JSON body to stdout."""
    if status != 200:
        print(f"Status: {status}")
    print("Content-Type: application/json")
    print("Access-Control-Allow-Origin: *")
    print()
    print(json.dumps(data))


def send_error(message, status=500):
    send_json({"error": message}, status=status)


def fiscal_get(path, params=None):
    """GET request to fiscal.ai v2 API."""
    qs = urllib.parse.urlencode(params) if params else ""
    url = f"{FISCAL_BASE}{path}?apiKey={FISCAL_API_KEY}"
    if qs:
        url += f"&{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "WamSEC/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def edgar_get(url):
    """GET request to SEC EDGAR (data.sec.gov or www.sec.gov)."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "WamSEC/1.0 (support@wamsec.com)",
            "Accept": "application/json, text/html, */*",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def load_company_tickers():
    """Load company tickers JSON, using local cache if available."""
    # Try local cache first
    if os.path.exists(COMPANY_TICKERS_CACHE):
        with open(COMPANY_TICKERS_CACHE, "r") as f:
            return json.load(f)
    # Fetch from SEC and cache
    data_bytes = edgar_get(COMPANY_TICKERS_URL)
    data = json.loads(data_bytes.decode("utf-8"))
    with open(COMPANY_TICKERS_CACHE, "w") as f:
        json.dump(data, f)
    return data


def levenshtein(a, b):
    """Simple Levenshtein distance for fuzzy matching."""
    m, n = len(a), len(b)
    if m == 0:
        return n
    if n == 0:
        return m
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    return dp[m][n]


def parse_qs(qs):
    """Parse QUERY_STRING into a dict (first value for each key)."""
    parsed = urllib.parse.parse_qs(qs or "")
    return {k: v[0] for k, v in parsed.items()}


def read_body():
    """Read POST body from stdin using CONTENT_LENGTH."""
    try:
        content_length = int(os.environ.get("CONTENT_LENGTH", 0))
    except (ValueError, TypeError):
        content_length = 0
    if content_length > 0:
        return sys.stdin.read(content_length)
    return ""


def sig_overlap(headers_a, rows_a, headers_b, rows_b):
    """
    Compute table signature overlap score.
    60% weight on header match, 40% weight on row label match.
    Returns float in [0.0, 1.0].
    """
    def jaccard(set_a, set_b):
        if not set_a and not set_b:
            return 1.0
        if not set_a or not set_b:
            return 0.0
        a = set(str(x).strip().lower() for x in set_a if str(x).strip())
        b = set(str(x).strip().lower() for x in set_b if str(x).strip())
        if not a and not b:
            return 1.0
        intersection = len(a & b)
        union = len(a | b)
        return intersection / union if union > 0 else 0.0

    h_score = jaccard(headers_a, headers_b)
    r_score = jaccard(rows_a, rows_b)
    return 0.6 * h_score + 0.4 * r_score


# ─────────────────────────────────────────────
# Route handlers
# ─────────────────────────────────────────────

def handle_companies_search(params):
    """Fuzzy search companies by ticker or name using SEC company_tickers.json."""
    q = params.get("q", "").strip().upper()
    if not q:
        return send_json([])

    try:
        tickers_data = load_company_tickers()
    except Exception as e:
        return send_error(f"Failed to load company tickers: {e}")

    results = []
    for entry in tickers_data.values():
        ticker = str(entry.get("ticker", "")).upper()
        name = str(entry.get("title", entry.get("name", "")))
        cik = entry.get("cik_str", entry.get("cik", ""))

        # Score candidates
        name_upper = name.upper()
        score = 999
        if ticker == q:
            score = 0
        elif ticker.startswith(q):
            score = 1
        elif name_upper.startswith(q):
            score = 2
        elif q in ticker:
            score = 3
        elif q in name_upper:
            score = 4
        elif any(w.startswith(q) for w in name_upper.split()):
            score = 5
        else:
            dist = levenshtein(q, ticker)
            threshold = max(2, len(q) // 2)
            if dist <= threshold:
                score = 6 + dist

        if score < 999:
            results.append({
                "ticker": ticker,
                "name": name,
                "cik": str(cik),
                "_score": score,
            })

    results.sort(key=lambda x: x["_score"])
    results = results[:10]
    for r in results:
        del r["_score"]

    send_json(results)


def handle_companies_profile(params):
    """Get company profile via fiscal.ai."""
    ticker = params.get("ticker", "").upper()
    if not ticker:
        return send_error("ticker is required", 400)
    try:
        data = fiscal_get(f"/company/profile", {"ticker": ticker})
        send_json(data)
    except urllib.error.HTTPError as e:
        send_error(f"fiscal.ai error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_companies_filings(params):
    """Get company filings via fiscal.ai."""
    ticker = params.get("ticker", "").upper()
    if not ticker:
        return send_error("ticker is required", 400)
    try:
        data = fiscal_get(f"/company/filings", {"ticker": ticker})
        send_json(data)
    except urllib.error.HTTPError as e:
        send_error(f"fiscal.ai error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_edgar_filings(params):
    """Get company filing list via EDGAR submissions API."""
    ticker = params.get("ticker", "").upper()
    if not ticker:
        return send_error("ticker is required", 400)

    # Look up CIK from company_tickers.json
    cik = None
    try:
        tickers_data = load_company_tickers()
        for entry in tickers_data.values():
            if str(entry.get("ticker", "")).upper() == ticker:
                cik = str(entry.get("cik_str", entry.get("cik", ""))).zfill(10)
                break
    except Exception:
        pass

    if not cik:
        return send_error(f"CIK not found for ticker: {ticker}", 404)

    try:
        url = f"https://data.sec.gov/submissions/CIK{cik}.json"
        raw = edgar_get(url)
        data = json.loads(raw.decode("utf-8"))
        recent = data.get("filings", {}).get("recent", {})
        filings = []
        forms = recent.get("form", [])
        for i in range(len(forms)):
            filings.append({
                "secFormType": forms[i],
                "formType": forms[i],
                "filingDate": recent.get("filingDate", [])[i] if i < len(recent.get("filingDate", [])) else "",
                "reportDate": recent.get("reportDate", [])[i] if i < len(recent.get("reportDate", [])) else "",
                "filingId": recent.get("accessionNumber", [])[i] if i < len(recent.get("accessionNumber", [])) else "",
                "primaryDocument": recent.get("primaryDocument", [])[i] if i < len(recent.get("primaryDocument", [])) else "",
                "description": recent.get("primaryDocDescription", [])[i] if i < len(recent.get("primaryDocDescription", [])) else forms[i],
                "items": recent.get("items", [])[i] if i < len(recent.get("items", [])) else "",
            })
        send_json({
            "cik": cik,
            "name": data.get("name", ""),
            "filings": filings,
        })
    except urllib.error.HTTPError as e:
        send_error(f"EDGAR error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_financials(params):
    """Get company financials via fiscal.ai."""
    ticker = params.get("ticker", "").upper()
    if not ticker:
        return send_error("ticker is required", 400)
    try:
        data = fiscal_get("/company/financials", {"ticker": ticker})
        send_json(data)
    except urllib.error.HTTPError as e:
        send_error(f"fiscal.ai error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_ratios(params):
    """Get company ratios via fiscal.ai."""
    ticker = params.get("ticker", "").upper()
    if not ticker:
        return send_error("ticker is required", 400)
    try:
        data = fiscal_get("/company/ratios", {"ticker": ticker})
        send_json(data)
    except urllib.error.HTTPError as e:
        send_error(f"fiscal.ai error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_stock(params):
    """Get stock prices via fiscal.ai."""
    ticker = params.get("ticker", "").upper()
    if not ticker:
        return send_error("ticker is required", 400)
    try:
        data = fiscal_get("/company/stock", {"ticker": ticker})
        send_json(data)
    except urllib.error.HTTPError as e:
        send_error(f"fiscal.ai error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_shares(params):
    """Get shares outstanding via fiscal.ai."""
    ticker = params.get("ticker", "").upper()
    if not ticker:
        return send_error("ticker is required", 400)
    try:
        data = fiscal_get("/company/shares", {"ticker": ticker})
        send_json(data)
    except urllib.error.HTTPError as e:
        send_error(f"fiscal.ai error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_segments(params):
    """Get company segments/KPIs via fiscal.ai."""
    ticker = params.get("ticker", "").upper()
    if not ticker:
        return send_error("ticker is required", 400)
    try:
        data = fiscal_get("/company/segments", {"ticker": ticker})
        send_json(data)
    except urllib.error.HTTPError as e:
        send_error(f"fiscal.ai error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_search(params):
    """EDGAR full-text search via EFTS API."""
    q = params.get("q", "")
    forms = params.get("forms", "")
    page = int(params.get("page", 0))
    start = page * 20

    efts_params = urllib.parse.urlencode({
        k: v for k, v in {
            "q": q,
            "forms": forms,
            "start": str(start),
        }.items() if v
    })

    url = f"https://efts.sec.gov/LATEST/search-index?{efts_params}"
    try:
        raw = edgar_get(url)
        data = json.loads(raw.decode("utf-8"))
        send_json(data)
    except urllib.error.HTTPError as e:
        send_error(f"EDGAR search error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_filing_doc(params):
    """Fetch a filing document from EDGAR by accession number + document name."""
    filing_id = params.get("filingId", "").replace("-", "")
    cik = params.get("cik", "")
    doc = params.get("doc", "")

    if not filing_id or not cik or not doc:
        return send_error("filingId, cik, and doc are required", 400)

    url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{filing_id}/{doc}"
    try:
        raw = edgar_get(url)
        send_json({"content": raw.decode("utf-8", errors="replace")})
    except urllib.error.HTTPError as e:
        send_error(f"EDGAR error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_filing_index(params):
    """Fetch filing index page from EDGAR."""
    filing_id = params.get("filingId", "").replace("-", "")
    cik = params.get("cik", "")
    accession_dashed = params.get("filingId", "")

    if not filing_id or not cik:
        return send_error("filingId and cik are required", 400)

    url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{filing_id}/{accession_dashed}-index.htm"
    try:
        raw = edgar_get(url)
        send_json({"html": raw.decode("utf-8", errors="replace")})
    except urllib.error.HTTPError as e:
        send_error(f"EDGAR error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_filing_pdf(params):
    """Return a redirect URL to the fiscal.ai PDF for a filing."""
    filing_id = params.get("filingId", "")
    ticker = params.get("ticker", "").upper()
    exchange = params.get("exchange", "")

    if not filing_id:
        return send_error("filingId is required", 400)

    company_key = f"{exchange}_{ticker}" if exchange and ticker else ticker
    pdf_url = f"https://api.fiscal.ai/v1/filing/{filing_id}/pdf?companyKey={company_key}&apiKey={FISCAL_API_KEY}"
    send_json({"pdfUrl": pdf_url})


def handle_edgar_proxy(params):
    """CORS bypass proxy for SEC EDGAR URLs."""
    url = params.get("url", "")
    if not url:
        return send_error("url parameter is required", 400)

    # Only allow SEC.gov URLs for security
    parsed = urllib.parse.urlparse(url)
    allowed_hosts = {"www.sec.gov", "data.sec.gov", "efts.sec.gov"}
    if parsed.netloc not in allowed_hosts:
        return send_error(f"Proxying only allowed for SEC.gov domains, got: {parsed.netloc}", 403)

    try:
        raw = edgar_get(url)
        try:
            data = json.loads(raw.decode("utf-8"))
            send_json(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            # Return raw text for HTML responses
            send_json({"content": raw.decode("utf-8", errors="replace")})
    except urllib.error.HTTPError as e:
        send_error(f"EDGAR proxy error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_edgar_document(params):
    """
    Fetch full filing HTML from EDGAR Archives, strip XBRL inline tags,
    rewrite relative URLs to absolute SEC paths, gzip-compress+base64-encode,
    and return JSON {"html_b64gz": "..."}.

    This reduces ~2MB raw HTML to ~256KB encoded, suitable for efficient
    transfer and client-side decompression.
    """
    cik = params.get("cik", "")
    accession = params.get("accession", "").replace("-", "")
    filename = params.get("filename", "")

    if not cik or not accession or not filename:
        return send_error("cik, accession, and filename are required", 400)

    url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{filename}"
    try:
        raw = edgar_get(url)
        html = raw.decode("utf-8", errors="replace")

        # Strip XBRL inline tags (ix:* namespace elements), keep inner content
        html = re.sub(r"<ix:[^>]+>", "", html, flags=re.IGNORECASE)
        html = re.sub(r"</ix:[^>]+>", "", html, flags=re.IGNORECASE)
        # Strip ix:header sections entirely
        html = re.sub(r"<ix:header[\s\S]*?</ix:header>", "", html, flags=re.IGNORECASE)

        # Rewrite relative URLs to absolute SEC paths
        base_path = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/"
        html = re.sub(
            r'(href|src)="(?!https?://|//|#|mailto:)([^"]*)"',
            lambda m: f'{m.group(1)}="{base_path}{m.group(2)}"',
            html,
        )

        # Gzip-compress and base64-encode
        compressed = gzip.compress(html.encode("utf-8"))
        encoded = base64.b64encode(compressed).decode("ascii")

        send_json({"html_b64gz": encoded})
    except urllib.error.HTTPError as e:
        send_error(f"EDGAR document error: {e.code} {e.reason}", e.code)
    except Exception as e:
        send_error(str(e))


def handle_tables_similar(params):
    """
    GET endpoint: find similar tables in the SQLite DB.
    Query params: headers (JSON array), row_labels (JSON array), ticker (optional filter)
    Returns list of {filing_id, ticker, form_type, filed_date, table_idx, score, headers, row_labels}
    sorted by score descending, threshold 0.25.
    """
    try:
        headers = json.loads(params.get("headers", "[]"))
        row_labels = json.loads(params.get("row_labels", "[]"))
    except json.JSONDecodeError:
        return send_error("headers and row_labels must be valid JSON arrays", 400)

    ticker_filter = params.get("ticker", "").upper() or None
    _find_and_return_similar(headers, row_labels, ticker_filter)


def handle_tables_find_similar(body_str):
    """
    POST endpoint: find similar tables in the SQLite DB.
    Reads JSON body: {headers: [...], row_labels: [...], ticker?: "..."}
    Returns list of {filing_id, ticker, form_type, filed_date, table_idx, score, headers, row_labels}
    sorted by score descending, threshold 0.25.
    """
    try:
        body = json.loads(body_str) if body_str else {}
    except json.JSONDecodeError:
        return send_error("Invalid JSON body", 400)

    headers = body.get("headers", [])
    row_labels = body.get("row_labels", [])
    ticker_filter = str(body.get("ticker", "")).upper() or None

    _find_and_return_similar(headers, row_labels, ticker_filter)


def _find_and_return_similar(headers, row_labels, ticker_filter=None):
    """Shared logic for similar-table lookup."""
    SIMILARITY_THRESHOLD = 0.25

    if not os.path.exists(TABLES_DB):
        return send_json([])

    try:
        import sqlite3
        conn = sqlite3.connect(TABLES_DB)
        conn.row_factory = sqlite3.Row

        if ticker_filter:
            rows = conn.execute(
                "SELECT * FROM tables WHERE ticker = ?", (ticker_filter,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM tables").fetchall()

        conn.close()

        results = []
        for row in rows:
            try:
                db_headers = json.loads(row["headers"]) if row["headers"] else []
                db_row_labels = json.loads(row["row_labels"]) if row["row_labels"] else []
            except (json.JSONDecodeError, KeyError):
                continue

            score = sig_overlap(headers, row_labels, db_headers, db_row_labels)
            if score >= SIMILARITY_THRESHOLD:
                results.append({
                    "filing_id": row["filing_id"],
                    "ticker": row["ticker"],
                    "form_type": row["form_type"],
                    "filed_date": row["filed_date"],
                    "table_idx": row["table_idx"],
                    "score": round(score, 4),
                    "headers": db_headers,
                    "row_labels": db_row_labels,
                    "row_count": row["row_count"] if "row_count" in row.keys() else 0,
                })

        results.sort(key=lambda x: x["score"], reverse=True)
        send_json(results)
    except Exception as e:
        send_error(f"Database error: {e}")


# ─────────────────────────────────────────────
# Main router
# ─────────────────────────────────────────────
def main():
    method = os.environ.get("REQUEST_METHOD", "GET").upper()
    path = os.environ.get("PATH_INFO", "/").rstrip("/") or "/"
    qs = os.environ.get("QUERY_STRING", "")
    params = parse_qs(qs)

    # CORS preflight
    if method == "OPTIONS":
        print("Status: 204")
        print("Access-Control-Allow-Origin: *")
        print("Access-Control-Allow-Methods: GET, POST, OPTIONS")
        print("Access-Control-Allow-Headers: Content-Type")
        print()
        return

    # Route dispatch
    if path == "/companies/search":
        handle_companies_search(params)

    elif path == "/companies/profile":
        handle_companies_profile(params)

    elif path == "/companies/filings":
        handle_companies_filings(params)

    elif path == "/edgar/filings":
        handle_edgar_filings(params)

    elif path == "/financials":
        handle_financials(params)

    elif path == "/ratios":
        handle_ratios(params)

    elif path == "/stock":
        handle_stock(params)

    elif path == "/shares":
        handle_shares(params)

    elif path == "/segments":
        handle_segments(params)

    elif path == "/search":
        handle_search(params)

    elif path == "/filing/doc":
        handle_filing_doc(params)

    elif path == "/filing/index":
        handle_filing_index(params)

    elif path == "/filing/pdf":
        handle_filing_pdf(params)

    elif path == "/edgar/proxy":
        handle_edgar_proxy(params)

    elif path == "/edgar/document":
        handle_edgar_document(params)

    elif path == "/tables/similar":
        if method == "POST":
            body = read_body()
            handle_tables_find_similar(body)
        else:
            handle_tables_similar(params)

    elif path == "/tables/find-similar":
        if method == "POST":
            body = read_body()
            handle_tables_find_similar(body)
        else:
            send_error("Method not allowed — use POST", 405)

    else:
        send_error(f"Not found: {path}", 404)


if __name__ == "__main__":
    main()
