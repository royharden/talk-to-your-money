import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase env vars. Check .env for VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");
}

const OWNER_TOKEN_KEY = "ownerToken";
export const OWNER_TOKEN_HEADER = "x-owner-token";

// In memory too, so the session survives a tab where localStorage is blocked
let ownerToken: string | null = null;
try {
  ownerToken = localStorage.getItem(OWNER_TOKEN_KEY);
} catch {
  // storage blocked: the session lasts for this tab only
}

export function getOwnerToken(): string | null {
  return ownerToken;
}

export function setOwnerToken(token: string | null): void {
  ownerToken = token;
  try {
    if (token) localStorage.setItem(OWNER_TOKEN_KEY, token);
    else localStorage.removeItem(OWNER_TOKEN_KEY);
  } catch {
    // storage blocked: keep the in-memory token
  }
}

/** Requests that read or write the caller's own rows carry the owner token */
const baseUrl = supabaseUrl.endsWith("/") ? supabaseUrl : `${supabaseUrl}/`;
const OWNER_SCOPED_PREFIXES = ["rest/v1/", "functions/v1/mutate", "functions/v1/jev-classify"].map(
  (path) => new URL(path, baseUrl).href
);

const ownerFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!ownerToken || !OWNER_SCOPED_PREFIXES.some((p) => url.startsWith(p))) {
    return fetch(input, init);
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(OWNER_TOKEN_HEADER, ownerToken);
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
  global: { fetch: ownerFetch },
});
