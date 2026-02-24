/* ============================================================
   WamSEC — Single Page Application
   Complete router + all page logic
   ============================================================ */

(function () {
  'use strict';

  // ===========================================================
  // CONFIG
  // ===========================================================
  const API = 'cgi-bin/api.py';
  const FISCAL_API_KEY = '1b665ff8-a5e1-4332-9604-1cd00bb65355';
  const SEC_PROXY = 'https://sec-proxy.perplexity-ai.workers.dev';

  // ===========================================================
  // STATE (in-memory only, no persistent storage)
  // ===========================================================
  const state = {
    auth: { loggedIn: false, user: null },
    watchList: [],
    highlights: [
      { id: 'hl1', ticker: 'META', filingId: '0001628280-26-003942', formType: '10-K', date: '2026-01-28', color: 'yellow', text: 'Meta AI had over 700 million monthly active users globally, making it one of the most widely used AI assistants in the world.' },
      { id: 'hl2', ticker: 'META', filingId: '0001628280-26-003942', formType: '10-K', date: '2026-01-28', color: 'green', text: 'Capital expenditures were $47.8 billion in fiscal 2025, an increase from $37.7 billion in 2024.' },
      { id: 'hl3', ticker: 'META', filingId: '0001628280-26-003942', formType: '10-K', date: '2026-01-28', color: 'blue', text: 'We expect capital expenditures to be in the range of $60–65 billion in fiscal 2026, reflecting significant ongoing investment in AI infrastructure.' },
    ],
    recentSearches: [],
    alerts: [],
    filingCache: {},
    profileCache: {},
  };

  // ===========================================================
  // UTILITIES
  // ===========================================================
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];
  const content = () => $('#content');

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatDate(d) {
    if (!d) return '—';
    try {
      const dt = new Date(d);
      if (isNaN(dt)) return d;
      return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return d; }
  }

  /** Short date format like actaterm: MM/DD/YY */
  function formatDateShort(d) {
    if (!d) return '—';
    try {
      const dt = new Date(d);
      if (isNaN(dt)) return d;
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      const yy = String(dt.getFullYear()).slice(-2);
      return `${mm}/${dd}/${yy}`;
    } catch { return d; }
  }

  function formatNumber(n) {
    if (n == null || n === '') return '—';
    const num = Number(n);
    if (isNaN(num)) return n;
    if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return num.toLocaleString();
  }

  function formatMoney(n) {
    if (n == null) return '—';
    return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Decompress a gzip+base64 encoded string using browser DecompressionStream API */
  async function decompressGzipBase64(b64String) {
    const binaryStr = atob(b64String);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(combined);
  }

  function showToast(msg, type = '') {
    const c = $('#toastContainer');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.remove(); }, 3000);
  }

  // ===========================================================
  // EMBEDDED DATA HELPERS
  // ===========================================================
  function waitForEmbeddedData(timeout = 5000) {
    return new Promise((resolve) => {
      if (window.__EMBEDDED_DATA_LOADED) { resolve(); return; }
      const start = Date.now();
      const interval = setInterval(() => {
        if (window.__EMBEDDED_DATA_LOADED || Date.now() - start > timeout) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });
  }

  function getEmbeddedData() {
    return window.__EMBEDDED_DATA || null;
  }

  function getEmbeddedCompany(ticker) {
    const data = getEmbeddedData();
    if (!data || !data.companies) return null;
    return data.companies[ticker.toUpperCase()] || null;
  }

  // ===========================================================
  // FILING CATEGORIES (module-scope so doc viewer can access)
  // ===========================================================
  const FILING_CATEGORIES = [
    {
      key: 'financials',
      label: 'Financials',
      icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M2 7h20M7 3v14"/></svg>`,
      forms: ['10-K', '10-K/A', '10-KSB', '10-Q', '10-Q/A', '10-QSB', '20-F', '20-F/A', '40-F', '6-K', 'NT 10-K', 'NT 10-Q', 'ARS'],
      desc: {
        '10-K': 'Annual Report', '10-K/A': 'Annual Report (Amended)', '10-KSB': 'Annual Report (Small)',
        '10-Q': 'Quarterly Report', '10-Q/A': 'Quarterly Report (Amended)', '10-QSB': 'Quarterly Report (Small)',
        '20-F': 'Annual Report (Foreign)', '20-F/A': 'Annual Report (Foreign, Amended)',
        '40-F': 'Annual Report (Canadian)', '6-K': 'Foreign Report',
        'NT 10-K': 'Late 10-K Notice', 'NT 10-Q': 'Late 10-Q Notice', 'ARS': 'Annual Report to Shareholders'
      }
    },
    {
      key: 'news',
      label: 'News (8-K)',
      icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
      forms: ['8-K', '8-K/A', '8-K12B', '8-K12G3', '8-K15D5', 'FWP', '6-K'],
      desc: {
        '8-K': 'Current Report', '8-K/A': 'Current Report (Amended)',
        '8-K12B': 'Current Report (Initial)', '8-K12G3': 'Current Report (Registration)',
        '8-K15D5': 'Current Report', 'FWP': 'Free Writing Prospectus'
      }
    },
    {
      key: 'prospectus',
      label: 'Prospectus & Registrations',
      icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>`,
      forms: ['S-1', 'S-1/A', 'S-3', 'S-3/A', 'S-3ASR', 'S-4', 'S-4/A', 'S-8', 'S-8 POS', 'S-11',
              '424B1', '424B2', '424B3', '424B4', '424B5', '424B7', '424B8',
              'F-1', 'F-1/A', 'F-3', 'F-3/A', 'F-4', 'F-6',
              'EFFECT', 'POS AM', 'RW', 'AW'],
      desc: {
        'S-1': 'Registration Statement', 'S-1/A': 'Registration (Amended)', 'S-3': 'Shelf Registration',
        'S-3/A': 'Shelf Registration (Amended)', 'S-3ASR': 'Automatic Shelf Registration',
        'S-4': 'Business Combination Reg.', 'S-4/A': 'Business Combination Reg. (Amended)',
        'S-8': 'Employee Benefits Reg.', 'S-8 POS': 'Employee Benefits (Post-Eff.)',
        '424B1': 'Prospectus Filing', '424B2': 'Prospectus Filing', '424B3': 'Prospectus Filing',
        '424B4': 'Prospectus Filing', '424B5': 'Prospectus Filing', '424B7': 'Prospectus Filing',
        '424B8': 'Prospectus Filing',
        'F-1': 'Foreign Registration', 'F-3': 'Foreign Shelf Reg.',
        'EFFECT': 'Effective Notice', 'POS AM': 'Post-Effective Amendment'
      }
    },
    {
      key: 'proxies',
      label: 'Proxies',
      icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>`,
      forms: ['DEF 14A', 'DEFA14A', 'DEFC14A', 'DEFM14A', 'DEFN14A', 'DEFR14A',
              'PRE 14A', 'PREA14A', 'PREC14A', 'PREM14A', 'PREN14A', 'PRER14A',
              'PX14A6G', 'PX14A6N', 'DFAN14A', 'DFRN14A'],
      desc: {
        'DEF 14A': 'Definitive Proxy Statement', 'DEFA14A': 'Additional Proxy Materials',
        'DEFC14A': 'Proxy Contest Materials', 'DEFM14A': 'Merger Proxy',
        'PRE 14A': 'Preliminary Proxy', 'PREA14A': 'Preliminary Additional Proxy',
        'PX14A6G': 'Notice of Exempt Solicitation', 'PX14A6N': 'Notice of Exempt Solicitation',
        'DFAN14A': 'Additional Proxy Soliciting'
      }
    },
    {
      key: 'ma',
      label: 'M&A Deals',
      icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="12" r="5"/><circle cx="16" cy="12" r="5"/></svg>`,
      forms: ['S-4', 'S-4/A', 'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A',
              'SCHEDULE 13G', 'SCHEDULE 13G/A', 'SCHEDULE 13D', 'SCHEDULE 13D/A',
              'SC 14D9', 'SC 14D9/A', 'SC TO-T', 'SC TO-T/A', 'SC TO-I', 'SC TO-I/A',
              'SC 14F1', '425', 'DEFM14A', 'PREM14A', 'CB'],
      desc: {
        'S-4': 'Business Combination Reg.', 'SC 13D': 'Beneficial Ownership (>5%)',
        'SC 13D/A': 'Beneficial Ownership (Amended)', 'SC 13G': 'Passive Beneficial Ownership',
        'SC 13G/A': 'Passive Ownership (Amended)',
        'SC 14D9': 'Tender Offer Response', 'SC TO-T': 'Tender Offer (Third-Party)',
        '425': 'Communication Under Rule 425', 'DEFM14A': 'Merger Proxy Statement',
        'CB': 'Cross-Border Transaction'
      }
    },
    {
      key: 'ownership',
      label: 'Ownership',
      icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
      forms: ['3', '3/A', '4', '4/A', '5', '5/A',
              'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A',
              'SCHEDULE 13G', 'SCHEDULE 13G/A', 'SCHEDULE 13D', 'SCHEDULE 13D/A',
              '13F-HR', '13F-HR/A', '13F-NT', '144'],
      desc: {
        '3': 'Initial Ownership Statement', '3/A': 'Initial Ownership (Amended)',
        '4': 'Change in Ownership', '4/A': 'Change in Ownership (Amended)',
        '5': 'Annual Ownership Statement', '5/A': 'Annual Ownership (Amended)',
        'SC 13D': 'Beneficial Ownership (>5%)', 'SC 13G': 'Passive Beneficial Ownership',
        'SCHEDULE 13G': 'Passive Beneficial Ownership', 'SCHEDULE 13G/A': 'Passive Ownership (Amended)',
        '13F-HR': 'Institutional Holdings', '13F-HR/A': 'Institutional Holdings (Amended)',
        '13F-NT': 'Institutional Holdings Notice',
        '144': 'Notice of Proposed Sale'
      }
    }
  ];

  // 8-K item number to human-readable description mapping
  const ITEM_8K_DESCRIPTIONS = {
    '1.01': 'Entry into a Material Definitive Agreement',
    '1.02': 'Termination of a Material Definitive Agreement',
    '1.03': 'Bankruptcy or Receivership',
    '1.04': 'Mine Safety',
    '2.01': 'Completion of Acquisition or Disposition of Assets',
    '2.02': 'Results of Operations and Financial Condition',
    '2.03': 'Creation of a Direct Financial Obligation',
    '2.04': 'Triggering Events That Accelerate Obligations',
    '2.05': 'Costs Associated with Exit or Disposal Activities',
    '2.06': 'Material Impairments',
    '3.01': 'Notice of Delisting',
    '3.02': 'Unregistered Sales of Equity Securities',
    '3.03': 'Material Modification to Rights of Security Holders',
    '4.01': 'Changes in Registrant\'s Certifying Accountant',
    '4.02': 'Non-Reliance on Previously Issued Financial Statements',
    '5.01': 'Changes in Control of Registrant',
    '5.02': 'Change in Directors, Officers or Compensation',
    '5.03': 'Amendments to Articles of Incorporation or Bylaws',
    '5.04': 'Temporary Suspension of Trading Under Benefit Plans',
    '5.05': 'Amendments to Code of Ethics',
    '5.06': 'Change in Shell Company Status',
    '5.07': 'Submission of Matters to a Vote of Security Holders',
    '5.08': 'Shareholder Nominations',
    '6.01': 'ABS Informational and Computational Material',
    '6.02': 'Change of Servicer or Trustee',
    '6.03': 'Change in Credit Enhancement',
    '6.04': 'Failure to Make a Required Distribution',
    '6.05': 'Securities Act Updating Disclosure',
    '7.01': 'Regulation FD Disclosure',
    '8.01': 'Other Events',
    '9.01': 'Financial Statements and Exhibits',
  };

  /** Get a rich description for 8-K filings based on item numbers */
  function get8KDescription(items) {
    if (!items) return '';
    const itemList = items.split(',').map(s => s.trim()).filter(Boolean);
    // Prefer the most informative item (skip 9.01 which is just exhibits)
    for (const item of itemList) {
      if (item !== '9.01' && ITEM_8K_DESCRIPTIONS[item]) {
        return ITEM_8K_DESCRIPTIONS[item];
      }
    }
    // Fall back to first item
    if (itemList.length && ITEM_8K_DESCRIPTIONS[itemList[0]]) {
      return ITEM_8K_DESCRIPTIONS[itemList[0]];
    }
    return '';
  }

  /** Extract owner name from Form 3/4/5 primaryDocument filename.
   *  Patterns like: xslF345X05/dp241880_4-mahoney.xml → Mahoney
   *  Or: wf-form4_173973908782476.htm → empty (no name)
   */
  function extractOwnerName(primaryDocument) {
    if (!primaryDocument) return '';
    // Common pattern: ..._4-lastname.xml or ..._3-lastname.xml
    const dashMatch = primaryDocument.match(/[-_](?:3|4|5)-([a-zA-Z]+)/i);
    if (dashMatch && dashMatch[1]) {
      const name = dashMatch[1];
      // Capitalize first letter
      return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }
    return '';
  }

  /** Get a human-readable description for SEC form types */
  const FORM_DESCRIPTIONS = {
    'S-8': 'Registration of securities for employees',
    'S-8 POS': 'Post-effective amendment to S-8',
    'S-1': 'Registration statement (IPO)',
    'S-1/A': 'Amendment to registration statement',
    'S-3': 'Registration of securities (shelf)',
    'S-3/A': 'Amendment to shelf registration',
    'S-4': 'Registration for business combinations',
    'F-1': 'Foreign private issuer registration',
    'F-3': 'Foreign private issuer shelf registration',
    '424B2': 'Prospectus for primary offering',
    '424B4': 'Prospectus for primary offering',
    '424B5': 'Prospectus supplement',
    'FWP': 'Free writing prospectus',
    'PX14A6G': 'Letter to shareholders',
    'DEFA14A': 'Additional proxy soliciting materials',
    'DEF 14A': 'Definitive proxy statement',
    'DFAN14A': 'Definitive additional soliciting materials',
    'PRE 14A': 'Preliminary proxy statement',
    'SC 13D': 'Beneficial ownership report (>5%)',
    'SC 13D/A': 'Amendment to beneficial ownership report',
    'SC 13G': 'Passive investor ownership report',
    'SC 13G/A': 'Amendment to passive ownership report',
    'SD': 'Conflict minerals disclosure',
    'ARS': 'Annual report to shareholders',
    '144': 'Notice of proposed sale of securities',
    '3': 'Initial statement of beneficial ownership',
    '4': 'Change in beneficial ownership',
    '5': 'Annual statement of changes in ownership',
    '13F-HR': 'Institutional investment manager report',
    '13F-HR/A': 'Amendment to institutional holdings report',
    'NT 10-K': 'Notification of late 10-K filing',
    'NT 10-Q': 'Notification of late 10-Q filing',
    '8-A12B': 'Registration of securities under Exchange Act',
    'CT ORDER': 'Court order',
    '25-NSE': 'Notification of delisting',
    'CORRESP': 'SEC correspondence',
    'UPLOAD': 'SEC uploaded document',
    'DEFA14C': 'Information statement (additional materials)',
    'DEF 14C': 'Definitive information statement',
    'PRE 14C': 'Preliminary information statement',
    'PRER14A': 'Preliminary revised proxy statement',
    'SC TO-I': 'Tender offer statement by issuer',
    'SC TO-I/A': 'Amendment to tender offer statement',
    'SC 14D9': 'Solicitation/recommendation statement',
    'EFFECT': 'Registration effectiveness notice',
    '8-K/A': 'Amendment to current report',
    '10-K/A': 'Amendment to annual report',
    '10-Q/A': 'Amendment to quarterly report',
    'S-3ASR': 'Automatic shelf registration',
    '6-K': 'Foreign private issuer current report',
    '20-F': 'Foreign private issuer annual report',
    '40-F': 'Canadian issuer annual report',
  };

  /** Get rich description for a filing */
  function getFilingRichDescription(f, cat) {
    const ft = (f.secFormType || f.formType || f.type || '').toUpperCase().trim();
    const reportDate = f.reportDate || '';
    
    // 10-K: FY year ended date
    if (ft === '10-K' && reportDate) {
      const yr = reportDate.split('-')[0];
      return `FY ${yr}    ended ${formatDateShort(reportDate)}`;
    }
    // 10-Q: Quarter ended date
    if (ft === '10-Q' && reportDate) {
      const month = parseInt(reportDate.split('-')[1] || '0');
      const qtr = month <= 3 ? 'Q1' : month <= 6 ? 'Q2' : month <= 9 ? 'Q3' : 'Q4';
      return `${qtr}    ended ${formatDateShort(reportDate)}`;
    }
    // 8-K: item-based description
    if (ft === '8-K' && f.items) {
      const itemDesc = get8KDescription(f.items);
      if (itemDesc) return itemDesc;
    }
    // Form 3/4/5: extract owner name
    if (['3', '4', '5'].includes(ft)) {
      const ownerName = extractOwnerName(f.primaryDocument);
      if (ownerName) return ownerName;
    }
    // Check FORM_DESCRIPTIONS map
    if (FORM_DESCRIPTIONS[ft]) return FORM_DESCRIPTIONS[ft];
    // Also check with original case
    const ftOrig = (f.secFormType || f.formType || f.type || '').trim();
    if (FORM_DESCRIPTIONS[ftOrig]) return FORM_DESCRIPTIONS[ftOrig];
    // Fall back to description from data
    return f.description || f.primaryDocDescription || getFilingDescription(ft, cat);
  }

  function categorizeFiling(f) {
    const ft = (f.secFormType || f.formType || f.type || '').toUpperCase().trim();
    const cats = [];
    for (const cat of FILING_CATEGORIES) {
      if (cat.forms.some(cf => ft === cf.toUpperCase())) cats.push(cat.key);
    }
    return cats.length ? cats : ['other'];
  }

  function getFilingDescription(ft, cat) {
    const ftUpper = ft.toUpperCase().trim();
    if (cat && cat.desc) {
      // Try exact match first, then case-insensitive
      for (const [k, v] of Object.entries(cat.desc)) {
        if (k.toUpperCase() === ftUpper) return v;
      }
    }
    // Fallbacks
    const defaultDescs = {
      '10-K': 'Annual Report', '10-Q': 'Quarterly Report', '8-K': 'Current Report',
      '4': 'Statement of Changes in Ownership', '3': 'Initial Statement of Ownership',
      'DEF 14A': 'Definitive Proxy Statement', 'S-8': 'Registration Statement',
      'SC 13G': 'Passive Beneficial Ownership', 'SC 13G/A': 'Passive Ownership (Amended)',
    };
    for (const [k, v] of Object.entries(defaultDescs)) {
      if (k.toUpperCase() === ftUpper) return v;
    }
    return ft;
  }

  // ===========================================================
  // API HELPERS (embedded data first, API fallback)
  // ===========================================================
  async function apiFetch(path, params = {}, retries = 1) {
    const qs = new URLSearchParams(params).toString();
    const url = `${API}${path}${qs ? '?' + qs : ''}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url);
        const text = await res.text();
        if (!res.ok) {
          let errMsg;
          try { errMsg = JSON.parse(text).error; } catch { errMsg = res.statusText; }
          if (attempt < retries && res.status >= 500) continue;
          throw new Error(errMsg || `HTTP ${res.status}`);
        }
        try { return JSON.parse(text); }
        catch { return text; }
      } catch (err) {
        if (attempt < retries) continue;
        throw err;
      }
    }
  }

  // Fuzzy matching helper — simple Levenshtein distance
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  async function searchCompanies(q) {
    if (!q || q.length < 1) return [];
    const query = q.toUpperCase().trim();

    // Build combined search index from embedded data + company_tickers.json
    let searchIndex = [];
    const data = getEmbeddedData();
    if (data && data.searchIndex) {
      searchIndex = [...data.searchIndex];
    }

    // Load company_tickers from global (loaded via <script> tag)
    if (window.__COMPANY_TICKERS__) {
      const existingTickers = new Set(searchIndex.map(c => c.ticker.toUpperCase()));
      for (const [ticker, entry] of Object.entries(window.__COMPANY_TICKERS__)) {
        if (!existingTickers.has(ticker)) {
          searchIndex.push({
            ticker: ticker,
            name: entry.name || ticker,
            cik: entry.cik,
          });
        }
      }
    }

    if (searchIndex.length > 0) {
      const scored = searchIndex.map(c => {
        const t = c.ticker.toUpperCase();
        const n = c.name.toUpperCase();
        let score = 999;
        if (t === query) score = 0;
        else if (t.startsWith(query)) score = 1;
        else if (n.startsWith(query)) score = 2;
        else if (t.includes(query)) score = 3;
        else if (n.includes(query)) score = 4;
        else if (n.split(/\s+/).some(w => w.startsWith(query))) score = 5;
        else {
          const dist = levenshtein(query, t);
          const threshold = Math.max(2, Math.floor(query.length * 0.5));
          if (dist <= threshold) score = 6 + dist;
        }
        if (score >= 999) {
          const words = n.split(/\s+/);
          for (const w of words) {
            const dist = levenshtein(query, w.substring(0, query.length + 2));
            if (dist <= 2) { score = 8 + dist; break; }
          }
        }
        return { ...c, _score: score };
      });
      const results = scored
        .filter(c => c._score < 999)
        .sort((a, b) => a._score - b._score)
        .slice(0, 10)
        .map(({ _score, ...c }) => c);
      if (results.length > 0) return results;
    }
    try { return await apiFetch('/companies/search', { q }); }
    catch { return []; }
  }

  async function getProfile(ticker) {
    if (state.profileCache[ticker]) return state.profileCache[ticker];
    try {
      const embedded = getEmbeddedCompany(ticker);
      if (embedded && embedded.profile) {
        state.profileCache[ticker] = embedded.profile;
        return embedded.profile;
      }
    } catch(e) { console.error('Embedded profile error:', e); }

    // Try SEC EDGAR submissions API for company info (via proxy for CORS/UA reliability)
    try {
      const cikPadded = await getCIK(ticker);
      if (cikPadded) {
        const secUrl = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;
        // Try direct first (data.sec.gov has CORS), fall back to proxy
        let resp;
        try {
          resp = await fetch(secUrl);
        } catch(e) { resp = null; }
        if (!resp || !resp.ok) {
          resp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(secUrl)}`);
        }
        if (resp.ok) {
          const data = await resp.json();
          const profile = {
            name: data.name || ticker,
            companyName: data.name || ticker,
            ticker: ticker,
            cik: cikPadded,
            sic: data.sic || '',
            sicDescription: data.sicDescription || '',
            exchange: data.exchanges?.[0] || '',
            exchangeName: data.exchanges?.[0] || '',
            sector: data.sicDescription || '',
            stateOfIncorporation: data.stateOfIncorporation || '',
            fiscalYearEnd: data.fiscalYearEnd || '',
            website: data.website || '',
            ein: data.ein || '',
          };
          state.profileCache[ticker] = profile;
          return profile;
        }
      }
    } catch(e) { console.warn('SEC profile fetch error:', e); }

    try {
      const data = await apiFetch('/companies/profile', { ticker });
      state.profileCache[ticker] = data;
      return data;
    } catch {
      return { name: ticker, ticker: ticker };
    }
  }

  async function getFilings(ticker) {
    if (state.filingCache[ticker]) return state.filingCache[ticker];

    // Try embedded data first
    let embeddedFilings = [];
    try {
      const embedded = getEmbeddedCompany(ticker);
      if (embedded && embedded.filings && embedded.filings.length > 0) {
        embeddedFilings = embedded.filings;
      }
    } catch(e) { console.error('Embedded filings error:', e); }

    // Note: Even if we have embedded data, we try to fetch from EDGAR
    // to get enrichment fields like 'items' for 8-K descriptions

    // Try CGI proxy to SEC EDGAR for complete filing history
    let edgarFilings = [];
    try {
      const data = await apiFetch('/edgar/filings', { ticker });
      edgarFilings = data.filings || [];
    } catch(e) { console.warn('CGI EDGAR proxy error:', e); }

    // Also try direct SEC EDGAR fetch, with proxy fallback
    if (!edgarFilings.length) {
      try {
        const cik = await getCIK(ticker);
        if (cik) {
          const secUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
          let resp;
          try {
            resp = await fetch(secUrl);
          } catch(e) { resp = null; }
          if (!resp || !resp.ok) {
            resp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(secUrl)}`);
          }
          if (resp.ok) {
            const data = await resp.json();
            const recent = data.filings?.recent;
            if (recent && recent.form) {
              for (let i = 0; i < recent.form.length; i++) {
                edgarFilings.push({
                  secFormType: recent.form[i],
                  formType: recent.form[i],
                  filingDate: recent.filingDate[i],
                  reportDate: recent.reportDate?.[i] || '',
                  filingId: recent.accessionNumber[i]?.replace(/-/g, '') ? recent.accessionNumber[i] : '',
                  primaryDocument: recent.primaryDocument?.[i] || '',
                  description: recent.primaryDocDescription?.[i] || recent.form[i],
                  items: recent.items?.[i] || '',
                });
              }
            }
          }
        }
      } catch(e) { console.warn('EDGAR filing fetch error:', e); }
    }

    // Merge: combine EDGAR + embedded, preserving EDGAR's items field
    let merged = edgarFilings.length ? edgarFilings : embeddedFilings;

    if (edgarFilings.length && embeddedFilings.length) {
      // Build maps for both sets
      const edgarMap = {};
      edgarFilings.forEach(f => { if (f.filingId) edgarMap[f.filingId] = f; });
      const embeddedMap = {};
      embeddedFilings.forEach(f => {
        const fid = f.filingId || f.id || '';
        if (fid) embeddedMap[fid] = f;
      });

      // Start with EDGAR filings enriched with embedded data
      merged = edgarFilings.map(ef => {
        const emb = embeddedMap[ef.filingId];
        if (emb) {
          const edgarItems = ef.items;
          const edgarPrimaryDoc = ef.primaryDocument;
          const edgarDesc = ef.description;
          const result = { ...emb, ...ef };
          if (edgarItems) result.items = edgarItems;
          if (edgarPrimaryDoc) result.primaryDocument = edgarPrimaryDoc;
          if (edgarDesc) result.description = edgarDesc;
          return result;
        }
        return ef;
      });

      // Append embedded filings NOT in EDGAR (older filings beyond recent window)
      const edgarIds = new Set(edgarFilings.map(f => f.filingId).filter(Boolean));
      embeddedFilings.forEach(f => {
        const fid = f.filingId || f.id || '';
        if (fid && !edgarIds.has(fid)) merged.push(f);
      });
    }

    // If no EDGAR results, try the API
    if (!merged.length) {
      try {
        const data = await apiFetch('/companies/filings', { ticker });
        merged = Array.isArray(data) ? data : (data?.filings || data?.data || []);
      } catch { /* fall through */ }
    }

    state.filingCache[ticker] = merged;
    return merged;
  }

  /** Look up CIK number for a ticker from embedded data, global tickers, or SEC */
  async function getCIK(ticker) {
    // Check embedded companies first
    const embedded = getEmbeddedCompany(ticker);
    if (embedded?.cik) return String(embedded.cik).padStart(10, '0');

    // Check in-memory cache from previous lookups
    if (state.cikCache && state.cikCache[ticker.toUpperCase()]) {
      return state.cikCache[ticker.toUpperCase()];
    }

    // Check global company tickers (loaded via <script> tag)
    if (window.__COMPANY_TICKERS__) {
      const entry = window.__COMPANY_TICKERS__[ticker.toUpperCase()];
      if (entry) {
        const cik = String(entry.cik).padStart(10, '0');
        if (!state.cikCache) state.cikCache = {};
        state.cikCache[ticker.toUpperCase()] = cik;
        return cik;
      }
    }

    // Fallback: fetch via Cloudflare Worker proxy
    try {
      const resp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent('https://www.sec.gov/files/company_tickers.json')}`);
      if (resp.ok) {
        const data = await resp.json();
        for (const entry of Object.values(data)) {
          if (entry.ticker && entry.ticker.toUpperCase() === ticker.toUpperCase()) {
            const cik = String(entry.cik_str).padStart(10, '0');
            if (!state.cikCache) state.cikCache = {};
            state.cikCache[ticker.toUpperCase()] = cik;
            return cik;
          }
        }
      }
    } catch(e) { console.warn('CIK lookup via proxy failed:', e); }
    return null;
  }

  async function edgarSearch(q, forms = '', page = 0) {
    const params = { q };
    if (forms) params.forms = forms;
    params.page = page;
    // Try CGI first, then fall back to CORS proxy to EDGAR full-text search
    try { return await apiFetch('/search', params); }
    catch(e) {
      console.warn('CGI search failed, trying CORS proxy:', e);
      const eftsParams = new URLSearchParams();
      if (q) eftsParams.set('q', q);
      if (forms) eftsParams.set('forms', forms);
      eftsParams.set('start', String((page || 0) * 20));
      const eftsUrl = `https://efts.sec.gov/LATEST/search-index?${eftsParams}`;
      const resp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(eftsUrl)}`);
      if (!resp.ok) throw new Error(`Search failed: HTTP ${resp.status}`);
      return await resp.json();
    }
  }

  // ===========================================================
  // BADGE HELPER
  // ===========================================================
  function badgeClass(formType) {
    if (!formType) return 'badge-default';
    const f = formType.toUpperCase().replace(/\//g, '').replace(/\s+/g, '');
    if (f.startsWith('10-K') || f.startsWith('10K') || f === '20-F' || f === '20F') return 'badge-10k';
    if (f.startsWith('10-Q') || f.startsWith('10Q')) return 'badge-10q';
    if (f.startsWith('8-K') || f.startsWith('8K')) return 'badge-8k';
    if (f.startsWith('S-1') || f.startsWith('S1') || f.startsWith('S-3') || f.startsWith('S3') || f.startsWith('S-4') || f.startsWith('S4')) return 'badge-s1';
    if (f.includes('DEF14A') || f.includes('DEF 14A') || f.includes('DEFA14A')) return 'badge-def14a';
    if (f.includes('SC13D') || f.includes('SC13G') || f.includes('SC 13D') || f.includes('SC 13G')) return 'badge-sc13';
    if (f === 'FORM3' || f === 'FORM4' || f === 'FORM5' || f === '3' || f === '4' || f === '5') return 'badge-insider';
    if (f.includes('13F')) return 'badge-13f';
    return 'badge-default';
  }

  function formBadge(formType) {
    return `<span class="badge ${badgeClass(formType)}">${escHtml(formType || 'Other')}</span>`;
  }

  // ===========================================================
  // ICONS (inline SVG)
  // ===========================================================
  const icons = {
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
    star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    starFilled: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    bell: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>',
    download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
    link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    chevronRight: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    chevronDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    arrowUp: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    arrowDown: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
    settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
    user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    mic: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    external: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  };

  // ===========================================================
  // AUTOCOMPLETE
  // ===========================================================
  function initAutocomplete(inputEl, dropdownEl, onSelect) {
    let idx = -1;
    let items = [];

    const search = debounce(async (q) => {
      if (q.length < 1) { dropdownEl.classList.remove('open'); return; }
      try {
        items = await searchCompanies(q);
        if (!items.length) { dropdownEl.classList.remove('open'); return; }
        idx = -1;
        renderDropdown();
        dropdownEl.classList.add('open');
      } catch { dropdownEl.classList.remove('open'); }
    }, 300);

    function renderDropdown() {
      dropdownEl.innerHTML = items.map((it, i) => `
        <div class="autocomplete-item${i === idx ? ' active' : ''}" data-idx="${i}">
          <span class="autocomplete-ticker">${escHtml(it.ticker)}</span>
          <span class="autocomplete-name">${escHtml(it.name)}</span>
        </div>`).join('');
    }

    inputEl.addEventListener('input', e => search(e.target.value.trim()));
    inputEl.addEventListener('keydown', e => {
      if (!dropdownEl.classList.contains('open')) {
        if (e.key === 'Enter') {
          const v = inputEl.value.trim();
          if (v) { navigate(`#/search?q=${encodeURIComponent(v)}`); dropdownEl.classList.remove('open'); }
        }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); renderDropdown(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); renderDropdown(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (idx >= 0 && items[idx]) { onSelect(items[idx]); dropdownEl.classList.remove('open'); inputEl.value = ''; }
        else {
          const v = inputEl.value.trim();
          if (v) { navigate(`#/search?q=${encodeURIComponent(v)}`); dropdownEl.classList.remove('open'); }
        }
      }
      else if (e.key === 'Escape') { dropdownEl.classList.remove('open'); }
    });

    dropdownEl.addEventListener('mousedown', e => {
      const item = e.target.closest('.autocomplete-item');
      if (item) {
        const i = Number(item.dataset.idx);
        if (items[i]) { onSelect(items[i]); dropdownEl.classList.remove('open'); inputEl.value = ''; }
      }
    });

    document.addEventListener('click', e => {
      if (!inputEl.contains(e.target) && !dropdownEl.contains(e.target)) {
        dropdownEl.classList.remove('open');
      }
    });
  }

  // ===========================================================
  // TABLE SORTING
  // ===========================================================
  function initTableSort(tableEl) {
    const headers = $$('th[data-sort]', tableEl);
    let sortCol = null, sortDir = 'asc';
    headers.forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortCol = col; sortDir = 'asc'; }
        const tbody = $('tbody', tableEl);
        const rows = [...tbody.querySelectorAll('tr')];
        rows.sort((a, b) => {
          const aVal = a.dataset[col] || a.children[th.cellIndex]?.textContent || '';
          const bVal = b.dataset[col] || b.children[th.cellIndex]?.textContent || '';
          const aNum = parseFloat(aVal.replace(/[,$%]/g, ''));
          const bNum = parseFloat(bVal.replace(/[,$%]/g, ''));
          let cmp;
          if (!isNaN(aNum) && !isNaN(bNum)) cmp = aNum - bNum;
          else cmp = aVal.localeCompare(bVal);
          return sortDir === 'asc' ? cmp : -cmp;
        });
        rows.forEach(r => tbody.appendChild(r));
        headers.forEach(h => {
          const arrow = h.querySelector('.sort-arrow');
          if (arrow) { arrow.classList.remove('active'); arrow.innerHTML = '↕'; }
        });
        const arrow = th.querySelector('.sort-arrow');
        if (arrow) { arrow.classList.add('active'); arrow.innerHTML = sortDir === 'asc' ? '↑' : '↓'; }
      });
    });
  }

  // ===========================================================
  // LOADING
  // ===========================================================
  function loadingSpinner() {
    return '<div class="loading-center"><div class="spinner spinner-lg"></div></div>';
  }

  function skeletonTable(rows = 5) {
    let html = '<div class="table-wrap"><table class="data-table"><thead><tr>';
    for (let i = 0; i < 5; i++) html += '<th><div class="skeleton skeleton-text" style="width:80px"></div></th>';
    html += '</tr></thead><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < 5; c++) html += `<td><div class="skeleton skeleton-text" style="width:${60 + Math.random() * 60}px"></div></td>`;
      html += '</tr>';
    }
    return html + '</tbody></table></div>';
  }

  // ===========================================================
  // WATCH LIST
  // ===========================================================
  function isWatched(ticker) { return state.watchList.some(w => w.ticker === ticker); }
  function toggleWatch(ticker, name) {
    const i = state.watchList.findIndex(w => w.ticker === ticker);
    if (i >= 0) { state.watchList.splice(i, 1); showToast(`Removed ${ticker} from Watch List`); }
    else { state.watchList.push({ ticker, name }); showToast(`Added ${ticker} to Watch List`, 'success'); }
  }

  // ===========================================================
  // ROUTER
  // ===========================================================
  const routes = [];
  function addRoute(pattern, handler) { routes.push({ pattern, handler }); }

  function matchRoute(hash) {
    const path = hash.replace(/^#/, '') || '/';
    const [pathname, search] = path.split('?');
    const params = {};
    if (search) new URLSearchParams(search).forEach((v, k) => { params[k] = v; });
    for (const route of routes) {
      const regex = new RegExp('^' + route.pattern.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '$');
      const m = pathname.match(regex);
      if (m) {
        return { handler: route.handler, params: { ...params, ...(m.groups || {}) } };
      }
    }
    return null;
  }

  function navigate(hash) {
    window.location.hash = hash.replace(/^#/, '');
  }

  async function handleRoute() {
    const hash = window.location.hash || '#/';
    const match = matchRoute(hash);
    if (match) {
      try { await match.handler(match.params); }
      catch (err) {
        console.error('Route error:', err);
        content().innerHTML = `<div class="container mt-8"><div class="card"><h2>Something went wrong</h2><p class="text-muted mt-2">We couldn't load this page. Please try again or go back to the home page.</p><a href="#/" class="btn btn-primary mt-4">Go Home</a></div></div>`;
      }
    } else {
      content().innerHTML = '<div class="container mt-8"><div class="card"><h2>Page Not Found</h2><p class="text-muted mt-2">The page you are looking for does not exist.</p><a href="#/" class="btn btn-primary mt-4">Go Home</a></div></div>';
    }
    window.scrollTo(0, 0);
  }

  // ===========================================================
  // SHARED FOOTER
  // ===========================================================
  function siteFooter() {
    return `
      <footer class="site-footer">
        <div class="site-footer-inner">
          <div class="site-footer-brand">
            <a href="#/" class="footer-logo">WamSEC</a>
            <p class="footer-tagline">Professional SEC filing research for investment analysts and finance teams.</p>
          </div>
          <div class="site-footer-cols">
            <div class="footer-col">
              <h4>Product</h4>
              <a href="#/features">Features</a>
              <a href="#/companies">Browse Companies</a>
              <a href="#/search">Search Filings</a>
            </div>
            <div class="footer-col">
              <h4>Resources</h4>
              <a href="#/features/filings">Filing Viewer</a>
              <a href="#/features/search">Full-Text Search</a>
              <a href="#/features/compare">Comparison Tool</a>
              <a href="#/features/alerts">Alerts</a>
            </div>
            <div class="footer-col">
              <h4>Company</h4>
              <a href="#/features">Help Center</a>
              <a href="#/login">Sign In</a>
              <a href="#/register">Get Started</a>

            </div>
            <div class="footer-col">
              <h4>Legal</h4>
              <a href="#/privacy">Privacy Policy</a>
              <a href="#/terms">Terms of Service</a>
            </div>
          </div>
        </div>
        <div class="site-footer-bottom">
          <span>&copy; 2026 WamSEC. All rights reserved.</span>
          <span class="footer-disclaimer">Not affiliated with the SEC. All data is for informational purposes only.</span>
        </div>
      </footer>
    `;
  }

  // ===========================================================
  // PAGE: LANDING
  // ===========================================================
  addRoute('/', async () => {
    content().innerHTML = `
      <section class="hero">
        <h1>Financial research made easier</h1>
        <p class="subtitle">Search and navigate SEC filings faster with an intuitive interface designed for finance professionals.</p>
        <div class="hero-search">
          <span class="hero-search-icon">${icons.search}</span>
          <input type="text" class="hero-search-input" id="heroSearchInput" placeholder="Search by company name or ticker (e.g. AAPL, Tesla)..." autocomplete="off">
          <div class="autocomplete-dropdown" id="heroAutocomplete"></div>
        </div>
        <div class="hero-cta">
          <a href="#/register" class="btn btn-success btn-lg">Get Started Free</a>
        </div>
        <div class="hero-tickers">
          ${['META','AAPL','MSFT','TSLA','NVDA','GOOGL'].map(t => `<a href="#/company/${t}" class="hero-ticker-chip">${t}</a>`).join('')}
        </div>
      </section>

      <section class="container mb-6">
        <div class="features-grid">
          <a class="feature-card" href="#/features/filings">
            <div class="feature-card-icon">${icons.file}</div>
            <h3>SEC Filings</h3>
            <p>Navigate 10-K, 10-Q, 8-K, and all SEC filings with an optimized reading experience.</p>
          </a>
          <a class="feature-card" href="#/features/search">
            <div class="feature-card-icon">${icons.search}</div>
            <h3>Full-Text Search</h3>
            <p>Search across millions of SEC filings to find exactly what you need, instantly.</p>
          </a>
          <a class="feature-card" href="#/features/screening">
            <div class="feature-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></div>
            <h3>Company Screening</h3>
            <p>Browse companies by SIC code and industry classification.</p>
          </a>
          <a class="feature-card" href="#/features/alerts">
            <div class="feature-card-icon">${icons.bell}</div>
            <h3>Filing Alerts</h3>
            <p>Get notified when companies file new documents with the SEC.</p>
          </a>
          <a class="feature-card" href="#/features/highlights">
            <div class="feature-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></div>
            <h3>Highlights & Notes</h3>
            <p>Highlight text, add notes, and share specific passages from filings.</p>
          </a>
          <a class="feature-card" href="#/features/compare">
            <div class="feature-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div>
            <h3>Filing Comparison</h3>
            <p>Compare filings side-by-side to identify changes between periods.</p>
          </a>
        </div>
      </section>

      ${siteFooter()}
    `;

    const hi = $('#heroSearchInput');
    const hd = $('#heroAutocomplete');
    initAutocomplete(hi, hd, (item) => { navigate(`#/company/${item.ticker}`); });
    hi.focus();
  });

  // ===========================================================
  // PAGE: COMPANY
  // ===========================================================

  addRoute('/company/{ticker}', async (params) => {
    const ticker = params.ticker.toUpperCase();
    content().innerHTML = loadingSpinner();

    let profile, filingsData;
    try { profile = await getProfile(ticker); }
    catch (err) { profile = { name: ticker, ticker: ticker }; }
    try { filingsData = await getFilings(ticker); }
    catch (err) { filingsData = []; }

    const p = Array.isArray(profile) ? profile[0] : profile;
    const companyName = p?.companyName || p?.name || ticker;
    const exchange = p?.exchangeSymbol || p?.exchangeName || p?.exchangeShortName || p?.exchange || '';
    const sector = p?.sector || '';
    const industry = p?.industry || '';
    const cik = p?.cik || '';
    const cikNum = cik ? String(cik).replace(/^0+/, '') : '';

    let filings = [];
    if (Array.isArray(filingsData)) filings = filingsData;
    else if (filingsData?.filings) filings = filingsData.filings;
    else if (filingsData?.data) filings = filingsData.data;

    const watched = isWatched(ticker);

    // Get embedded company data for rich features
    const embeddedCo = getEmbeddedCompany(ticker);

    // Sidebar icons (SVG)
    const sidebarIcons = {
      categorized: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
      chronological: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
      ownershipByOwner: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>`,
      insiderTxns: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M2 7h20"/><path d="M12 11v4"/><path d="M9 14l3-3 3 3"/></svg>`,
      institutional: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M8 10v11M12 10v11M16 10v11M20 10v11"/></svg>`,
      expert: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
      broker: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
      transcripts: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`,
      highlights: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
      search: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
      externalLink: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
      watch: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
    };

    // Determine exchange label
    const exchangeLabel = exchange ? `${exchange}: ${ticker}` : ticker;

    // BamSEC-style layout: sidebar + main content
    content().innerHTML = `
      <div class="company-page-layout">
        <!-- LEFT SIDEBAR -->
        <div class="company-sidebar" id="companySidebar">
          <div class="company-sidebar-nav">
            <a class="sidebar-nav-item active" data-view="categorized">${sidebarIcons.categorized} Categorized</a>
            <a class="sidebar-nav-item" data-view="chronological">${sidebarIcons.chronological} Chronological</a>
            <a class="sidebar-nav-item" data-view="ownershipByOwner">${sidebarIcons.ownershipByOwner} Ownership by Owner</a>
            <a class="sidebar-nav-item" data-view="insiderTransactions">${sidebarIcons.insiderTxns} Insider Transactions</a>
            <a class="sidebar-nav-item" data-view="institutionalOwners">${sidebarIcons.institutional} Institutional Owners</a>
            <a class="sidebar-nav-item" data-view="expertInterviews">${sidebarIcons.expert} Expert Interviews</a>
            <a class="sidebar-nav-item" data-view="brokerResearch">${sidebarIcons.broker} Broker Research</a>
            <a class="sidebar-nav-item" data-view="transcripts">${sidebarIcons.transcripts} Transcripts</a>
            <a class="sidebar-nav-item" data-view="highlights">${sidebarIcons.highlights} Your Highlights</a>
          </div>

          <div class="sidebar-divider"></div>

          <div class="sidebar-section-title">Search in Documents</div>
          <div class="sidebar-search-box">
            <div class="search-input-wrap">
              <input type="text" id="sidebarDocSearch" placeholder="Any keyword or phrase">
              <button id="sidebarDocSearchBtn">${sidebarIcons.search}</button>
            </div>
          </div>

          <div class="sidebar-divider"></div>

          <div class="sidebar-section-title">Key Exhibits</div>
          <a class="sidebar-exhibit-item" data-exhibit="articles">Articles of Inc. & Bylaws</a>
          <a class="sidebar-exhibit-item" data-exhibit="credit">Credit Agreements</a>
          <a class="sidebar-exhibit-item" data-exhibit="indentures">Indentures</a>
          <a class="sidebar-exhibit-item" data-exhibit="material">Material Contracts</a>
          <a class="sidebar-exhibit-item" data-exhibit="reorg">Plans of Reorganization</a>
          <a class="sidebar-exhibit-item" data-exhibit="underwriting">Underwriting Agreements</a>

          <div class="sidebar-divider" style="margin-top:8px"></div>

          <div class="sidebar-section-title">External Links</div>
          <a class="sidebar-ext-link" href="https://www.google.com/finance/quote/${encodeURIComponent(ticker)}:${encodeURIComponent(exchange || 'NASDAQ')}" target="_blank">Google Finance ${sidebarIcons.externalLink}</a>
          <a class="sidebar-ext-link" href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cikNum || ticker)}&type=&dateb=&owner=exclude&count=40" target="_blank">SEC EDGAR ${sidebarIcons.externalLink}</a>
        </div>

        <!-- MAIN CONTENT -->
        <div class="company-main-content">
          <div class="company-header-bar">
            <div class="company-name-row">
              <div class="company-name-bamsec">${escHtml(companyName)}</div>
              <button class="btn btn-outline btn-sm" id="watchBtn" style="margin-left:12px">
                ${sidebarIcons.watch}
                <span>${watched ? 'Watching' : 'Watch'}</span>
              </button>
            </div>
            <div class="company-stock-info">
              <span>${escHtml(exchangeLabel)}</span>
              ${sector ? `<span>${escHtml(sector)}</span>` : ''}
              ${industry ? `<span>${escHtml(industry)}</span>` : ''}
              ${cik ? `<span>CIK: ${escHtml(cikNum)}</span>` : ''}
            </div>
          </div>
          <div style="padding:24px 32px 40px;" id="companyTabContent"></div>
        </div>
      </div>
    `;

    // Watch button
    $('#watchBtn').addEventListener('click', () => {
      toggleWatch(ticker, companyName);
      const w = isWatched(ticker);
      $('#watchBtn').innerHTML = `${sidebarIcons.watch}<span>${w ? 'Watching' : 'Watch'}</span>`;
    });

    // Sidebar navigation
    const tabContent = $('#companyTabContent');
    const sidebarItems = $$('.sidebar-nav-item', $('#companySidebar'));
    sidebarItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        sidebarItems.forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        renderView(item.dataset.view);
      });
    });

    // Exhibit links
    $$('.sidebar-exhibit-item', $('#companySidebar')).forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        sidebarItems.forEach(i => i.classList.remove('active'));
        renderExhibitView(item.dataset.exhibit);
      });
    });

    // Sidebar doc search
    const docSearchInput = $('#sidebarDocSearch');
    const docSearchBtn = $('#sidebarDocSearchBtn');
    docSearchBtn.addEventListener('click', () => {
      const q = docSearchInput.value.trim();
      if (q) {
        sidebarItems.forEach(i => i.classList.remove('active'));
        renderDocSearchView(q);
      }
    });
    docSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') docSearchBtn.click();
    });

    function renderView(view) {
      switch (view) {
        case 'categorized': renderFilingsTab(); break;
        case 'chronological': renderChronologicalTab(); break;
        case 'ownershipByOwner': renderOwnershipByOwnerTab(); break;
        case 'insiderTransactions': renderInsidersTab(); break;
        case 'institutionalOwners': renderInstitutionalTab(); break;
        case 'expertInterviews': renderExpertTab(); break;
        case 'brokerResearch': renderBrokerTab(); break;
        case 'transcripts': renderTranscriptsTab(); break;
        case 'highlights': renderHighlightsTab(); break;
      }
    }

    // --- FILINGS TAB ---
    // FILING_CATEGORIES, categorizeFiling, getFilingDescription are at module scope

    function renderFilingsTab() {
      // Group filings by category
      const groups = {};
      for (const cat of FILING_CATEGORIES) groups[cat.key] = [];
      groups['other'] = [];

      filings.forEach(f => {
        const cats = categorizeFiling(f);
        cats.forEach(c => {
          if (groups[c]) groups[c].push(f);
        });
      });

      // Sort each group by filing date (newest first)
      for (const key of Object.keys(groups)) {
        groups[key].sort((a, b) => {
          const da = a.filingDate || a.dateFiled || '';
          const db = b.filingDate || b.dateFiled || '';
          return db.localeCompare(da);
        });
      }

      // Build view toggle + category grid
      const allCats = [...FILING_CATEGORIES];
      // Only add "other" if it has filings not covered elsewhere
      const coveredIds = new Set();
      for (const cat of FILING_CATEGORIES) {
        groups[cat.key].forEach(f => coveredIds.add(f.filingId || f.id || JSON.stringify(f)));
      }
      const trueOthers = filings.filter(f => !coveredIds.has(f.filingId || f.id || JSON.stringify(f)));
      if (trueOthers.length) {
        groups['other'] = trueOthers.sort((a, b) => {
          const da = a.filingDate || a.dateFiled || '';
          const db = b.filingDate || b.dateFiled || '';
          return db.localeCompare(da);
        });
        allCats.push({
          key: 'other', label: 'Other Filings',
          icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
          forms: [], desc: {}
        });
      }

      const INITIAL_SHOW = 8;

      tabContent.innerHTML = `
        <div class="filings-categorized-grid" id="filingsGrid">
          ${allCats.map(cat => {
            const items = groups[cat.key] || [];
            if (!items.length) return '';
            return `
              <div class="filing-category-card" data-cat="${cat.key}">
                <div class="filing-category-header">
                  <div class="filing-category-title">
                    <span>${escHtml(cat.label)}</span>
                  </div>
                  <button class="filing-filter-btn" onclick="showToast('Filter options coming soon', 'info')">Filter</button>
                </div>
                <div class="filing-category-list">
                  ${items.slice(0, INITIAL_SHOW).map(f => {
                    const ft = f.secFormType || f.formType || f.type || '';
                    const fd = f.filingDate || f.dateFiled || '';
                    const filingId = f.filingId || f.id || '';
                    const desc = getFilingRichDescription(f, cat);
                    return `
                      <div class="filing-category-row" data-fid="${escHtml(filingId)}">
                        <span class="filing-row-type">${escHtml(ft)}</span>
                        <span class="filing-row-desc">${escHtml(desc)}</span>
                        <span class="filing-row-date">${formatDateShort(fd)}</span>
                        <span class="filing-row-chevron">${icons.chevronRight || '›'}</span>
                      </div>`;
                  }).join('')}
                </div>
                ${items.length > INITIAL_SHOW ? `
                  <div class="filing-category-expand" data-cat="${cat.key}">
                    <button class="filing-expand-btn" data-cat="${cat.key}">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                      Show ${items.length - INITIAL_SHOW} more
                    </button>
                  </div>` : ''}
              </div>`;
          }).join('')}
        </div>
      `;

      // Click handlers for filing rows
      $$('.filing-category-row', tabContent).forEach(row => {
        row.addEventListener('click', () => {
          const fid = row.dataset.fid;
          if (fid) navigate(`#/doc/${ticker}/${fid}`);
        });
      });

      // Expand buttons
      $$('.filing-expand-btn', tabContent).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const catKey = btn.dataset.cat;
          const cat = allCats.find(c => c.key === catKey);
          const items = groups[catKey] || [];
          const card = btn.closest('.filing-category-card');
          const list = card.querySelector('.filing-category-list');
          const expandDiv = card.querySelector('.filing-category-expand');

          // Append remaining items
          const remaining = items.slice(INITIAL_SHOW);
          remaining.forEach(f => {
            const ft = f.secFormType || f.formType || f.type || '';
            const fd = f.filingDate || f.dateFiled || '';
            const filingId = f.filingId || f.id || '';
            const desc = getFilingRichDescription(f, cat);
            const row = document.createElement('div');
            row.className = 'filing-category-row';
            row.dataset.fid = filingId;
            row.innerHTML = `
              <span class="filing-row-type">${escHtml(ft)}</span>
              <span class="filing-row-desc">${escHtml(desc)}</span>
              <span class="filing-row-date">${formatDateShort(fd)}</span>
              <span class="filing-row-chevron">${icons.chevronRight || '›'}</span>`;
            row.addEventListener('click', () => {
              if (filingId) navigate(`#/doc/${ticker}/${filingId}`);
            });
            list.appendChild(row);
          });

          expandDiv.remove();
        });
      });
    }

    // --- CHRONOLOGICAL VIEW ---
    function renderChronologicalTab() {
      const INITIAL_SHOW = 50;
      const sorted = [...filings].sort((a, b) => {
        const da = a.filingDate || a.dateFiled || '';
        const db = b.filingDate || b.dateFiled || '';
        return db.localeCompare(da);
      });

      tabContent.innerHTML = `
        <div class="flex justify-between items-center mb-4">
          <h3 style="font-weight:600;">All Filings — Chronological</h3>
          <span class="text-muted text-sm">${sorted.length} filings</span>
        </div>
        <div class="filing-category-card">
          <div class="filing-category-list" id="chronList">
            ${sorted.slice(0, INITIAL_SHOW).map(f => {
              const ft = f.secFormType || f.formType || f.type || '';
              const desc = getFilingRichDescription(f, null);
              const fd = f.filingDate || f.dateFiled || '';
              const fid = f.filingId || f.id || '';
              return `
                <div class="filing-category-row" data-fid="${escHtml(fid)}">
                  <span class="filing-row-type">${escHtml(ft)}</span>
                  <span class="filing-row-desc">${escHtml(desc)}</span>
                  <span class="filing-row-date">${formatDateShort(fd)}</span>
                  <span class="filing-row-chevron">${icons.chevronRight || '›'}</span>
                </div>`;
            }).join('')}
          </div>
          ${sorted.length > INITIAL_SHOW ? `
            <div class="filing-category-expand">
              <button class="filing-expand-btn" id="chronExpandBtn">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                Show ${sorted.length - INITIAL_SHOW} more
              </button>
            </div>` : ''}
        </div>
      `;

      $$('.filing-category-row', tabContent).forEach(row => {
        row.addEventListener('click', () => {
          const fid = row.dataset.fid;
          if (fid) navigate(`#/doc/${ticker}/${fid}`);
        });
      });

      const expandBtn = document.getElementById('chronExpandBtn');
      if (expandBtn) {
        expandBtn.addEventListener('click', () => {
          const list = document.getElementById('chronList');
          sorted.slice(INITIAL_SHOW).forEach(f => {
            const ft = f.secFormType || f.formType || f.type || '';
            const desc = getFilingRichDescription(f, null);
            const fd = f.filingDate || f.dateFiled || '';
            const fid = f.filingId || f.id || '';
            const row = document.createElement('div');
            row.className = 'filing-category-row';
            row.dataset.fid = fid;
            row.innerHTML = `
              <span class="filing-row-type">${escHtml(ft)}</span>
              <span class="filing-row-desc">${escHtml(desc)}</span>
              <span class="filing-row-date">${formatDateShort(fd)}</span>
              <span class="filing-row-chevron">${icons.chevronRight || '›'}</span>`;
            row.addEventListener('click', () => { if (fid) navigate(`#/doc/${ticker}/${fid}`); });
            list.appendChild(row);
          });
          expandBtn.parentElement.remove();
        });
      }
    }

    // --- OWNERSHIP BY OWNER VIEW ---
    function renderOwnershipByOwnerTab() {
      // Show Form 3/4/5 and SC 13D/13G grouped by reporting person
      const ownerForms = new Set(['3', '3/A', '4', '4/A', '5', '5/A', '144', 'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A', 'SCHEDULE 13G', 'SCHEDULE 13G/A', 'SCHEDULE 13D', 'SCHEDULE 13D/A']);
      const ownerFilings = filings.filter(f => {
        const ft = (f.secFormType || f.formType || '').toUpperCase();
        return ownerForms.has(ft);
      }).sort((a, b) => (b.filingDate || '').localeCompare(a.filingDate || ''));

      if (!ownerFilings.length) {
        tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">${sidebarIcons.ownershipByOwner}</div><h3>No Ownership Filings</h3><p>Form 3/4/5 and SC 13D/13G filings will appear here when available.</p></div>`;
        return;
      }

      // Group by owner name (from description field)
      const ownerGroups = {};
      ownerFilings.forEach(f => {
        const desc = f.description || f.primaryDocDescription || '';
        // For Form 4s, the description usually contains the owner name
        const ownerName = desc || 'Unknown';
        if (!ownerGroups[ownerName]) ownerGroups[ownerName] = [];
        ownerGroups[ownerName].push(f);
      });

      const sortedOwners = Object.entries(ownerGroups).sort((a, b) => {
        const dateA = a[1][0]?.filingDate || '';
        const dateB = b[1][0]?.filingDate || '';
        return dateB.localeCompare(dateA);
      });

      tabContent.innerHTML = `
        <div class="flex justify-between items-center mb-4">
          <h3 style="font-weight:600;">Ownership by Owner</h3>
          <span class="text-muted text-sm">${ownerFilings.length} filings from ${sortedOwners.length} owner${sortedOwners.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="filing-category-card">
          <div class="filing-category-list">
            ${ownerFilings.slice(0, 50).map(f => {
              const ft = f.secFormType || f.formType || '';
              const desc = f.description || f.primaryDocDescription || '';
              const fd = f.filingDate || '';
              const fid = f.filingId || f.id || '';
              return `<div class="filing-category-row" data-fid="${escHtml(fid)}"><span class="filing-row-type">${escHtml(ft)}</span><span class="filing-row-desc">${escHtml(desc)}</span><span class="filing-row-date">${formatDateShort(fd)}</span><span class="filing-row-chevron">${icons.chevronRight || '›'}</span></div>`;
            }).join('')}
          </div>
          ${ownerFilings.length > 50 ? `<div class="filing-category-expand"><button class="filing-expand-btn" onclick="showToast('Showing first 50 of ${ownerFilings.length}', 'info')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg> ${ownerFilings.length - 50} more</button></div>` : ''}
        </div>
      `;

      $$('.filing-category-row', tabContent).forEach(row => {
        row.addEventListener('click', () => { const fid = row.dataset.fid; if (fid) navigate(`#/doc/${ticker}/${fid}`); });
      });
    }

    // --- INSTITUTIONAL OWNERS VIEW ---
    function renderInstitutionalTab() {
      // Filter ownership filings (13F-HR, SC 13G, SC 13D)
      const ownerForms = ['13F-HR', '13F-HR/A', '13F-NT', 'SC 13G', 'SC 13G/A', 'SC 13D', 'SC 13D/A', 'SCHEDULE 13G', 'SCHEDULE 13G/A', 'SCHEDULE 13D', 'SCHEDULE 13D/A'];
      const ownerFilings = filings.filter(f => {
        const ft = (f.secFormType || f.formType || '').toUpperCase();
        return ownerForms.some(of => ft === of);
      }).sort((a, b) => (b.filingDate || '').localeCompare(a.filingDate || ''));

      // Also check embedded owner data
      const owners = embeddedCo?.owners || [];

      if (!owners.length && !ownerFilings.length) {
        tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">${sidebarIcons.institutional}</div><h3>No Institutional Ownership Data</h3><p>Institutional ownership filings (13F-HR, SC 13G/13D) will appear here when available.</p></div>`;
        return;
      }

      if (owners.length) {
        const totalPct = owners.reduce((sum, o) => sum + o.pct, 0).toFixed(1);
        const totalValue = owners.reduce((sum, o) => sum + o.value, 0);
        tabContent.innerHTML = `
          <div class="owners-header mt-2 mb-4">
            <div class="owners-stat"><span class="stat-val">${owners.length}</span><span class="stat-lbl">Institutions</span></div>
            <div class="owners-stat"><span class="stat-val">${totalPct}%</span><span class="stat-lbl">Institutional Ownership (Top 15)</span></div>
            <div class="owners-stat"><span class="stat-val">$${formatNumber(totalValue)}</span><span class="stat-lbl">Total Value Held</span></div>
          </div>
          <div class="table-wrap">
            <table class="data-table" id="instOwnersTable">
              <thead><tr>
                <th data-sort="name">Institution <span class="sort-arrow">↕</span></th>
                <th data-sort="shares">Shares <span class="sort-arrow">↕</span></th>
                <th data-sort="value">Value <span class="sort-arrow">↕</span></th>
                <th data-sort="pct">% Outstanding <span class="sort-arrow">↕</span></th>
                <th data-sort="change">Qtr Change <span class="sort-arrow">↕</span></th>
                <th data-sort="filingdate">Filing Date <span class="sort-arrow">↕</span></th>
              </tr></thead>
              <tbody>${owners.map(o => `
                <tr data-name="${escHtml(o.name)}" data-shares="${o.shares}" data-value="${o.value}" data-pct="${o.pct}" data-change="${o.change}" data-filingdate="${escHtml(o.filingDate || '')}">
                  <td class="fw-500">${escHtml(o.name)}</td>
                  <td class="col-num">${formatNumber(o.shares)}</td>
                  <td class="col-num">$${formatNumber(o.value)}</td>
                  <td class="col-num">${o.pct.toFixed(2)}%</td>
                  <td class="col-num ${o.change >= 0 ? 'text-success' : 'text-danger'}">${o.change >= 0 ? '+' : ''}${o.change.toFixed(1)}%</td>
                  <td class="col-date">${formatDate(o.filingDate)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        `;
        initTableSort($('#instOwnersTable'));
      } else {
        tabContent.innerHTML = `
          <h3 style="font-weight:600;margin-bottom:16px;">Institutional Ownership Filings</h3>
          <div class="filing-category-card">
            <div class="filing-category-list">
              ${ownerFilings.slice(0, 30).map(f => {
                const ft = f.secFormType || f.formType || '';
                const desc = f.description || f.primaryDocDescription || ft;
                const fd = f.filingDate || '';
                const fid = f.filingId || f.id || '';
                return `<div class="filing-category-row" data-fid="${escHtml(fid)}"><span class="filing-row-type">${escHtml(ft)}</span><span class="filing-row-desc">${escHtml(desc)}</span><span class="filing-row-date">${formatDateShort(fd)}</span><span class="filing-row-chevron">${icons.chevronRight || '›'}</span></div>`;
              }).join('')}
            </div>
          </div>
        `;
        $$('.filing-category-row', tabContent).forEach(row => {
          row.addEventListener('click', () => { const fid = row.dataset.fid; if (fid) navigate(`#/doc/${ticker}/${fid}`); });
        });
      }
    }

    // --- EXPERT INTERVIEWS VIEW ---
    function renderExpertTab() {
      tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">${sidebarIcons.expert}</div><h3>Expert Interviews</h3><p>Expert interview transcripts for ${escHtml(companyName)} will be available with a WamSEC Pro subscription.</p><button class="btn btn-primary mt-4" onclick="showToast('Pro feature — coming soon', 'info')">Learn More</button></div>`;
    }

    // --- BROKER RESEARCH VIEW ---
    function renderBrokerTab() {
      tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">${sidebarIcons.broker}</div><h3>Broker Research</h3><p>Broker research reports for ${escHtml(companyName)} will be available with a WamSEC Pro subscription.</p><button class="btn btn-primary mt-4" onclick="showToast('Pro feature — coming soon', 'info')">Learn More</button></div>`;
    }

    // --- DOCUMENT SEARCH VIEW ---
    function renderDocSearchView(query) {
      // Search through filing descriptions for keyword matches
      const q = query.toLowerCase();
      const results = filings.filter(f => {
        const desc = (f.description || f.primaryDocDescription || '').toLowerCase();
        const ft = (f.secFormType || f.formType || '').toLowerCase();
        return desc.includes(q) || ft.includes(q);
      }).sort((a, b) => (b.filingDate || '').localeCompare(a.filingDate || ''));

      tabContent.innerHTML = `
        <div class="flex justify-between items-center mb-4">
          <h3 style="font-weight:600;">Search Results for "${escHtml(query)}"</h3>
          <span class="text-muted text-sm">${results.length} result${results.length !== 1 ? 's' : ''}</span>
        </div>
        ${results.length ? `
          <div class="filing-category-card">
            <div class="filing-category-list">
              ${results.slice(0, 50).map(f => {
                const ft = f.secFormType || f.formType || '';
                const desc = f.description || f.primaryDocDescription || getFilingDescription(ft, null);
                const fd = f.filingDate || f.dateFiled || '';
                const fid = f.filingId || f.id || '';
                return `<div class="filing-category-row" data-fid="${escHtml(fid)}"><span class="filing-row-type">${escHtml(ft)}</span><span class="filing-row-desc">${escHtml(desc)}</span><span class="filing-row-date">${formatDateShort(fd)}</span><span class="filing-row-chevron">${icons.chevronRight || '›'}</span></div>`;
              }).join('')}
            </div>
          </div>` : `<div class="empty-state mt-8"><div class="empty-state-icon">${sidebarIcons.search}</div><h3>No Results</h3><p>No filings matching "${escHtml(query)}" were found.</p></div>`}
      `;
      $$('.filing-category-row', tabContent).forEach(row => {
        row.addEventListener('click', () => { const fid = row.dataset.fid; if (fid) navigate(`#/doc/${ticker}/${fid}`); });
      });
    }

    // --- EXHIBIT VIEW (Key Exhibits sidebar links) ---
    function renderExhibitView(exhibitType) {
      const exhibitConfig = {
        articles: { label: 'Articles of Incorporation & Bylaws', exhibits: ['3.1', '3.2', '3.3', '3.4', '3.5'], keywords: ['articles of incorporation', 'bylaws', 'certificate of incorporation', 'amended and restated'] },
        credit: { label: 'Credit Agreements', exhibits: ['10.1', '10.2', '10.3'], keywords: ['credit agreement', 'revolving', 'credit facility', 'loan agreement'] },
        indentures: { label: 'Indentures', exhibits: ['4.1', '4.2', '4.3', '4.4', '4.5'], keywords: ['indenture', 'supplemental indenture', 'notes indenture'] },
        material: { label: 'Material Contracts', exhibits: ['10'], keywords: ['material contract', 'employment agreement', 'license agreement', 'lease agreement', 'supply agreement'] },
        reorg: { label: 'Plans of Reorganization', exhibits: [], keywords: ['plan of reorganization', 'restructuring', 'reorganization plan'] },
        underwriting: { label: 'Underwriting Agreements', exhibits: ['1.1', '1.2'], keywords: ['underwriting agreement', 'purchase agreement'] }
      };

      const cfg = exhibitConfig[exhibitType] || { label: exhibitType, exhibits: [], keywords: [] };

      // Search filings for matching exhibits by description keywords
      const results = filings.filter(f => {
        const desc = (f.description || f.primaryDocDescription || '').toLowerCase();
        return cfg.keywords.some(k => desc.includes(k));
      }).sort((a, b) => (b.filingDate || '').localeCompare(a.filingDate || ''));

      tabContent.innerHTML = `
        <div class="flex justify-between items-center mb-4">
          <h3 style="font-weight:600;">${escHtml(cfg.label)}</h3>
          <span class="text-muted text-sm">${results.length} result${results.length !== 1 ? 's' : ''}</span>
        </div>
        ${results.length ? `
          <div class="filing-category-card">
            <div class="filing-category-list">
              ${results.map(f => {
                const ft = f.secFormType || f.formType || '';
                const desc = f.description || f.primaryDocDescription || '';
                const fd = f.filingDate || '';
                const fid = f.filingId || f.id || '';
                return `<div class="filing-category-row" data-fid="${escHtml(fid)}"><span class="filing-row-type">${escHtml(ft)}</span><span class="filing-row-desc">${escHtml(desc)}</span><span class="filing-row-date">${formatDateShort(fd)}</span><span class="filing-row-chevron">${icons.chevronRight || '›'}</span></div>`;
              }).join('')}
            </div>
          </div>` : `<div class="empty-state mt-8"><div class="empty-state-icon">${icons.folder}</div><h3>No ${escHtml(cfg.label)} Found</h3><p>No matching exhibit filings were found for ${escHtml(companyName)}.</p></div>`}
      `;
      $$('.filing-category-row', tabContent).forEach(row => {
        row.addEventListener('click', () => { const fid = row.dataset.fid; if (fid) navigate(`#/doc/${ticker}/${fid}`); });
      });
    }

    // --- TRANSCRIPTS TAB ---
    function renderTranscriptsTab() {
      const transcripts = embeddedCo?.transcripts || [];

      if (!transcripts.length) {
        tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">${icons.mic}</div><h3>No Transcripts Available</h3><p>Transcript data is available for META, AAPL, MSFT, TSLA, NVDA, and GOOGL.</p></div>`;
        return;
      }

      tabContent.innerHTML = `
        <div class="transcripts-header mt-2 mb-4">
          <h3 class="fw-600">Earnings Call Transcripts</h3>
          <p class="text-muted text-sm">${transcripts.length} transcripts available — click any row to expand</p>
        </div>
        <div class="transcripts-list" id="transcriptsList">
          ${transcripts.map((t, i) => `
            <div class="transcript-item" id="tItem${i}">
              <div class="transcript-row" onclick="window._toggleTranscript(${i})">
                <div class="transcript-row-left">
                  <span class="badge badge-8k">Earnings</span>
                  <span class="fw-600 ml-3">${escHtml(t.event)}</span>
                </div>
                <div class="transcript-row-right">
                  <span class="col-date text-muted">${formatDate(t.date)}</span>
                  <span class="transcript-toggle" id="tToggle${i}">${icons.chevronDown}</span>
                </div>
              </div>
              <div class="transcript-body" id="tBody${i}" style="display:none">
                <div class="transcript-participants">
                  <strong>Participants:</strong>
                  <ul>${(t.participants || []).map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>
                </div>
                <div class="transcript-highlights">
                  <strong>Key Highlights:</strong>
                  <p class="mt-2">${escHtml(t.highlights)}</p>
                </div>
                <div class="mt-3">
                  <button class="btn btn-outline btn-sm" onclick="showToast('Full transcript viewer — Pro feature', 'info')">
                    ${icons.file} View Full Transcript
                  </button>
                </div>
              </div>
            </div>`).join('')}
        </div>
      `;

      window._toggleTranscript = (i) => {
        const body = document.getElementById(`tBody${i}`);
        const toggle = document.getElementById(`tToggle${i}`);
        const item = document.getElementById(`tItem${i}`);
        if (body) {
          const isOpen = body.style.display !== 'none';
          body.style.display = isOpen ? 'none' : 'block';
          if (toggle) toggle.innerHTML = isOpen ? icons.chevronDown : icons.chevronRight;
          if (item) item.classList.toggle('transcript-open', !isOpen);
        }
      };
    }

    // --- INSIDERS TAB ---
    function renderInsidersTab() {
      const insiders = embeddedCo?.insiders || [];

      if (!insiders.length) {
        tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">${icons.user}</div><h3>No Insider Data</h3><p>Insider transaction data is available for demo companies.</p></div>`;
        return;
      }

      const purchases = insiders.filter(i => i.type === 'Purchase');
      const sales = insiders.filter(i => i.type === 'Sale');
      const netShares = purchases.reduce((s, i) => s + i.shares, 0) - sales.reduce((s, i) => s + i.shares, 0);

      tabContent.innerHTML = `
        <div class="insider-summary">
          <div class="insider-summary-card">
            <div class="value ${netShares >= 0 ? 'text-success' : 'text-danger'} mono">${formatNumber(netShares)}</div>
            <div class="label">Net Shares (12mo)</div>
          </div>
          <div class="insider-summary-card">
            <div class="value mono">${insiders.length}</div>
            <div class="label">Transactions</div>
          </div>
          <div class="insider-summary-card">
            <div class="value text-success mono">${purchases.length ? formatDate(purchases[purchases.length-1].date) : '—'}</div>
            <div class="label">Last Purchase</div>
          </div>
          <div class="insider-summary-card">
            <div class="value text-danger mono">${sales.length ? formatDate(sales[0].date) : '—'}</div>
            <div class="label">Last Sale</div>
          </div>
        </div>
        <div class="filter-bar">
          <input type="text" class="form-input form-input-sm" placeholder="Search insider name..." id="insiderSearch">
          <select class="form-select form-select-sm" id="insiderType">
            <option value="">All Types</option><option value="Purchase">Purchase</option><option value="Sale">Sale</option>
          </select>
          <select class="form-select form-select-sm" id="insiderPlan">
            <option value="">All Plans</option><option value="10b5-1">10b5-1 Plan</option><option value="Open Market">Open Market</option>
          </select>
        </div>
        <div class="table-wrap">
          <table class="data-table" id="insidersTable">
            <thead><tr>
              <th data-sort="name">Insider <span class="sort-arrow">↕</span></th>
              <th data-sort="title">Title <span class="sort-arrow">↕</span></th>
              <th data-sort="date">Date <span class="sort-arrow">↕</span></th>
              <th data-sort="type">Type <span class="sort-arrow">↕</span></th>
              <th data-sort="shares">Shares <span class="sort-arrow">↕</span></th>
              <th data-sort="price">Price <span class="sort-arrow">↕</span></th>
              <th data-sort="value">Value <span class="sort-arrow">↕</span></th>
              <th data-sort="plan">Plan Type <span class="sort-arrow">↕</span></th>
            </tr></thead>
            <tbody id="insidersBody"></tbody>
          </table>
        </div>
      `;

      function renderInsiders() {
        const search = ($('#insiderSearch')?.value || '').toLowerCase();
        const typeFilter = $('#insiderType')?.value || '';
        const planFilter = $('#insiderPlan')?.value || '';
        const filtered = insiders.filter(i => {
          if (search && !i.name.toLowerCase().includes(search)) return false;
          if (typeFilter && i.type !== typeFilter) return false;
          if (planFilter && i.planType !== planFilter) return false;
          return true;
        });
        $('#insidersBody').innerHTML = filtered.map(i => `
          <tr class="${i.type === 'Purchase' ? 'row-purchase' : 'row-sale'}" data-name="${escHtml(i.name)}" data-title="${escHtml(i.title)}" data-date="${i.date}" data-type="${i.type}" data-shares="${i.shares}" data-price="${i.price}" data-value="${i.value}" data-plan="${escHtml(i.planType || '')}">
            <td class="fw-600">${escHtml(i.name)}</td>
            <td class="text-muted">${escHtml(i.title)}</td>
            <td class="col-date">${formatDate(i.date)}</td>
            <td><span class="badge ${i.type === 'Purchase' ? 'badge-success' : 'badge-danger'}">${i.type}</span></td>
            <td class="col-num">${i.shares.toLocaleString()}</td>
            <td class="col-num">${formatMoney(i.price)}</td>
            <td class="col-num">${formatMoney(i.value)}</td>
            <td><span class="badge ${i.planType === '10b5-1' ? 'badge-info' : 'badge-default'}">${escHtml(i.planType || '—')}</span></td>
          </tr>`).join('');
        initTableSort($('#insidersTable'));
      }
      renderInsiders();
      $('#insiderSearch').addEventListener('input', debounce(renderInsiders, 200));
      $('#insiderType').addEventListener('change', renderInsiders);
      $('#insiderPlan').addEventListener('change', renderInsiders);
    }

    // --- OWNERS TAB ---
    function renderOwnersTab() {
      const owners = embeddedCo?.owners || [];

      if (!owners.length) {
        tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">${icons.folder}</div><h3>No Ownership Data</h3><p>Institutional ownership data is available for demo companies.</p></div>`;
        return;
      }

      // Compute total institutional
      const totalPct = owners.reduce((sum, o) => sum + o.pct, 0).toFixed(1);
      const totalValue = owners.reduce((sum, o) => sum + o.value, 0);

      tabContent.innerHTML = `
        <div class="owners-header mt-2 mb-4">
          <div class="owners-stat"><span class="stat-val">${owners.length}</span><span class="stat-lbl">Institutions</span></div>
          <div class="owners-stat"><span class="stat-val">${totalPct}%</span><span class="stat-lbl">Institutional Ownership (Top 15)</span></div>
          <div class="owners-stat"><span class="stat-val">$${formatNumber(totalValue)}</span><span class="stat-lbl">Total Value Held</span></div>
        </div>
        <div class="table-wrap">
          <table class="data-table" id="ownersTable">
            <thead><tr>
              <th data-sort="name">Institution <span class="sort-arrow">↕</span></th>
              <th data-sort="shares">Shares <span class="sort-arrow">↕</span></th>
              <th data-sort="value">Value <span class="sort-arrow">↕</span></th>
              <th data-sort="pct">% Outstanding <span class="sort-arrow">↕</span></th>
              <th data-sort="change">Qtr Change <span class="sort-arrow">↕</span></th>
              <th data-sort="filingdate">Filing Date <span class="sort-arrow">↕</span></th>
            </tr></thead>
            <tbody>${owners.map(o => `
              <tr data-name="${escHtml(o.name)}" data-shares="${o.shares}" data-value="${o.value}" data-pct="${o.pct}" data-change="${o.change}" data-filingdate="${escHtml(o.filingDate || '')}">
                <td class="fw-500">${escHtml(o.name)}</td>
                <td class="col-num">${formatNumber(o.shares)}</td>
                <td class="col-num">$${formatNumber(o.value)}</td>
                <td class="col-num">${o.pct.toFixed(2)}%</td>
                <td class="col-num ${o.change >= 0 ? 'text-success' : 'text-danger'}">${o.change >= 0 ? '+' : ''}${o.change.toFixed(1)}%</td>
                <td class="col-date">${formatDate(o.filingDate)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
      initTableSort($('#ownersTable'));
    }

    // --- HIGHLIGHTS TAB ---
    function renderHighlightsTab() {
      const hl = state.highlights.filter(h => h.ticker === ticker);
      if (!hl.length) {
        tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">📝</div><h3>No Highlights Yet</h3><p>Open a filing and select text to create highlights. Your highlights will appear here.</p><a href="#/company/${ticker}" class="btn btn-primary mt-4" onclick="event.preventDefault();renderTab('filings')">Browse Filings</a></div>`;
        return;
      }
      tabContent.innerHTML = `
        <div class="highlights-header mt-2 mb-4">
          <h3 class="fw-600">${hl.length} Highlight${hl.length !== 1 ? 's' : ''}</h3>
          <button class="btn btn-outline btn-sm" onclick="showToast('Sharing link copied!', 'success')">Share All</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Date</th><th>Form</th><th>Highlighted Text</th><th>Color</th><th></th></tr></thead>
            <tbody>${hl.map((h, i) => `
              <tr>
                <td class="col-date">${formatDate(h.date)}</td>
                <td>${formBadge(h.formType)}</td>
                <td style="max-width:400px">
                  <div class="highlight-text-cell hl-${h.color}">${escHtml(h.text)}</div>
                </td>
                <td><span class="hl-chip hl-${h.color}"></span></td>
                <td>
                  <div class="flex gap-2">
                    <button class="btn btn-ghost btn-sm" onclick="location.hash='#/doc/${ticker}/${escHtml(h.filingId || '')}'" title="View in filing">${icons.external}</button>
                    <button class="btn btn-ghost btn-sm" onclick="window._deleteHighlight(${i})" title="Delete">${icons.trash}</button>
                  </div>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    window._deleteHighlight = (i) => {
      const hl = state.highlights.filter(h => h.ticker === ticker);
      if (hl[i]) {
        const idx = state.highlights.indexOf(hl[i]);
        if (idx >= 0) state.highlights.splice(idx, 1);
        renderHighlightsTab();
        showToast('Highlight deleted');
      }
    };

    // --- EXHIBITS TAB ---
    function renderExhibitsTab() {
      const exhibits = embeddedCo?.exhibits || [];

      if (!exhibits.length) {
        tabContent.innerHTML = `<div class="empty-state mt-8"><div class="empty-state-icon">${icons.folder}</div><h3>No Exhibits Found</h3><p>Exhibit data is available for demo companies in this version.</p></div>`;
        return;
      }

      // Group by category
      const groups = {};
      exhibits.forEach(e => {
        const cat = e.category || 'Other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(e);
      });

      tabContent.innerHTML = Object.entries(groups).map(([cat, items]) => `
        <h3 class="fw-600 mt-6 mb-3">${escHtml(cat)}</h3>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th>Exhibit #</th>
              <th>Name</th>
              <th>Form Type</th>
              <th>Filing Date</th>
            </tr></thead>
            <tbody>${items.map(e => `
              <tr>
                <td class="col-badge"><span class="badge badge-default">${escHtml(e.exhibitNum || '')}</span></td>
                <td class="fw-500">${escHtml(e.name || '')}</td>
                <td>${formBadge(e.formType || '')}</td>
                <td class="col-date">${formatDate(e.filingDate)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`).join('');
    }

    // --- COMPARE TAB ---
    function renderCompareTab() {
      // Only use filings that have embedded HTML content
      const embeddedDocs = embeddedCo?.filingDocuments || {};
      const hasEmbedded = Object.keys(embeddedDocs).length > 0;

      const opts = filings.slice(0, 100).map((f, i) => {
        const ft = f.secFormType || f.formType || '';
        const dt = f.filingDate || f.reportDate || '';
        const fid = f.filingId || f.id || '';
        const hasContent = embeddedDocs[fid] ? ' ★' : '';
        return `<option value="${i}">${escHtml(ft)} — ${formatDate(dt)}${hasContent}</option>`;
      }).join('');

      tabContent.innerHTML = `
        <div class="compare-intro">
          <p class="text-muted text-sm">Select two filings to compare. Filings marked with ★ have full embedded content for richer comparison.</p>
        </div>
        <div class="flex gap-4 items-center mt-4 mb-4 flex-wrap">
          <div class="form-group" style="flex:1;min-width:200px">
            <label class="form-label">Filing A (Earlier)</label>
            <select class="form-select" id="compareA"><option value="">Select filing...</option>${opts}</select>
          </div>
          <div class="form-group" style="flex:1;min-width:200px">
            <label class="form-label">Filing B (Later)</label>
            <select class="form-select" id="compareB"><option value="">Select filing...</option>${opts}</select>
          </div>
          <button class="btn btn-primary mt-3" id="compareBtn">Compare</button>
        </div>
        <div id="compareResult"></div>
      `;

      $('#compareBtn').addEventListener('click', () => {
        const a = $('#compareA').value;
        const b = $('#compareB').value;
        if (a === '' || b === '') { showToast('Select both filings', 'error'); return; }
        const fA = filings[Number(a)];
        const fB = filings[Number(b)];
        const fidA = fA.filingId || fA.id || '';
        const fidB = fB.filingId || fB.id || '';

        // Try to use embedded content for richer diff
        const docA = embeddedDocs[fidA];
        const docB = embeddedDocs[fidB];

        const ftA = fA.secFormType || fA.formType || '';
        const ftB = fB.secFormType || fB.formType || '';
        const dtA = fA.filingDate || fA.reportDate || '';
        const dtB = fB.filingDate || fB.reportDate || '';

        let html = `<div class="compare-header">
          <div class="compare-labels">
            <div class="compare-label-a">${formBadge(ftA)} ${formatDate(dtA)}</div>
            <div class="compare-label-b">${formBadge(ftB)} ${formatDate(dtB)}</div>
          </div>
        </div>`;

        if (docA && docB) {
          // Rich section-based comparison
          html += `<div class="card mt-4 p-4">
            <h4 class="fw-600 mb-3">Document Structure Comparison</h4>
            <div class="diff-summary mb-4">
              <p>Comparing <strong>${escHtml(docA.title || ftA)}</strong> vs <strong>${escHtml(docB.title || ftB)}</strong></p>
            </div>`;

          const sectionsA = (docA.sections || []).map(s => s.title);
          const sectionsB = (docB.sections || []).map(s => s.title);
          const allSections = [...new Set([...sectionsA, ...sectionsB])];

          html += `<table class="data-table mt-3"><thead><tr>
            <th>Section</th>
            <th style="color:#e02424">Filing A</th>
            <th style="color:#0e9f6e">Filing B</th>
          </tr></thead><tbody>`;

          allSections.forEach(sec => {
            const inA = sectionsA.includes(sec);
            const inB = sectionsB.includes(sec);
            html += `<tr>
              <td>${escHtml(sec)}</td>
              <td>${inA ? '<span class="text-success">✓ Present</span>' : '<span class="text-danger">✗ Not found</span>'}</td>
              <td>${inB ? '<span class="text-success">✓ Present</span>' : '<span class="text-danger">✗ Not found</span>'}</td>
            </tr>`;
          });
          html += '</tbody></table>';

          // Show first shared section side-by-side
          const sharedSections = sectionsA.filter(s => sectionsB.includes(s));
          if (sharedSections.length > 0) {
            const firstShared = sharedSections[0];
            const secA = docA.sections.find(s => s.title === firstShared);
            const secB = docB.sections.find(s => s.title === firstShared);
            if (secA && secB) {
              html += `<div class="mt-4"><h4 class="fw-600 mb-3">Side-by-Side: "${escHtml(firstShared)}"</h4>
              <div class="compare-sidebyside">
                <div class="compare-pane compare-pane-a">
                  <div class="compare-pane-label">Filing A — ${formatDate(dtA)}</div>
                  <div class="compare-pane-content sec-document">${secA.content}</div>
                </div>
                <div class="compare-pane compare-pane-b">
                  <div class="compare-pane-label">Filing B — ${formatDate(dtB)}</div>
                  <div class="compare-pane-content sec-document">${secB.content}</div>
                </div>
              </div></div>`;
            }
          }
          html += '</div>';
        } else {
          // Metadata-based diff
          const textA = generateFilingText(fA);
          const textB = generateFilingText(fB);

          if (typeof diff_match_patch !== 'undefined') {
            const dmp = new diff_match_patch();
            const diffs = dmp.diff_main(textA, textB);
            dmp.diff_cleanupSemantic(diffs);
            let diffHtml = '<div class="card mt-4"><div class="diff-view">';
            let addCount = 0, delCount = 0;
            diffs.forEach(([op, text]) => {
              const t = escHtml(text);
              if (op === 1) { diffHtml += `<span class="diff-add">${t}</span>`; addCount += text.length; }
              else if (op === -1) { diffHtml += `<span class="diff-del">${t}</span>`; delCount += text.length; }
              else diffHtml += t;
            });
            diffHtml += `</div>
              <div class="diff-stats mt-3">
                <span class="diff-stat-add">+${addCount} chars added</span>
                <span class="diff-stat-del">-${delCount} chars removed</span>
              </div>
            </div>`;
            html += diffHtml;
          } else {
            html += `<div class="compare-sidebyside mt-4">
              <div class="compare-pane compare-pane-a">
                <div class="compare-pane-label">Filing A</div>
                <div class="compare-pane-content"><pre class="text-sm">${escHtml(textA)}</pre></div>
              </div>
              <div class="compare-pane compare-pane-b">
                <div class="compare-pane-label">Filing B</div>
                <div class="compare-pane-content"><pre class="text-sm">${escHtml(textB)}</pre></div>
              </div>
            </div>`;
          }
          html += '<p class="text-muted text-sm mt-3">For richer comparison with full document content, open individual filings (★ marked) and compare specific sections.</p>';
        }

        $('#compareResult').innerHTML = html;
      });

      function generateFilingText(f) {
        const ft = f.secFormType || f.formType || '';
        const desc = f.documentType || f.description || '';
        const rd = f.reportDate || '';
        const fd = f.filingDate || '';
        return `Form Type: ${ft}\nDescription: ${desc}\nFiling Date: ${fd}\nReport Date: ${rd}\nFiscal Year: ${f.fiscalYear || ''}\nFiscal Quarter: ${f.fiscalQuarter || ''}\nFiling ID: ${f.filingId || ''}`;
      }
    }

    // Render default tab
    renderFilingsTab();
  });

  // ===========================================================
  // PAGE: DOCUMENT VIEWER — COMPLETELY REWRITTEN
  // ===========================================================
  addRoute('/doc/{ticker}/{filingId}', async (params) => {
    const ticker = params.ticker.toUpperCase();
    const filingId = params.filingId;
    content().innerHTML = loadingSpinner();

    // Get filing metadata and all filings for sidebar
    const allFilings = await getFilings(ticker);
    const filingMeta = allFilings.find(f => (f.filingId || f.id) === filingId);
    const formType = filingMeta?.secFormType || filingMeta?.formType || '';
    const filingDate = filingMeta?.filingDate || '';
    const primaryDoc = filingMeta?.primaryDocument || '';
    const docTitle = filingMeta?.documentType || filingMeta?.description || formType || 'Filing';

    // Get company profile for sidebar
    const embeddedCo = getEmbeddedCompany(ticker);
    const profileData = await getProfile(ticker);
    const companyName = profileData?.name || profileData?.companyName || embeddedCo?.profile?.name || ticker;
    const cik = profileData?.cik || embeddedCo?.profile?.cik || await getCIK(ticker) || '';

    // Build description from formType + categories
    const formDescCat = FILING_CATEGORIES.find(c => c.forms.some(f => f.toUpperCase() === formType.toUpperCase()));
    const formDesc = getFilingDescription(formType, formDescCat) || docTitle;

    // Categorize all filings for sidebar
    const groups = {};
    for (const cat of FILING_CATEGORIES) groups[cat.key] = [];
    groups['other'] = [];
    allFilings.forEach(f => {
      const cats = categorizeFiling(f);
      cats.forEach(c => { if (groups[c]) groups[c].push(f); });
    });
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        const da = a.filingDate || a.dateFiled || '';
        const db = b.filingDate || b.dateFiled || '';
        return db.localeCompare(da);
      });
    }

    const SIDEBAR_SHOW = 3; // Show 3 per category initially

    // Build sidebar HTML
    const sidebarHtml = FILING_CATEGORIES.map(cat => {
      const items = groups[cat.key] || [];
      if (!items.length) return '';
      return `
        <div class="fdoc-cat-section" data-cat="${cat.key}">
          <div class="fdoc-cat-header">
            <span class="fdoc-cat-title">${escHtml(cat.label)}</span>
            <span class="fdoc-cat-count">${items.length} result${items.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="fdoc-cat-list">
            ${items.slice(0, SIDEBAR_SHOW).map(f => {
              const ft = f.secFormType || f.formType || f.type || '';
              const desc = getFilingDescription(ft, cat);
              const fd = f.filingDate || f.dateFiled || '';
              const fid = f.filingId || f.id || '';
              const isActive = fid === filingId;
              return `
                <a class="fdoc-filing-row ${isActive ? 'active' : ''}" href="#/doc/${ticker}/${fid}">
                  <span class="form-type">${escHtml(ft)}</span>
                  <span class="filing-desc">${escHtml(desc)}</span>
                  <span class="filing-date">${formatDateShort(fd)}</span>
                  <span class="row-chevron">›</span>
                </a>`;
            }).join('')}
          </div>
          ${items.length > SIDEBAR_SHOW ? `
            <div class="fdoc-cat-expand" data-cat="${cat.key}" data-expanded="false">
              ▾ Show ${items.length - SIDEBAR_SHOW} more
            </div>` : ''}
        </div>`;
    }).join('');

    // Render the layout
    content().innerHTML = `
      <div class="fdoc-layout">
        <aside class="fdoc-sidebar">
          <div class="fdoc-sidebar-header">
            <div style="display:flex;align-items:center;gap:10px;">
              <a href="#/company/${ticker}" style="color:var(--color-text-muted);font-size:1.2rem;text-decoration:none;" title="Back to ${ticker}">←</a>
              <div>
                <div class="company-name"><a href="#/company/${ticker}">${escHtml(companyName)}</a></div>
                <div class="company-ticker">${escHtml(ticker)}</div>
              </div>
            </div>
          </div>
          <div class="fdoc-search">
            <div class="fdoc-search-label">Search in Documents</div>
            <div class="fdoc-search-row">
              <input type="text" id="fdocSearchInput" placeholder="Search across all filings...">
              <button id="fdocSearchBtn">${icons.search}</button>
            </div>
          </div>
          <div class="fdoc-categories" id="fdocCategories">
            ${sidebarHtml}
          </div>
        </aside>
        <div class="fdoc-main">
          <div class="fdoc-doc-header">
            <div class="fdoc-doc-header-left">
              <h2>Form ${escHtml(formType)} - ${escHtml(formDesc)}</h2>
              <div class="meta-line">Company: ${escHtml(ticker)} &nbsp;|&nbsp; Filed: ${formatDate(filingDate)}</div>
            </div>
            <div class="fdoc-doc-header-right">
              <div class="doc-find-container" style="display:flex;gap:4px;">
                <input type="text" class="doc-find-input" id="fdocFindInput" placeholder="Find in document..." style="height:30px;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0 8px;font-size:0.786rem;width:180px;">
                <button class="btn btn-ghost btn-sm" id="fdocFindBtn">${icons.search}</button>
              </div>
              <button class="btn btn-outline btn-sm" id="fdocDownloadPdfBtn">${icons.download} PDF</button>
            </div>
          </div>
          <div class="fdoc-doc-body">
            <div class="fdoc-doc-content" id="fdocContent">
              ${loadingSpinner()}
              <p class="text-muted text-center mt-4">Loading full document from SEC EDGAR...</p>
            </div>
          </div>
        </div>
      </div>
    `;

    // === Wire up sidebar events ===

    // Expand/collapse categories
    $$('.fdoc-cat-expand', content()).forEach(btn => {
      btn.addEventListener('click', () => {
        const catKey = btn.dataset.cat;
        const expanded = btn.dataset.expanded === 'true';
        const section = btn.closest('.fdoc-cat-section');
        const listEl = section.querySelector('.fdoc-cat-list');
        const items = groups[catKey] || [];
        const cat = FILING_CATEGORIES.find(c => c.key === catKey);

        if (expanded) {
          // Collapse back to SIDEBAR_SHOW
          listEl.innerHTML = items.slice(0, SIDEBAR_SHOW).map(f => {
            const ft = f.secFormType || f.formType || f.type || '';
            const desc = getFilingDescription(ft, cat);
            const fd = f.filingDate || f.dateFiled || '';
            const fid = f.filingId || f.id || '';
            const isActive = fid === filingId;
            return `<a class="fdoc-filing-row ${isActive ? 'active' : ''}" href="#/doc/${ticker}/${fid}">
              <span class="form-type">${escHtml(ft)}</span>
              <span class="filing-desc">${escHtml(desc)}</span>
              <span class="filing-date">${formatDateShort(fd)}</span>
              <span class="row-chevron">›</span>
            </a>`;
          }).join('');
          btn.textContent = `▾ Show ${items.length - SIDEBAR_SHOW} more`;
          btn.dataset.expanded = 'false';
        } else {
          // Expand all
          listEl.innerHTML = items.map(f => {
            const ft = f.secFormType || f.formType || f.type || '';
            const desc = getFilingDescription(ft, cat);
            const fd = f.filingDate || f.dateFiled || '';
            const fid = f.filingId || f.id || '';
            const isActive = fid === filingId;
            return `<a class="fdoc-filing-row ${isActive ? 'active' : ''}" href="#/doc/${ticker}/${fid}">
              <span class="form-type">${escHtml(ft)}</span>
              <span class="filing-desc">${escHtml(desc)}</span>
              <span class="filing-date">${formatDateShort(fd)}</span>
              <span class="row-chevron">›</span>
            </a>`;
          }).join('');
          btn.textContent = `▴ Show less`;
          btn.dataset.expanded = 'true';
        }
      });
    });

    // Sidebar full-text search across all filings
    const searchBtn = $('#fdocSearchBtn');
    const searchInput = $('#fdocSearchInput');
    if (searchBtn && searchInput) {
      searchBtn.addEventListener('click', () => {
        const q = searchInput.value.trim();
        if (q) runFullTextSearch(q);
      });
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { searchBtn.click(); }
      });
    }

    /** Full-text search across all filings for a keyword. Shows snippet results in sidebar. */
    async function runFullTextSearch(query) {
      const categoriesEl = $('#fdocCategories');
      if (!categoriesEl) return;

      const q = query.toLowerCase();
      const qRegex = new RegExp(query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');

      // Show loading state in sidebar
      categoriesEl.innerHTML = `
        <div style="padding:16px 20px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
            <div class="loading-spinner" style="width:16px;height:16px"></div>
            <span style="font-size:0.857rem;color:var(--color-text-muted)">Searching filings for "${escHtml(query)}"...</span>
          </div>
          <div class="similar-progress-bar-wrap" style="height:4px;background:#e5e7eb;border-radius:4px;overflow:hidden">
            <div id="ftSearchProgress" class="similar-progress-bar" style="width:5%;height:100%;background:var(--color-primary);transition:width 0.3s"></div>
          </div>
          <div id="ftSearchStatus" style="font-size:0.714rem;color:var(--color-text-muted);margin-top:6px">Loading filings...</div>
        </div>`;

      // Also highlight keyword in current document immediately
      highlightKeywordInDoc(query);

      // Gather all filings to search through
      const all = allFilings.slice(0, 200); // limit to 200 most recent filings
      const results = []; // { filing, snippets: [{text, offset}] }

      const BATCH = 5;
      let done = 0;
      const progBar = document.getElementById('ftSearchProgress');
      const statusEl = document.getElementById('ftSearchStatus');

      for (let i = 0; i < all.length; i += BATCH) {
        const batch = all.slice(i, i + BATCH);
        await Promise.all(batch.map(async (f) => {
          const fid = f.filingId || f.id || '';
          if (!fid) return;
          let htmlText = null;

          // If this is the current filing, grab from the DOM
          if (fid === filingId) {
            const contentEl = document.getElementById('fdocContent');
            if (contentEl) htmlText = contentEl.innerText || contentEl.textContent || '';
          }

          // Try loading from cache
          if (!htmlText) {
            try {
              const cached = await loadFromCacheQuick(fid);
              if (cached) {
                // Strip HTML to get plain text
                htmlText = stripHtml(cached);
              }
            } catch(e) { /* skip */ }
          }

          if (!htmlText) return;
          if (!htmlText.toLowerCase().includes(q)) return;

          // Extract snippets — find paragraphs/blocks containing the keyword
          const snippets = extractSnippets(htmlText, query, qRegex);
          if (snippets.length) {
            results.push({ filing: f, snippets, totalMatches: (htmlText.match(qRegex) || []).length });
          }
        }));

        done += batch.length;
        const pct = Math.round((done / all.length) * 100);
        if (progBar) progBar.style.width = pct + '%';
        if (statusEl) statusEl.textContent = `Searched ${done} of ${all.length} filings (${results.length} with matches)...`;
      }

      // Render results grouped by category
      renderSearchResults(query, results, categoriesEl);
    }

    /** Quick cache load — only tries in-memory and static cache, no SEC proxy */
    async function loadFromCacheQuick(accessionId) {
      if (window.__FILING_CACHE__ && window.__FILING_CACHE__[accessionId]) {
        return await decompressGzipBase64(window.__FILING_CACHE__[accessionId]);
      }
      // Try dynamic script load from filing_cache
      const accNoDash = accessionId.replace(/-/g, '');
      try {
        const resp = await fetch(`./filing_cache/${accNoDash}.js?v=20260222`, { method: 'HEAD' });
        if (!resp.ok) return null;
      } catch(e) { return null; }
      return new Promise(resolve => {
        const script = document.createElement('script');
        script.src = `./filing_cache/${accNoDash}.js?v=20260222`;
        script.onload = async () => {
          if (window.__FILING_CACHE__ && window.__FILING_CACHE__[accessionId]) {
            try { resolve(await decompressGzipBase64(window.__FILING_CACHE__[accessionId])); }
            catch(e) { resolve(null); }
          } else { resolve(null); }
        };
        script.onerror = () => resolve(null);
        document.head.appendChild(script);
      });
    }

    /** Strip HTML tags and decode entities to get plain text */
    function stripHtml(html) {
      // Remove script/style content, XBRL tags
      let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<ix:[^>]*>/gi, '').replace(/<\/ix:[^>]*>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#\d+;/gi, ' ')
        .replace(/\s{2,}/g, ' ');
      return text;
    }

    /** Extract text snippets containing the keyword with surrounding context */
    function extractSnippets(text, query, regex) {
      const snippets = [];
      const q = query.toLowerCase();
      const CONTEXT_CHARS = 200; // chars before/after match
      const seen = new Set(); // dedup
      let match;
      regex.lastIndex = 0;

      while ((match = regex.exec(text)) !== null && snippets.length < 20) {
        const idx = match.index;
        // Extract surrounding context
        let start = Math.max(0, idx - CONTEXT_CHARS);
        let end = Math.min(text.length, idx + match[0].length + CONTEXT_CHARS);

        // Snap to word/sentence boundaries
        if (start > 0) {
          const spaceIdx = text.indexOf(' ', start);
          if (spaceIdx !== -1 && spaceIdx < idx) start = spaceIdx + 1;
        }
        if (end < text.length) {
          const spaceIdx = text.lastIndexOf(' ', end);
          if (spaceIdx > idx + match[0].length) end = spaceIdx;
        }

        let snippet = text.slice(start, end).trim();
        if (start > 0) snippet = '...' + snippet;
        if (end < text.length) snippet = snippet + '...';

        // Dedup by rough content
        const key = snippet.slice(0, 80).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        snippets.push({ text: snippet, offset: idx });
      }
      return snippets;
    }

    /** Highlight all occurrences of keyword in the document content */
    function highlightKeywordInDoc(query) {
      const mainEl = document.getElementById('fdocContent');
      if (!mainEl) return;

      // Clear previous search highlights
      mainEl.querySelectorAll('mark.ft-search-hl').forEach(m => {
        m.replaceWith(document.createTextNode(m.textContent));
      });
      // Normalize the DOM after removing marks
      mainEl.normalize();

      const regex = new RegExp(query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
      const walker = document.createTreeWalker(mainEl, NodeFilter.SHOW_TEXT, null, false);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      let count = 0;
      textNodes.forEach(node => {
        if (!node.nodeValue || !node.nodeValue.match(regex)) return;
        const span = document.createElement('span');
        span.innerHTML = node.nodeValue.replace(regex, m => {
          count++;
          return `<mark class="ft-search-hl">${m}</mark>`;
        });
        node.parentNode.replaceChild(span, node);
      });

      // Scroll to first match
      if (count) {
        const first = mainEl.querySelector('mark.ft-search-hl');
        if (first) {
          const scrollContainer = mainEl.closest('.fdoc-doc-body');
          if (scrollContainer) {
            const targetRect = first.getBoundingClientRect();
            const containerRect = scrollContainer.getBoundingClientRect();
            scrollContainer.scrollTo({ top: targetRect.top - containerRect.top + scrollContainer.scrollTop - 100, behavior: 'smooth' });
          }
        }
      }
    }

    /** Render full-text search results in the sidebar grouped by filing category */
    function renderSearchResults(query, results, containerEl) {
      if (!results.length) {
        containerEl.innerHTML = `
          <div style="padding:20px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:16px">
              <a href="javascript:void(0)" id="ftSearchBack" style="color:var(--color-text-muted);text-decoration:none;font-size:1.1rem" title="Back to filings">←</a>
              <span style="font-size:0.857rem;font-weight:600">Search: "${escHtml(query)}"</span>
            </div>
            <div style="text-align:center;padding:30px 10px;color:var(--color-text-muted)">
              <div style="font-size:2rem;margin-bottom:8px">🔍</div>
              <p style="font-size:0.857rem">No results found for "${escHtml(query)}"</p>
              <p style="font-size:0.786rem;margin-top:4px">Try a different keyword or check spelling.</p>
            </div>
          </div>`;
        document.getElementById('ftSearchBack')?.addEventListener('click', () => restoreSidebarFilings());
        return;
      }

      // Group results by filing category
      const grouped = {};
      let totalSnippets = 0;
      results.forEach(r => {
        const cats = categorizeFiling(r.filing);
        const cat = cats[0] || 'other';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(r);
        totalSnippets += r.totalMatches;
      });

      // Build category sections
      const qRegex = new RegExp(query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');

      let html = `
        <div class="fts-header">
          <div style="display:flex;align-items:center;gap:6px">
            <a href="javascript:void(0)" id="ftSearchBack" class="fts-back-btn" title="Back to filings">←</a>
            <span class="fts-query-label">${escHtml(query)}</span>
          </div>
        </div>`;

      // Render each category that has results
      for (const cat of FILING_CATEGORIES) {
        const catResults = grouped[cat.key];
        if (!catResults || !catResults.length) continue;
        const totalCatMatches = catResults.reduce((sum, r) => sum + r.totalMatches, 0);

        html += `
          <div class="fts-cat-section">
            <div class="fts-cat-header">
              <span class="fts-cat-title">${escHtml(cat.label)}</span>
              <span class="fts-cat-count">${totalCatMatches} result${totalCatMatches !== 1 ? 's' : ''}</span>
            </div>
            <div class="fts-cat-list">`;

        // Show filings and their snippets
        catResults.forEach(r => {
          const f = r.filing;
          const ft = f.secFormType || f.formType || '';
          const desc = f.description || f.primaryDocDescription || getFilingDescription(ft, cat) || '';
          const fd = f.filingDate || f.dateFiled || '';
          const fid = f.filingId || f.id || '';

          // Show up to 3 snippets per filing, with a "show more" toggle
          r.snippets.slice(0, 8).forEach((snip, si) => {
            // Highlight keyword in snippet
            const hlText = escHtml(snip.text).replace(
              new RegExp(query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'),
              m => `<b class="fts-keyword-hl">${m}</b>`
            );

            html += `
              <a class="fts-snippet-row" href="javascript:void(0)" data-fid="${escHtml(fid)}" data-offset="${snip.offset}" data-query="${escHtml(query)}">
                <div class="fts-snippet-meta">
                  <span class="fts-snippet-form">${escHtml(ft)}</span>
                  <span class="fts-snippet-desc">${escHtml(desc.slice(0, 60))}</span>
                  <span class="fts-snippet-date">${formatDateShort(fd)}</span>
                </div>
                <div class="fts-snippet-text">${hlText}</div>
              </a>`;
          });
        });

        html += `</div></div>`;
      }

      // Check for 'other' category
      if (grouped['other']?.length) {
        const otherResults = grouped['other'];
        const totalOther = otherResults.reduce((sum, r) => sum + r.totalMatches, 0);
        html += `
          <div class="fts-cat-section">
            <div class="fts-cat-header">
              <span class="fts-cat-title">Other</span>
              <span class="fts-cat-count">${totalOther} result${totalOther !== 1 ? 's' : ''}</span>
            </div>
            <div class="fts-cat-list">`;
        otherResults.forEach(r => {
          const f = r.filing;
          const ft = f.secFormType || f.formType || '';
          const fid = f.filingId || f.id || '';
          const fd = f.filingDate || '';
          r.snippets.slice(0, 4).forEach(snip => {
            const hlText = escHtml(snip.text).replace(qRegex, m => `<b class="fts-keyword-hl">${m}</b>`);
            html += `
              <a class="fts-snippet-row" href="javascript:void(0)" data-fid="${escHtml(fid)}" data-offset="${snip.offset}" data-query="${escHtml(query)}">
                <div class="fts-snippet-meta">
                  <span class="fts-snippet-form">${escHtml(ft)}</span>
                  <span class="fts-snippet-date">${formatDateShort(fd)}</span>
                </div>
                <div class="fts-snippet-text">${hlText}</div>
              </a>`;
          });
        });
        html += `</div></div>`;
      }

      containerEl.innerHTML = html;

      // Wire up back button
      document.getElementById('ftSearchBack')?.addEventListener('click', () => restoreSidebarFilings());

      // Wire up snippet clicks
      containerEl.querySelectorAll('.fts-snippet-row').forEach(row => {
        row.addEventListener('click', (e) => {
          e.preventDefault();
          const fid = row.dataset.fid;
          const offset = parseInt(row.dataset.offset || '0');
          const searchQuery = row.dataset.query || query;

          // Mark active
          containerEl.querySelectorAll('.fts-snippet-row').forEach(r => r.classList.remove('active'));
          row.classList.add('active');

          if (fid === filingId) {
            // Same document — just scroll to the match
            scrollToMatchInDoc(searchQuery, offset);
          } else {
            // Different filing — navigate with search highlight parameter
            navigate(`#/doc/${ticker}/${fid}?hl=${encodeURIComponent(searchQuery)}`);
          }
        });
      });
    }

    /** Scroll to a specific match occurrence in the current document */
    function scrollToMatchInDoc(query, offset) {
      const mainEl = document.getElementById('fdocContent');
      if (!mainEl) return;

      // Ensure highlights exist
      const marks = mainEl.querySelectorAll('mark.ft-search-hl');
      if (!marks.length) highlightKeywordInDoc(query);

      // Find the mark closest to the target offset by scanning text position
      const allMarks = mainEl.querySelectorAll('mark.ft-search-hl');
      if (!allMarks.length) return;

      // Remove previous active state
      allMarks.forEach(m => m.classList.remove('ft-search-active'));

      // Find closest mark — estimate by walking text nodes
      let bestMark = allMarks[0];
      let charCount = 0;
      let bestDist = Infinity;
      const walker = document.createTreeWalker(mainEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeType === Node.TEXT_NODE) {
          charCount += (node.nodeValue || '').length;
        } else if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('ft-search-hl')) {
          const dist = Math.abs(charCount - offset);
          if (dist < bestDist) {
            bestDist = dist;
            bestMark = node;
          }
        }
      }

      bestMark.classList.add('ft-search-active');
      const scrollContainer = mainEl.closest('.fdoc-doc-body');
      if (scrollContainer) {
        const targetRect = bestMark.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        scrollContainer.scrollTo({ top: targetRect.top - containerRect.top + scrollContainer.scrollTop - 100, behavior: 'smooth' });
      }
    }

    /** Restore the original filing list sidebar (after search) */
    function restoreSidebarFilings() {
      const categoriesEl = document.getElementById('fdocCategories');
      if (!categoriesEl) return;
      categoriesEl.innerHTML = sidebarHtml;

      // Clear search input
      const si = document.getElementById('fdocSearchInput');
      if (si) si.value = '';

      // Clear search highlights in document
      const mainEl = document.getElementById('fdocContent');
      if (mainEl) {
        mainEl.querySelectorAll('mark.ft-search-hl').forEach(m => {
          m.replaceWith(document.createTextNode(m.textContent));
        });
        mainEl.normalize();
      }

      // Re-wire expand/collapse
      categoriesEl.querySelectorAll('.fdoc-cat-expand').forEach(btn => {
        btn.addEventListener('click', () => {
          const catKey = btn.dataset.cat;
          const expanded = btn.dataset.expanded === 'true';
          const section = btn.closest('.fdoc-cat-section');
          const listEl = section.querySelector('.fdoc-cat-list');
          const items = groups[catKey] || [];
          if (!expanded) {
            listEl.innerHTML = items.map(f => {
              const ft = f.secFormType || f.formType || f.type || '';
              const catObj = FILING_CATEGORIES.find(c => c.key === catKey);
              const desc = getFilingDescription(ft, catObj);
              const fd = f.filingDate || f.dateFiled || '';
              const fid = f.filingId || f.id || '';
              const isActive = fid === filingId;
              return `<a class="fdoc-filing-row ${isActive ? 'active' : ''}" href="#/doc/${ticker}/${fid}"><span class="form-type">${escHtml(ft)}</span><span class="filing-desc">${escHtml(desc)}</span><span class="filing-date">${formatDateShort(fd)}</span><span class="row-chevron">›</span></a>`;
            }).join('');
            btn.textContent = `▴ Show less`;
            btn.dataset.expanded = 'true';
          } else {
            listEl.innerHTML = items.slice(0, SIDEBAR_SHOW).map(f => {
              const ft = f.secFormType || f.formType || f.type || '';
              const catObj = FILING_CATEGORIES.find(c => c.key === catKey);
              const desc = getFilingDescription(ft, catObj);
              const fd = f.filingDate || f.dateFiled || '';
              const fid = f.filingId || f.id || '';
              const isActive = fid === filingId;
              return `<a class="fdoc-filing-row ${isActive ? 'active' : ''}" href="#/doc/${ticker}/${fid}"><span class="form-type">${escHtml(ft)}</span><span class="filing-desc">${escHtml(desc)}</span><span class="filing-date">${formatDateShort(fd)}</span><span class="row-chevron">›</span></a>`;
            }).join('');
            btn.textContent = `▾ Show ${items.length - SIDEBAR_SHOW} more`;
            btn.dataset.expanded = 'false';
          }
        });
      });
    }

    // Download PDF button
    const pdfBtn = $('#fdocDownloadPdfBtn');
    if (pdfBtn) {
      pdfBtn.addEventListener('click', () => {
        const pdfUrl = filingMeta?.pdfUrl;
        if (pdfUrl) { window.open(pdfUrl, '_blank'); }
        else {
          // Try EDGAR link
          const accNoDash = filingId.replace(/-/g, '');
          window.open(`https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${filingId}-index.htm`, '_blank');
        }
      });
    }

    // Find in document (uses same highlight mechanism as full-text search)
    const findBtn = $('#fdocFindBtn');
    const findInput = $('#fdocFindInput');
    if (findBtn && findInput) {
      findBtn.addEventListener('click', () => {
        const term = findInput.value.trim();
        if (!term) return;
        highlightKeywordInDoc(term);
        const mainEl = $('#fdocContent');
        const count = mainEl.querySelectorAll('mark.ft-search-hl').length;
        if (count) {
          showToast(`Found ${count} match${count !== 1 ? 'es' : ''}`, 'info');
        } else {
          showToast(`"${term}" not found`, 'info');
        }
      });
      findInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') findBtn.click();
      });
    }

    // === LOAD THE FULL DOCUMENT ===
    const contentEl = $('#fdocContent');

    /** Clean XBRL/EDGAR HTML for display */
    function cleanEdgarHtml(html, cikNum, accessionNoDash) {
      // Strip XBRL inline tags but keep text content
      html = html.replace(/<ix:[^>]*>/gi, '').replace(/<\/ix:[^>]*>/gi, '');
      // Remove hidden XBRL elements
      html = html.replace(/<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>.*?<\/div>/gis, '');
      // Remove XML declaration
      html = html.replace(/<\?xml[^>]*\?>/g, '');
      // Simplify root html tag
      html = html.replace(/<html[^>]*>/, '<html>');
      // Rewrite relative URLs to SEC EDGAR
      const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDash}/`;
      html = html.replace(/(src|href)="(?!http|\/\/|#|data:)([^"]+)"/gi, (m, attr, path) => `${attr}="${base}${path}"`);
      return html;
    }

    /** Try to load a pre-cached filing from static JS files */
    async function loadFromCache(accessionId) {
      // Check if already loaded in memory
      if (window.__FILING_CACHE__ && window.__FILING_CACHE__[accessionId]) {
        console.log(`[Cache HIT] ${accessionId} already in memory`);
        return await decompressGzipBase64(window.__FILING_CACHE__[accessionId]);
      }
      // Try to dynamically load the cache file
      const accNoDash = accessionId.replace(/-/g, '');
      const cacheBust = '?v=20260222';
      const cacheUrl = `./filing_cache/${accNoDash}.js${cacheBust}`;
      try {
        const resp = await fetch(cacheUrl, { method: 'HEAD' });
        if (!resp.ok) return null;
      } catch(e) { return null; }
      // File exists — load it via dynamic script tag
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = cacheUrl;
        script.onload = async () => {
          if (window.__FILING_CACHE__ && window.__FILING_CACHE__[accessionId]) {
            try {
              const html = await decompressGzipBase64(window.__FILING_CACHE__[accessionId]);
              resolve(html);
            } catch(e) {
              console.warn('Decompression failed:', e);
              resolve(null);
            }
          } else {
            resolve(null);
          }
        };
        script.onerror = () => resolve(null);
        document.head.appendChild(script);
      });
    }

    /** Fetch full document directly from SEC EDGAR via CORS proxy */
    async function fetchDocumentDirect(ticker, filingId, primaryDoc) {
      let cikNum = cik ? String(cik).replace(/^0+/, '') : '';
      
      // If CIK is still empty, try to look it up
      if (!cikNum) {
        const lookedUp = await getCIK(ticker);
        if (lookedUp) cikNum = String(lookedUp).replace(/^0+/, '');
      }
      if (!cikNum) throw new Error(`Could not determine CIK for ${ticker}`);

      const accNoDash = filingId.replace(/-/g, '');

      // === FAST PATH: Check pre-cached static files ===
      contentEl.innerHTML = `
        <div style="padding:60px 20px;text-align:center">
          <div style="font-size:36px;margin-bottom:16px">📄</div>
          <h3 style="font-weight:600;margin-bottom:12px">Loading full document...</h3>
          <div style="max-width:400px;margin:0 auto">
            <div style="background:#e5e7eb;border-radius:8px;height:8px;overflow:hidden">
              <div id="docLoadProgress" style="background:#2563eb;height:100%;width:15%;transition:width 0.3s;animation:pulse 1.5s ease-in-out infinite"></div>
            </div>
            <p id="docLoadStatus" style="color:#6b7280;margin-top:8px;font-size:14px">Checking cache...</p>
          </div>
          <style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}</style>
        </div>`;

      const t0 = performance.now();
      const cachedHtml = await loadFromCache(filingId);
      if (cachedHtml) {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(`[Cache] Loaded ${filingId} in ${elapsed}s (${(cachedHtml.length/1024/1024).toFixed(1)}MB)`);
        const bar = document.getElementById('docLoadProgress');
        const stat = document.getElementById('docLoadStatus');
        if (bar) { bar.style.width = '100%'; bar.style.animation = 'none'; }
        if (stat) stat.textContent = `Loaded from cache in ${elapsed}s`;
        return cachedHtml;
      }

      // === SLOW PATH: CORS proxy fallback ===
      const bar = document.getElementById('docLoadProgress');
      const stat = document.getElementById('docLoadStatus');
      if (stat) stat.textContent = 'Fetching from SEC EDGAR...';
      if (bar) bar.style.width = '15%';

      // Determine the document URL
      let docName = primaryDoc;
      console.log(`[fetchDocumentDirect] ticker=${ticker}, filingId=${filingId}, primaryDoc="${primaryDoc}", cikNum=${cikNum}`);
      if (!docName) {
        console.warn('[fetchDocumentDirect] primaryDoc is empty, falling back to index page scrape');
        try {
          const idxUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${filingId}-index.htm`;
          const idxResp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(idxUrl)}`);
          if (idxResp.ok) {
            const idxHtml = await idxResp.text();
            // Strategy 1: Extract the first .htm link from the filing documents table
            const tableMatch = idxHtml.match(/<table[^>]*class="tableFile"[^>]*>([\s\S]*?)<\/table>/);
            if (tableMatch) {
              // Look for links in the table — handles both /ix?doc=...path/file.htm and direct /Archives/.../file.htm
              const tableLinks = tableMatch[1].match(/href="([^"]+\.htm[l]?)"/gi) || [];
              for (const link of tableLinks) {
                const urlPart = link.match(/href="([^"]+)"/i)?.[1] || '';
                // Extract filename from path (handles /ix?doc=.../file.htm and /Archives/.../file.htm)
                const fnMatch = urlPart.match(/\/([^\/]+\.htm)(?:\?|$|")/i) || urlPart.match(/\/([^\/]+\.htm)$/i);
                if (fnMatch && fnMatch[1] !== 'index.htm' && !fnMatch[1].endsWith('-index.htm')) {
                  docName = fnMatch[1];
                  console.log(`[fetchDocumentDirect] Extracted from table: ${docName}`);
                  break;
                }
              }
            }
            // Strategy 2: Broader fallback — find .htm links in Archives path (skip nav links)
            if (!docName) {
              const archiveLinks = idxHtml.match(/href="\/Archives\/edgar\/data\/[^"]+\.htm"/gi) || [];
              if (archiveLinks.length) {
                const firstLink = archiveLinks[0].match(/\/([^\/"]+\.htm)"/i);
                if (firstLink && firstLink[1] !== 'index.htm') {
                  docName = firstLink[1];
                  console.log(`[fetchDocumentDirect] Extracted from archive link: ${docName}`);
                }
              }
            }
            // Strategy 3: Look for /ix?doc= viewer links
            if (!docName) {
              const ixMatch = idxHtml.match(/\/ix\?doc=\/Archives\/[^"]*\/([^\/"]+\.htm)/i);
              if (ixMatch) {
                docName = ixMatch[1];
                console.log(`[fetchDocumentDirect] Extracted from ix viewer link: ${docName}`);
              }
            }
          }
        } catch(e) { console.warn('Index fetch failed:', e); }
      }

      if (!docName) throw new Error('Could not determine primary document');

      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${docName}`;

      // Fetch via CORS proxy (with retry + cache-bust on failure)
      let resp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(docUrl)}`);
      if (!resp.ok) {
        // Retry with cache-busting on the SEC URL to bypass stale CF edge cache
        console.warn(`First fetch failed (${resp.status}), retrying with cache-bust...`);
        const bustUrl = docUrl + (docUrl.includes('?') ? '&' : '?') + '_cb=' + Date.now();
        resp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(bustUrl)}`);
      }
      if (!resp.ok) throw new Error(`SEC EDGAR returned HTTP ${resp.status}`);

      if (bar) { bar.style.width = '60%'; bar.style.animation = 'none'; }
      if (stat) stat.textContent = 'Processing document...';

      const rawHtml = await resp.text();

      if (bar) bar.style.width = '90%';
      if (stat) stat.textContent = 'Rendering...';

      return cleanEdgarHtml(rawHtml, cikNum, accNoDash);
    }

    try {
      const docHtml = await fetchDocumentDirect(ticker, filingId, primaryDoc);

      // Extract body content
      const bodyMatch = docHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      let bodyContent = bodyMatch ? bodyMatch[1] : docHtml;

      // Also extract any <style> tags from <head> to preserve document styling
      const styleMatches = docHtml.match(/<style[^>]*>[\s\S]*?<\/style>/gi);
      const styles = styleMatches ? styleMatches.join('\n') : '';

      contentEl.innerHTML = styles + bodyContent;

      // Intercept internal anchor links (table of contents) to prevent hash router interference
      // Remove previous handler if any (prevent stacking)
      if (contentEl._tocHandler) contentEl.removeEventListener('click', contentEl._tocHandler);
      contentEl._tocHandler = function(e) {
        const link = e.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href) return;
        
        // Handle internal anchor links (e.g., #R1, #item1, #toc)
        if (href.startsWith('#') && !href.startsWith('#/')) {
          e.preventDefault();
          e.stopPropagation();
          const targetId = decodeURIComponent(href.slice(1));
          if (!targetId) return;
          // getElementById is the most reliable — handles special chars in IDs
          let target = document.getElementById(targetId);
          // Also try name attribute
          if (!target) {
            try { target = contentEl.querySelector('[name="' + targetId.replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"]'); } catch(ex) {}
          }
          // Case-insensitive fallback for SEC filings
          if (!target) {
            const lower = targetId.toLowerCase();
            for (const el of contentEl.querySelectorAll('[id], [name]')) {
              if ((el.id || '').toLowerCase() === lower || (el.getAttribute('name') || '').toLowerCase() === lower) {
                target = el;
                break;
              }
            }
          }
          // Debug logging
          const idCount = contentEl.querySelectorAll('[id]').length;
          console.log(`[TOC Debug] href=${href}, targetId=${targetId}, found=${!!target}, totalIDs=${idCount}`);
          if (!target && typeof showToast === 'function') showToast(`Anchor not found: ${targetId.slice(0,40)}`, 'error');
          if (target) {
            // Find the scrollable parent (.fdoc-doc-body has overflow-y: auto)
            const scrollContainer = contentEl.closest('.fdoc-doc-body');
            if (scrollContainer) {
              const targetRect = target.getBoundingClientRect();
              const containerRect = scrollContainer.getBoundingClientRect();
              const offset = targetRect.top - containerRect.top + scrollContainer.scrollTop;
              scrollContainer.scrollTo({ top: offset - 20, behavior: 'smooth' });
            } else {
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }
          return;
        }
        
        // Open external links in new tab
        if (href.startsWith('http://') || href.startsWith('https://')) {
          e.preventDefault();
          window.open(href, '_blank', 'noopener');
          return;
        }
      };
      contentEl.addEventListener('click', contentEl._tocHandler);

      // Initialize table tools
      initTableTools(contentEl, ticker, filingId, formType, filingDate, null);

      // Auto-highlight if navigated from search (?hl= parameter)
      const hlParam = new URLSearchParams(window.location.hash.split('?')[1] || '').get('hl');
      if (hlParam) {
        setTimeout(() => highlightKeywordInDoc(hlParam), 200);
        // Also pre-fill the search input
        const si = document.getElementById('fdocSearchInput');
        if (si) si.value = hlParam;
      }

      // Auto-scroll to table if ?table= parameter present
      const tableParam = new URLSearchParams(window.location.hash.split('?')[1] || '').get('table');
      if (tableParam) {
        const tableNum = parseInt(tableParam);
        if (!isNaN(tableNum) && tableNum >= 1) {
          // Wait for document to fully render, then scroll
          function scrollToTargetTable() {
            const badges = contentEl.querySelectorAll('.table-index-badge');
            let targetBar = null;
            for (const badge of badges) {
              if (badge.textContent.trim() === `Table ${tableNum}`) {
                targetBar = badge.closest('.table-tools-bar');
                break;
              }
            }
            if (!targetBar) return false;
            const wrapper = targetBar.closest('.table-tools-wrapper');
            const scrollTarget = targetBar;
            const scrollContainer = contentEl.closest('.fdoc-doc-body');
            if (scrollContainer) {
              const targetRect = scrollTarget.getBoundingClientRect();
              const containerRect = scrollContainer.getBoundingClientRect();
              scrollContainer.scrollTo({ top: targetRect.top - containerRect.top + scrollContainer.scrollTop - 20, behavior: 'smooth' });
            }
            // Highlight the table briefly
            if (wrapper) {
              wrapper.style.outline = '3px solid #991b1b';
              wrapper.style.outlineOffset = '2px';
              wrapper.style.borderRadius = '6px';
              setTimeout(() => {
                wrapper.style.outline = '';
                wrapper.style.outlineOffset = '';
              }, 4000);
            }
            return true;
          }
          // Retry a few times as the document may still be rendering
          let attempts = 0;
          const tryScroll = setInterval(() => {
            attempts++;
            if (scrollToTargetTable() || attempts >= 10) clearInterval(tryScroll);
          }, 500);
        }
      }
    } catch(err) {
      console.error('Document fetch error:', err);
      // Fallback: try embedded data
      const filingDocs = embeddedCo?.filingDocuments || {};
      const embeddedDoc = filingDocs[filingId];
      if (embeddedDoc && embeddedDoc.sections) {
        contentEl.innerHTML = embeddedDoc.sections.map(s => `<h2>${escHtml(s.title)}</h2>${s.content}`).join('<hr>');
        initTableTools(contentEl, ticker, filingId, formType, filingDate, null);
      } else {
        contentEl.innerHTML = `
          <div class="text-center" style="padding:60px 20px">
            <div style="font-size:48px;margin-bottom:16px">📄</div>
            <h3 class="fw-600 mb-3">Could not load document</h3>
            <p class="text-muted mb-4">${escHtml(err.message)}</p>
            <a href="https://www.sec.gov/Archives/edgar/data/${cik}/${filingId.replace(/-/g,'')}/${filingId}-index.htm" target="_blank" class="btn btn-primary">${icons.external} View on SEC EDGAR</a>
          </div>`;
      }
    }

    // Scroll active sidebar item into view
    const activeRow = document.querySelector('.fdoc-filing-row.active');
    if (activeRow) {
      setTimeout(() => activeRow.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    }
  });

  // ===========================================================
  // PAGE: GLOBAL SEARCH
  // ===========================================================
  addRoute('/search', async (params) => {
    const query = params.q || '';
    const formsParam = params.forms || '';
    const page = parseInt(params.page || '0');

    if (query && !state.recentSearches.includes(query)) {
      state.recentSearches.unshift(query);
      if (state.recentSearches.length > 5) state.recentSearches.pop();
    }

    content().innerHTML = `
      <div class="search-layout">
        <aside class="search-sidebar">
          <div class="search-sidebar-group">
            <h3>Document Type</h3>
            ${['10-K', '10-Q', '8-K', 'DEF 14A', 'S-1', 'SC 13D', '13F-HR', 'Form 4'].map(ft => `
              <label><input type="checkbox" value="${ft}" class="search-form-cb" ${formsParam.includes(ft) ? 'checked' : ''}> ${ft}</label>
            `).join('')}
          </div>
          <div class="search-sidebar-group">
            <h3>Date Range</h3>
            <div class="form-group">
              <label class="form-label text-xs">From</label>
              <input type="date" class="form-input form-input-sm" id="searchDateStart">
            </div>
            <div class="form-group">
              <label class="form-label text-xs">To</label>
              <input type="date" class="form-input form-input-sm" id="searchDateEnd">
            </div>
          </div>
          <div class="search-sidebar-group">
            <h3>Options</h3>
            <label><input type="checkbox" id="searchWatchOnly"> Watch List Only</label>
          </div>
          ${state.recentSearches.length ? `
          <div class="search-sidebar-group">
            <h3>Recent Searches</h3>
            ${state.recentSearches.map(q => `<a href="#/search?q=${encodeURIComponent(q)}" class="recent-search-chip">${icons.clock} ${escHtml(q)}</a>`).join('')}
          </div>` : ''}
        </aside>
        <div class="search-main">
          <div class="search-bar-top">
            <input type="text" class="form-input" id="searchMainInput" placeholder="Search SEC filings..." value="${escHtml(query)}">
            <button class="btn btn-primary" id="searchBtn">Search</button>
          </div>
          <div id="searchResults">${query ? loadingSpinner() : `<div class="empty-state mt-8"><div class="empty-state-icon">${icons.search}</div><h3>Search SEC Filings</h3><p>Enter a search term to search across all EDGAR filings.</p><div class="mt-4"><p class="text-muted text-sm">Try: <a href="#/search?q=artificial+intelligence+risk" class="text-link">artificial intelligence risk</a> · <a href="#/search?q=metaverse+strategy" class="text-link">metaverse strategy</a> · <a href="#/search?q=revenue+recognition" class="text-link">revenue recognition</a></p></div></div>`}</div>
        </div>
      </div>
    `;

    function doSearch() {
      const q = $('#searchMainInput').value.trim();
      const checkedForms = $$('.search-form-cb:checked').map(cb => cb.value).join(',');
      if (q) navigate(`#/search?q=${encodeURIComponent(q)}${checkedForms ? '&forms=' + encodeURIComponent(checkedForms) : ''}`);
    }

    $('#searchBtn').addEventListener('click', doSearch);
    $('#searchMainInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    if (query) {
      // First: search embedded data
      const embeddedResults = searchEmbeddedData(query, formsParam);

      try {
        const data = await edgarSearch(query, formsParam, page);
        renderSearchResults(data, query, page, embeddedResults);
      } catch (err) {
        // Show embedded results even if EDGAR fails
        if (embeddedResults.length) {
          renderSearchResults({ hits: { hits: [], total: { value: 0 } } }, query, page, embeddedResults);
        } else {
          $('#searchResults').innerHTML = `<div class="card mt-4"><p class="text-danger">Search error: ${escHtml(err.message)}</p><p class="text-muted text-sm mt-2">Try searching for a company name or ticker directly.</p></div>`;
        }
      }
    }

    function searchEmbeddedData(q, forms) {
      const data = getEmbeddedData();
      if (!data?.companies) return [];
      const ql = q.toLowerCase();
      const results = [];
      Object.entries(data.companies).forEach(([ticker, co]) => {
        const profile = co.profile || {};
        // Search filings
        (co.filings || []).forEach(f => {
          const ft = f.secFormType || f.formType || '';
          const desc = f.documentType || f.description || '';
          if (forms && !forms.split(',').some(fm => ft.toLowerCase().includes(fm.toLowerCase()))) return;
          if (desc.toLowerCase().includes(ql) || ft.toLowerCase().includes(ql) || ticker.toLowerCase().includes(ql) || profile.name?.toLowerCase().includes(ql)) {
            results.push({ ticker, name: profile.name || ticker, formType: ft, desc, date: f.filingDate, filingId: f.filingId || '' });
          }
        });
        // Search transcripts
        (co.transcripts || []).forEach(t => {
          if (t.highlights?.toLowerCase().includes(ql) || t.event?.toLowerCase().includes(ql)) {
            results.push({ ticker, name: profile.name || ticker, formType: 'Transcript', desc: t.event, date: t.date, filingId: '' });
          }
        });
      });
      return results.slice(0, 10);
    }

    function renderSearchResults(data, q, currentPage, embeddedResults = []) {
      const hits = data?.hits?.hits || data?.hits || [];
      const total = data?.hits?.total?.value || data?.total?.value || hits.length;
      const container = $('#searchResults');

      let html = '';

      // Show embedded results first
      if (embeddedResults.length) {
        html += `<div class="search-results-section">
          <h4 class="search-section-label">From WamSEC Demo Data</h4>
          ${embeddedResults.map(r => `
            <div class="search-result-card" onclick="location.hash='#/company/${r.ticker}'">
              <div class="search-result-header">
                ${formBadge(r.formType)}
                <span class="search-result-company fw-600 ml-2">${escHtml(r.name)} (${escHtml(r.ticker)})</span>
                <span class="search-result-date">${formatDate(r.date)}</span>
              </div>
              <div class="search-result-desc">${escHtml(r.desc)}</div>
            </div>`).join('')}
        </div>`;
      }

      if (hits.length > 0) {
        html += `<div class="search-results-section">
          <h4 class="search-section-label">From EDGAR Full-Text Search <span class="text-muted text-sm">(${total.toLocaleString()} total results)</span></h4>`;

        hits.forEach(hit => {
          const src = hit._source || hit;
          const ft = src.form || src.form_type || src.root_forms?.[0] || src.file_type || '';
          const company = src.display_names?.join(', ') || src.entity_name || '';
          const dateFiled = src.file_date || src.date_filed || '';
          const desc = src.file_description || src.display_description || '';
          const snippet = (hit.highlight?.text || []).join('... ') || desc;
          const tickerMatch = company.match(/\(([A-Z]+)\)/);
          const tickerFromName = tickerMatch ? tickerMatch[1] : '';

          html += `
            <div class="search-result-card" onclick="location.hash='${tickerFromName ? '#/company/' + tickerFromName : '#/search?q=' + encodeURIComponent(q)}'">
              <div class="search-result-header">
                ${formBadge(ft)}
                <span class="search-result-company">${escHtml(company)}</span>
                <span class="search-result-date">${formatDate(dateFiled)}</span>
              </div>
              <div class="search-result-desc">${escHtml(desc)}</div>
              ${snippet && snippet !== desc ? `<div class="search-result-snippet">${escHtml(snippet)}</div>` : ''}
            </div>
          `;
        });
        html += '</div>';

        // Pagination
        const totalPages = Math.ceil(total / 20);
        if (totalPages > 1) {
          html += '<div class="pagination">';
          html += `<button ${currentPage === 0 ? 'disabled' : ''} onclick="location.hash='#/search?q=${encodeURIComponent(q)}&page=${currentPage - 1}'">← Prev</button>`;
          for (let i = 0; i < Math.min(totalPages, 10); i++) {
            html += `<button class="${i === currentPage ? 'active' : ''}" onclick="location.hash='#/search?q=${encodeURIComponent(q)}&page=${i}'">${i + 1}</button>`;
          }
          html += `<button ${currentPage >= totalPages - 1 ? 'disabled' : ''} onclick="location.hash='#/search?q=${encodeURIComponent(q)}&page=${currentPage + 1}'">Next →</button>`;
          html += '</div>';
        }
      } else if (!embeddedResults.length) {
        html = `<div class="empty-state mt-8"><h3>No results found</h3><p>Try a different search query or adjust your filters.</p></div>`;
      }

      container.innerHTML = html;
    }
  });

  // ===========================================================
  // PAGE: ALL-COMPANY DOCUMENT SEARCH (Screening)
  // ===========================================================

  // SIC code to industry name mapping (common sectors)
  const SIC_INDUSTRIES = {
    '3674': 'Semiconductors', '7372': 'Software', '7371': 'IT Services', '7370': 'Internet Services',
    '7373': 'Computer Systems', '7577': 'Computer Peripherals', '3572': 'Data Storage', '3576': 'Networking',
    '3661': 'Telecom Equipment', '3663': 'Radio/TV Equipment', '3570': 'Computer Hardware',
    '5961': 'Catalog Retail', '4813': 'Telecom Services', '4812': 'Wireless Telecom',
    '6020': 'Banking', '6021': 'National Banks', '6022': 'State Banks', '6035': 'Savings Institutions',
    '6141': 'Credit Services', '6153': 'Financial Services', '6199': 'Finance Services',
    '6200': 'Securities', '6211': 'Securities Dealers', '6282': 'Investment Advice',
    '6311': 'Insurance-Life', '6321': 'Insurance-Health', '6331': 'Insurance-Fire', '6399': 'Insurance',
    '6500': 'Real Estate', '6510': 'Real Estate Operators', '6552': 'REIT', '6770': 'Investment Offices',
    '6794': 'Patent Owners', '6798': 'REIT',
    '2834': 'Pharma', '2835': 'Diagnostics', '2836': 'Biotech',
    '3841': 'Medical Devices', '3842': 'Medical Instruments', '3845': 'Medical Electronics',
    '8000': 'Healthcare Services', '8011': 'Physicians', '8060': 'Hospitals', '8071': 'Medical Labs',
    '2911': 'Oil Refining', '1311': 'Oil & Gas Extraction', '1381': 'Drilling', '1382': 'Oil & Gas Services',
    '4911': 'Electric Utilities', '4923': 'Natural Gas', '4931': 'Electric & Gas', '4953': 'Waste Management',
    '2000': 'Food Products', '2080': 'Beverages', '5411': 'Grocery Stores', '5812': 'Restaurants',
    '3711': 'Motor Vehicles', '3714': 'Auto Parts', '3721': 'Aircraft', '3812': 'Defense Electronics',
    '5311': 'Department Stores', '5331': 'Variety Stores', '5600': 'Apparel Retail', '5999': 'Retail',
    '7361': 'Staffing', '7363': 'Staffing Services', '7389': 'Business Services',
    '8711': 'Engineering Services', '8721': 'Accounting', '8731': 'R&D Services', '8742': 'Management Consulting',
    '3620': 'Electrical Equipment', '3621': 'Motors & Generators', '3679': 'Electronic Components',
    '3089': 'Plastics Products', '2821': 'Plastics Materials', '2860': 'Industrial Chemicals',
    '3559': 'Industrial Machinery', '5045': 'Computer Wholesale', '5900': 'Retail-General',
  };

  function getIndustryFromSic(sics) {
    if (!sics || !sics.length) return 'Other or Unknown';
    return SIC_INDUSTRIES[sics[0]] || 'Other or Unknown';
  }

  const DOC_CATEGORIES_FILTER = [
    { key: 'transcripts', label: 'Transcripts', forms: ['425'] },
    { key: 'financials', label: 'Financials', forms: ['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F'] },
    { key: 'news', label: 'Current Events (8-K)', forms: ['8-K', '8-K/A', '6-K', '6-K/A'] },
    { key: 'proxies', label: 'Proxies', forms: ['DEF 14A', 'DEFA14A', 'DEFC14A', 'DEFR14A', 'PRE 14A'] },
    { key: 'registration', label: 'Registration & Prospectus', forms: ['S-1', 'S-1/A', 'S-3', 'S-4', 'S-11', '424B4', '424B2', 'F-1', 'F-3'] },
    { key: 'ownership', label: 'Ownership', forms: ['SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A', '3', '4', '5'] },
  ];

  const MARKET_CAP_CATEGORIES = [
    { key: 'large', label: '≥$10bn', desc: 'Large' },
    { key: 'mid', label: '$2bn–$10bn', desc: 'Mid' },
    { key: 'small', label: '$300mm–$2bn', desc: 'Small' },
    { key: 'micro', label: '<$300mm', desc: 'Micro' },
    { key: 'private', label: 'Private or No Market Cap', desc: 'Private' },
  ];

  addRoute('/screening/search', async (params) => {
    const q = params.q || '';
    content().innerHTML = `
      <div class="acds-page">
        <div class="acds-header">
          <h1>All-Company Document Search</h1>
          <p>Search across the text of all companies' documents</p>
        </div>
        <div class="acds-search-bar">
          <input type="text" id="acdsSearchInput" placeholder="Any keyword or phrase" value="${escHtml(q)}">
          <button class="acds-search-btn" id="acdsSearchBtn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          </button>
        </div>
        <div class="acds-controls">
          <div class="acds-toggle-wrap">
            <span class="acds-toggle-label active" id="acdsToggleCompanies">Top Companies</span>
            <div class="acds-toggle" id="acdsToggle"></div>
            <span class="acds-toggle-label" id="acdsToggleDocs">Latest Docs</span>
          </div>
          <a class="acds-adv-link" href="https://efts.sec.gov/LATEST/search-index" target="_blank">Advanced Operators</a>
        </div>
        <div id="acdsResultsArea"></div>
        ${siteFooter()}
      </div>
    `;

    let viewMode = 'companies';
    let currentPage = 1;
    let allResults = [];
    let activeFilters = {
      timeFrame: 'last5y',
      marketCap: new Set(['large','mid','small','micro','private']),
      industries: new Set(),
      docCategories: new Set(['transcripts','financials','news','proxies','registration','ownership']),
      watchedOnly: false,
    };

    const searchInput = $('#acdsSearchInput');
    const toggleEl = $('#acdsToggle');
    const toggleCompLabel = $('#acdsToggleCompanies');
    const toggleDocLabel = $('#acdsToggleDocs');

    toggleEl.addEventListener('click', () => {
      viewMode = viewMode === 'companies' ? 'docs' : 'companies';
      toggleEl.classList.toggle('on', viewMode === 'docs');
      toggleCompLabel.classList.toggle('active', viewMode === 'companies');
      toggleDocLabel.classList.toggle('active', viewMode === 'docs');
      currentPage = 1;
      renderResults();
    });

    function doSearch() {
      const val = searchInput.value.trim();
      if (!val) return;
      currentPage = 1;
      history.replaceState(null, '', `#/screening/search?q=${encodeURIComponent(val)}`);
      fetchResults(val);
    }
    $('#acdsSearchBtn').addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

    async function fetchResults(query) {
      const area = $('#acdsResultsArea');
      area.innerHTML = '<div class="acds-loading"><div class="spinner"></div><br>Searching SEC filings...</div>';

      const timeMap = { 'last30d': 30, 'last3m': 90, 'last6m': 180, 'last1y': 365, 'last2y': 730, 'last5y': 1826 };
      const days = timeMap[activeFilters.timeFrame] || 1826;
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const fmt = d => d.toISOString().split('T')[0];

      let formTypes = [];
      for (const cat of DOC_CATEGORIES_FILTER) {
        if (activeFilters.docCategories.has(cat.key)) formTypes.push(...cat.forms);
      }
      const filterForms = activeFilters.docCategories.size < DOC_CATEGORIES_FILTER.length;

      // Build CIK filter for watched companies
      let ciksParam = '';
      if (activeFilters.watchedOnly && state.watchList.length > 0) {
        const cikPromises = state.watchList.map(w => getCIK(w.ticker));
        const ciks = (await Promise.all(cikPromises)).filter(Boolean);
        if (ciks.length === 0) {
          allResults = [];
          renderResults();
          return;
        }
        ciksParam = '&ciks=' + ciks.join(',');
      }

      try {
        const params = `q=${encodeURIComponent(query)}&dateRange=custom&startdt=${fmt(startDate)}&enddt=${fmt(endDate)}`;
        const formsParam = filterForms && formTypes.length ? `&forms=${formTypes.join(',')}` : '';
        const url = `${SEC_PROXY}/?url=${encodeURIComponent(`https://efts.sec.gov/LATEST/search-index?${params}${formsParam}${ciksParam}`)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Search failed');
        const data = await resp.json();
        allResults = (data.hits?.hits || []).map(h => h._source);
        renderResults();
      } catch(e) {
        console.error('ACDS search error:', e);
        area.innerHTML = '<div class="acds-empty"><p>Search failed. Please try again.</p></div>';
      }
    }

    function renderResults() {
      const area = $('#acdsResultsArea');
      if (!allResults.length) {
        area.innerHTML = '<div class="acds-empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg><p>No results found. Try a different search term.</p></div>';
        return;
      }
      if (viewMode === 'companies') renderCompanyView(area);
      else renderDocsView(area);
    }

    function buildSidebar(allIndustries) {
      return `
        <div class="acds-sidebar">
          <div class="acds-sidebar-section">
            <h3>Time Frame</h3>
            <select id="acdsTimeFrame">
              <option value="last30d"${activeFilters.timeFrame==='last30d'?' selected':''}>Last 30 Days</option>
              <option value="last3m"${activeFilters.timeFrame==='last3m'?' selected':''}>Last 3 Months</option>
              <option value="last6m"${activeFilters.timeFrame==='last6m'?' selected':''}>Last 6 Months</option>
              <option value="last1y"${activeFilters.timeFrame==='last1y'?' selected':''}>Last 1 Year</option>
              <option value="last2y"${activeFilters.timeFrame==='last2y'?' selected':''}>Last 2 Years</option>
              <option value="last5y"${activeFilters.timeFrame==='last5y'?' selected':''}>Last 5 Years</option>
            </select>
          </div>
          <div class="acds-sidebar-section">
            <h3>Market Cap</h3>
            ${MARKET_CAP_CATEGORIES.map(mc => `
              <label class="acds-filter-check">
                <input type="checkbox" data-mcap="${mc.key}" ${activeFilters.marketCap.has(mc.key)?'checked':''}>
                <span class="check-label">${mc.desc}</span>
                <span class="check-desc">${mc.label}</span>
              </label>
            `).join('')}
          </div>
          <div class="acds-sidebar-section">
            <h3>Industries <a class="acds-edit-link" id="acdsEditIndustries">Edit</a></h3>
            <div style="font-size:13px;color:#6b7280">${activeFilters.industries.size === 0 ? 'All' : [...activeFilters.industries].join(', ')}</div>
          </div>
          <div class="acds-sidebar-section">
            <h3>Companies</h3>
            <label class="acds-filter-check">
              <input type="checkbox" id="acdsWatchedOnly" ${activeFilters.watchedOnly?'checked':''}>
              <span class="check-label">Only on Your Watched List</span>
            </label>
          </div>
          <div class="acds-sidebar-section">
            <h3>Document Categories</h3>
            ${DOC_CATEGORIES_FILTER.map(dc => `
              <label class="acds-filter-check">
                <input type="checkbox" data-doccat="${dc.key}" ${activeFilters.docCategories.has(dc.key)?'checked':''}>
                <span class="check-label">${dc.label}</span>
              </label>
            `).join('')}
          </div>
        </div>
      `;
    }

    function renderCompanyView(area) {
      const companyMap = {};
      for (const r of allResults) {
        const cik = (r.ciks && r.ciks[0]) || '';
        if (!cik) continue;
        if (!companyMap[cik]) {
          const displayName = (r.display_names && r.display_names[0]) || '';
          const nameMatch = displayName.match(/^(.+?)\s+\(([^)]+)\)/);
          const companyName = nameMatch ? nameMatch[1].trim() : displayName;
          const tickerPart = nameMatch ? nameMatch[2] : '';
          const tickers = tickerPart.split(',').map(t => t.trim()).filter(Boolean);
          const sics = r.sics || [];
          const industry = getIndustryFromSic(sics);
          companyMap[cik] = { cik, companyName, tickers, industry, sics, docs: 0 };
        }
        companyMap[cik].docs++;
      }

      let companies = Object.values(companyMap);

      if (activeFilters.watchedOnly) {
        const wt = new Set(state.watchList.map(w => w.ticker.toUpperCase()));
        companies = companies.filter(c => c.tickers.some(t => wt.has(t.toUpperCase())));
      }
      if (activeFilters.industries.size > 0) {
        companies = companies.filter(c => activeFilters.industries.has(c.industry));
      }

      companies.sort((a, b) => b.docs - a.docs);
      const perPage = 25;
      const totalPages = Math.ceil(companies.length / perPage);
      const page = companies.slice((currentPage - 1) * perPage, currentPage * perPage);
      const allIndustries = [...new Set(Object.values(companyMap).map(c => c.industry))].sort();

      area.innerHTML = `
        <div class="acds-results">
          ${buildSidebar(allIndustries)}
          <div class="acds-table-wrap">
            <div class="acds-total-count">${companies.length} companies found</div>
            <table class="acds-table">
              <thead><tr><th>Company</th><th>Industry</th><th style="text-align:right">Matching Docs</th><th style="width:24px"></th></tr></thead>
              <tbody>
                ${page.map(c => {
                  const ticker = c.tickers[0] || '';
                  return `<tr data-ticker="${escHtml(ticker)}" data-cik="${escHtml(c.cik)}">
                    <td><a class="acds-company-name" href="#/company/${escHtml(ticker || c.cik)}">${escHtml(c.companyName)}</a>${ticker ? `<span class="acds-exchange">${escHtml(ticker)}</span>` : ''}</td>
                    <td>${escHtml(c.industry)}</td>
                    <td class="acds-match-count"><a class="acds-match-link" href="#/screening/company/${escHtml(ticker || c.cik)}?q=${encodeURIComponent(q)}">${c.docs}</a></td>
                    <td class="acds-chevron">›</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
            ${totalPages > 1 ? `<div class="acds-pagination"><button class="acds-page-btn" id="acdsPrev" ${currentPage<=1?'disabled':''}>← Previous</button><span class="acds-page-info">Page ${currentPage} of ${totalPages}</span><button class="acds-page-btn" id="acdsNext" ${currentPage>=totalPages?'disabled':''}>Next →</button></div>` : ''}
          </div>
        </div>
      `;
      wireFilters(allIndustries);
    }

    function renderDocsView(area) {
      let docs = [...allResults];
      if (activeFilters.watchedOnly) {
        const wt = new Set(state.watchList.map(w => w.ticker.toUpperCase()));
        docs = docs.filter(r => {
          const dn = (r.display_names && r.display_names[0]) || '';
          const m = dn.match(/\(([^)]+)\)/);
          if (!m) return false;
          return m[1].split(',').some(t => wt.has(t.trim().toUpperCase()));
        });
      }
      if (activeFilters.industries.size > 0) {
        docs = docs.filter(r => activeFilters.industries.has(getIndustryFromSic(r.sics)));
      }
      docs.sort((a, b) => (b.file_date || '').localeCompare(a.file_date || ''));

      const perPage = 50;
      const totalPages = Math.ceil(docs.length / perPage);
      const pageDocs = docs.slice((currentPage - 1) * perPage, currentPage * perPage);
      const allIndustries = [...new Set(allResults.map(r => getIndustryFromSic(r.sics)))].sort();

      area.innerHTML = `
        <div class="acds-results">
          ${buildSidebar(allIndustries)}
          <div class="acds-table-wrap">
            <div class="acds-total-count">${docs.length} documents found</div>
            <table class="acds-table">
              <thead><tr><th>Company</th><th>Form</th><th>Description</th><th>Filed</th><th style="width:24px"></th></tr></thead>
              <tbody>
                ${pageDocs.map(d => {
                  const dn = (d.display_names && d.display_names[0]) || '';
                  const nm = dn.match(/^(.+?)\s+\(([^)]+)\)/);
                  const companyName = nm ? nm[1].trim() : dn;
                  const ticker = nm ? nm[2].split(',')[0].trim() : '';
                  const accession = (d.adsh || '').replace(/-/g, '');
                  return `<tr class="acds-doc-row" data-ticker="${escHtml(ticker)}" data-fid="${accession}">
                    <td><a class="acds-company-name" href="#/company/${escHtml(ticker)}">${escHtml(companyName)}</a>${ticker ? `<span class="acds-exchange">${escHtml(ticker)}</span>` : ''}</td>
                    <td><span class="acds-form-badge">${escHtml(d.form || '')}</span></td>
                    <td class="acds-doc-desc" title="${escHtml(d.file_description || '')}">${escHtml(d.file_description || d.form || '')}</td>
                    <td style="white-space:nowrap">${d.file_date || ''}</td>
                    <td class="acds-chevron">›</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
            ${totalPages > 1 ? `<div class="acds-pagination"><button class="acds-page-btn" id="acdsPrev" ${currentPage<=1?'disabled':''}>← Previous</button><span class="acds-page-info">Page ${currentPage} of ${totalPages}</span><button class="acds-page-btn" id="acdsNext" ${currentPage>=totalPages?'disabled':''}>Next →</button></div>` : ''}
          </div>
        </div>
      `;

      $$('.acds-doc-row', area).forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('a')) return;
          const ticker = row.dataset.ticker;
          const fid = row.dataset.fid;
          if (ticker && fid) navigate(`#/doc/${ticker}/${fid}`);
          else if (ticker) navigate(`#/company/${ticker}`);
        });
      });
      wireFilters(allIndustries);
    }

    function wireFilters(allIndustries) {
      const tfSelect = $('#acdsTimeFrame');
      if (tfSelect) tfSelect.addEventListener('change', () => {
        activeFilters.timeFrame = tfSelect.value;
        const query = searchInput.value.trim();
        if (query) fetchResults(query);
      });
      const watchCb = $('#acdsWatchedOnly');
      if (watchCb) watchCb.addEventListener('change', () => {
        activeFilters.watchedOnly = watchCb.checked;
        currentPage = 1;
        const query = searchInput.value.trim();
        if (query) fetchResults(query);
      });
      $$('[data-doccat]').forEach(cb => cb.addEventListener('change', () => {
        const key = cb.dataset.doccat;
        if (cb.checked) activeFilters.docCategories.add(key);
        else activeFilters.docCategories.delete(key);
        const query = searchInput.value.trim();
        if (query) fetchResults(query);
      }));
      const editBtn = $('#acdsEditIndustries');
      if (editBtn) editBtn.addEventListener('click', () => showIndustryModal(allIndustries));
      const prevBtn = $('#acdsPrev');
      const nextBtn = $('#acdsNext');
      if (prevBtn) prevBtn.addEventListener('click', () => { currentPage--; renderResults(); });
      if (nextBtn) nextBtn.addEventListener('click', () => { currentPage++; renderResults(); });
      $$('.acds-table tbody tr', $('#acdsResultsArea')).forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('a')) return;
          const ticker = row.dataset.ticker;
          const currentQ = searchInput.value.trim();
          if (ticker && currentQ) navigate(`#/screening/company/${ticker}?q=${encodeURIComponent(currentQ)}`);
          else if (ticker) navigate(`#/company/${ticker}`);
        });
      });
    }

    function showIndustryModal(allIndustries) {
      const overlay = document.createElement('div');
      overlay.className = 'acds-modal-overlay';
      overlay.innerHTML = `
        <div class="acds-modal">
          <h3>Select Industries</h3>
          <label class="acds-filter-check" style="margin-bottom:12px;font-weight:600">
            <input type="checkbox" id="acdsIndAll" ${activeFilters.industries.size===0?'checked':''}>
            <span class="check-label">All Industries</span>
          </label>
          ${allIndustries.map(ind => `
            <label class="acds-filter-check">
              <input type="checkbox" data-ind="${escHtml(ind)}" ${activeFilters.industries.size===0||activeFilters.industries.has(ind)?'checked':''}>
              <span class="check-label">${escHtml(ind)}</span>
            </label>
          `).join('')}
          <div class="acds-modal-actions">
            <button class="acds-modal-btn" id="acdsIndCancel">Cancel</button>
            <button class="acds-modal-btn primary" id="acdsIndApply">Apply</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const allCb = overlay.querySelector('#acdsIndAll');
      const indCbs = [...overlay.querySelectorAll('[data-ind]')];
      allCb.addEventListener('change', () => { indCbs.forEach(cb => { cb.checked = allCb.checked; }); });
      indCbs.forEach(cb => cb.addEventListener('change', () => { allCb.checked = indCbs.every(c => c.checked); }));
      overlay.querySelector('#acdsIndCancel').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#acdsIndApply').addEventListener('click', () => {
        if (allCb.checked || indCbs.every(c => c.checked)) activeFilters.industries = new Set();
        else activeFilters.industries = new Set(indCbs.filter(c => c.checked).map(c => c.dataset.ind));
        overlay.remove();
        currentPage = 1;
        renderResults();
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    if (q) fetchResults(q);
  });

  // Placeholder routes for other screening pages
  addRoute('/screening/recent', async () => {
    content().innerHTML = `<div class="acds-page"><div class="acds-header"><h1>All-Company Recent Filings</h1><p>View all recent filings of a form type</p></div><div class="acds-empty"><p>Coming soon.</p></div>${siteFooter()}</div>`;
  });
  addRoute('/screening/alerts', async () => {
    content().innerHTML = `<div class="acds-page"><div class="acds-header"><h1>All-Company Filing Alerts</h1><p>Manage alerts for any new filings of a form type</p></div><div class="acds-empty"><p>Coming soon.</p></div>${siteFooter()}</div>`;
  });
  addRoute('/screening/search-alerts', async () => {
    content().innerHTML = `<div class="acds-page"><div class="acds-header"><h1>All-Company Search Alerts</h1><p>Manage alerts for any new documents that match a search</p></div><div class="acds-empty"><p>Coming soon.</p></div>${siteFooter()}</div>`;
  });

  // ===========================================================
  // PAGE: COMPANY SEARCH DRILL-DOWN (from All-Company Doc Search)
  // ===========================================================
  addRoute('/screening/company/{ticker}', async (params) => {
    const ticker = params.ticker.toUpperCase();
    const q = params.q || '';
    if (!q) { navigate('#/screening/search'); return; }

    content().innerHTML = loadingSpinner();

    // Look up CIK and company info
    const cik = await getCIK(ticker);
    const profileData = await getProfile(ticker);
    const embeddedCo = getEmbeddedCompany(ticker);
    const companyName = profileData?.name || profileData?.companyName || embeddedCo?.profile?.name || ticker;

    // Fetch all matching filings from EFTS for this company + query
    let eftsResults = [];
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 1826); // 5 years
      const fmt = d => d.toISOString().split('T')[0];
      const ciksParam = cik ? `&ciks=${cik}` : '';
      const searchUrl = `${SEC_PROXY}/?url=${encodeURIComponent(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&dateRange=custom&startdt=${fmt(startDate)}&enddt=${fmt(endDate)}${ciksParam}`)}`;
      const resp = await fetch(searchUrl);
      if (resp.ok) {
        const data = await resp.json();
        eftsResults = (data.hits?.hits || []).map(h => h._source);
      }
    } catch(e) { console.error('EFTS company search error:', e); }

    // Categorize EFTS results by filing type using FILING_CATEGORIES
    function categorizeEftsForm(form) {
      const ft = (form || '').toUpperCase().trim();
      for (const cat of FILING_CATEGORIES) {
        if (cat.forms.some(cf => cf.toUpperCase() === ft)) return cat.key;
      }
      return 'other';
    }

    const grouped = {};
    for (const cat of FILING_CATEGORIES) grouped[cat.key] = [];
    grouped['other'] = [];
    eftsResults.forEach(r => {
      const catKey = categorizeEftsForm(r.form);
      if (!grouped[catKey]) grouped[catKey] = [];
      grouped[catKey].push(r);
    });

    // Build the 3-panel layout
    const cikNum = cik ? String(cik).replace(/^0+/, '') : '';

    // State
    let activeCatKey = null;
    let activeFilingIdx = null;
    let activeSnippetIdx = null;
    let currentDocHtml = null;
    let snippetsForActiveDoc = [];

    // Find first non-empty category
    for (const cat of FILING_CATEGORIES) {
      if (grouped[cat.key]?.length) { activeCatKey = cat.key; break; }
    }
    if (!activeCatKey && grouped['other']?.length) activeCatKey = 'other';

    content().innerHTML = `
      <div class="scd-layout">
        <aside class="scd-sidebar">
          <div class="scd-sidebar-header">
            <a class="scd-back-link" href="#/screening/search?q=${encodeURIComponent(q)}">← Back to All-Company Document Search</a>
            <div class="scd-company-info">
              <a href="#/company/${escHtml(ticker)}" class="scd-company-name">${escHtml(companyName)}</a>
              <span class="scd-company-ticker">${escHtml(ticker)}</span>
            </div>
          </div>
          <div class="scd-search-box">
            <input type="text" id="scdSearchInput" value="${escHtml(q)}" placeholder="Search keyword...">
            <button id="scdSearchBtn">${icons.search}</button>
          </div>
          <div class="scd-categories" id="scdCategories"></div>
        </aside>
        <div class="scd-snippets" id="scdSnippets">
          <div class="scd-snippets-header" id="scdSnippetsHeader"></div>
          <div class="scd-snippets-list" id="scdSnippetsList"></div>
        </div>
        <div class="scd-docview" id="scdDocview">
          <div class="scd-doc-header" id="scdDocHeader"></div>
          <div class="scd-doc-body" id="scdDocBody">
            <div class="scd-doc-placeholder">
              <div style="font-size:48px;margin-bottom:16px">📄</div>
              <p>Click a snippet to view the full document</p>
            </div>
          </div>
        </div>
      </div>
    `;

    // Render the sidebar categories
    function renderCategories() {
      const el = $('#scdCategories');
      if (!el) return;
      let html = '';
      const allCats = [...FILING_CATEGORIES, { key: 'other', label: 'Other', forms: [] }];
      for (const cat of allCats) {
        const items = grouped[cat.key] || [];
        if (!items.length) continue;
        const isActive = cat.key === activeCatKey;
        html += `<div class="scd-cat ${isActive ? 'active' : ''}" data-catkey="${cat.key}">
          <div class="scd-cat-header">
            <span class="scd-cat-label">${escHtml(cat.label)}</span>
            <span class="scd-cat-count">${items.length} result${items.length !== 1 ? 's' : ''}</span>
          </div>
          ${isActive ? `<div class="scd-cat-filings">${items.map((r, i) => {
            const desc = r.file_description || r.form || '';
            const isActiveFiling = i === activeFilingIdx;
            return `<a class="scd-filing-item ${isActiveFiling ? 'active' : ''}" data-catkey="${cat.key}" data-idx="${i}">
              <span class="scd-filing-form">${escHtml(r.form || '')}</span>
              <span class="scd-filing-desc">${escHtml(desc.length > 50 ? desc.slice(0, 50) + '...' : desc)}</span>
              <span class="scd-filing-date">${r.file_date || ''}</span>
            </a>`;
          }).join('')}</div>` : ''}
        </div>`;
      }
      el.innerHTML = html;

      // Wire category clicks
      el.querySelectorAll('.scd-cat-header').forEach(hdr => {
        hdr.addEventListener('click', () => {
          const catKey = hdr.closest('.scd-cat').dataset.catkey;
          activeCatKey = catKey;
          activeFilingIdx = null;
          renderCategories();
          // Show prompt to select a filing
          const snippetsEl = $('#scdSnippetsList');
          const headerEl = $('#scdSnippetsHeader');
          if (headerEl) headerEl.innerHTML = '';
          if (snippetsEl) snippetsEl.innerHTML = '<div class="scd-no-snippets"><p>Select a filing from the sidebar to see keyword matches.</p></div>';
        });
      });
      // Wire filing clicks
      el.querySelectorAll('.scd-filing-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.preventDefault();
          const catKey = item.dataset.catkey;
          const idx = parseInt(item.dataset.idx);
          activeCatKey = catKey;
          activeFilingIdx = idx;
          renderCategories();
          loadFilingSnippets(grouped[catKey][idx]);
        });
      });
    }

    // Load snippets for a specific filing — fetch its content and extract snippets
    async function loadFilingSnippets(filing) {
      const snippetsEl = $('#scdSnippetsList');
      const headerEl = $('#scdSnippetsHeader');
      if (!snippetsEl || !headerEl) return;

      const accession = (filing.adsh || '').replace(/-/g, '');
      const accessionDashed = filing.adsh || '';
      const form = filing.form || '';
      const desc = filing.file_description || form;
      const date = filing.file_date || '';

      headerEl.innerHTML = `
        <div class="scd-snippet-filing-info">
          <span class="scd-snippet-form-badge">${escHtml(form)}</span>
          <span class="scd-snippet-filing-desc">${escHtml(desc)}</span>
          <span class="scd-snippet-filing-date">${date}</span>
        </div>
      `;

      snippetsEl.innerHTML = '<div class="scd-loading"><div class="spinner"></div><br>Loading document and extracting snippets...</div>';

      // Attempt to load document content
      let docHtml = null;
      try {
        // Try cache first
        if (window.__FILING_CACHE__ && window.__FILING_CACHE__[accessionDashed]) {
          docHtml = await decompressGzipBase64(window.__FILING_CACHE__[accessionDashed]);
        }
        if (!docHtml) {
          const accNoDash = accessionDashed.replace(/-/g, '');
          try {
            const cacheResp = await fetch(`./filing_cache/${accNoDash}.js?v=20260222`, { method: 'HEAD' });
            if (cacheResp.ok) {
              docHtml = await new Promise(resolve => {
                const script = document.createElement('script');
                script.src = `./filing_cache/${accNoDash}.js?v=20260222`;
                script.onload = async () => {
                  if (window.__FILING_CACHE__ && window.__FILING_CACHE__[accessionDashed]) {
                    try { resolve(await decompressGzipBase64(window.__FILING_CACHE__[accessionDashed])); }
                    catch(e) { resolve(null); }
                  } else { resolve(null); }
                };
                script.onerror = () => resolve(null);
                document.head.appendChild(script);
              });
            }
          } catch(e) { /* skip cache */ }
        }
        // Fallback: fetch directly from SEC
        if (!docHtml && cikNum) {
          // Get filing index to find primary doc
          const idxUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession}/${accessionDashed}-index.htm`;
          const idxResp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(idxUrl)}`);
          if (idxResp.ok) {
            const idxHtml = await idxResp.text();
            let docName = '';
            const tableMatch = idxHtml.match(/<table[^>]*class="tableFile"[^>]*>([\s\S]*?)<\/table>/);
            if (tableMatch) {
              const tableLinks = tableMatch[1].match(/href="([^"]+\.htm[l]?)"/gi) || [];
              for (const link of tableLinks) {
                const urlPart = link.match(/href="([^"]+)"/i)?.[1] || '';
                const fnMatch = urlPart.match(/\/([^\/]+\.htm)(?:\?|$|")/i) || urlPart.match(/\/([^\/]+\.htm)$/i);
                if (fnMatch && fnMatch[1] !== 'index.htm' && !fnMatch[1].endsWith('-index.htm')) {
                  docName = fnMatch[1];
                  break;
                }
              }
            }
            if (!docName) {
              const ixMatch = idxHtml.match(/\/ix\?doc=\/Archives\/[^"]*\/([^\/"]+\.htm)/i);
              if (ixMatch) docName = ixMatch[1];
            }
            if (docName) {
              const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession}/${docName}`;
              const docResp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(docUrl)}`);
              if (docResp.ok) {
                const rawHtml = await docResp.text();
                docHtml = rawHtml
                  .replace(/<ix:[^>]*>/gi, '').replace(/<\/ix:[^>]*>/gi, '')
                  .replace(/<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>.*?<\/div>/gis, '');
              }
            }
          }
        }
      } catch(e) {
        console.error('Failed to load filing content for snippets:', e);
      }

      if (!docHtml) {
        snippetsEl.innerHTML = '<div class="scd-no-snippets"><p>Could not load document content. <a href="#/doc/' + ticker + '/' + (accessionDashed || accession) + '?hl=' + encodeURIComponent(q) + '">View filing directly</a></p></div>';
        return;
      }

      currentDocHtml = docHtml;

      // Extract plain text and find snippets
      const plainText = stripHtmlGlobal(docHtml);
      const qRegex = new RegExp(q.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
      const snippets = [];
      const CONTEXT_CHARS = 250;
      const seen = new Set();
      let match;
      qRegex.lastIndex = 0;
      while ((match = qRegex.exec(plainText)) !== null && snippets.length < 30) {
        const idx = match.index;
        let start = Math.max(0, idx - CONTEXT_CHARS);
        let end = Math.min(plainText.length, idx + match[0].length + CONTEXT_CHARS);
        if (start > 0) { const sp = plainText.indexOf(' ', start); if (sp !== -1 && sp < idx) start = sp + 1; }
        if (end < plainText.length) { const sp = plainText.lastIndexOf(' ', end); if (sp > idx + match[0].length) end = sp; }
        let snippet = plainText.slice(start, end).trim();
        if (start > 0) snippet = '...' + snippet;
        if (end < plainText.length) snippet = snippet + '...';
        const key = snippet.slice(0, 80).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        snippets.push({ text: snippet, offset: idx });
      }

      snippetsForActiveDoc = snippets;

      if (!snippets.length) {
        snippetsEl.innerHTML = '<div class="scd-no-snippets"><p>No keyword matches found in this document.</p></div>';
        return;
      }

      // Render snippets
      snippetsEl.innerHTML = snippets.map((snip, i) => {
        const hlText = escHtml(snip.text).replace(
          new RegExp(q.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi'),
          m => `<b class="scd-keyword-hl">${m}</b>`
        );
        return `<div class="scd-snippet ${i === 0 ? 'active' : ''}" data-idx="${i}" data-offset="${snip.offset}">
          <div class="scd-snippet-text">${hlText}</div>
        </div>`;
      }).join('');

      // Wire snippet clicks
      snippetsEl.querySelectorAll('.scd-snippet').forEach(el => {
        el.addEventListener('click', () => {
          snippetsEl.querySelectorAll('.scd-snippet').forEach(s => s.classList.remove('active'));
          el.classList.add('active');
          const offset = parseInt(el.dataset.offset);
          renderDocWithHighlight(offset);
        });
      });

      // Auto-load the document into the right panel with first snippet highlighted
      renderDocWithHighlight(snippets[0].offset);
    }

    // Strip HTML for global use (outside doc viewer closure)
    function stripHtmlGlobal(html) {
      let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<ix:[^>]*>/gi, '').replace(/<\/ix:[^>]*>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#\d+;/gi, ' ')
        .replace(/\s{2,}/g, ' ');
      return text;
    }

    // Render the document in the right panel with keyword highlighting
    function renderDocWithHighlight(targetOffset) {
      const docBody = $('#scdDocBody');
      const docHeader = $('#scdDocHeader');
      if (!docBody || !currentDocHtml) return;

      // Get filing info for header
      const filing = (grouped[activeCatKey] || [])[activeFilingIdx];
      const form = filing?.form || '';
      const desc = filing?.file_description || form;
      const accessionDashed = filing?.adsh || '';

      docHeader.innerHTML = `
        <div class="scd-doc-title">
          <span class="scd-doc-form-badge">${escHtml(form)}</span>
          <span>${escHtml(desc)}</span>
        </div>
        <div class="scd-doc-actions">
          <a class="btn btn-outline btn-sm" href="#/doc/${ticker}/${accessionDashed || ''}?hl=${encodeURIComponent(q)}">${icons.external} Full Viewer</a>
        </div>
      `;

      // Extract body content
      const bodyMatch = currentDocHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      let bodyContent = bodyMatch ? bodyMatch[1] : currentDocHtml;
      const styleMatches = currentDocHtml.match(/<style[^>]*>[\s\S]*?<\/style>/gi);
      const styles = styleMatches ? styleMatches.join('\n') : '';

      docBody.innerHTML = `<div class="scd-doc-content" id="scdDocContent">${styles}${bodyContent}</div>`;

      // Highlight all keyword occurrences
      const contentEl = $('#scdDocContent');
      if (!contentEl) return;
      const regex = new RegExp(q.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
      const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null, false);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      textNodes.forEach(node => {
        if (!node.nodeValue || !node.nodeValue.match(regex)) return;
        const span = document.createElement('span');
        span.innerHTML = node.nodeValue.replace(regex, m => `<mark class="scd-search-hl">${m}</mark>`);
        node.parentNode.replaceChild(span, node);
      });

      // Scroll to the closest match near targetOffset
      const allMarks = contentEl.querySelectorAll('mark.scd-search-hl');
      if (!allMarks.length) return;

      allMarks.forEach(m => m.classList.remove('scd-search-active'));

      let bestMark = allMarks[0];
      let charCount = 0;
      let bestDist = Infinity;
      const walker2 = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false);
      while (walker2.nextNode()) {
        const node = walker2.currentNode;
        if (node.nodeType === Node.TEXT_NODE) {
          charCount += (node.nodeValue || '').length;
        } else if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('scd-search-hl')) {
          const dist = Math.abs(charCount - targetOffset);
          if (dist < bestDist) {
            bestDist = dist;
            bestMark = node;
          }
        }
      }

      bestMark.classList.add('scd-search-active');
      setTimeout(() => {
        const targetRect = bestMark.getBoundingClientRect();
        const containerRect = docBody.getBoundingClientRect();
        docBody.scrollTo({ top: targetRect.top - containerRect.top + docBody.scrollTop - 100, behavior: 'smooth' });
      }, 100);
    }

    // Wire search input
    const scdSearchInput = $('#scdSearchInput');
    const scdSearchBtn = $('#scdSearchBtn');
    if (scdSearchInput && scdSearchBtn) {
      scdSearchBtn.addEventListener('click', () => {
        const val = scdSearchInput.value.trim();
        if (val) navigate(`#/screening/company/${ticker}?q=${encodeURIComponent(val)}`);
      });
      scdSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') scdSearchBtn.click(); });
    }

    // Initial render
    renderCategories();

    // If there's an active category, auto-select first filing and load snippets
    if (activeCatKey && grouped[activeCatKey]?.length) {
      activeFilingIdx = 0;
      renderCategories();
      loadFilingSnippets(grouped[activeCatKey][0]);
    } else {
      const snippetsEl = $('#scdSnippetsList');
      if (snippetsEl) snippetsEl.innerHTML = '<div class="scd-no-snippets"><p>No matching documents found for this company.</p></div>';
    }
  });

  // ===========================================================
  // PAGE: DASHBOARD
  // ===========================================================
  addRoute('/dashboard', async () => {
    if (!state.auth.loggedIn) { navigate('#/login'); return; }

    const hasWatchList = state.watchList.length > 0;

    content().innerHTML = `
      <div class="container mt-6">
        <h1 class="fw-700 mb-6">Dashboard</h1>
        <div class="dashboard-layout">
          <div class="dashboard-left">
            <div class="card">
              <div class="flex items-center justify-between mb-4">
                <h2 class="fw-600" style="font-size:1.143rem">Documents Feed</h2>
                <select class="form-select form-select-sm" style="width:auto;min-width:120px" id="feedFilter">
                  <option value="all">All Types</option>
                  <option value="10-K">10-K</option>
                  <option value="10-Q">10-Q</option>
                  <option value="8-K">8-K</option>
                </select>
              </div>
              <div class="dashboard-feed" id="dashboardFeed">
                ${hasWatchList
                  ? state.watchList.map(w => `
                    <div class="feed-item" onclick="location.hash='#/company/${w.ticker}'">
                      <span class="feed-item-time">Today</span>
                      <div class="feed-item-content">
                        <div class="feed-item-company">${escHtml(w.name || w.ticker)}</div>
                        <div class="feed-item-desc">Recent filings available — click to view</div>
                      </div>
                    </div>`).join('')
                  : '<div class="empty-state"><div class="empty-state-icon">📋</div><h3>No items in feed</h3><p>Add companies to your Watch List to see their filings here.</p></div>'}
              </div>
            </div>
          </div>
          <div class="dashboard-right">
            <div class="dashboard-widget">
              <h3>${icons.star} Your Watch List</h3>
              ${state.watchList.length
                ? state.watchList.map(w => `
                  <div class="widget-item">
                    <a href="#/company/${w.ticker}" style="font-weight:500">${escHtml(w.ticker)}</a>
                    <span class="text-muted text-sm">${escHtml(w.name || '')}</span>
                  </div>`).join('')
                : '<p class="text-muted text-sm">No companies watched yet.</p>'}
            </div>
            <div class="dashboard-widget">
              <h3>${icons.clock} Recent Searches</h3>
              ${state.recentSearches.length
                ? state.recentSearches.map(q => `
                  <div class="widget-item">
                    <a href="#/search?q=${encodeURIComponent(q)}">${escHtml(q)}</a>
                  </div>`).join('')
                : '<p class="text-muted text-sm">No recent searches.</p>'}
            </div>
            <div class="dashboard-widget">
              <h3>${icons.bell} Active Alerts</h3>
              <div class="widget-item">
                <span class="fw-600" style="font-size:1.5rem">${state.alerts.length}</span>
                <span class="text-muted text-sm">active alert${state.alerts.length !== 1 ? 's' : ''}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  });

  // ===========================================================
  // PAGE: LOGIN
  // ===========================================================
  addRoute('/login', async () => {
    content().innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <h1>Sign In</h1>
          <p class="auth-subtitle">Welcome back to WamSEC</p>
          <button class="btn-google">
            <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Sign in with Google
          </button>
          <div class="auth-divider">or sign in with email</div>
          <form id="loginForm">
            <div class="form-group">
              <label class="form-label">Email</label>
              <input type="email" class="form-input" placeholder="you@company.com" required>
            </div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input type="password" class="form-input" placeholder="Enter your password" required>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Sign In</button>
          </form>
          <div class="auth-footer">Don't have an account? <a href="#/register">Sign up</a></div>
        </div>
      </div>
    `;

    $('#loginForm').addEventListener('submit', e => {
      e.preventDefault();
      state.auth = { loggedIn: true, user: { name: 'Demo User', email: 'demo@wamsec.com' } };
      updateNavbar();
      showToast('Signed in successfully', 'success');
      navigate('#/dashboard');
    });

    $('button.btn-google')?.addEventListener('click', () => {
      state.auth = { loggedIn: true, user: { name: 'Demo User', email: 'demo@gmail.com' } };
      updateNavbar();
      showToast('Signed in with Google', 'success');
      navigate('#/dashboard');
    });
  });

  // ===========================================================
  // PAGE: REGISTER
  // ===========================================================
  addRoute('/register', async () => {
    content().innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <h1>Create Account</h1>
          <p class="auth-subtitle">Start researching SEC filings today</p>
          <button class="btn-google">
            <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Sign up with Google
          </button>
          <div class="auth-divider">or sign up with email</div>
          <form id="registerForm">
            <div class="form-group">
              <label class="form-label">Full Name</label>
              <input type="text" class="form-input" placeholder="Jane Smith" required>
            </div>
            <div class="form-group">
              <label class="form-label">Email</label>
              <input type="email" class="form-input" placeholder="you@company.com" required>
            </div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input type="password" class="form-input" placeholder="Create a password" required>
            </div>
            <div class="form-group">
              <label class="form-label">Confirm Password</label>
              <input type="password" class="form-input" placeholder="Confirm your password" required>
            </div>
            <button type="submit" class="btn btn-success" style="width:100%;margin-top:8px">Create Account</button>
          </form>
          <div class="auth-footer">Already have an account? <a href="#/login">Sign in</a></div>
        </div>
      </div>
    `;

    $('#registerForm').addEventListener('submit', e => {
      e.preventDefault();
      state.auth = { loggedIn: true, user: { name: 'New User', email: 'new@wamsec.com' } };
      updateNavbar();
      showToast('Account created successfully!', 'success');
      navigate('#/dashboard');
    });

    $('button.btn-google')?.addEventListener('click', () => {
      state.auth = { loggedIn: true, user: { name: 'Demo User', email: 'demo@gmail.com' } };
      updateNavbar();
      showToast('Signed up with Google', 'success');
      navigate('#/dashboard');
    });
  });

  // ===========================================================
  // PAGE: SETTINGS
  // ===========================================================
  function settingsLayout(activeTab, mainContent) {
    return `
      <div class="settings-layout" style="min-height:calc(100vh - var(--navbar-h))">
        <nav class="settings-nav">
          <a href="#/settings/account" class="${activeTab === 'account' ? 'active' : ''}">${icons.user} Account</a>
          <a href="#/settings/watchlist" class="${activeTab === 'watchlist' ? 'active' : ''}">${icons.star} Watch List</a>
          <a href="#/settings/alerts" class="${activeTab === 'alerts' ? 'active' : ''}">${icons.bell} Alerts</a>
        </nav>
        <div class="settings-main">${mainContent}</div>
      </div>
    `;
  }

  addRoute('/settings/account', async () => {
    if (!state.auth.loggedIn) { navigate('#/login'); return; }
    content().innerHTML = settingsLayout('account', `
      <h2>Account Settings</h2>
      <div class="settings-section">
        <h3>Profile</h3>
        <div class="form-group"><label class="form-label">Full Name</label><input type="text" class="form-input" value="${escHtml(state.auth.user?.name || '')}"></div>
        <div class="form-group"><label class="form-label">Email</label><input type="email" class="form-input" value="${escHtml(state.auth.user?.email || '')}"></div>
        <button class="btn btn-primary btn-sm" onclick="showToast('Profile updated', 'success')">Save Changes</button>
      </div>
      <div class="settings-section">
        <h3>Change Password</h3>
        <div class="form-group"><label class="form-label">Current Password</label><input type="password" class="form-input" placeholder="Enter current password"></div>
        <div class="form-group"><label class="form-label">New Password</label><input type="password" class="form-input" placeholder="Enter new password"></div>
        <button class="btn btn-outline btn-sm" onclick="showToast('Password changed', 'success')">Update Password</button>
      </div>
      <div class="settings-section">
        <h3>Danger Zone</h3>
        <button class="btn btn-danger btn-sm" onclick="if(confirm('Delete account?')){state.auth={loggedIn:false,user:null};updateNavbar();navigate('#/');showToast('Account deleted');}">Delete Account</button>
      </div>
    `);
  });

  addRoute('/settings/watchlist', async () => {
    if (!state.auth.loggedIn) { navigate('#/login'); return; }
    const watchHtml = state.watchList.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Ticker</th><th>Company</th><th></th></tr></thead><tbody>
        ${state.watchList.map((w, i) => `<tr><td class="fw-600"><a href="#/company/${w.ticker}">${escHtml(w.ticker)}</a></td><td>${escHtml(w.name || '')}</td><td><button class="btn btn-ghost btn-sm" onclick="state.watchList.splice(${i},1);navigate('#/settings/watchlist');showToast('Removed');">${icons.trash}</button></td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="text-muted">No companies in your Watch List.</p>';

    content().innerHTML = settingsLayout('watchlist', `
      <h2>Watch List</h2>
      <div class="flex gap-3 items-center mb-4">
        <div style="position:relative;flex:1">
          <input type="text" class="form-input" id="addWatchInput" placeholder="Search company to add...">
          <div class="autocomplete-dropdown" id="addWatchDropdown"></div>
        </div>
      </div>
      ${watchHtml}
    `);

    initAutocomplete($('#addWatchInput'), $('#addWatchDropdown'), (item) => {
      if (!isWatched(item.ticker)) {
        state.watchList.push({ ticker: item.ticker, name: item.name });
        showToast(`Added ${item.ticker}`, 'success');
        navigate('#/settings/watchlist');
      }
    });
  });

  addRoute('/settings/alerts', async () => {
    if (!state.auth.loggedIn) { navigate('#/login'); return; }
    const alertsHtml = state.alerts.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Type</th><th>Company</th><th>Created</th><th></th></tr></thead><tbody>
        ${state.alerts.map((a, i) => `<tr><td><span class="badge badge-info">${escHtml(a.type)}</span></td><td class="fw-500">${escHtml(a.ticker)}</td><td class="col-date">${formatDate(a.created)}</td><td><button class="btn btn-ghost btn-sm" onclick="state.alerts.splice(${i},1);navigate('#/settings/alerts');showToast('Alert removed');">${icons.trash}</button></td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="text-muted">No alerts configured.</p>';

    content().innerHTML = settingsLayout('alerts', `
      <h2>Alerts</h2>
      ${alertsHtml}
    `);
  });

  // ===========================================================
  // PAGE: FEATURES
  // ===========================================================
  addRoute('/features', async () => {
    content().innerHTML = `
      <div class="features-content">
        <h1>Features</h1>
        <p>WamSEC provides a comprehensive suite of tools for SEC filing research, designed for investment professionals, analysts, and anyone who needs to navigate public company disclosures efficiently.</p>
        <div class="features-grid mt-8" style="max-width:100%">
          ${[
            { title: 'SEC Filing Viewer', desc: 'Read 10-K, 10-Q, 8-K, and all SEC filings with an optimized, distraction-free reading experience.', hash: '#/features/filings', icon: icons.file },
            { title: 'Full-Text Search', desc: 'Search across all EDGAR filings to find specific disclosures, risk factors, and financial data.', hash: '#/features/search', icon: icons.search },
            { title: 'Company Screening', desc: 'Browse and filter companies by SIC code, industry, and other attributes.', hash: '#/features/screening', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>' },
            { title: 'Filing Alerts', desc: 'Get real-time notifications when companies you follow file new documents.', hash: '#/features/alerts', icon: icons.bell },
            { title: 'Highlights & Notes', desc: 'Annotate filings with highlights and notes, and share them with colleagues.', hash: '#/features/highlights', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>' },
            { title: 'Filing Comparison', desc: 'Compare filings side-by-side to identify material changes between periods.', hash: '#/features/compare', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>' },
          ].map(f => `
            <a class="feature-card" href="${f.hash}">
              <div class="feature-card-icon">${f.icon}</div>
              <h3>${f.title}</h3>
              <p>${f.desc}</p>
              <span class="feature-card-cta">Learn more →</span>
            </a>
          `).join('')}
        </div>
        <div class="features-cta-section mt-8">
          <h2>Ready to get started?</h2>
          <p>Join thousands of analysts and investors who rely on WamSEC for their SEC research.</p>
          <div class="flex gap-4 justify-center mt-4">
            <a href="#/register" class="btn btn-success btn-lg">Get Started Free</a>
          </div>
        </div>
      </div>
      ${siteFooter()}
    `;
  });

  // Sub-feature pages with richer content
  const featureDetails = {
    filings: {
      title: 'SEC Filing Viewer',
      desc: 'Navigate all SEC filing types — 10-K annual reports, 10-Q quarterly reports, 8-K current reports, proxy statements, and more — with a clean, optimized reading experience.',
      points: ['Navigate 10-K, 10-Q, 8-K, DEF 14A, S-1 and all filing types', 'Section-based navigation for quick jumping between parts', 'Text selection and highlighting with color-coded notes', 'Built-in Find-in-document search', 'High-quality PDF export (Pro)', 'Keyboard shortcuts for power users'],
      visual: `<div class="feature-visual"><div class="feature-visual-doc"><div style="background:#f0f0f0;padding:12px;border-radius:4px;margin-bottom:8px;font-size:11px;font-family:monospace">Form 10-K — Annual Report</div><div style="height:6px;background:#ddd;border-radius:3px;margin:6px 0;width:80%"></div><div style="height:6px;background:#ddd;border-radius:3px;margin:6px 0;width:95%"></div><div style="height:6px;background:#ddd;border-radius:3px;margin:6px 0;width:70%"></div><div style="height:6px;background:#ffe082;border-radius:3px;margin:6px 0;width:85%"></div><div style="height:6px;background:#ddd;border-radius:3px;margin:6px 0;width:60%"></div></div></div>`
    },
    search: {
      title: 'Full-Text Search',
      desc: 'Search across millions of SEC filings using the EDGAR Full-Text Search System. Find specific keywords, phrases, or disclosures across all filing types.',
      points: ['Search 35M+ EDGAR filings in real time', 'Filter by form type, date range, and company', 'Highlighted search term snippets in results', 'Boolean operators and phrase search', 'Save searches and set alerts', 'Export results to CSV (Pro)'],
      visual: `<div class="feature-visual"><div class="feature-visual-search"><div style="background:#f5f5f5;padding:8px 12px;border-radius:20px;display:flex;align-items:center;gap:8px;margin-bottom:12px"><div style="width:12px;height:12px;border-radius:50%;border:2px solid #999"></div><div style="flex:1;height:4px;background:#ccc;border-radius:2px"></div></div><div style="background:white;border:1px solid #e0e0e0;border-radius:8px;padding:12px;margin-bottom:8px"><div style="height:4px;background:#4f46e5;border-radius:2px;width:30%;margin-bottom:6px"></div><div style="height:4px;background:#ddd;border-radius:2px;width:80%;margin-bottom:4px"></div><div style="height:4px;background:#ddd;border-radius:2px;width:60%"></div></div></div></div>`
    },
    screening: {
      title: 'Company Screening',
      desc: 'Browse the universe of SEC-registered companies organized by Standard Industrial Classification (SIC) codes. Filter by industry sector and find peers for comparative analysis.',
      points: ['Browse 30+ SIC code categories', 'Filter by sector, industry, and sub-industry', 'Quick company profiles with key metrics', 'Navigate directly to any company\'s filing history', 'Compare multiple companies side-by-side', 'Download company lists (Pro)'],
      visual: `<div class="feature-visual"><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${['7372 Software','3674 Semiconductors','6022 Banking','2834 Pharma'].map(s => `<div style="background:#f5f5f5;padding:8px;border-radius:6px;font-size:11px;font-weight:500">${s}</div>`).join('')}</div></div>`
    },
    alerts: {
      title: 'Filing Alerts',
      desc: 'Set up alerts for specific companies or search queries. Get notified immediately when new filings are submitted to the SEC, so you never miss an important disclosure.',
      points: ['Real-time email alerts for new filings', 'Filter alerts by form type (10-K, 8-K, etc.)', 'Watch List integration — alert your whole Watch List at once', 'Digest mode for daily/weekly summaries', 'Mobile push notifications (coming soon)', 'Unlimited alerts on Pro tier'],
      visual: `<div class="feature-visual"><div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px"><div style="font-weight:600;font-size:12px;margin-bottom:6px">🔔 New Filing Alert</div><div style="font-size:11px;color:#666">META · 8-K · Filed Jan 28, 2026</div><div style="font-size:11px;margin-top:4px">Q4 2025 Earnings Press Release</div></div></div>`
    },
    highlights: {
      title: 'Highlights & Notes',
      desc: 'Select and highlight text passages directly in SEC filings. Choose colors, add notes, and organize your research. Share specific highlighted passages with colleagues via direct links.',
      points: ['4-color highlighting system (yellow, green, blue, pink)', 'Add text notes to any highlight', 'Highlights saved to your account', 'Share individual highlights via URL', 'Export highlights to PDF', 'Bulk highlights management dashboard'],
      visual: `<div class="feature-visual"><div style="background:white;padding:12px;border-radius:8px;border:1px solid #e0e0e0"><p style="font-size:11px;line-height:1.7">Revenue was <mark style="background:#ffe082;padding:0 2px">$48.4 billion, an increase of 21% year-over-year</mark>. Net income was <mark style="background:#a5d6a7;padding:0 2px">$20.5 billion</mark>, an increase of 48% year-over-year.</p><div style="display:flex;gap:6px;margin-top:8px">${['yellow','green','blue','pink'].map(c => `<button style="width:18px;height:18px;border-radius:50%;background:var(--hl-${c},#ffe082);border:none;cursor:pointer"></button>`).join('')}</div></div></div>`
    },
    compare: {
      title: 'Filing Comparison',
      desc: 'Compare two filings side-by-side with an inline diff view. Additions are highlighted in green, deletions in red. Perfect for tracking changes between annual reports or amendment filings.',
      points: ['Inline diff view with green/red change highlighting', 'Section-level navigation in comparison mode', 'Compare any two filings for the same company', 'Word-level and sentence-level diff granularity', 'Export comparison to PDF (Pro)', 'Cross-company comparison coming soon'],
      visual: `<div class="feature-visual compare-visual"><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><div style="font-size:10px;font-weight:600;color:#666;margin-bottom:4px">Filing A</div><div style="font-size:10px;line-height:1.7"><span style="background:#ffcdd2;text-decoration:line-through">$40.1B</span> revenue</div></div><div><div style="font-size:10px;font-weight:600;color:#666;margin-bottom:4px">Filing B</div><div style="font-size:10px;line-height:1.7"><span style="background:#c8e6c9">$48.4B</span> revenue</div></div></div></div>`
    },
  };

  Object.keys(featureDetails).forEach(feature => {
    addRoute(`/features/${feature}`, async () => {
      const f = featureDetails[feature];
      content().innerHTML = `
        <div class="features-content">
          <a href="#/features" class="text-muted text-sm" style="display:inline-flex;align-items:center;gap:4px;margin-bottom:16px">← Back to Features</a>
          <div class="feature-detail-header">
            <div class="feature-detail-text">
              <h1>${f.title}</h1>
              <p class="feature-detail-desc">${f.desc}</p>
              <ul class="feature-detail-points">
                ${f.points.map(p => `<li>${icons.check} ${p}</li>`).join('')}
              </ul>
              <div class="mt-6">
                <a href="#/register" class="btn btn-success btn-lg">Get Started Free</a>
              </div>
            </div>
            <div class="feature-detail-visual">
              ${f.visual}
            </div>
          </div>
        </div>
        ${siteFooter()}
      `;
    });
  });

  // ===========================================================
  // PAGE: PRICING
  // ===========================================================
  // ===========================================================
  // PAGE: SIC BROWSE
  // ===========================================================
  addRoute('/companies', async () => {
    const categories = [
      // Agriculture
      { code: '0100', name: 'Crops', sector: 'Agriculture', desc: 'Farming and crop production' },
      { code: '0200', name: 'Livestock', sector: 'Agriculture', desc: 'Livestock and animal products' },
      // Mining & Energy
      { code: '1040', name: 'Gold and Silver Mining', sector: 'Mining', desc: 'Precious metals mining' },
      { code: '1311', name: 'Crude Petroleum & Natural Gas', sector: 'Energy', desc: 'Oil and gas exploration and production' },
      { code: '1381', name: 'Drilling Oil & Gas Wells', sector: 'Energy', desc: 'Oil and gas well drilling services' },
      // Construction
      { code: '1521', name: 'General Building Contractors', sector: 'Construction', desc: 'Residential and commercial construction' },
      { code: '1731', name: 'Electrical Work', sector: 'Construction', desc: 'Electrical contractors and services' },
      // Manufacturing
      { code: '2000', name: 'Food and Kindred Products', sector: 'Manufacturing', desc: 'Food processing and manufacturing' },
      { code: '2670', name: 'Converted Paper Products', sector: 'Manufacturing', desc: 'Paper and packaging manufacturing' },
      { code: '2836', name: 'Biological Products', sector: 'Biotech/Pharma', desc: 'Biologics, vaccines, and diagnostics' },
      { code: '2834', name: 'Pharmaceutical Preparations', sector: 'Healthcare', desc: 'Pharmaceutical manufacturing' },
      { code: '2860', name: 'Industrial Chemicals', sector: 'Chemicals', desc: 'Industrial chemical manufacturing' },
      { code: '3310', name: 'Steel Works & Blast Furnaces', sector: 'Materials', desc: 'Steel and iron manufacturing' },
      { code: '3559', name: 'Special Industry Machinery', sector: 'Industrials', desc: 'Specialized industrial machinery' },
      { code: '3571', name: 'Electronic Computers', sector: 'Technology', desc: 'Computer hardware manufacturing' },
      { code: '3672', name: 'Printed Circuit Boards', sector: 'Technology', desc: 'PCB and electronic component manufacturing' },
      { code: '3674', name: 'Semiconductors', sector: 'Technology', desc: 'Semiconductor and related devices' },
      { code: '3711', name: 'Motor Vehicles', sector: 'Consumer Discretionary', desc: 'Automobiles and light trucks' },
      { code: '3812', name: 'Defense Electronics', sector: 'Industrials', desc: 'Search, detection, and navigation systems' },
      { code: '3841', name: 'Surgical & Medical Instruments', sector: 'Healthcare', desc: 'Medical device manufacturing' },
      // Transportation
      { code: '4512', name: 'Air Transportation', sector: 'Transportation', desc: 'Commercial airlines' },
      { code: '4813', name: 'Telephone Communications', sector: 'Telecom', desc: 'Telephone and telecommunications' },
      { code: '4911', name: 'Electric Services', sector: 'Utilities', desc: 'Electric power generation and distribution' },
      // Finance & Insurance
      { code: '6021', name: 'National Commercial Banks', sector: 'Finance', desc: 'Federally-chartered commercial banks' },
      { code: '6022', name: 'State Commercial Banks', sector: 'Finance', desc: 'State-chartered commercial banks' },
      { code: '6311', name: 'Life Insurance', sector: 'Insurance', desc: 'Life insurance carriers' },
      { code: '6411', name: 'Insurance Agents & Brokers', sector: 'Insurance', desc: 'Insurance intermediaries' },
      { code: '6770', name: 'Blank Checks', sector: 'Finance', desc: 'SPACs and blank check companies' },
      // Services
      { code: '5812', name: 'Eating Places', sector: 'Consumer', desc: 'Restaurants and food service' },
      { code: '5961', name: 'Catalog & Mail-Order', sector: 'Consumer', desc: 'E-commerce and catalog retail' },
      { code: '6199', name: 'Finance Services', sector: 'Finance', desc: 'Financial technology and services' },
      { code: '7011', name: 'Hotels & Motels', sector: 'Consumer', desc: 'Hospitality and lodging' },
      { code: '7372', name: 'Prepackaged Software', sector: 'Technology', desc: 'Software publishers and SaaS' },
      { code: '7370', name: 'Computer Programming Services', sector: 'Technology', desc: 'IT services and consulting' },
      { code: '7374', name: 'Computer Processing Services', sector: 'Technology', desc: 'Data processing and hosting' },
      { code: '7389', name: 'Services to Buildings', sector: 'Services', desc: 'Consulting and business services' },
      { code: '8011', name: 'Offices & Clinics of Doctors', sector: 'Healthcare', desc: 'Medical practices and clinics' },
      { code: '8711', name: 'Engineering Services', sector: 'Professional Services', desc: 'Engineering consulting' },
      { code: '8742', name: 'Management Consulting Services', sector: 'Professional Services', desc: 'Strategy and management consulting' },
    ];

    // Group by sector
    const sectors = {};
    categories.forEach(c => {
      if (!sectors[c.sector]) sectors[c.sector] = [];
      sectors[c.sector].push(c);
    });

    // Map demo companies to SIC codes
    const sicCompanyMap = {
      '7370': [{ ticker: 'META', name: 'Meta Platforms' }, { ticker: 'GOOGL', name: 'Alphabet' }],
      '7372': [{ ticker: 'MSFT', name: 'Microsoft' }],
      '3674': [{ ticker: 'NVDA', name: 'NVIDIA' }],
      '3571': [{ ticker: 'AAPL', name: 'Apple' }],
      '3711': [{ ticker: 'TSLA', name: 'Tesla' }],
    };

    content().innerHTML = `
      <div class="container mt-6 mb-8">
        <h1 class="fw-700 mb-2">Browse Companies by SIC Code</h1>
        <p class="text-muted mb-6">Navigate ${categories.length} Standard Industrial Classification (SIC) codes. Demo companies are highlighted with a ★ badge.</p>
        <div class="sic-search-bar mb-6">
          <input type="text" class="form-input" id="sicSearch" placeholder="Search SIC codes or industry names...">
        </div>
        <div id="sicContent">
          ${Object.entries(sectors).map(([sector, codes]) => `
            <div class="sic-sector-group">
              <h2 class="sic-sector-title">${escHtml(sector)}</h2>
              <div class="sic-grid">
                ${codes.map(c => {
                  const demos = sicCompanyMap[c.code] || [];
                  return `<a class="sic-card${demos.length ? ' sic-has-demo' : ''}" href="#/companies/${c.code}" style="text-decoration:none;color:inherit">
                    <div class="sic-card-code">SIC ${c.code}</div>
                    <h3>${escHtml(c.name)}</h3>
                    <p>${escHtml(c.desc)}</p>
                    ${demos.length ? `<div class="sic-demo-badges">${demos.map(d => `<span class="sic-demo-badge">★ ${d.ticker}</span>`).join('')}</div>` : ''}
                  </a>`;
                }).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>
      ${siteFooter()}
    `;

    // SIC search filter
    const sicSearch = $('#sicSearch');
    sicSearch.addEventListener('input', debounce(() => {
      const q = sicSearch.value.toLowerCase();
      $$('.sic-card').forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = !q || text.includes(q) ? '' : 'none';
      });
      // Hide empty sectors
      $$('.sic-sector-group').forEach(grp => {
        const visible = $$('.sic-card', grp).filter(c => c.style.display !== 'none');
        grp.style.display = visible.length ? '' : 'none';
      });
    }, 200));
  });

  addRoute('/companies/{sic}', async (params) => {
    const sic = params.sic;

    // Find companies in embedded data with matching SIC
    const sicCompanyMap = {
      '7370': ['META', 'GOOGL'],
      '7372': ['MSFT'],
      '3674': ['NVDA'],
      '3571': ['AAPL'],
      '3711': ['TSLA'],
    };
    const demoTickers = sicCompanyMap[sic] || [];
    const embeddedData = getEmbeddedData();

    const demoCompanies = demoTickers.map(t => {
      const co = embeddedData?.companies?.[t];
      return co ? { ticker: t, name: co.profile?.name || t } : null;
    }).filter(Boolean);

    content().innerHTML = `
      <div class="container mt-6 mb-8">
        <a href="#/companies" class="text-muted text-sm" style="display:inline-flex;align-items:center;gap:4px;margin-bottom:16px">← Back to SIC Codes</a>
        <h1 class="fw-700 mb-2">SIC ${escHtml(sic)}</h1>
        <p class="text-muted mb-4">Companies classified under SIC code ${escHtml(sic)}.</p>
        ${demoCompanies.length ? `
          <div class="mb-4">
            <h3 class="fw-600 mb-3">Demo Companies</h3>
            <div class="company-chips">
              ${demoCompanies.map(c => `
                <a href="#/company/${c.ticker}" class="company-chip">
                  <span class="company-chip-ticker">${escHtml(c.ticker)}</span>
                  <span class="company-chip-name">${escHtml(c.name)}</span>
                </a>`).join('')}
            </div>
          </div>
        ` : ''}
        <div class="card">
          <p class="text-muted">Search for any company above to view its full filing history, or browse other SIC codes.</p>
          <div class="mt-3" style="position:relative;max-width:400px">
            <input type="text" class="form-input" id="sicCompanySearch" placeholder="Search for a company in this SIC code...">
            <div class="autocomplete-dropdown" id="sicAutocomplete"></div>
          </div>
        </div>
      </div>
    `;

    initAutocomplete($('#sicCompanySearch'), $('#sicAutocomplete'), (item) => {
      navigate(`#/company/${item.ticker}`);
    });
  });

  // ===========================================================
  // PAGE: SHARED HIGHLIGHT
  // ===========================================================
  addRoute('/h/{token}', async (params) => {
    const hl = state.highlights.find(h => h.id === params.token);
    if (hl) {
      navigate(`#/doc/${hl.ticker}/${hl.filingId || ''}`);
    } else {
      content().innerHTML = `<div class="container mt-8"><div class="card"><h2>Highlight Not Found</h2><p class="text-muted mt-2">This shared highlight could not be found.</p><a href="#/" class="btn btn-primary mt-4">Go Home</a></div></div>`;
    }
  });

  // Privacy / Terms stubs
  addRoute('/privacy', async () => {
    content().innerHTML = `<div class="features-content"><h1>Privacy Policy</h1><p class="text-muted">Last updated: January 2026</p><p class="mt-4">WamSEC is committed to protecting your privacy. This policy describes how we collect, use, and protect your information.</p><h2 class="mt-6">Information We Collect</h2><p>We collect information you provide when creating an account, as well as usage data to improve our services. We do not sell your personal information.</p><h2 class="mt-6">Contact</h2><p>For privacy inquiries, contact privacy@wamsec.com</p></div>${siteFooter()}`;
  });
  addRoute('/terms', async () => {
    content().innerHTML = `<div class="features-content"><h1>Terms of Service</h1><p class="text-muted">Last updated: January 2026</p><p class="mt-4">By using WamSEC, you agree to these Terms of Service. WamSEC provides tools for navigating public SEC filings and is not affiliated with the SEC.</p><h2 class="mt-6">Data Usage</h2><p>All filing data is sourced from EDGAR, the SEC's public filing database, and is in the public domain.</p><h2 class="mt-6">Contact</h2><p>For legal inquiries, contact legal@wamsec.com</p></div>${siteFooter()}`;
  });

  // ===========================================================
  // NAVBAR STATE
  // ===========================================================
  function updateNavbar() {
    const links = $('#navbarLinks');
    const screeningDropdownHTML = `
      <div class="navbar-dropdown" id="screeningDropdown">
        <button class="navbar-dropdown-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> Screening <svg class="dropdown-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></button>
        <div class="navbar-dropdown-menu">
          <a href="#/screening/search" class="navbar-dropdown-item"><strong>All-Company Document Search</strong><span>Search across the text of all companies' documents</span></a>
          <a href="#/screening/recent" class="navbar-dropdown-item"><strong>All-Company Recent Filings</strong><span>View all recent filings of a form type</span></a>
          <a href="#/screening/alerts" class="navbar-dropdown-item"><strong>All-Company Filing Alerts</strong><span>Manage alerts for any new filings of a form type</span></a>
          <a href="#/screening/search-alerts" class="navbar-dropdown-item"><strong>All-Company Search Alerts</strong><span>Manage alerts for any new documents that match a search</span></a>
        </div>
      </div>
    `;
    if (state.auth.loggedIn) {
      links.innerHTML = `
        ${screeningDropdownHTML}
        <a href="#/dashboard">Dashboard</a>
        <a href="#/features">Features</a>
        <a href="#/settings/account">${icons.settings}</a>
        <button class="btn-primary-sm" onclick="state.auth={loggedIn:false,user:null};updateNavbar();navigate('#/');showToast('Signed out');">Sign Out</button>
      `;
    } else {
      links.innerHTML = `
        ${screeningDropdownHTML}
        <a href="#/features">Features</a>
        <a href="#/login" id="navSignIn">Sign In</a>
        <a href="#/register" class="btn-primary-sm" id="navGetStarted">Get Started</a>
      `;
    }
    // Re-init screening dropdown toggle
    const scrDrop = $('#screeningDropdown');
    if (scrDrop) {
      const scrBtn = scrDrop.querySelector('.navbar-dropdown-btn');
      scrBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        scrDrop.classList.toggle('open');
      });
      scrDrop.querySelectorAll('.navbar-dropdown-item').forEach(a => {
        a.addEventListener('click', () => scrDrop.classList.remove('open'));
      });
    }
  }

  // ===========================================================
  // EXTRA CSS FOR NEW FEATURES
  // ===========================================================
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* ── Transcript styles ── */
      .transcript-item { border:1px solid var(--color-border); border-radius:8px; margin-bottom:8px; overflow:hidden; }
      .transcript-row { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; cursor:pointer; transition:background .15s; }
      .transcript-row:hover { background:var(--color-bg-subtle); }
      .transcript-row-left { display:flex; align-items:center; gap:12px; }
      .transcript-row-right { display:flex; align-items:center; gap:12px; color:var(--color-text-muted); font-size:.857rem; }
      .transcript-toggle { color:var(--color-text-muted); }
      .transcript-body { padding:16px; border-top:1px solid var(--color-border); background:var(--color-bg-subtle); }
      .transcript-participants { margin-bottom:12px; font-size:.857rem; }
      .transcript-participants ul { margin:6px 0 0 20px; }
      .transcript-participants li { margin-bottom:2px; color:var(--color-text-muted); }
      .transcript-highlights { font-size:.857rem; }
      .transcript-highlights p { color:var(--color-text-muted); line-height:1.6; }
      .transcript-open .transcript-row { background:var(--color-bg-subtle); }

      /* ── Owners header ── */
      .owners-header { display:flex; gap:24px; flex-wrap:wrap; }
      .owners-stat { display:flex; flex-direction:column; }
      .owners-stat .stat-val { font-size:1.4rem; font-weight:700; color:var(--color-text); }
      .owners-stat .stat-lbl { font-size:.786rem; color:var(--color-text-muted); margin-top:2px; }

      /* ── Highlight styles ── */
      .highlight-text-cell { font-size:.857rem; line-height:1.6; padding:4px 8px; border-radius:4px; }
      .hl-yellow { background:#fffde7; border-left:3px solid #f9a825; }
      .hl-green { background:#f1f8e9; border-left:3px solid #558b2f; }
      .hl-blue { background:#e3f2fd; border-left:3px solid #1565c0; }
      .hl-pink { background:#fce4ec; border-left:3px solid #c62828; }

      /* ── Highlights highlights tab ── */
      .highlights-header { display:flex; justify-content:space-between; align-items:center; }

      /* ── Document viewer ── */
      .doc-meta-bar { padding:12px 24px; border-bottom:1px solid var(--color-border); background:var(--color-bg-subtle); display:flex; align-items:center; }
      .doc-meta-info { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .sec-document { padding:24px 32px; font-family: "Times New Roman", Times, serif; line-height:1.6; color:#1a1a1a; font-size:13px; }
      .sec-document h1, .sec-document h2, .sec-document h3 { font-family: Arial, sans-serif; }
      .sec-document table { width:100%; border-collapse:collapse; margin:12px 0; font-size:11px; }
      .sec-cover-page, .sec-section, .sec-toc { max-width:800px; margin:0 auto; }
      .find-highlight { background:#fff176; padding:0 1px; border-radius:2px; }
      .doc-hl-item { display:flex; align-items:center; gap:6px; padding:4px 8px; font-size:.786rem; color:var(--color-text-muted); cursor:pointer; }
      .doc-hl-item:hover { background:var(--color-bg-subtle); }
      .hl-chip-sm { font-size:11px; }
      .doc-find-container { display:flex; align-items:center; gap:4px; }
      .doc-find-input { padding:4px 10px; border:1px solid var(--color-border); border-radius:6px; font-size:.857rem; min-width:180px; background:var(--color-bg); color:var(--color-text); }
      .doc-toolbar-right { display:flex; align-items:center; gap:8px; }

      /* ── Highlight tooltip ── */
      .hl-tooltip { position:fixed; z-index:10000; background:var(--color-bg); border:1px solid var(--color-border); border-radius:8px; padding:6px 10px; display:flex; align-items:center; gap:6px; box-shadow:0 4px 16px rgba(0,0,0,.15); }
      .hl-tooltip-label { font-size:.75rem; color:var(--color-text-muted); margin-right:4px; }
      .hl-btn { width:20px; height:20px; border-radius:50%; border:2px solid rgba(0,0,0,.15); cursor:pointer; transition:transform .15s; }
      .hl-btn:hover { transform:scale(1.2); }
      .hl-btn.hl-yellow { background:#ffe082; }
      .hl-btn.hl-green { background:#a5d6a7; }
      .hl-btn.hl-blue { background:#90caf9; }
      .hl-btn.hl-pink { background:#f48fb1; }
      .hl-tooltip-cancel { background:none; border:none; cursor:pointer; color:var(--color-text-muted); padding:2px; }

      /* ── Compare tab ── */
      .compare-intro { padding:12px 0; }
      .compare-sidebyside { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:8px; }
      .compare-pane { border:1px solid var(--color-border); border-radius:8px; overflow:hidden; }
      .compare-pane-a .compare-pane-label { background:#fff8e1; color:#f57f17; }
      .compare-pane-b .compare-pane-label { background:#f1f8e9; color:#2e7d32; }
      .compare-pane-label { font-size:.786rem; font-weight:600; padding:6px 12px; border-bottom:1px solid var(--color-border); }
      .compare-pane-content { padding:12px; max-height:500px; overflow-y:auto; font-size:.857rem; }
      .diff-stats { display:flex; gap:12px; font-size:.857rem; }
      .diff-stat-add { color:var(--color-success); font-weight:600; }
      .diff-stat-del { color:var(--color-danger); font-weight:600; }
      .compare-header { margin-bottom:8px; }
      .compare-labels { display:flex; gap:16px; }
      .compare-label-a { padding:4px 8px; background:#fff8e1; border-radius:4px; font-size:.857rem; }
      .compare-label-b { padding:4px 8px; background:#f1f8e9; border-radius:4px; font-size:.857rem; }

      /* ── SIC browse ── */
      .sic-sector-group { margin-bottom:32px; }
      .sic-sector-title { font-size:1rem; font-weight:700; color:var(--color-text-muted); text-transform:uppercase; letter-spacing:.08em; margin-bottom:12px; padding-bottom:6px; border-bottom:1px solid var(--color-border); }
      .sic-card-code { font-size:.75rem; font-weight:700; color:var(--color-primary); margin-bottom:4px; letter-spacing:.05em; }
      .sic-has-demo { border-color:var(--color-primary); }
      .sic-demo-badges { display:flex; flex-wrap:wrap; gap:4px; margin-top:8px; }
      .sic-demo-badge { background:var(--color-primary); color:white; font-size:.643rem; font-weight:700; padding:2px 6px; border-radius:4px; }
      .sic-search-bar input { max-width:400px; }

      /* ── Company chips ── */
      .company-chips { display:flex; gap:12px; flex-wrap:wrap; }
      .company-chip { display:flex; align-items:center; gap:8px; padding:10px 16px; border:1px solid var(--color-border); border-radius:8px; text-decoration:none; color:inherit; transition:all .15s; }
      .company-chip:hover { border-color:var(--color-primary); background:var(--color-bg-subtle); }
      .company-chip-ticker { font-weight:700; color:var(--color-primary); }
      .company-chip-name { color:var(--color-text-muted); font-size:.857rem; }

      /* ── Site footer ── */
      .site-footer { background:var(--color-bg); border-top:1px solid var(--color-border); margin-top:64px; padding:40px 0 0; }
      .site-footer-inner { max-width:1100px; margin:0 auto; padding:0 24px; display:grid; grid-template-columns:1fr 2fr; gap:48px; margin-bottom:40px; }
      @media (max-width:768px) { .site-footer-inner { grid-template-columns:1fr; } }
      .footer-logo { font-size:1.2rem; font-weight:800; color:var(--color-text); text-decoration:none; }
      .footer-tagline { font-size:.857rem; color:var(--color-text-muted); margin-top:8px; line-height:1.6; max-width:280px; }
      .site-footer-cols { display:grid; grid-template-columns:repeat(4,1fr); gap:24px; }
      @media (max-width:640px) { .site-footer-cols { grid-template-columns:repeat(2,1fr); } }
      .footer-col h4 { font-size:.857rem; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--color-text-muted); margin-bottom:12px; }
      .footer-col a { display:block; font-size:.857rem; color:var(--color-text-muted); text-decoration:none; margin-bottom:6px; transition:color .15s; }
      .footer-col a:hover { color:var(--color-text); }
      .site-footer-bottom { border-top:1px solid var(--color-border); padding:16px 24px; max-width:1100px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
      .footer-disclaimer { font-size:.75rem; color:var(--color-text-muted); }

      /* ── Search enhancements ── */
      .search-results-section { margin-bottom:24px; }
      .search-section-label { font-size:.857rem; font-weight:700; color:var(--color-text-muted); text-transform:uppercase; letter-spacing:.06em; padding:8px 0; border-bottom:1px solid var(--color-border); margin-bottom:12px; }
      .recent-search-chip { display:flex; align-items:center; gap:6px; padding:4px 0; font-size:.857rem; color:var(--color-text-muted); text-decoration:none; }
      .recent-search-chip:hover { color:var(--color-primary); }
      .text-link { color:var(--color-primary); text-decoration:none; }
      .text-link:hover { text-decoration:underline; }

      /* ── Landing hero enhancements ── */
      .hero-tickers { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; margin-top:16px; }
      .hero-ticker-chip { background:var(--color-bg); border:1px solid var(--color-border); padding:4px 12px; border-radius:20px; font-size:.857rem; font-weight:600; text-decoration:none; color:var(--color-text); transition:all .15s; }
      .hero-ticker-chip:hover { border-color:var(--color-primary); color:var(--color-primary); }
      .hero-cta { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; margin-top:20px; }
      .social-proof-stats { display:flex; gap:32px; justify-content:center; flex-wrap:wrap; margin-top:24px; }
      .stat-item { text-align:center; }
      .stat-value { font-size:1.6rem; font-weight:800; color:var(--color-text); display:block; }
      .stat-label { font-size:.786rem; color:var(--color-text-muted); display:block; }

      /* ── Feature detail page ── */
      .feature-detail-header { display:grid; grid-template-columns:1fr 1fr; gap:48px; align-items:start; margin-top:24px; }
      @media (max-width:768px) { .feature-detail-header { grid-template-columns:1fr; } }
      .feature-detail-desc { font-size:1.05rem; color:var(--color-text-muted); line-height:1.7; margin-top:12px; }
      .feature-detail-points { list-style:none; padding:0; margin:20px 0; }
      .feature-detail-points li { display:flex; align-items:flex-start; gap:10px; padding:6px 0; }
      .feature-detail-points li svg { color:var(--color-success); flex-shrink:0; margin-top:2px; }
      .feature-detail-visual { background:var(--color-bg-subtle); border:1px solid var(--color-border); border-radius:12px; padding:24px; min-height:200px; display:flex; align-items:center; justify-content:center; }
      .feature-visual { width:100%; }
      .features-cta-section { text-align:center; padding:40px; background:var(--color-bg-subtle); border-radius:12px; }
      .feature-card-cta { font-size:.786rem; color:var(--color-primary); font-weight:600; margin-top:8px; display:block; }

      /* ── SEC document styles ── */
      .ml-2 { margin-left:8px; }
      .ml-3 { margin-left:12px; }
      .justify-center { justify-content:center; }
    `;
    document.head.appendChild(style);
  }

  // ===========================================================
  // TABLE TOOLS
  // ===========================================================

  /**
   * Build a signature object from a <table> element for similarity matching.
   * Returns { title: string, headers: string[], rowLabels: string[] }
   *
   * Title extraction: walks backward from the table through preceding siblings
   * and parent's preceding siblings to find the bold/heading text that serves
   * as the table's title in SEC filings.
   */
  function buildTableSignature(tableEl) {
    const headers = [];
    const rowLabels = [];

    // Collect header text from <thead> or first <tr>
    const theadRows = tableEl.querySelectorAll('thead tr');
    const headerRow = theadRows.length ? theadRows[0] : tableEl.querySelector('tr');
    if (headerRow) {
      headerRow.querySelectorAll('th, td').forEach(cell => {
        const text = cell.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
        if (text) headers.push(text);
      });
    }

    // Collect first-column labels from body rows
    const bodyRows = tableEl.querySelectorAll('tbody tr, tr');
    bodyRows.forEach((row, i) => {
      if (i === 0 && !theadRows.length) return;
      const firstCell = row.querySelector('th, td');
      if (firstCell) {
        const text = firstCell.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
        if (text && text.length > 1) rowLabels.push(text);
      }
    });

    // --- Extract the table title ---
    // Walk backward through preceding siblings of the table (or its wrapper)
    // looking for bold text, headings, or styled spans that serve as the title.
    const title = extractTableTitle(tableEl);

    return { title, headers, rowLabels };
  }

  /**
   * Extract the title/heading that appears above a table element in the DOM.
   * Walks backward through preceding siblings looking for bold text.
   */
  function extractTableTitle(tableEl) {
    // The table might be inside a .table-tools-wrapper; look at the wrapper's context
    let anchor = tableEl;
    if (anchor.parentElement && anchor.parentElement.classList.contains('table-tools-wrapper')) {
      anchor = anchor.parentElement;
    }
    // Also check if inside a .sec-table-inner wrapper
    if (anchor.parentElement && anchor.parentElement.classList.contains('sec-table-inner')) {
      anchor = anchor.parentElement;
    }

    // Walk backward through preceding siblings
    let node = anchor.previousElementSibling;
    let attempts = 0;
    while (node && attempts < 15) {
      attempts++;
      const text = extractBoldText(node);
      if (text && text.length >= 5) {
        // Filter out generic/irrelevant text
        const lower = text.toLowerCase();
        if (lower !== 'table of contents' && !/^\d+$/.test(text.trim())) {
          return normalizeTitle(text);
        }
      }
      node = node.previousElementSibling;
    }
    return '';
  }

  /**
   * Extract bold/heading text from a DOM element.
   * Checks: the element itself (if heading/bold), or its children for bold spans.
   */
  function extractBoldText(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();

    // If it's a heading tag, return its text
    if (/^h[1-6]$/.test(tag)) {
      return el.textContent.trim();
    }

    // If it's bold/strong, return text
    if (tag === 'b' || tag === 'strong') {
      return el.textContent.trim();
    }

    // Check for bold styling on the element itself
    const style = el.getAttribute('style') || '';
    if (/font-weight:\s*(?:700|bold|800|900)/i.test(style)) {
      return el.textContent.trim();
    }

    // Check children for bold spans/elements
    const boldChildren = el.querySelectorAll('b, strong, [style*="font-weight:700"], [style*="font-weight: 700"], [style*="font-weight:bold"], [style*="font-weight: bold"]');
    if (boldChildren.length) {
      const texts = Array.from(boldChildren).map(c => c.textContent.trim()).filter(t => t.length > 3);
      if (texts.length) return texts[texts.length - 1]; // last bold text
    }

    return '';
  }

  /**
   * Normalize a title string for comparison.
   */
  function normalizeTitle(t) {
    return t.replace(/\s+/g, ' ').trim()
            .replace(/^[\s.,;:()\-]+|[\s.,;:()\-]+$/g, '');
  }

  /**
   * Compute title similarity between two strings (0..1).
   * Uses case-insensitive comparison with fuzzy matching.
   */
  function titleSimilarity(a, b) {
    if (!a || !b) return 0;
    const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    // Exact match
    if (na === nb) return 1.0;

    // One contains the other
    if (na.includes(nb) || nb.includes(na)) return 0.9;

    // Word-level Jaccard similarity
    const wordsA = new Set(na.split(' ').filter(w => w.length > 1));
    const wordsB = new Set(nb.split(' ').filter(w => w.length > 1));
    if (!wordsA.size || !wordsB.size) return 0;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const union = new Set([...wordsA, ...wordsB]).size;
    return intersection / union;
  }

  /**
   * Compute overlap score between two string arrays (0..1).
   * Used as a secondary signal for row label matching.
   */
  function sigOverlap(a, b) {
    if (!a.length || !b.length) return 0;
    let matches = 0;
    a.forEach(s => {
      if (b.some(t => t.includes(s) || s.includes(t) || (s.length > 3 && t.includes(s.substring(0, 4))))) matches++;
    });
    return matches / Math.max(a.length, b.length);
  }

  // =============================================
  // TABLES INDEX (loaded from static JSON files)
  // =============================================
  let _tablesIndex = null;
  const _htmlChunkCache = {};

  // Live table index cache: window.__LIVE_TABLE_INDEX__[ticker] = array of match objects
  if (!window.__LIVE_TABLE_INDEX__) window.__LIVE_TABLE_INDEX__ = {};

  async function loadTablesIndex() {
    if (_tablesIndex) return _tablesIndex;
    // Loaded via <script> tag as window.__TABLES_INDEX__
    if (window.__TABLES_INDEX__) {
      _tablesIndex = window.__TABLES_INDEX__;
      console.log('[WamSEC] Tables index loaded from global:', _tablesIndex.meta?.tables_count, 'tables');
      return _tablesIndex;
    }
    console.warn('[WamSEC] Tables index not available (window.__TABLES_INDEX__ not set)');
    return null;
  }

  /**
   * Find similar tables using static index (client-side matching).
   * NEW ALGORITHM: Primary match on table title, secondary on row labels.
   * Tables must have matching titles to be considered similar.
   */
  async function findSimilarTablesAPI(signature, currentFilingId, ticker) {
    try {
      const index = await loadTablesIndex();
      if (!index || !index.tables) return null;

      const tkUpper = ticker.toUpperCase();
      if (!index.meta.companies[tkUpper]) {
        return { matches: [], error: 'not_ingested', filings_scanned: 0, tables_scanned: 0 };
      }

      const candidates = index.tables.filter(t => t.tk === tkUpper && t.fid !== currentFilingId);
      const matches = [];
      const queryTitle = signature.title || '';

      for (const t of candidates) {
        const candidateTitle = t.tt || '';

        // --- Title-based matching (primary) ---
        const tScore = titleSimilarity(queryTitle, candidateTitle);

        // --- Row-label overlap (secondary tiebreaker) ---
        const rowScore = sigOverlap(signature.rowLabels, t.r);

        // STRICT RULE: If both tables have titles, title must match >= 0.6
        // If neither has a title, fall back to row-label matching with high threshold
        let score = 0;
        let matched = false;

        if (queryTitle && candidateTitle) {
          // Both have titles — title must be sufficiently similar
          if (tScore >= 0.6) {
            score = tScore * 0.7 + rowScore * 0.3;
            matched = true;
          }
        } else if (!queryTitle && !candidateTitle) {
          // Neither has a title — use strict row-label matching
          if (rowScore >= 0.5) {
            score = rowScore;
            matched = true;
          }
        } else {
          // One has title, other doesn't — only match if row labels are very strong
          if (rowScore >= 0.65) {
            score = rowScore * 0.8;
            matched = true;
          }
        }

        if (matched) {
          matches.push({
            id: t.id,
            filing_id: t.fid,
            form_type: t.ft,
            filing_date: t.fd,
            report_date: t.rd,
            section_context: candidateTitle || t.sc,
            table_index: t.ti,
            score: Math.round(score * 10000) / 10000,
            title_score: Math.round(tScore * 100) / 100,
            num_rows: t.nr,
            num_cols: t.nc,
          });
        }
      }

      matches.sort((a, b) => b.score - a.score);

      const seen = new Set();
      const deduped = [];
      for (const m of matches) {
        const key = `${m.filing_id}:${m.table_index}`;
        if (!seen.has(key)) { seen.add(key); deduped.push(m); }
      }

      return {
        matches: deduped.slice(0, 50),
        total_matches: deduped.length,
        filings_scanned: index.meta.filings_count,
        tables_scanned: index.meta.tables_count,
      };
    } catch (e) {
      console.warn('[WamSEC] Client-side similarity search failed:', e);
      return null;
    }
  }

  /**
   * Fetch a single table's HTML from static chunk files.
   * Uses dynamic script injection since fetch may not work in sandboxed iframes.
   */
  async function fetchTableHTML(tableId) {
    try {
      const chunkId = Math.floor(tableId / 100) * 100;
      const chunkKey = `chunk_${chunkId}`;

      // Check in-memory cache first
      if (_htmlChunkCache[chunkKey]) {
        return _htmlChunkCache[chunkKey][String(tableId)] || null;
      }

      // Check if already loaded via script injection
      if (window.__TABLE_CHUNKS__ && window.__TABLE_CHUNKS__[chunkKey]) {
        _htmlChunkCache[chunkKey] = window.__TABLE_CHUNKS__[chunkKey];
        return _htmlChunkCache[chunkKey][String(tableId)] || null;
      }

      // Dynamically load the chunk via script tag
      return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = `./tables_data/html/${chunkKey}.js?v=1771633800`;
        script.onload = () => {
          if (window.__TABLE_CHUNKS__ && window.__TABLE_CHUNKS__[chunkKey]) {
            _htmlChunkCache[chunkKey] = window.__TABLE_CHUNKS__[chunkKey];
            resolve(_htmlChunkCache[chunkKey][String(tableId)] || null);
          } else {
            resolve(null);
          }
        };
        script.onerror = () => resolve(null);
        document.head.appendChild(script);
      });
    } catch (e) {
      console.warn('[WamSEC] Failed to fetch table HTML chunk:', e);
      return null;
    }
  }

  /**
   * Find similar tables across all embedded filings for this company (FALLBACK).
   * Returns array of { filingId, formType, filingDate, reportDate, sectionTitle, tableIndex, tableHtml, score }
   */
  function findSimilarTables(signature, currentFilingId, ticker) {
    const results = [];
    const embeddedCo = getEmbeddedCompany(ticker);
    if (!embeddedCo) return results;

    const filingDocs = embeddedCo.filingDocuments || {};
    const allFilings = embeddedCo.filings || [];

    Object.entries(filingDocs).forEach(([fid, doc]) => {
      if (fid === currentFilingId) return; // skip current filing
      const sections = doc.sections || [];
      const meta = allFilings.find(f => f.filingId === fid) || {};

      sections.forEach(section => {
        // Parse section HTML to find tables
        const wrapper = document.createElement('div');
        wrapper.innerHTML = section.content || '';
        const tables = wrapper.querySelectorAll('table');

        tables.forEach((tbl, idx) => {
          const sig = buildTableSignature(tbl);
          const queryTitle = signature.title || '';
          const candidateTitle = sig.title || '';
          const tScore = titleSimilarity(queryTitle, candidateTitle);
          const rowScore = sigOverlap(signature.rowLabels, sig.rowLabels);

          let score = 0;
          let matched = false;
          if (queryTitle && candidateTitle) {
            if (tScore >= 0.6) { score = tScore * 0.7 + rowScore * 0.3; matched = true; }
          } else if (!queryTitle && !candidateTitle) {
            if (rowScore >= 0.5) { score = rowScore; matched = true; }
          } else {
            if (rowScore >= 0.65) { score = rowScore * 0.8; matched = true; }
          }

          if (matched) {
            results.push({
              filingId: fid,
              formType: meta.secFormType || meta.formType || doc.formType || 'Filing',
              filingDate: meta.filingDate || '',
              reportDate: meta.reportDate || '',
              sectionTitle: section.title || '',
              tableIndex: idx,
              tableHtml: tbl.outerHTML,
              score
            });
          }
        });
      });
    });

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Fetch an SEC filing's HTML and return a parsed DOM wrapper.
   * Uses the CORS proxy. Returns null on failure.
   */
  async function fetchFilingHtml(cikNum, filingId, primaryDoc) {
    const accNoDash = filingId.replace(/-/g, '');
    let docName = primaryDoc;

    if (!docName) {
      // Scrape the filing index page to find the primary document
      try {
        const idxUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${filingId}-index.htm`;
        const idxResp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(idxUrl)}`);
        if (idxResp.ok) {
          const idxHtml = await idxResp.text();
          // Strategy 1: Extract from tableFile rows
          const tableMatch = idxHtml.match(/<table[^>]*class="tableFile"[^>]*>([\s\S]*?)<\/table>/);
          if (tableMatch) {
            const tableLinks = tableMatch[1].match(/href="([^"]+\.htm[l]?)"/gi) || [];
            for (const link of tableLinks) {
              const urlPart = link.match(/href="([^"]+)"/i)?.[1] || '';
              const fnMatch = urlPart.match(/\/([^\/]+\.htm)(?:\?|$|")/i) || urlPart.match(/\/([^\/]+\.htm)$/i);
              if (fnMatch && fnMatch[1] !== 'index.htm' && !fnMatch[1].endsWith('-index.htm')) {
                docName = fnMatch[1];
                break;
              }
            }
          }
          // Strategy 2: Broader archive links
          if (!docName) {
            const archiveLinks = idxHtml.match(/href="\/Archives\/edgar\/data\/[^"]+\.htm"/gi) || [];
            if (archiveLinks.length) {
              const firstLink = archiveLinks[0].match(/\/([^\/"]+\.htm)"/i);
              if (firstLink && firstLink[1] !== 'index.htm') docName = firstLink[1];
            }
          }
          // Strategy 3: ix?doc= viewer links
          if (!docName) {
            const ixMatch = idxHtml.match(/\/ix\?doc=\/Archives\/[^"]*\/([^\/"]+\.htm)/i);
            if (ixMatch) docName = ixMatch[1];
          }
        }
      } catch(e) { console.warn('[fetchFilingHtml] Index fetch failed:', e); }
    }

    if (!docName) return null;

    const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${docName}`;
    try {
      const resp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(docUrl)}`);
      if (!resp.ok) return null;
      const rawHtml = await resp.text();
      // Strip XBRL inline tags
      const cleaned = rawHtml
        .replace(/<ix:[^>]*>/gi, '').replace(/<\/ix:[^>]*>/gi, '')
        .replace(/<\?xml[^>]*\?>/g, '');
      const wrapper = document.createElement('div');
      wrapper.innerHTML = cleaned;
      return wrapper;
    } catch(e) {
      console.warn('[fetchFilingHtml] Fetch failed:', e);
      return null;
    }
  }

  /**
   * Compute a human-readable period label for a filing.
   */
  function getFilingPeriodLabel(formType, reportDate) {
    const ft = (formType || '').toUpperCase();
    if (!reportDate) return '';
    if (ft === '10-K') {
      const yr = reportDate.split('-')[0];
      return `FY ${yr}`;
    }
    if (ft === '10-Q') {
      const month = parseInt(reportDate.split('-')[1] || '0');
      return month <= 3 ? 'Q1' : month <= 6 ? 'Q2' : month <= 9 ? 'Q3' : 'Q4';
    }
    return ft;
  }

  /**
   * Build a live table index for a ticker by fetching and parsing EDGAR filings.
   * Results are cached in window.__LIVE_TABLE_INDEX__[ticker].
   *
   * @param {string} ticker
   * @param {Object} signature - { title, headers, rowLabels } of the query table
   * @param {string} currentFilingId - filing to exclude from results
   * @param {Function} progressCallback - called with (done, total, statusText)
   * @returns {Array} matches array sorted by score desc
   */
  async function buildLiveTableIndex(ticker, signature, currentFilingId, progressCallback) {
    const tkUpper = ticker.toUpperCase();
    const cacheKey = tkUpper;

    // If we have a fully-built index for this ticker, use it directly
    if (window.__LIVE_TABLE_INDEX__[cacheKey]) {
      const cachedIndex = window.__LIVE_TABLE_INDEX__[cacheKey];
      return scoreLiveMatches(cachedIndex, signature, currentFilingId);
    }

    // Get CIK
    const cikPadded = await getCIK(tkUpper);
    if (!cikPadded) {
      progressCallback && progressCallback(0, 0, 'Could not determine CIK for ' + ticker);
      return [];
    }
    const cikNum = cikPadded.replace(/^0+/, '');

    // Get filing list — first from embedded data, then from EDGAR API
    let allFilings = [];
    const embeddedCo = getEmbeddedCompany(tkUpper);
    if (embeddedCo && embeddedCo.filings && embeddedCo.filings.length) {
      allFilings = embeddedCo.filings;
    } else {
      // Fetch from EDGAR submissions API
      try {
        const subUrl = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;
        const subResp = await fetch(`${SEC_PROXY}/?url=${encodeURIComponent(subUrl)}`);
        if (subResp.ok) {
          const subData = await subResp.json();
          const recent = subData.filings?.recent || {};
          const forms = recent.form || [];
          const accNums = recent.accessionNumber || [];
          const dates = recent.filingDate || [];
          const repDates = recent.reportDate || [];
          const primaryDocs = recent.primaryDocument || [];
          for (let i = 0; i < forms.length; i++) {
            allFilings.push({
              filingId: accNums[i],
              secFormType: forms[i],
              filingDate: dates[i] || '',
              reportDate: repDates[i] || '',
              primaryDoc: primaryDocs[i] || '',
            });
          }
        }
      } catch(e) { console.warn('[buildLiveTableIndex] EDGAR submissions fetch failed:', e); }
    }

    // Filter to 10-K and 10-Q from last 5 years
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 5);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    const targetFilings = allFilings.filter(f => {
      const ft = (f.secFormType || f.formType || '').toUpperCase();
      const isRelevant = ft === '10-K' || ft === '10-Q' || ft === '10-K/A' || ft === '10-Q/A';
      const dateStr = f.filingDate || '';
      return isRelevant && dateStr >= cutoffStr;
    });

    // Sort by filing date descending (most recent first)
    targetFilings.sort((a, b) => (b.filingDate || '').localeCompare(a.filingDate || ''));

    if (!targetFilings.length) {
      progressCallback && progressCallback(0, 0, 'No 10-K/10-Q filings found in last 5 years');
      return [];
    }

    progressCallback && progressCallback(0, targetFilings.length, `Scanning ${targetFilings.length} filings...`);

    // Fetch filings in parallel batches of 3
    const BATCH_SIZE = 3;
    const allTableEntries = [];  // { filingId, formType, filingDate, reportDate, tables: [{html, sig}] }
    let done = 0;

    for (let i = 0; i < targetFilings.length; i += BATCH_SIZE) {
      const batch = targetFilings.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (filing) => {
        const fid = filing.filingId || filing.id || '';
        if (!fid) return null;
        const primaryDoc = filing.primaryDoc || filing.primaryDocument || '';
        const ft = (filing.secFormType || filing.formType || '').toUpperCase();
        try {
          const domWrapper = await fetchFilingHtml(cikNum, fid, primaryDoc);
          if (!domWrapper) return null;
          const tables = Array.from(domWrapper.querySelectorAll('table'));
          const tableEntries = tables.map((tbl, idx) => ({
            tableIndex: idx,
            html: tbl.outerHTML,
            sig: buildTableSignature(tbl),
          }));
          return {
            filingId: fid,
            formType: ft,
            filingDate: filing.filingDate || '',
            reportDate: filing.reportDate || '',
            tables: tableEntries,
          };
        } catch(e) {
          console.warn(`[buildLiveTableIndex] Failed to fetch ${fid}:`, e);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (result) allTableEntries.push(result);
        done++;
      }
      progressCallback && progressCallback(done, targetFilings.length,
        `Scanned ${done} of ${targetFilings.length} filings...`);
    }

    // Store in cache
    window.__LIVE_TABLE_INDEX__[cacheKey] = allTableEntries;
    progressCallback && progressCallback(targetFilings.length, targetFilings.length, 'Done');

    return scoreLiveMatches(allTableEntries, signature, currentFilingId);
  }

  /**
   * Score cached live table entries against a query signature.
   */
  function scoreLiveMatches(allTableEntries, signature, currentFilingId) {
    const matches = [];
    const queryTitle = signature.title || '';

    for (const filing of allTableEntries) {
      if (filing.filingId === currentFilingId) continue;
      for (const entry of filing.tables) {
        const candidateTitle = entry.sig.title || '';
        const tScore = titleSimilarity(queryTitle, candidateTitle);
        const rowScore = sigOverlap(signature.rowLabels, entry.sig.rowLabels);

        let score = 0;
        let matched = false;
        if (queryTitle && candidateTitle) {
          if (tScore >= 0.6) { score = tScore * 0.7 + rowScore * 0.3; matched = true; }
        } else if (!queryTitle && !candidateTitle) {
          if (rowScore >= 0.5) { score = rowScore; matched = true; }
        } else {
          if (rowScore >= 0.65) { score = rowScore * 0.8; matched = true; }
        }

        if (matched) {
          matches.push({
            filingId: filing.filingId,
            formType: filing.formType,
            filingDate: filing.filingDate,
            reportDate: filing.reportDate,
            sectionTitle: candidateTitle || entry.sig.title || '',
            tableIndex: entry.tableIndex,
            tableHtml: entry.html,
            score,
          });
        }
      }
    }

    matches.sort((a, b) => b.score - a.score);

    // Deduplicate by filingId + tableIndex
    const seen = new Set();
    const deduped = [];
    for (const m of matches) {
      const key = `${m.filingId}:${m.tableIndex}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(m); }
    }
    return deduped.slice(0, 50);
  }

  /**
   * Download a single table as .xlsx using SheetJS.
   * filename: suggested download filename (e.g. "META_10-K_Table_1.xlsx")
   */
  function downloadTableAsExcel(tableEl, filename, sourceUrl) {
    if (!window.XLSX) {
      showToast('Excel library not loaded yet. Please try again.', 'error');
      return;
    }
    try {
      const wb = window.XLSX.utils.book_new();

      // Build data array: first row = source URL, then table rows
      const rows = [];
      if (sourceUrl) rows.push([`Source: ${sourceUrl}`]);

      // Extract all rows from the table
      tableEl.querySelectorAll('tr').forEach(tr => {
        const rowData = [];
        tr.querySelectorAll('th, td').forEach(cell => {
          rowData.push(cell.textContent.trim());
        });
        rows.push(rowData);
      });

      const ws = window.XLSX.utils.aoa_to_sheet(rows);

      // Auto-size columns (rough estimate)
      const colWidths = [];
      rows.forEach(row => {
        row.forEach((cell, ci) => {
          const len = String(cell || '').length;
          if (!colWidths[ci] || colWidths[ci] < len) colWidths[ci] = len;
        });
      });
      ws['!cols'] = colWidths.map(w => ({ wch: Math.min(w + 2, 50) }));

      window.XLSX.utils.book_append_sheet(wb, ws, 'Table');
      window.XLSX.writeFile(wb, filename);
      showToast(`Downloaded ${filename}`, 'success');
    } catch (e) {
      console.error('Excel export error:', e);
      showToast('Failed to generate Excel file', 'error');
    }
  }

  /**
   * Download ALL tables on the current section as a single .xlsx file,
   * each table on its own sheet.
   */
  function downloadAllTables(ticker, filingId, formType, filingDate, section) {
    if (!window.XLSX) {
      showToast('Excel library not loaded yet. Please try again.', 'error');
      return;
    }
    const mainEl = $('#docSectionContent');
    if (!mainEl) return;
    const tables = mainEl.querySelectorAll('table');
    if (!tables.length) {
      showToast('No tables found in this section', 'info');
      return;
    }
    try {
      const wb = window.XLSX.utils.book_new();
      const sourceUrl = window.location.href;
      const sectionTitle = section ? section.title : '';

      tables.forEach((tbl, idx) => {
        const rows = [];
        rows.push([`Source: ${sourceUrl}`]);
        if (sectionTitle) rows.push([`Section: ${sectionTitle}`]);
        rows.push([`Table ${idx + 1}`]);
        rows.push([]);

        tbl.querySelectorAll('tr').forEach(tr => {
          const rowData = [];
          tr.querySelectorAll('th, td').forEach(cell => {
            rowData.push(cell.textContent.trim());
          });
          rows.push(rowData);
        });

        const ws = window.XLSX.utils.aoa_to_sheet(rows);
        const colWidths = [];
        rows.forEach(row => {
          row.forEach((cell, ci) => {
            const len = String(cell || '').length;
            if (!colWidths[ci] || colWidths[ci] < len) colWidths[ci] = len;
          });
        });
        ws['!cols'] = colWidths.map(w => ({ wch: Math.min(w + 2, 50) }));
        window.XLSX.utils.book_append_sheet(wb, ws, `Table ${idx + 1}`);
      });

      const safeFormType = (formType || 'Filing').replace(/[^A-Za-z0-9-]/g, '');
      const safeDate = (filingDate || '').replace(/-/g, '');
      const filename = `${ticker}_${safeFormType}_AllTables_${safeDate}.xlsx`;
      window.XLSX.writeFile(wb, filename);
      showToast(`Downloaded ${tables.length} tables as ${filename}`, 'success');
    } catch (e) {
      console.error('Excel export error:', e);
      showToast('Failed to generate Excel file', 'error');
    }
  }

  /**
   * Show the Similar Tables modal (BamSEC-style redesign).
   * tableEl: the <table> DOM element clicked
   * ticker, filingId: current filing context
   * formType, filingDate: metadata for display
   * tableIdx: index among tables in current section
   */
  async function showSimilarTablesModal(tableEl, ticker, filingId, formType, filingDate, tableIdx) {
    const signature = buildTableSignature(tableEl);
    const detectedTitle = signature.title || '';
    const tkUpper = ticker.toUpperCase();
    const hasStaticIndex = window.__TABLES_INDEX__ && window.__TABLES_INDEX__.meta?.companies?.[tkUpper];

    // Remove any existing overlay
    document.getElementById('similarTablesOverlay')?.remove();

    // Create modal shell immediately
    const overlay = document.createElement('div');
    overlay.className = 'similar-tables-overlay';
    overlay.id = 'similarTablesOverlay';

    const modalTitleText = detectedTitle
      ? `Similar Tables: ${detectedTitle}`
      : `Similar Tables Across Time`;

    overlay.innerHTML = `
      <div class="similar-tables-modal" id="similarTablesModal">
        <div class="similar-tables-header">
          <h3>${escHtml(modalTitleText)}</h3>
          <button class="similar-tables-close" id="similarTablesCloseBtn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="similar-tables-tabs">
          <div class="similar-tables-tab active" data-tab="view">View Tables</div>
          <div class="similar-tables-tab" data-tab="merge">Merge Tables</div>
        </div>
        <div class="similar-tables-body" id="similarTablesBody">
          <div class="similar-tables-sidebar">
            <div class="similar-tables-sidebar-header" id="similarSidebarHeader">
              <button class="similar-tables-dl-all-btn" id="similarDlAllBtn" disabled>
                <span>${icons.download || '&#8659;'} Download All</span>
                <span class="dl-arrow">&#9660;</span>
              </button>
            </div>
            <div class="similar-filing-list" id="similarFilingList">
              <div class="similar-scanning-status">
                <div class="loading-spinner" style="margin:0 auto 12px"></div>
                <p>${hasStaticIndex ? 'Loading index...' : `Scanning ${escHtml(ticker)} filings...`}</p>
              </div>
            </div>
          </div>
          <div class="similar-tables-content" id="similarTablesContent">
            <div class="similar-scanning-status">
              <div class="loading-spinner" style="margin:0 auto 12px"></div>
              <p style="color:#6b7280">${hasStaticIndex ? 'Loading...' : 'Fetching filings from SEC EDGAR...'}</p>
            </div>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Close handlers
    document.getElementById('similarTablesCloseBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    // Tab switching
    let currentTab = 'view';
    let currentMatchIdx = 0;
    let matches = [];
    const htmlCache = {};
    let checkedFilings = new Set(); // indices of checked filings in merge mode
    let mergeFilter = 'all'; // 'all' | 'annual' | 'annual-quarterly'

    overlay.querySelectorAll('.similar-tables-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        overlay.querySelectorAll('.similar-tables-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        renderFilingList(); // re-render sidebar with/without checkboxes
        if (currentTab === 'view') {
          renderPreview(currentMatchIdx);
        } else if (currentTab === 'merge') {
          renderMerge();
        }
      });
    });

    // ---- Helpers ----

    function getPeriodLabel(m) {
      return getFilingPeriodLabel(m.formType, m.reportDate) || formatDateShort(m.reportDate || m.filingDate);
    }

    function renderFilingList() {
      const listEl = document.getElementById('similarFilingList');
      const headerEl = document.getElementById('similarSidebarHeader');
      if (!listEl) return;
      if (!matches.length) {
        listEl.innerHTML = `<div class="similar-no-results" style="padding:24px 16px">No similar tables found in other filings.</div>`;
        return;
      }

      if (currentTab === 'merge') {
        // Update sidebar header: show select-all checkbox widget instead of Download All button
        if (headerEl) {
          const allChecked = matches.every((_, i) => checkedFilings.has(i));
          const noneChecked = checkedFilings.size === 0;
          headerEl.innerHTML = `
            <div class="similar-merge-select-all">
              <input type="checkbox" class="similar-merge-select-all-cb" id="mergeSelectAllCb" ${allChecked ? 'checked' : ''} ${!allChecked && !noneChecked ? 'data-indeterminate="true"' : ''} />
              <button class="similar-merge-select-all-dropdown" id="mergeSelectAllDropdown">&#9660;</button>
            </div>`;
          const selectAllCb = headerEl.querySelector('#mergeSelectAllCb');
          if (selectAllCb) {
            // Set indeterminate state
            if (!allChecked && !noneChecked) selectAllCb.indeterminate = true;
            selectAllCb.addEventListener('change', () => {
              if (selectAllCb.checked) {
                matches.forEach((_, i) => checkedFilings.add(i));
              } else {
                checkedFilings.clear();
              }
              renderFilingList();
              renderMerge();
            });
          }
        }

        // BamSEC-style: single-row items with checkbox | type | period | date | ext link
        listEl.innerHTML = matches.map((m, i) => {
          const checked = checkedFilings.has(i);
          const sourceUrl = `#/doc/${ticker}/${m.filingId}`;
          return `
            <div class="similar-filing-item similar-filing-item-merge" data-idx="${i}">
              <input type="checkbox" class="similar-filing-checkbox" data-idx="${i}" ${checked ? 'checked' : ''} />
              <span class="similar-filing-type">${escHtml(m.formType)}</span>
              <span class="similar-filing-period-label">${escHtml(getPeriodLabel(m))}</span>
              <span class="similar-filing-date">${formatDateShort(m.filingDate)}</span>
              <a class="similar-filing-ext-link" href="${escHtml(sourceUrl)}" target="_blank" title="Open filing" onclick="event.stopPropagation()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
            </div>`;
        }).join('') +
        `<div class="similar-filing-footer"><span style="color:#b91c1c">See an issue? <a href="mailto:support@wamsec.com" style="color:#b91c1c">Let us know.</a></span></div>`;

        // Checkbox event handlers
        listEl.querySelectorAll('.similar-filing-checkbox').forEach(cb => {
          cb.addEventListener('change', () => {
            const idx = parseInt(cb.dataset.idx);
            if (cb.checked) {
              checkedFilings.add(idx);
            } else {
              checkedFilings.delete(idx);
            }
            // Update select-all checkbox state
            const selectAllCb = document.getElementById('mergeSelectAllCb');
            if (selectAllCb) {
              const allChecked = matches.every((_, i) => checkedFilings.has(i));
              const noneChecked = checkedFilings.size === 0;
              selectAllCb.checked = allChecked;
              selectAllCb.indeterminate = !allChecked && !noneChecked;
            }
            renderMerge();
          });
        });

      } else {
        // Restore Download All button in sidebar header for View mode
        if (headerEl) {
          headerEl.innerHTML = `
            <button class="similar-tables-dl-all-btn" id="similarDlAllBtn">
              <span>${icons.download || '&#8659;'} Download All</span>
              <span class="dl-arrow">&#9660;</span>
            </button>`;
          const dlAllBtn = headerEl.querySelector('#similarDlAllBtn');
          if (dlAllBtn) {
            dlAllBtn.addEventListener('click', downloadAll);
          }
        }
        // View tab: clickable items with active highlight, no checkboxes
        listEl.innerHTML = matches.map((m, i) => `
          <div class="similar-filing-item ${i === currentMatchIdx ? 'active' : ''}" data-idx="${i}">
            <span class="similar-filing-type">${escHtml(m.formType)}</span>
            <span class="similar-filing-period-label">${escHtml(getPeriodLabel(m))}</span>
            <span class="similar-filing-date">${formatDateShort(m.filingDate)}</span>
            <span class="similar-filing-arrow">&#8250;</span>
          </div>`).join('');

        listEl.querySelectorAll('.similar-filing-item').forEach(el => {
          el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx);
            currentMatchIdx = idx;
            listEl.querySelectorAll('.similar-filing-item').forEach((e, i) => e.classList.toggle('active', i === idx));
            if (currentTab === 'view') renderPreview(idx);
          });
        });
      }
    }

    function buildPreviewHeader(m, matchIdx) {
      if (!m) return '';
      const periodLabel = getPeriodLabel(m);
      const tableNum = matchIdx + 1;
      const tableOf = matches.length;
      const headerText = `Table ${tableNum} of ${tableOf} (from ${escHtml(m.formType)} for period ended ${formatDateShort(m.reportDate || m.filingDate)})`;
      const sourceUrl = `#/doc/${ticker}/${m.filingId}`;
      return `
        <div class="similar-table-preview-header">
          <span class="similar-table-preview-title">${headerText}</span>
          <div class="similar-table-preview-actions">
            <a href="${escHtml(sourceUrl)}" class="similar-preview-btn" onclick="document.getElementById('similarTablesOverlay')?.remove()">
              Source &#8599;
            </a>
            <button class="similar-preview-btn" id="similarPreviewDlBtn" data-idx="${matchIdx}">&#8659; Download</button>
          </div>
        </div>`;
    }

    function renderPreview(matchIdx) {
      const contentEl = document.getElementById('similarTablesContent');
      if (!contentEl) return;
      const m = matches[matchIdx];
      if (!m) {
        contentEl.innerHTML = `<div class="similar-no-results">Select a filing from the list.</div>`;
        return;
      }
      const htmlContent = m.tableHtml || htmlCache[m.id] || null;
      const bodyContent = htmlContent
        ? htmlContent
        : `<div style="display:flex;align-items:center;justify-content:center;min-height:200px;color:#6b7280"><div class="loading-spinner" style="margin-right:12px"></div> Loading table...</div>`;

      // Context text from section title
      const contextHtml = m.sectionTitle
        ? `<div style="padding:10px 20px 0;font-size:0.82rem;color:#6b7280;font-style:italic">…${escHtml(m.sectionTitle)}</div>`
        : '';

      contentEl.innerHTML = buildPreviewHeader(m, matchIdx) + contextHtml +
        `<div class="similar-table-preview-body" id="similarPreviewBody">${bodyContent}</div>`;

      // Attach download button
      const dlBtn = contentEl.querySelector('#similarPreviewDlBtn');
      if (dlBtn) {
        dlBtn.addEventListener('click', async () => {
          const midx = parseInt(dlBtn.dataset.idx);
          await downloadSingleMatch(midx);
        });
      }

      // Lazy-load HTML if not present (static index case)
      if (!htmlContent && m.id) {
        fetchTableHTML(m.id).then(html => {
          if (!html) {
            const bodyEl = document.getElementById('similarPreviewBody');
            if (bodyEl) bodyEl.innerHTML = '<div style="color:#6b7280;text-align:center;padding:40px">Failed to load table preview.</div>';
            return;
          }
          m.tableHtml = html;
          htmlCache[m.id] = html;
          if (currentMatchIdx === matchIdx) {
            const bodyEl = document.getElementById('similarPreviewBody');
            if (bodyEl) bodyEl.innerHTML = html;
          }
        });
      }
    }

    // ---- Helper: parse a date string from column header text into a sortable timestamp ----
    // (Hoisted to showSimilarTablesModal scope so both renderMerge and downloadMerged can use it)
    function parsePeriodDate(text) {
        if (!text) return null;
        text = text.trim();
        // "December 31, 2024" or "March 31, 2025"
        const longDate = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
        if (longDate) {
          return new Date(`${longDate[1]} ${longDate[2]}, ${longDate[3]}`).getTime();
        }
        // "Three Months Ended March 31, 2025" – extract the date part
        const endedDate = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
        if (endedDate) {
          return new Date(`${endedDate[1]} ${endedDate[2]}, ${endedDate[3]}`).getTime();
        }
        // "2024" standalone year
        const yearOnly = text.match(/^(\d{4})$/);
        if (yearOnly) {
          return new Date(`December 31, ${yearOnly[1]}`).getTime();
        }
        // "12/31/24" or "09/30/25"
        const shortDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (shortDate) {
          const yr = shortDate[3].length === 2 ? '20' + shortDate[3] : shortDate[3];
          return new Date(`${shortDate[1]}/${shortDate[2]}/${yr}`).getTime();
        }
        return null;
      }

      // ---- Helper: format a timestamp as "MM/DD/YY" ----
      function tsFmtShort(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yy = String(d.getFullYear()).substring(2);
        return `${mm}/${dd}/${yy}`;
      }

      // ---- Helper: parse a SEC filing table HTML into structured column data ----
      // Each original column in the SEC table is preserved as its own output column.
      // Returns: { columns: [{segment, periodDesc, yearLabel, units, isPercent, physCol}], rows: [{label, cells[]}] }
      function parseTableData(html) {
        if (!html) return null;
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const tbl = tmp.querySelector('table');
        if (!tbl) return null;

        const allRows = Array.from(tbl.querySelectorAll('tr'));
        if (!allRows.length) return null;

        // Step 1: Build cell descriptors with physical start/end positions for each row
        function buildCellMap(rows) {
          let maxCols = 0;
          const rowMaps = rows.map(tr => {
            let pos = 0;
            const cells = [];
            Array.from(tr.querySelectorAll('td, th')).forEach(cell => {
              const cs = parseInt(cell.getAttribute('colspan') || '1');
              const style = cell.getAttribute('style') || '';
              const hidden = style.includes('display:none');
              // Replace <br> with space before extracting text (SEC uses <br> in headers)
              if (!hidden) cell.querySelectorAll('br').forEach(br => br.replaceWith(' '));
              const text = hidden ? '' : cell.textContent.trim();
              cells.push({ start: pos, end: pos + cs - 1, span: cs, text, hidden });
              pos += cs;
            });
            if (pos > maxCols) maxCols = pos;
            return cells;
          });
          return { rowMaps, maxCols };
        }

        const { rowMaps, maxCols } = buildCellMap(allRows);
        if (!rowMaps.length || maxCols < 4) return null;

        // Step 2: Find the "year labels" header row — the bottom-most row in the header
        // that has year numbers like "2025" AND "% change" entries.
        // Each non-empty cell in this row defines one logical data column.
        let yearLabelRowIdx = -1;
        for (let r = 0; r < Math.min(10, rowMaps.length); r++) {
          const row = rowMaps[r];
          const hasYearLabel = row.some(c => !c.hidden && /^\d{4}$/.test(c.text));
          const hasPctChange = row.some(c => !c.hidden && /change|PercentageChange/i.test(c.text));
          // Also detect date-based headers like "June 30, 2024" or "Year Ended June 30,"
          const hasDateHeader = row.some(c => !c.hidden && /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}/i.test(c.text));
          if (hasYearLabel && hasPctChange) {
            yearLabelRowIdx = r; // keep scanning — want last (bottom-most) match
          } else if (hasYearLabel && !hasPctChange && yearLabelRowIdx < 0) {
            const yearCells = row.filter(c => !c.hidden && /^\d{4}$/.test(c.text));
            if (yearCells.length >= 2) yearLabelRowIdx = r;
          } else if (hasDateHeader && yearLabelRowIdx < 0) {
            const dateCells = row.filter(c => !c.hidden && /\d{4}/.test(c.text) && c.start > 1);
            if (dateCells.length >= 2) yearLabelRowIdx = r;
          }
        }

        if (yearLabelRowIdx < 0) return parseTableDataSimple(html);

        // Step 3: Dynamically compute labelColEnd.
        // Strategy: look at the first few data rows (after yearLabel) to find where
        // numeric/$ data begins. The label area is everything before that.
        // This handles all formats:
        //   - META: 3 label cols (0-2), data starts at col 3
        //   - MSFT: 2 label cols (0-1), data starts at col 2  
        //   - AAPL: headers overlap labels (years at pos 0), but data values start at col 3
        let labelColEnd = 0;
        const yearRow = rowMaps[yearLabelRowIdx];

        // First, try to detect from data rows (most reliable)
        let dataColStart = -1;
        for (let r = yearLabelRowIdx + 1; r < Math.min(yearLabelRowIdx + 6, rowMaps.length); r++) {
          const row = rowMaps[r];
          for (const c of row) {
            if (c.hidden || !c.text) continue;
            // Find the first cell with numeric data ($, digits, parens) that's not the label
            if (/^\$|^\d|^\(\d/.test(c.text.trim()) && c.start > 0) {
              if (dataColStart < 0 || c.start < dataColStart) dataColStart = c.start;
            }
          }
          if (dataColStart >= 0) break;
        }

        if (dataColStart > 0) {
          labelColEnd = dataColStart - 1;
        } else {
          // Fallback: try from year-label row header positions
          const firstDataCell = yearRow.find(c => !c.hidden && c.text && (/^\d{4}$/.test(c.text) || /change|PercentageChange/i.test(c.text)));
          if (firstDataCell && firstDataCell.start > 0) {
            labelColEnd = firstDataCell.start - 1;
          } else {
            labelColEnd = 2; // ultimate fallback
          }
        }

        // Step 4: Define logical columns from the year-label row.
        // If year-label cells overlap with the label area (AAPL: "2024" at pos 0-2),
        // shift each logical column's physical range to align with actual data positions.
        const logicalCols = [];
        const yearLabelCells = yearRow.filter(c => !c.hidden && c.text && (/^\d{4}$/.test(c.text) || /change|PercentageChange/i.test(c.text)));
        
        // Check if headers overlap with labels (first year cell starts at or before labelColEnd)
        const headersOverlap = yearLabelCells.length > 0 && yearLabelCells[0].start <= labelColEnd;

        if (headersOverlap && yearLabelCells.length >= 2) {
          // AAPL-style: headers occupy label positions. Compute data positions from dataColStart.
          // Each logical column has the same span as the header cell, but shifted to start after labels.
          const headerSpan = yearLabelCells[0].end - yearLabelCells[0].start + 1;
          let curPos = dataColStart;
          yearLabelCells.forEach(cell => {
            logicalCols.push({
              physStart: curPos,
              physEnd: curPos + headerSpan - 1,
              yearLabel: cell.text,
              isPercent: (/change|PercentageChange/i.test(cell.text) && !/^\$\s*Change$/i.test(cell.text)) || cell.text === '%',
            });
            curPos += headerSpan;
          });
        } else {
          // Standard: headers are in data column positions (META, MSFT style)
          yearRow.forEach(cell => {
            if (cell.hidden || !cell.text) return;
            if (cell.start <= labelColEnd) return;
            logicalCols.push({
              physStart: cell.start,
              physEnd: cell.end,
              yearLabel: cell.text,
              isPercent: (/change|PercentageChange/i.test(cell.text) && !/^\$\s*Change$/i.test(cell.text)) || cell.text === '%',
            });
          });
        }

        if (!logicalCols.length) return parseTableDataSimple(html);

        // Step 5: For each logical column, scan header rows above to find segment, periodDesc, units
        // Segment detection is GENERIC — any wide-spanning header cell that covers multiple
        // logical columns and isn't a period/units descriptor is treated as a segment label.
        // This works for all companies: META (Family of Apps, Reality Labs), GOOG (Google Services,
        // Google Cloud), AMZN (North America, AWS), MSFT (Intelligent Cloud), etc.
        // Use the max span among logical columns as the "single column" reference.
        // This avoids false segment detection when some columns have variable widths.
        const colSpans = logicalCols.map(lc => lc.physEnd - lc.physStart + 1);
        const singleColSpan = colSpans.length > 0 ? Math.max(...colSpans) : 3;

        function getHeaderForLogicalCol(lc) {
          const result = { segment: '', periodDesc: '', units: '' };
          for (let r = 0; r < yearLabelRowIdx; r++) {
            for (const cell of rowMaps[r]) {
              if (cell.hidden || !cell.text) continue;
              if (cell.start > lc.physEnd || cell.end < lc.physStart) continue;
              const text = cell.text;

              // Period descriptions: "Year Ended December 31,", "Three Months Ended...", "Years ended", "Fiscal year ended"
              if (/(?:Three|Six|Nine)\s+Months\s+Ended|Years?\s+Ended|Fiscal\s+Year|Period\s+Ended/i.test(text) && !result.periodDesc) {
                result.periodDesc = text.replace(/\s+/g, ' ');
              }
              // Units: "(in millions...)", "(dollars in millions...)", "(In millions, except...)"
              else if (/\((?:dollars\s+in|in\s+)(?:millions|thousands|billions)/i.test(text) || /^\(?In\s+millions/i.test(text) || /^\(?In\s+thousands/i.test(text) || /^\(?In\s+billions/i.test(text)) {
                if (!result.units) result.units = text;
              }
              // Segment: any wide-spanning cell (wider than a single logical column)
              // that isn't a period desc, units, or a generic period label ("Years ended", "Fiscal year").
              else if (cell.span > singleColSpan && !result.segment
                && !/years?\s+ended|fiscal\s+year|period\s+ended|months?\s+ended/i.test(text)) {
                result.segment = text;
              }
            }
          }
          // Also check rows after yearLabel for units (sometimes below the year row)
          for (let r = yearLabelRowIdx + 1; r < Math.min(yearLabelRowIdx + 3, rowMaps.length); r++) {
            for (const cell of rowMaps[r]) {
              if (cell.hidden || !cell.text) continue;
              if (/\((?:dollars\s+in|in\s+)(?:millions|thousands|billions)/i.test(cell.text) || /^\(?In\s+millions/i.test(cell.text) || /^\(?In\s+thousands/i.test(cell.text) || /^\(?In\s+billions/i.test(cell.text) || /except percentages/i.test(cell.text)) {
                if (!result.units) result.units = cell.text;
              }
            }
          }
          // Also check the year-label row's label area for units and period descriptions
          // MSFT puts "(In millions, except...)" in col 0 and "Year Ended June 30," in col 0
          for (const cell of yearRow) {
            if (cell.hidden || !cell.text) continue;
            if (cell.start <= labelColEnd) {
              if (/\((?:dollars\s+in|in\s+)(?:millions|thousands|billions)/i.test(cell.text) || /^\(?In\s+millions/i.test(cell.text) || /^\(?In\s+thousands/i.test(cell.text) || /^\(?In\s+billions/i.test(cell.text)) {
                if (!result.units) result.units = cell.text;
              }
              if (/(?:Three|Six|Nine)\s+Months\s+Ended|Years?\s+Ended|Fiscal\s+Year|Period\s+Ended/i.test(cell.text) && !result.periodDesc) {
                result.periodDesc = cell.text.replace(/\s+/g, ' ');
              }
            }
          }
          // Also check rows above yearLabel in the label column area for period descriptions
          for (let r = 0; r < yearLabelRowIdx; r++) {
            for (const cell of rowMaps[r]) {
              if (cell.hidden || !cell.text || cell.start > labelColEnd) continue;
              if (/(?:Three|Six|Nine)\s+Months\s+Ended|Years?\s+Ended|Fiscal\s+Year|Period\s+Ended/i.test(cell.text) && !result.periodDesc) {
                result.periodDesc = cell.text.replace(/\s+/g, ' ');
              }
            }
          }
          return result;
        }

        const columns = logicalCols.map(lc => {
          const hdr = getHeaderForLogicalCol(lc);
          // Normalize "PercentageChange" / "Percentage Change" to "% Change" for consistent display
          let yearLabel = lc.yearLabel;
          if (/^Percentage\s*Change$/i.test(yearLabel)) yearLabel = '% Change';
          return { ...hdr, yearLabel, isPercent: lc.isPercent, physStart: lc.physStart, physEnd: lc.physEnd };
        });

        // Step 5: Find first data row — skip spacer/units rows after the year-label row
        let dataStartRow = yearLabelRowIdx + 1;
        while (dataStartRow < rowMaps.length) {
          const row = rowMaps[dataStartRow];
          const hasNumericData = row.some(c => !c.hidden && c.text && /[\d$%()]/.test(c.text) && c.start > labelColEnd);
          const isUnitsRow = row.some(c => !c.hidden && /\(in\s+millions|dollars\s+in|except percentages/i.test(c.text));
          if (hasNumericData && !isUnitsRow) break;
          dataStartRow++;
        }

        // Step 6: Extract data rows
        const rows = [];
        for (let r = dataStartRow; r < rowMaps.length; r++) {
          const rowCells = rowMaps[r];
          let label = '';
          for (const c of rowCells) {
            if (c.hidden) continue;
            if (c.start <= labelColEnd && c.text) label += (label ? ' ' : '') + c.text;
          }
          label = label.trim();
          if (!label) continue;

          // For each logical column, concatenate text from all cells overlapping its physical range
          const cells = columns.map(col => {
            let combined = '';
            for (const c of rowCells) {
              if (c.hidden || !c.text) continue;
              if (c.end < col.physStart || c.start > col.physEnd) continue;
              combined += c.text;
            }
            return combined.replace(/\$\s+/g, '$').replace(/\s+%/g, '%').replace(/\s{2,}/g, ' ').trim();
          });

          rows.push({ label, cells });
        }

        // Step 7: Derive period dates from periodDesc + yearLabel
        const periodDates = columns.map(col => {
          if (col.yearLabel && /^\d{4}$/.test(col.yearLabel)) {
            // Try to extract date from period description
            if (col.periodDesc) {
              const dateMatch = col.periodDesc.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
              if (dateMatch) return new Date(`${dateMatch[1]} ${dateMatch[2]}, ${col.yearLabel}`).getTime();
            }
            // Fallback: use December 31 of the year
            return new Date(`December 31, ${col.yearLabel}`).getTime();
          }
          return null;
        });

        // Fill dates for % change columns from nearest preceding value column
        for (let i = 0; i < columns.length; i++) {
          if (periodDates[i] === null && i > 0) {
            for (let j = i - 1; j >= 0; j--) {
              if (periodDates[j] !== null) { periodDates[i] = periodDates[j]; break; }
            }
          }
        }

        const colHeaders = columns.map((col, i) => {
          // Normalize "PercentageChange" / "Percentage Change" to "% Change" for display
          let yearLabel = col.yearLabel;
          if (/^Percentage\s*Change$/i.test(yearLabel)) yearLabel = '% Change';
          const parts = [col.segment, yearLabel].filter(Boolean);
          return parts.join(' ') || `Col${i+1}`;
        });
        const periodDescs = columns.map(c => c.periodDesc);

        return { colHeaders, periodDates, periodDescs, rows, columns };
      }


      // Simple fallback parser for non-SEC-style tables
      function parseTableDataSimple(html) {
        if (!html) return null;
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const tbl = tmp.querySelector('table');
        if (!tbl) return null;
        const allRows = Array.from(tbl.querySelectorAll('tr'));
        if (!allRows.length) return null;
        let headerRowCount = 0;
        for (let i = 0; i < Math.min(4, allRows.length); i++) {
          const cells = Array.from(allRows[i].querySelectorAll('td, th'));
          if (!cells.length) { headerRowCount++; continue; }
          const thCount = Array.from(allRows[i].querySelectorAll('th')).length;
          if (thCount >= cells.length * 0.5) headerRowCount++;
          else break;
        }
        if (headerRowCount === 0) headerRowCount = 1;
        const headerRows = allRows.slice(0, headerRowCount);
        const dataRows = allRows.slice(headerRowCount);
        const lastHeaderRow = headerRows[headerRows.length - 1];
        const lastHeaderCells = Array.from(lastHeaderRow.querySelectorAll('td, th'));
        const colHeaders = lastHeaderCells.slice(1).map(c => c.textContent.trim());
        let periodDates = colHeaders.map(h => parsePeriodDate(h));
        const periodDescs = new Array(colHeaders.length).fill('');
        const rows = [];
        dataRows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td, th'));
          if (!cells.length) return;
          const label = cells[0].textContent.trim();
          if (!label) return;
          rows.push({ label, cells: cells.slice(1).map(c => c.textContent.trim()) });
        });
        const columns = colHeaders.map((h, i) => ({
          segment: '', periodDesc: '', yearLabel: h, units: '', isPercent: false,
          startCol: i + 1, endCol: i + 1
        }));
        return { colHeaders, periodDates, periodDescs, rows, columns };
    }

    // ==================================================================
    // Shared merge helper — builds deduplicated merged data from parsed
    // tables across filings, matching BamSEC behavior:
    //   1. Normalize row labels (strip ®, (1)/(2) suffixes, whitespace)
    //   2. Deduplicate columns by (periodDate, segment, isPercent) key
    //   3. Merge values: first non-empty value from any filing wins
    //   4. Sort columns oldest → newest
    // ==================================================================
    function buildMergedData(columnGroups, filter) {
      // --- Row label normalization ---
      function normalizeLabel(lbl) {
        return lbl
          .replace(/[®™©]/g, '')           // strip registered/trademark symbols
          .replace(/\s*\(\d+\)\s*/g, '')   // strip (1), (2), etc.
          .replace(/\s{2,}/g, ' ')          // collapse whitespace
          .trim();
      }

      // --- Collect all raw columns with source data pointers ---
      const rawCols = [];
      columnGroups.forEach((grp, gi) => {
        const cols = grp.parsed.columns || [];
        cols.forEach((colMeta, ci) => {
          rawCols.push({
            groupIdx: gi, colIdx: ci,
            segment: colMeta.segment || '',
            periodDesc: colMeta.periodDesc || '',
            yearLabel: colMeta.yearLabel || '',
            units: colMeta.units || '',
            isPercent: colMeta.isPercent || false,
            periodDate: grp.parsed.periodDates[ci],
            isAnnual: grp.isAnnual,
            matchIdx: grp.matchIdx,
            m: grp.m,
          });
        });
      });

      // --- Filter ---
      let filtered = rawCols;
      if (filter === 'annual') filtered = rawCols.filter(c => c.isAnnual);

      // --- Deduplicate columns by (periodDate, segment, isPercent) ---
      // Columns with the same key are merged: their data gets combined.
      const colKeyMap = new Map(); // key -> { col metadata, sources: [{groupIdx, colIdx}] }
      const colOrder = [];         // preserve insertion order

      filtered.forEach(col => {
        // Build a dedup key from period date + segment + percent flag
        const dateKey = col.periodDate ? String(col.periodDate) : col.yearLabel;
        const key = `${dateKey}|${col.segment}|${col.isPercent ? 'pct' : 'val'}`;

        if (colKeyMap.has(key)) {
          // Add as another source for the same logical column
          colKeyMap.get(key).sources.push({ groupIdx: col.groupIdx, colIdx: col.colIdx });
          // Prefer metadata from annual filings over quarterly
          if (col.isAnnual && !colKeyMap.get(key).isAnnual) {
            const existing = colKeyMap.get(key);
            existing.periodDesc = col.periodDesc || existing.periodDesc;
            existing.units = col.units || existing.units;
            existing.isAnnual = true;
            existing.m = col.m;
          }
        } else {
          const entry = {
            segment: col.segment,
            periodDesc: col.periodDesc,
            yearLabel: col.yearLabel,
            units: col.units,
            isPercent: col.isPercent,
            periodDate: col.periodDate,
            isAnnual: col.isAnnual,
            m: col.m,
            sources: [{ groupIdx: col.groupIdx, colIdx: col.colIdx }],
          };
          colKeyMap.set(key, entry);
          colOrder.push(key);
        }
      });

      // Build final deduplicated column list, sorted oldest → newest
      const mergedCols = colOrder.map(k => colKeyMap.get(k));
      mergedCols.sort((a, b) => {
        if (!a.periodDate && !b.periodDate) return 0;
        if (!a.periodDate) return 1;
        if (!b.periodDate) return -1;
        if (a.periodDate !== b.periodDate) return a.periodDate - b.periodDate;
        // Within same date: value columns before percent columns
        if (a.isPercent !== b.isPercent) return a.isPercent ? 1 : -1;
        return 0;
      });

      // --- Normalize row labels and build unified row set ---
      // Map: normalizedLabel -> { displayLabel, values per deduped column }
      const rowMap = new Map();  // normalizedLabel -> { display, cells: string[] }
      const rowOrder = [];       // preserve first-seen order

      // Build normalized lookup: { groupIdx -> { normalizedLabel -> rawCells[] } }
      const normLookup = {};
      columnGroups.forEach((grp, gi) => {
        normLookup[gi] = {};
        grp.parsed.rows.forEach(r => {
          const norm = normalizeLabel(r.label);
          // Keep first occurrence (don't overwrite)
          if (!normLookup[gi][norm]) {
            normLookup[gi][norm] = r.cells;
          }
        });
      });

      // Collect all normalized labels in first-seen order
      columnGroups.forEach(grp => {
        grp.parsed.rows.forEach(r => {
          const norm = normalizeLabel(r.label);
          if (!rowMap.has(norm)) {
            rowMap.set(norm, { display: r.label.replace(/\s*\(\d+\)\s*/g, '').replace(/[®™©]/g, '').trim(), cells: new Array(mergedCols.length).fill('') });
            rowOrder.push(norm);
          }
        });
      });

      // Fill cell values — for each merged column, try each source until non-empty
      mergedCols.forEach((mc, mci) => {
        rowOrder.forEach(norm => {
          const entry = rowMap.get(norm);
          if (entry.cells[mci]) return; // already filled
          for (const src of mc.sources) {
            const grpData = normLookup[src.groupIdx];
            if (!grpData || !grpData[norm]) continue;
            const val = grpData[norm][src.colIdx];
            if (val && val.trim()) {
              entry.cells[mci] = val;
              break;
            }
          }
        });
      });

      // Build final rows array
      const rows = rowOrder.map(norm => ({
        label: rowMap.get(norm).display,
        cells: rowMap.get(norm).cells,
      }));

      return { mergedCols, rows };
    }

    // ---- Helper functions for row styling ----
    function isSectionHeader(label) {
      return /^(Total\s+|Revenue|Net\s+(?:sales|revenue|income|loss)|Gross\s+(?:margin|profit)|Operating\s+(?:income|margin|loss|expenses?)|Income\s+(?:from|before|\(loss\))|Loss\s+from|Costs?\s+and\s+expenses?|Earnings\s+per\s+share|Weighted|Share.based|Comprehensive\s+income|Total\s+stockholders|Total\s+liabilities|Total\s+assets|Total\s+equity|Cash\s+and\s+cash|EBITDA|Diluted|Basic)/i.test(label);
    }
    function isSubItem(label) {
      return /^(Cost\s+of\s+revenue|Research\s+and|Marketing\s+and|Sales\s+and\s+marketing|General\s+and\s+administrative|Interest\s+and|Interest\s+expense|Income\s+before\s+(?:provision|income)|Provision\s+for|Other\s+(?:income|expense)|Depreciation|Amortization|Impairment|Restructuring|Stock-based|Selling,?\s+general)/i.test(label);
    }

    function renderMerge() {
      const contentEl = document.getElementById('similarTablesContent');
      if (!contentEl) return;
      if (!matches.length) {
        contentEl.innerHTML = `<div class="similar-no-results">No matches to merge.</div>`;
        return;
      }

      const checkedIndices = Array.from(checkedFilings).filter(i => i < matches.length).sort((a, b) => a - b);

      // Lazy-load any missing HTML
      const needsLoad = checkedIndices.some(i => {
        const m = matches[i];
        return !m.tableHtml && !htmlCache[m.id] && m.id;
      });

      const toolbarHtml = (dlEnabled) => `
        <div class="similar-merge-toolbar">
          <div class="similar-merge-filter-group">
            <button class="similar-merge-filter-btn ${mergeFilter==='all'?'active':''}" data-filter="all">All Columns</button>
            <button class="similar-merge-filter-btn ${mergeFilter==='annual'?'active':''}" data-filter="annual">Annual Columns</button>
            <button class="similar-merge-filter-btn ${mergeFilter==='annual-quarterly'?'active':''}" data-filter="annual-quarterly">Annual &amp; Quarterly Columns</button>
          </div>
          <button class="similar-merge-dl-btn" id="similarMergeDlBtn" ${dlEnabled?'':'disabled'}><span>&#8681;</span> Download</button>
        </div>`;

      if (needsLoad) {
        contentEl.innerHTML = toolbarHtml(false) + `
          <div class="similar-merge-area">
            <div style="display:flex;align-items:center;justify-content:center;min-height:200px;color:#6b7280">
              <div class="loading-spinner" style="margin-right:12px"></div> Loading table data...
            </div>
          </div>`;
        Promise.all(checkedIndices.map(async i => {
          const m = matches[i];
          if (!m.tableHtml && !htmlCache[m.id] && m.id) {
            const html = await fetchTableHTML(m.id);
            if (html) { m.tableHtml = html; htmlCache[m.id] = html; }
          }
        })).then(() => renderMerge());
        return;
      }

      // Parse all checked matches
      const columnGroups = [];
      checkedIndices.forEach(i => {
        const m = matches[i];
        const html = m.tableHtml || htmlCache[m.id] || '';
        if (!html) return;
        const parsed = parseTableData(html);
        if (!parsed || !parsed.columns || !parsed.columns.length) return;
        columnGroups.push({ matchIdx: i, m, parsed, isAnnual: /10-K/i.test(m.formType) });
      });

      if (!columnGroups.length) {
        contentEl.innerHTML = toolbarHtml(false) + `
          <div class="similar-merge-area">
            <div class="similar-no-results">
              ${checkedIndices.length === 0
                ? 'Check filings in the sidebar to merge their tables.'
                : 'Table data not yet loaded. Switch to View tab to preview each table, then return to Merge.'}
            </div>
          </div>`;
        contentEl.querySelector('#similarMergeDlBtn')?.addEventListener('click', downloadMerged);
        setupMergeToolbar(contentEl);
        return;
      }

      // ---- Use shared merge helper ----
      const { mergedCols, rows } = buildMergedData(columnGroups, mergeFilter);

      if (!mergedCols.length) {
        contentEl.innerHTML = toolbarHtml(false) + `<div class="similar-merge-area"><div class="similar-no-results">No columns to display.</div></div>`;
        setupMergeToolbar(contentEl);
        return;
      }

      // ---- Build header HTML ----
      const hasUnits = mergedCols.some(c => c.units);
      const headerRowspan = 4 + (hasUnits ? 1 : 0);

      // Row 1: Dates
      let dateHeaderCells = `<th class="similar-merge-rowlabel-th" rowspan="${headerRowspan}"></th>`;
      mergedCols.forEach(col => {
        let dateLabel = col.periodDate ? tsFmtShort(col.periodDate) : '';
        if (mergeFilter === 'annual-quarterly') {
          dateLabel = (col.isAnnual ? '<span class="merge-col-type annual">ANNUAL</span>' : '<span class="merge-col-type quarterly">QUARTERLY</span>');
        }
        dateHeaderCells += `<th>${dateLabel}</th>`;
      });

      // Row 2: Segments
      let segmentCells = '';
      mergedCols.forEach(col => { segmentCells += `<th>${escHtml(col.segment)}</th>`; });

      // Row 3: Period descriptions (blank for % change columns)
      let periodDescCells = '';
      mergedCols.forEach(col => {
        periodDescCells += `<th>${escHtml(!col.isPercent ? col.periodDesc : '')}</th>`;
      });

      // Row 4: Year / % change labels
      let yearCells = '';
      mergedCols.forEach(col => { yearCells += `<th>${escHtml(col.yearLabel)}</th>`; });

      // Row 5: Units (optional)
      let unitsRowHtml = '';
      if (hasUnits) {
        let unitsCells = '';
        mergedCols.forEach(col => { unitsCells += `<th>${escHtml(col.units)}</th>`; });
        unitsRowHtml = `<tr class="similar-merge-units-row">${unitsCells}</tr>`;
      }

      // ---- Data rows ----
      const dataRowsHtml = rows.map(row => {
        const sectionHdr = isSectionHeader(row.label);
        const subItem = !sectionHdr && isSubItem(row.label);
        const labelClass = sectionHdr ? 'similar-merge-label-td section-header' : (subItem ? 'similar-merge-label-td sub-item' : 'similar-merge-label-td');
        let cells = `<td class="${labelClass}">${escHtml(row.label)}</td>`;
        row.cells.forEach(val => { cells += `<td>${escHtml(val)}</td>`; });
        return `<tr>${cells}</tr>`;
      }).join('');

      // ---- Source row ----
      let sourceCells = `<td class="similar-merge-label-td"></td>`;
      mergedCols.forEach(col => {
        const url = `#/doc/${ticker}/${col.m.filingId}`;
        sourceCells += `<td class="similar-merge-source-td"><a href="${escHtml(url)}" class="similar-merge-source-link" onclick="document.getElementById('similarTablesOverlay')?.remove()">Source &#8599;</a></td>`;
      });

      // ---- Assemble ----
      contentEl.innerHTML = toolbarHtml(true) + `
        <div class="similar-merge-area">
          <table class="similar-merge-table">
            <thead>
              <tr class="similar-merge-date-row">${dateHeaderCells}</tr>
              <tr class="similar-merge-segment-row">${segmentCells}</tr>
              <tr class="similar-merge-period-row">${periodDescCells}</tr>
              <tr class="similar-merge-year-row">${yearCells}</tr>
              ${unitsRowHtml}
            </thead>
            <tbody>
              ${dataRowsHtml}
              <tr class="similar-merge-source-row">${sourceCells}</tr>
            </tbody>
          </table>
        </div>`;

      contentEl.querySelector('#similarMergeDlBtn')?.addEventListener('click', downloadMerged);
      setupMergeToolbar(contentEl);
    }

    function setupMergeToolbar(contentEl) {
      contentEl.querySelectorAll('.similar-merge-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          mergeFilter = btn.dataset.filter;
          renderMerge();
        });
      });
    }

    async function downloadSingleMatch(matchIdx) {
      if (!window.XLSX) { showToast('Excel library not loaded yet.', 'error'); return; }
      const m = matches[matchIdx];
      if (!m) return;
      let html = m.tableHtml || htmlCache[m.id];
      if (!html && m.id) {
        html = await fetchTableHTML(m.id);
        if (html) { m.tableHtml = html; htmlCache[m.id] = html; }
      }
      if (!html) { showToast('Table HTML not available', 'error'); return; }
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      const tblEl = tempDiv.querySelector('table');
      if (tblEl) {
        const dlFn = `${ticker}_${(m.formType||'Filing').replace(/[^A-Za-z0-9-]/g,'')}_Table_${m.tableIndex+1}.xlsx`;
        downloadTableAsExcel(tblEl, dlFn, `${window.location.origin}#/doc/${ticker}/${m.filingId}`);
      }
    }

    async function downloadAll() {
      if (!window.XLSX) { showToast('Excel library not loaded yet.', 'error'); return; }
      if (!matches.length) { showToast('No similar tables to download', 'info'); return; }
      try {
        showToast('Loading all tables for download...', 'info');
        const wb = window.XLSX.utils.book_new();
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i];
          let html = m.tableHtml || htmlCache[m.id];
          if (!html && m.id) {
            html = await fetchTableHTML(m.id);
            if (html) { m.tableHtml = html; htmlCache[m.id] = html; }
          }
          if (!html) continue;
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = html;
          const tbl = tempDiv.querySelector('table');
          if (!tbl) continue;
          const rows = [];
          rows.push([`Source: #/doc/${ticker}/${m.filingId}`]);
          rows.push([`${m.formType} \u2014 ${formatDate(m.filingDate)} \u2014 ${m.sectionTitle} \u2014 Table ${m.tableIndex + 1}`]);
          rows.push([]);
          tbl.querySelectorAll('tr').forEach(tr => {
            const rowData = [];
            tr.querySelectorAll('th, td').forEach(cell => rowData.push(cell.textContent.trim()));
            rows.push(rowData);
          });
          const ws = window.XLSX.utils.aoa_to_sheet(rows);
          const colWidths = [];
          rows.forEach(row => row.forEach((cell, ci) => {
            const len = String(cell || '').length;
            if (!colWidths[ci] || colWidths[ci] < len) colWidths[ci] = len;
          }));
          ws['!cols'] = colWidths.map(w => ({ wch: Math.min(w + 2, 50) }));
          const sheetName = `${m.formType}_${(m.filingDate||'').substring(0,7)}_T${m.tableIndex+1}`.substring(0, 31);
          window.XLSX.utils.book_append_sheet(wb, ws, sheetName);
        }
        const filename = `${ticker}_SimilarTables_Table${tableIdx+1}.xlsx`;
        window.XLSX.writeFile(wb, filename);
        showToast(`Downloaded ${matches.length} similar tables`, 'success');
      } catch(e) {
        console.error('Similar tables download error:', e);
        showToast('Failed to generate Excel file', 'error');
      }
    }

    async function downloadMerged() {
      if (!window.XLSX) { showToast('Excel library not loaded yet.', 'error'); return; }
      if (!matches.length) { showToast('No tables to merge', 'info'); return; }
      try {
        const checkedIndices = Array.from(checkedFilings).filter(i => i < matches.length).sort((a, b) => a - b);
        if (!checkedIndices.length) { showToast('No filings checked', 'info'); return; }

        // Lazy-load any missing HTML first
        for (const i of checkedIndices) {
          const m = matches[i];
          if (!m.tableHtml && !htmlCache[m.id] && m.id) {
            const html = await fetchTableHTML(m.id);
            if (html) { m.tableHtml = html; htmlCache[m.id] = html; }
          }
        }

        // Parse using same parseTableData as renderMerge
        const columnGroups = [];
        checkedIndices.forEach(i => {
          const m = matches[i];
          const html = m.tableHtml || htmlCache[m.id] || '';
          if (!html) return;
          const parsed = parseTableData(html);
          if (!parsed || !parsed.columns || !parsed.columns.length) return;
          columnGroups.push({ matchIdx: i, m, parsed, isAnnual: /10-K/i.test(m.formType) });
        });

        if (!columnGroups.length) { showToast('No table data available', 'info'); return; }

        // ---- Use the SAME shared buildMergedData() helper as renderMerge ----
        const { mergedCols, rows } = buildMergedData(columnGroups, mergeFilter);

        if (!mergedCols.length) { showToast('No columns to export', 'info'); return; }

        // ---- Build BamSEC-format Excel: 5 header rows + data rows + source row ----
        const wb = window.XLSX.utils.book_new();

        // Row 1: Period end dates
        const dateRow = ['', ...mergedCols.map(c => {
          if (c.periodDate) {
            const d = new Date(c.periodDate);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
          }
          return '';
        })];

        // Row 2: Segment labels
        const segmentRow = ['', ...mergedCols.map(c => c.segment)];

        // Row 3: Period descriptions (blank for % change columns)
        const periodDescRow = ['', ...mergedCols.map(c => c.isPercent ? '' : c.periodDesc)];

        // Row 4: Year / % change labels
        const yearRow = ['', ...mergedCols.map(c => {
          if (/^\d{4}$/.test(c.yearLabel)) return parseInt(c.yearLabel);
          return c.yearLabel;
        })];

        // Row 5: Units
        const unitsRow = ['', ...mergedCols.map(c => c.units)];

        // Data rows: parse numeric values from the already-deduplicated rows
        const dataRows = rows.map(row => {
          return [row.label, ...row.cells.map((val, ci) => {
            if (!val) return '';
            // Skip non-numeric markers
            if (/^[*\-—]+$/.test(val.trim()) || /^N\/[MA]$/i.test(val.trim())) return val;
            // Try to parse as number
            let cleaned = val.replace(/[$,\s]/g, '').replace(/%|ppt/gi, '').replace(/^\((.+)\)$/, '-$1');
            const num = Number(cleaned);
            if (!isNaN(num) && cleaned !== '') {
              if (val.endsWith('%') || /ppt$/i.test(val)) return num / 100;
              if (mergedCols[ci].isPercent && !val.includes('$') && Math.abs(num) < 10000) return num / 100;
              return num;
            }
            return val;
          })];
        });

        // Empty row before source
        const emptyRow = new Array(mergedCols.length + 1).fill('');

        // Source row with hyperlinks
        const sourceRow = ['', ...mergedCols.map(() => 'Source')];

        const allRows = [dateRow, segmentRow, periodDescRow, yearRow, unitsRow, ...dataRows, emptyRow, sourceRow];
        const ws = window.XLSX.utils.aoa_to_sheet(allRows);

        // Format percentage cells in data rows
        dataRows.forEach((row, ri) => {
          mergedCols.forEach((col, ci) => {
            const cellRef = window.XLSX.utils.encode_cell({ r: ri + 5, c: ci + 1 });
            if (ws[cellRef] && typeof ws[cellRef].v === 'number' && col.isPercent) {
              ws[cellRef].z = '0%';
            }
          });
        });

        // Add hyperlinks to source row
        const sourceRowIdx = allRows.length - 1;
        mergedCols.forEach((col, ci) => {
          const cellRef = window.XLSX.utils.encode_cell({ r: sourceRowIdx, c: ci + 1 });
          if (ws[cellRef]) {
            const url = `${window.location.origin}#/doc/${ticker}/${col.m.filingId}`;
            ws[cellRef].l = { Target: url, Tooltip: 'View source filing' };
          }
        });

        // Set column widths
        ws['!cols'] = [{ wch: 30 }, ...mergedCols.map(() => ({ wch: 18 }))];

        window.XLSX.utils.book_append_sheet(wb, ws, 'Sheet');
        const companyName = (state.filings.companyName || ticker).replace(/[^A-Za-z0-9 -]/g, '').replace(/\s+/g, '-').toLowerCase();
        window.XLSX.writeFile(wb, `${companyName}-all.xlsx`);
        showToast('Downloaded merged table', 'success');
      } catch(e) {
        console.error('Merge download error:', e);
        showToast('Failed to generate merged Excel', 'error');
      }
    }

    // ---- Load matches ----

    async function loadMatches() {
      let result = null;

      if (hasStaticIndex) {
        // Use static pre-built index (META case — instant)
        result = await findSimilarTablesAPI(signature, filingId, ticker);
        if (result && !result.error && result.matches.length > 0) {
          matches = result.matches.map(m => ({
            id: m.id,
            filingId: m.filing_id,
            formType: m.form_type || 'Filing',
            filingDate: m.filing_date || '',
            reportDate: m.report_date || '',
            sectionTitle: m.section_context || '',
            tableIndex: m.table_index,
            tableHtml: null,
            score: m.score,
            numRows: m.num_rows,
          }));
        } else {
          matches = [];
        }
      } else {
        // Live indexing for non-META companies
        const progressFn = (done, total, statusText) => {
          const listEl = document.getElementById('similarFilingList');
          const contentEl = document.getElementById('similarTablesContent');
          if (listEl) {
            if (done < total) {
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              listEl.innerHTML = `
                <div style="padding:16px">
                  <div style="font-size:0.8rem;color:#374151;margin-bottom:8px">${escHtml(statusText)}</div>
                  <div class="similar-progress-bar-wrap">
                    <div class="similar-progress-bar" style="width:${pct}%"></div>
                  </div>
                </div>`;
            }
          }
          if (contentEl) {
            if (done < total) {
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              contentEl.innerHTML = `
                <div class="similar-progress-area">
                  <span>${escHtml(statusText)}</span>
                  <div class="similar-progress-bar-wrap">
                    <div class="similar-progress-bar" style="width:${pct}%"></div>
                  </div>
                  <span style="white-space:nowrap">${done}/${total}</span>
                </div>
                <div class="similar-scanning-status">
                  <p>Finding similar tables...</p>
                </div>`;
            }
          }
        };

        matches = await buildLiveTableIndex(ticker, signature, filingId, progressFn);
      }

      // Update Download All button
      const dlAllBtn = document.getElementById('similarDlAllBtn');
      if (dlAllBtn) {
        dlAllBtn.disabled = !matches.length;
        dlAllBtn.innerHTML = `<span>${icons.download || '&#8659;'} Download All (${matches.length})</span><span class="dl-arrow">&#9660;</span>`;
        dlAllBtn.addEventListener('click', downloadAll);
      }

      renderFilingList();
      if (matches.length > 0) {
        // Initialize all filings as checked by default
        checkedFilings = new Set(matches.map((_, i) => i));
        currentMatchIdx = 0;
        renderPreview(0);
      } else {
        const contentEl = document.getElementById('similarTablesContent');
        if (contentEl) {
          contentEl.innerHTML = `<div class="similar-no-results">No similar tables found in other filings.<br><br>This table's structure did not match any tables in the historical filings database.</div>`;
        }
      }
    }

    // Start loading
    loadMatches();
  }

  /**
   * Initialize Table Tools for a rendered section.
   * Wraps each <table> in a container with a floating toolbar.
   */
  function initTableTools(containerEl, ticker, filingId, formType, filingDate, section) {
    if (!containerEl) return;
    const tables = Array.from(containerEl.querySelectorAll('table'));
    if (!tables.length) return;

    const safeFormType = (formType || 'Filing').replace(/[^A-Za-z0-9-]/g, '');
    const sourceUrl = window.location.href;

    tables.forEach((tbl, idx) => {
      // Avoid double-wrapping
      if (tbl.parentElement && tbl.parentElement.classList.contains('table-tools-wrapper')) return;

      // Create wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'table-tools-wrapper';
      tbl.parentNode.insertBefore(wrapper, tbl);
      wrapper.appendChild(tbl);

      // Create toolbar
      const bar = document.createElement('div');
      bar.className = 'table-tools-bar';
      bar.innerHTML = `
        <span class="table-index-badge">Table ${idx + 1}</span>
        <button class="table-tools-btn" data-action="link" title="Copy link to this table">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
          Link
        </button>
        <button class="table-tools-btn" data-action="similar" title="View similar tables across filings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
          Similar Tables
        </button>
        <button class="table-tools-btn" data-action="download" title="Download table as Excel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>`;

      wrapper.insertBefore(bar, tbl);

      // --- JS-based hover with grace period (replaces pure CSS :hover) ---
      // This prevents the toolbar from disappearing when the cursor briefly
      // leaves the wrapper (common on MacBook trackpads with fast swipes).
      let hideTimer = null;
      const HIDE_DELAY = 300; // ms grace period

      wrapper.addEventListener('mouseenter', () => {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        wrapper.classList.add('table-tools-active');
      });

      wrapper.addEventListener('mouseleave', () => {
        hideTimer = setTimeout(() => {
          wrapper.classList.remove('table-tools-active');
          hideTimer = null;
        }, HIDE_DELAY);
      });

      // Also keep toolbar visible while any toolbar button is focused (keyboard a11y)
      bar.addEventListener('focusin', () => {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        wrapper.classList.add('table-tools-active');
      });
      bar.addEventListener('focusout', () => {
        hideTimer = setTimeout(() => {
          wrapper.classList.remove('table-tools-active');
          hideTimer = null;
        }, HIDE_DELAY);
      });

      // Toolbar button actions
      bar.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;

        if (action === 'link') {
          const tableAnchor = `${sourceUrl.split('#')[0]}#/doc/${ticker}/${filingId}?table=${idx + 1}`;
          navigator.clipboard.writeText(tableAnchor)
            .then(() => showToast('Table link copied to clipboard', 'success'))
            .catch(() => showToast('Could not copy link', 'error'));
        }

        if (action === 'similar') {
          showSimilarTablesModal(tbl, ticker, filingId, formType, filingDate, idx);
        }

        if (action === 'download') {
          const safeDate = (filingDate || '').replace(/-/g, '');
          const filename = `${ticker}_${safeFormType}_Table_${idx + 1}.xlsx`;
          downloadTableAsExcel(tbl, filename, sourceUrl);
        }
      });
    });
  }

  // ===========================================================
  // INIT
  // ===========================================================
  function init() {
    // Inject extra styles
    injectStyles();

    // Init navbar autocomplete
    const ni = $('#navbarSearchInput');
    const nd = $('#navbarAutocomplete');
    initAutocomplete(ni, nd, (item) => {
      navigate(`#/company/${item.ticker}`);
    });

    // Close screening dropdown on outside click (delegated)
    document.addEventListener('click', (e) => {
      const scrDrop = $('#screeningDropdown');
      if (scrDrop && !scrDrop.contains(e.target)) scrDrop.classList.remove('open');
    });

    // Handle routing
    window.addEventListener('hashchange', handleRoute);
    handleRoute();
    updateNavbar();
  }

  // Make some functions globally accessible for inline handlers
  window.showToast = showToast;
  window.state = state;
  window.navigate = navigate;
  window.updateNavbar = updateNavbar;

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
