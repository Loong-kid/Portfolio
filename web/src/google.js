// Google Sheets API — 서비스 계정 JWT 로 직접 호출 (gspread 대체).
// 값은 gspread.get_all_values() 와 같은 "표시 문자열"(FORMATTED_VALUE)로 읽는다 →
// 파이썬 버전과 입력이 똑같아진다.

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

let tokenCache = null; // { token, exp } — isolate 메모리 캐시

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlStr = (str) => b64url(new TextEncoder().encode(str));

async function importKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 120 > now) return tokenCache.token;
  const sa = JSON.parse(env.GCP_SA_JSON);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: now, exp: now + 3600,
  }));
  const key = await importKey(sa.private_key);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`)));
  const jwt = `${header}.${claim}.${b64url(sig)}`;
  const r = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google 토큰 발급 실패: ${JSON.stringify(j).slice(0, 200)}`);
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokenCache.token;
}

async function gfetch(env, url, init = {}, tries = 4) {
  const token = await getAccessToken(env);
  for (let i = 0; ; i++) {
    const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });
    if (r.status === 429 && i < tries - 1) {           // 할당량 초과 → 지수 백오프
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`Sheets API ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

const q = (s) => `'${s.replace(/'/g, "''")}'`; // 탭 이름 따옴표

/** 여러 탭을 한 번에 읽어 {tab: [ {col: value} ... ]} 로 돌려준다. 없는 탭은 빈 배열. */
export async function readTabs(env, sheetId, tabs) {
  const meta = await gfetch(env, `${API}/${sheetId}?fields=sheets.properties.title`);
  const existing = new Set(meta.sheets.map((s) => s.properties.title));
  const present = tabs.filter((t) => existing.has(t));
  const out = Object.fromEntries(tabs.map((t) => [t, []]));
  if (!present.length) return out;
  const params = present.map((t) => `ranges=${encodeURIComponent(q(t))}`).join("&");
  const j = await gfetch(env, `${API}/${sheetId}/values:batchGet?${params}`);
  j.valueRanges.forEach((vr, i) => {
    const rows = vr.values || [];
    if (!rows.length) return;
    const cols = rows[0];
    out[present[i]] = rows.slice(1).map((r) => Object.fromEntries(cols.map((c, k) => [c, r[k] ?? ""])));
  });
  return out;
}

/** 탭 전체 덮어쓰기 — 파이썬 write_tab 과 같은 순서(먼저 덮어쓰고, 남는 꼬리 행만 지움). */
export async function writeTab(env, sheetId, tab, headers, rows) {
  const values = [headers, ...rows.map((r) => headers.map((h) => fmtCell(r[h])))];
  await gfetch(env, `${API}/${sheetId}/values/${encodeURIComponent(q(tab) + "!A1")}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const lastCol = colLetter(headers.length);
  try {
    await gfetch(env, `${API}/${sheetId}/values:batchClear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ranges: [`${q(tab)}!A${values.length + 1}:${lastCol}`] }),
    });
  } catch { /* 지울 꼬리가 없으면 무시 */ }
}

/** 한 행 추가 (파이썬 append_row). */
export async function appendRow(env, sheetId, tab, headers, row) {
  await gfetch(env, `${API}/${sheetId}/values/${encodeURIComponent(q(tab) + "!A1")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: [headers.map((h) => fmtCell(row[h]))] }),
  });
}

function fmtCell(v) {
  if (v == null) return "";
  if (typeof v === "number" && !Number.isFinite(v)) return "";
  return String(v);
}

function colLetter(n) {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
