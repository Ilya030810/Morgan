import crypto from "node:crypto";

const b64url = (buf) => buf.toString("base64url");

export function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomUUID();
  return { verifier, challenge, state };
}

export function buildAuthUrl({ challenge, state }) {
  const p = new URLSearchParams({
    scope: "birthday contacts openid profile snils blitz_change_password blitz_user_rights blitz_qr_auth",
    access_type: "offline",
    response_type: "code",
    state,
    client_id: process.env.MES_CLIENT_ID,
    redirect_uri: "http://localhost",
    prompt: "login",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://login.mos.ru/sps/oauth/ae?${p}`;
}

// пользователь присылает адрес вида http://localhost/?code=...&state=...
export function parseRedirect(text) {
  const u = new URL(text.trim());
  return { code: u.searchParams.get("code"), state: u.searchParams.get("state") };
}

export async function exchangeCode({ code, verifier }) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };

  // секрет нужен, только если сервер ответит invalid_client
  if (process.env.MES_CLIENT_SECRET) {
    const basic = Buffer.from(
      `${process.env.MES_CLIENT_ID}:${process.env.MES_CLIENT_SECRET}`
    ).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }

  const r = await fetch(process.env.MES_TOKEN_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost",
      client_id: process.env.MES_CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return r.json(); // access_token, refresh_token, id_token, expires_in
}
