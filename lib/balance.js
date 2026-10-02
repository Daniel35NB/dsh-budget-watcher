// Pure helpers for the DeepSeek balance payload.
//
// These are deliberately free of Cordis, `fetch`, and DSH imports so `node --test`
// can exercise every branch without a running harness. The host half owns the
// network and the routing; this file owns the meaning of the bytes.

/**
 * The subset of `GET /user/balance` this plugin reads. DeepSeek documents three
 * amounts per currency, all as decimal **strings** — the docs never promise
 * numbers, so a client that does `Number(...)` on them without checking is the
 * one that breaks, not the API.
 *
 * @typedef {object} Wallet
 * @property {string} currency   `CNY` or `USD` as returned; not an enum here,
 *   because a new currency must not throw.
 * @property {string} total      `total_balance` — granted + topped up.
 * @property {string} granted    `granted_balance` — promotional credit, expires.
 * @property {string} toppedUp   `topped_up_balance` — the money the user paid for.
 */

/** A decimal string with an optional sign and an optional fraction. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

function amount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && DECIMAL.test(value.trim())) return value.trim();
  return undefined;
}

/**
 * Add two decimal strings in integer hundredths, so the result is exact for the
 * two-decimal money this API deals in. Only used to reconstruct `total_balance`
 * when a response omits it; DeepSeek normally sends all three amounts.
 */
function addAmounts(left, right) {
  const toHundredths = (text) => {
    const negative = text.startsWith("-");
    const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
    const value = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
    return negative ? -value : value;
  };
  const total = toHundredths(left) + toHundredths(right);
  const magnitude = Math.abs(total);
  return `${total < 0 ? "-" : ""}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}

/**
 * Normalize one `balance_infos[]` entry, dropping fields that are absent or not
 * decimal. A wallet missing every amount is not a wallet and is dropped by the
 * caller.
 *
 * `total` is the figure the panel shows, because it is the whole balance:
 * topped-up money plus granted credit. DeepSeek documents
 * `total_balance = granted_balance + topped_up_balance` and normally sends it,
 * but it is reconstructed when absent so a wallet that reported only its parts
 * cannot render as zero.
 *
 * @param {unknown} raw
 * @returns {Wallet | undefined}
 */
export function normalizeWallet(raw) {
  if (typeof raw !== "object" || raw === null) return undefined;
  const info = /** @type {Record<string, unknown>} */ (raw);
  const currency = typeof info.currency === "string" ? info.currency.trim().toUpperCase() : "";
  if (currency === "") return undefined;

  const total = amount(info.total_balance);
  const granted = amount(info.granted_balance);
  const toppedUp = amount(info.topped_up_balance);
  if (total === undefined && granted === undefined && toppedUp === undefined) return undefined;

  return {
    currency,
    total: total ?? addAmounts(toppedUp ?? "0", granted ?? "0"),
    granted: granted ?? "0",
    toppedUp: toppedUp ?? "0",
  };
}

/**
 * Normalize a whole `GET /user/balance` body.
 *
 * `is_available` is documented as "whether the balance is sufficient for API
 * calls" and is why a zero topped-up balance can still be usable: an account
 * living on granted credit reports `is_available: true` with
 * `topped_up_balance: "0.00"`. The panel shows the total, which includes that
 * credit, and reports `is_available` separately so the two are never confused.
 *
 * @param {unknown} payload
 * @returns {{ isAvailable: boolean, wallets: Wallet[] } | undefined} `undefined`
 *   when the body is not the documented shape — the caller reports a protocol
 *   error rather than rendering zeros for an account it could not read.
 */
export function normalizeBalance(payload) {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = /** @type {Record<string, unknown>} */ (payload);
  if (!Array.isArray(body.balance_infos)) return undefined;

  const wallets = body.balance_infos.map(normalizeWallet).filter((w) => w !== undefined);
  if (wallets.length === 0) return undefined;

  return { isAvailable: body.is_available === true, wallets };
}

/**
 * Choose the wallet a single-currency display should show.
 *
 * `balance_infos` is an array with no documented order and an account may hold
 * more than one currency, so "the first one" is not a decision — it is whatever
 * the server happened to send first. An explicit preference wins; `auto` prefers
 * CNY because a DeepSeek account topped up from the mainland platform is billed
 * in CNY, and falls back to the first wallet for accounts that only hold USD.
 *
 * @param {Wallet[]} wallets
 * @param {string} preference `auto`, or a currency code.
 * @returns {Wallet | undefined}
 */
export function pickWallet(wallets, preference) {
  if (wallets.length === 0) return undefined;
  const wanted = String(preference ?? "auto").trim().toUpperCase();
  if (wanted !== "" && wanted !== "AUTO") {
    return wallets.find((wallet) => wallet.currency === wanted) ?? wallets[0];
  }
  return wallets.find((wallet) => wallet.currency === "CNY") ?? wallets[0];
}

/**
 * Map a non-2xx response to a stable `code` the widget can branch on plus a
 * message a person can act on.
 *
 * The 401 body is the reason `body` is inspected at all: with no `Authorization`
 * header DeepSeek answers `text/plain` — `Authentication Fails (governor)` — so
 * parsing the error body as JSON unconditionally is itself a bug. A wrong key
 * answers a JSON envelope instead. Both mean the same thing to the user, and the
 * message says so without echoing the key or the server's request id.
 *
 * @param {number} status
 * @param {string} body
 * @returns {{ code: string, message: string }}
 */
export function describeHttpFailure(status, body) {
  const detail = extractErrorDetail(body);
  switch (status) {
    case 401:
    case 403:
      return {
        code: "unauthorized",
        message: "DeepSeek rejected the API key. Check the key configured for this profile.",
      };
    case 402:
      return { code: "insufficient-balance", message: "DeepSeek reports the balance is exhausted." };
    case 429:
      return { code: "rate-limited", message: "DeepSeek rate-limited the balance request. It will retry." };
    default:
      return {
        code: `http-${status}`,
        message: detail === undefined ? `DeepSeek answered HTTP ${status}.` : `DeepSeek answered HTTP ${status}: ${detail}`,
      };
  }
}

/**
 * Pull a short human-readable message out of an error body, tolerating the
 * plain-text one. The server's message can name the key suffix and a request id,
 * so it is truncated rather than relayed whole.
 *
 * @param {string} body
 * @returns {string | undefined}
 */
export function extractErrorDetail(body) {
  const text = typeof body === "string" ? body.trim() : "";
  if (text === "") return undefined;
  let message = text;
  try {
    const parsed = JSON.parse(text);
    const fromEnvelope = parsed?.error?.message;
    if (typeof fromEnvelope === "string" && fromEnvelope.trim() !== "") message = fromEnvelope.trim();
  } catch {
    // Not JSON: the plain-text body is already the message.
  }
  message = message.replace(/\s+/g, " ");
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
