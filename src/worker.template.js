/**
 * Remnawave subscription card: a Telegram Widget that shows a VPN client
 * their subscription right in the chat with the bot.
 * Telegram Widgets (Bot API 10.4) + Remnawave API 3.x + Cloudflare Workers.
 *
 * Without payments the Worker only reads the panel. With payments on (see below) it
 * extends subscriptions and creates new clients after a confirmed Telegram Stars payment.
 *
 * Try it without a panel: set BOT_TOKEN and DEMO=1. The card then shows a made-up
 * subscription to anyone, and "payments" only move the date on the card. Nothing is charged.
 *
 * Secrets (Settings -> Variables and Secrets):
 *   BOT_TOKEN      token from @BotFather
 *   PANEL_URL      https://panel.example.com
 *   PANEL_TOKEN    API token from the panel (Settings -> API Tokens)
 * Optional:
 *   PANEL_COOKIE   "name=value" if the panel sits behind a cookie-protected reverse proxy
 *   PANEL_API_KEY  X-Api-Key value if the panel sits behind Caddy with an API key
 *   BRAND          service name shown on the card (default "VPN")
 *   ACCENT         accent color of the card as #RRGGBB (default #5B8CFF)
 *   RENEW_URL      link opened by the "Pay" button (your shop bot or payment page)
 *   SUPPORT_URL    link opened by the "Support" button
 *   TARIFFS        JSON list shown on the "Renew" tab: [{"title":"1 month","price":"199 ₽"}]
 *
 * Payments with Telegram Stars (optional). They turn on when both are true:
 *   - a D1 database is bound to this Worker as DB (orders are stored there);
 *   - TARIFFS entries have "days" and "stars": [{"title":"1 month","days":30,"stars":150}]
 * The panel token then needs permission to update and create users.
 * Defaults for clients who buy for the first time:
 *   NEW_USER_SQUADS      internal squad UUIDs, comma separated (default: the only squad, if there is exactly one)
 *   NEW_USER_TRAFFIC_GB  monthly traffic limit in GB (default 0 = unlimited)
 *   NEW_USER_DEVICES     device limit (default: the panel's default)
 * If a paid order cannot be delivered, the Stars are refunded automatically.
 *   STARS_URL            where the "No Stars?" button leads (default https://t.me/PremiumBot, Telegram's own
 *                        bot that sells Stars; set to "off" to hide the button)
 * The card opens Telegram's payment window itself. Set INVOICE_AS_MESSAGE to 1 to send
 * the invoice as a chat message instead (use it if the payment window does not open).
 *   APP_NAME       client app named in the instructions (default "Happ")
 *   CARD_LANG      "ru" or "en" to force a language (default: the user's Telegram language)
 *   BEHIND_ROUTER  set to 1 when another Worker owns this bot's webhook and forwards
 *                  updates here through a service binding; /setup then leaves the webhook alone
 *
 * Then open https://<your-worker>.workers.dev/setup once and send /start to the bot.
 */

// The card itself: one HTML document. Built from src/card.html + src/card.js.
const CARD = __CARD__;

// Interface texts, from src/texts.json.
const TEXTS = __TEXTS__;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const missing = (env.DEMO ? ["BOT_TOKEN"] : ["BOT_TOKEN", "PANEL_URL", "PANEL_TOKEN"]).filter((k) => !env[k]);
    if (missing.length) {
      return text("Add these in Settings -> Variables and Secrets, then open /setup: " + missing.join(", "));
    }
    const secret = await hookSecret(env.BOT_TOKEN);

    if (url.pathname === "/setup") return setup(url, env, secret);

    if (url.pathname === "/hook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handle(update, env).catch((e) => console.error("handler", e)));
      return text("ok");
    }
    return text("The bot is running. Open /setup once after adding the secrets.");
  },
};

function text(body) {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function hookSecret(token) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hook:" + token));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

// -------------------------------------------------------------- telegram ---
async function tg(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const json = await res.json().catch(() => ({ ok: false, description: "bad response" }));
  if (!json.ok && !/not modified/.test(json.description || "")) console.error(method, json.description);
  return json;
}

// ------------------------------------------------------------- remnawave ---
// Client for the Remnawave 3.x API. GET by default, POST when a body is passed.
async function panel(env, path, body) {
  let base = env.PANEL_URL.trim().replace(/\/+$/, "").replace(/\/api$/, "");
  if (!/^https?:\/\//.test(base)) base = "https://" + base;
  const headers = { authorization: "Bearer " + env.PANEL_TOKEN.trim(), accept: "application/json" };
  if (env.PANEL_COOKIE) headers.cookie = env.PANEL_COOKIE.trim();
  if (env.PANEL_API_KEY) headers["x-api-key"] = env.PANEL_API_KEY.trim();
  const init = { headers };
  if (body) {
    init.method = "POST";
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(base + "/api" + path, init);
  const raw = await res.text();
  if (!res.ok) throw new Error(`panel ${res.status} on ${path.split("?")[0]}: ${raw.slice(0, 160) || "empty answer"}`);
  if (!raw) return {};
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`panel answered with something that is not JSON on ${path.split("?")[0]} (a login page or a proxy?)`);
  }
  return json && json.response !== undefined ? json.response : json;
}

// Remnawave 3.x has no "by telegram id" route: list users with a filter instead.
async function findUser(env, telegramId) {
  const filters = encodeURIComponent(JSON.stringify([{ id: "telegramId", value: String(telegramId) }]));
  const page = await panel(env, `/users?start=0&size=25&filters=${filters}`);
  const users = (page.users || []).filter((u) => String(u.telegramId) === String(telegramId));
  // One person may have several subscriptions: show the one that lasts longest.
  users.sort((a, b) => new Date(b.expireAt) - new Date(a.expireAt));
  return users[0] || null;
}

async function deviceCount(env, userId) {
  try {
    const r = await panel(env, `/hwid/devices/${userId}`);
    if (typeof r.total === "number") return r.total;
    if (Array.isArray(r.devices)) return r.devices.length;
    if (Array.isArray(r)) return r.length;
  } catch (e) {
    // HWID limits may be off or the token may lack access: the card just hides the cell.
  }
  return null;
}

// The dynamic part of the card. Kept short: Telegram allows 1024 bytes.
async function cardData(env, telegramId, lang) {
  if (env.DEMO) return demoData(env, 0);
  const user = await findUser(env, telegramId);
  // Payment links travel with the state, not with the code: the code has a 4 KB limit.
  const v = paymentsOn(env) && !env.INVOICE_AS_MESSAGE ? await invoiceLinks(env, tariffs(env), lang || "en") : [];
  if (!user) return v.length ? { x: 1, v } : { x: 1 };
  const traffic = user.userTraffic || {};
  const limit = Number(user.hwidDeviceLimit) || 0;
  return {
    s: user.status,
    e: Math.floor(new Date(user.expireAt).getTime() / 1000),
    u: Number(traffic.usedTrafficBytes ?? user.usedTrafficBytes ?? 0),
    l: Number(user.trafficLimitBytes) || 0,
    d: await deviceCount(env, user.id ?? user.uuid),
    dl: limit,
    k: user.subscriptionUrl || "",
    ...(v.length ? { v } : {}),
  };
}

// ------------------------------------------------------------------ card ---
function language(env, user) {
  const forced = (env.CARD_LANG || "").toLowerCase();
  if (TEXTS[forced]) return forced;
  return /^(ru|uk|be|kk)/.test((user && user.language_code) || "") ? "ru" : "en";
}

// ------------------------------------------------------------------ demo ---
// DEMO=1: no panel and no real payments. Everyone sees the same made-up subscription,
// and "buying" a tariff only moves the date on the card.
const DEMO_TARIFFS = '[{"title":"1 month","days":30,"stars":150},{"title":"3 months","days":90,"stars":390},{"title":"12 months","days":365,"stars":1290}]';

function demoData(env, extraDays) {
  return {
    s: "ACTIVE",
    e: Math.floor(Date.now() / 1000) + (12 + extraDays) * 86400 - 600,
    u: 41231686041,
    l: 107374182400,
    d: 2,
    dl: 3,
    k: link(env.DEMO_URL) || "https://github.com/run-script-dev/remnawave-telegram-widget",
  };
}

async function demoQuery(query, env) {
  const m = /^b(\d)$/.exec(query.data || "");
  const tariff = m && tariffs(env)[Number(m[1])];
  if (!tariff) return tg(env, "answerWidgetQuery", { widget_query_id: query.id, data: "{}" }); // keep the card as it is
  if (query.chat && query.message_id) {
    await tg(env, "editMessageWidgetData", {
      chat_id: query.chat.id,
      message_id: query.message_id,
      chat_data: JSON.stringify(demoData(env, tariff.days)),
    });
  }
  return tg(env, "answerWidgetQuery", { widget_query_id: query.id, data: "2" });
}

// A tariff is buyable when it has whole positive "days" and "stars".
function tariffs(env) {
  try {
    const list = JSON.parse(env.TARIFFS || (env.DEMO ? DEMO_TARIFFS : "[]"));
    return list.filter((t) => t && t.title).slice(0, 5).map((t) => {
      const days = Number(t.days), stars = Number(t.stars);
      const buy = Number.isInteger(days) && days > 0 && days <= 9999 && Number.isInteger(stars) && stars > 0;
      // Titles and prices are cut short: the card's code has a hard size limit.
      return { title: String(t.title).slice(0, 24), price: buy ? stars + " ★" : String(t.price || "").slice(0, 12), days: buy ? days : 0, stars: buy ? stars : 0 };
    });
  } catch (e) {
    return [];
  }
}

// Payments need the orders database and at least one buyable tariff; then every tariff must be buyable.
function paymentsOn(env) {
  const list = tariffs(env);
  return Boolean(env.DB || env.DEMO) && list.length > 0 && list.every((t) => t.stars > 0);
}

function link(value) {
  return /^https:\/\//.test(value || "") ? value : "";
}

// Only the texts the card itself shows travel inside the widget: its size is limited.
const SERVER_ONLY = ["left", "was", "copied", "copy", "sent", "mo", "daysShort", "invoice", "paid", "refunded", "stuck", "linkmsg", "caption", "error"];
function cardTexts(lang) {
  const out = {};
  for (const k of Object.keys(TEXTS[lang])) if (!SERVER_ONLY.includes(k)) out[k] = TEXTS[lang][k];
  return out;
}

async function cardHtml(env, lang) {
  const pay = paymentsOn(env);
  const list = tariffs(env);
  const config = {
    n: (env.BRAND || "VPN").slice(0, 32),
    a: (env.APP_NAME || "Happ").slice(0, 24),
    r: link(env.RENEW_URL),
    h: link(env.SUPPORT_URL),
    z: link(env.STARS_URL === undefined ? "https://t.me/PremiumBot" : env.STARS_URL),
    c: /^#[0-9a-f]{6}$/i.test(env.ACCENT || "") ? env.ACCENT : "",
    t: list.map((t) => ({ title: t.title, price: t.price })),
    p: pay,
    s: cardTexts(lang),
  };
  // "<" is escaped so that no config value can close the script tag.
  return CARD.replace("__CFG__", () => JSON.stringify(config).replace(/</g, "\\u003c"));
}

// -------------------------------------------------------------- handlers ---
async function handle(update, env) {
  if (env.DEMO && (update.pre_checkout_query || (update.message && update.message.successful_payment))) return;
  if (update.pre_checkout_query) return onPreCheckout(update.pre_checkout_query, env);
  if (update.message && update.message.successful_payment) return onPaid(update.message, env);
  if (update.message && update.message.refunded_payment) return;
  if (update.message) return onMessage(update.message, env);
  const query = update.widget_query || update.shared_widget_query;
  if (query) return onQuery(query, env);
}

async function onMessage(msg, env) {
  if (msg.chat.type !== "private") return; // widgets work only in private chats for now
  const lang = language(env, msg.from);
  let data;
  try {
    data = await cardData(env, msg.from.id, lang);
  } catch (e) {
    console.error("panel", e.message);
    return tg(env, "sendMessage", { chat_id: msg.chat.id, text: TEXTS[lang].error });
  }
  const sent = await tg(env, "sendWidget", {
    chat_id: msg.chat.id,
    html: await cardHtml(env, lang),
    allow_queries: true,
    chat_data: JSON.stringify(data),
    width: 360,
    caption: (env.BRAND ? env.BRAND + ". " : "") + TEXTS[lang].caption,
  });
  if (sent.ok && !env.DEMO) await rememberCard(env, msg.from.id, msg.chat.id, sent.result.message_id);
  return sent;
}

// Requests from the card. The user is always taken from Telegram's authenticated
// `from`, never from data sent by the widget.
//   "r": fresh numbers (sent when the card appears)
//   "k": send me my subscription link
//   "b<n>": I want to buy tariff number n (no colon: "name:number" is reserved for game scores)
async function onQuery(query, env) {
  if (env.DEMO) return demoQuery(query, env);
  if (query.data === "k") return sendLink(query, env);
  if (/^b\d$/.test(query.data || "")) return startOrder(query, env);
  let answer = "{}";
  try {
    const data = await cardData(env, query.from.id, language(env, query.from));
    answer = JSON.stringify(data);
    if (query.chat && query.message_id) {
      await rememberCard(env, query.from.id, query.chat.id, query.message_id);
      await tg(env, "editMessageWidgetData", {
        chat_id: query.chat.id,
        message_id: query.message_id,
        chat_data: answer,
      });
    }
  } catch (e) {
    console.error("query", e.message);
  }
  return tg(env, "answerWidgetQuery", { widget_query_id: query.id, data: answer });
}

// Widget messages are protected: Telegram does not let users copy anything out of them.
// So the link goes out as an ordinary message, where one tap on it copies it.
async function sendLink(query, env) {
  let ok = false;
  try {
    const user = await findUser(env, query.from.id);
    if (user && user.subscriptionUrl) {
      const safe = user.subscriptionUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const sent = await tg(env, "sendMessage", {
        chat_id: query.from.id,
        text: TEXTS[language(env, query.from)].linkmsg + "\n\n<code>" + safe + "</code>",
        parse_mode: "HTML",
      });
      ok = sent.ok;
    }
  } catch (e) {
    console.error("link", e.message);
  }
  return tg(env, "answerWidgetQuery", { widget_query_id: query.id, data: ok ? "1" : "0" });
}

// -------------------------------------------------------------- payments ---
// Telegram Stars. Two ways to show the invoice:
//   - link mode (default): the card opens Telegram's payment window itself, no chat messages;
//   - message mode (INVOICE_AS_MESSAGE=1): the bot sends the invoice as a message.
// Either way:
//   1. Telegram asks "can I charge?" and the bot checks the tariff and price (pre_checkout_query);
//   2. Telegram reports the payment and the bot extends or creates the client in the panel;
//   3. the card the client is looking at gets the new date;
//   4. if step 2 fails, the Stars are refunded.
let tablesReady = false;
async function tables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    // One row per payment. In link mode the id is Telegram's charge id, so a payment
    // delivered twice cannot be stored (and delivered) twice.
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS vpn_orders (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, days INTEGER NOT NULL, " +
        "stars INTEGER NOT NULL, chat_id INTEGER, message_id INTEGER, status TEXT NOT NULL, charge_id TEXT, created INTEGER NOT NULL)"
    ),
    // The last card each user opened: this is the one to refresh after a payment.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS vpn_cards (user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL)"),
    // Reusable invoice links, one per tariff and language.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS vpn_links (key TEXT PRIMARY KEY, url TEXT NOT NULL)"),
  ]);
  tablesReady = true;
}

async function rememberCard(env, userId, chatId, messageId) {
  if (!env.DB) return;
  try {
    await tables(env);
    await env.DB.prepare(
      "INSERT INTO vpn_cards (user_id, chat_id, message_id) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id"
    ).bind(userId, chatId, messageId).run();
  } catch (e) {
    console.error("card", e.message);
  }
}

function invoice(env, tariff, lang, payload) {
  return {
    title: ((env.BRAND ? env.BRAND + ": " : "") + tariff.title).slice(0, 32),
    description: TEXTS[lang].invoice.replace("{days}", tariff.days),
    payload,
    currency: "XTR", // Telegram Stars
    prices: [{ label: tariff.title.slice(0, 32), amount: tariff.stars }],
  };
}

// A link invoice is not tied to a user: its payload just names the tariff ("t|days|stars").
// Links are created once and kept; a changed tariff gets a new link.
async function invoiceLinks(env, list, lang) {
  const links = [];
  try {
    await tables(env);
    for (const t of list) {
      const key = [lang, env.BRAND || "", t.title, t.days, t.stars].join("|");
      let row = await env.DB.prepare("SELECT url FROM vpn_links WHERE key = ?1").bind(key).first();
      if (!row) {
        const made = await tg(env, "createInvoiceLink", invoice(env, t, lang, `t|${t.days}|${t.stars}`));
        if (!made.ok) return []; // the card falls back to invoice messages
        row = { url: made.result };
        await env.DB.prepare("INSERT OR REPLACE INTO vpn_links (key, url) VALUES (?1, ?2)").bind(key, row.url).run();
      }
      links.push(row.url.replace(/^https:\/\/t\.me\/\$/, ""));
    }
  } catch (e) {
    console.error("links", e.message);
    return [];
  }
  return links;
}

// Message mode: the card asked for an invoice for tariff number n.
async function startOrder(query, env) {
  let ok = false;
  try {
    const tariff = tariffs(env)[Number(query.data.slice(1))];
    if (paymentsOn(env) && tariff) {
      const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
      await tables(env);
      await env.DB.prepare(
        "INSERT INTO vpn_orders (id, user_id, days, stars, chat_id, message_id, status, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7)"
      ).bind(id, query.from.id, tariff.days, tariff.stars, query.chat ? query.chat.id : null, query.message_id || null, Math.floor(Date.now() / 1000)).run();
      const sent = await tg(env, "sendInvoice", { chat_id: query.from.id, ...invoice(env, tariff, language(env, query.from), id) });
      ok = sent.ok;
    }
  } catch (e) {
    console.error("order", e.message);
  }
  return tg(env, "answerWidgetQuery", { widget_query_id: query.id, data: ok ? "1" : "0" });
}

// "t|30|150" -> the current tariff with exactly these days and price, or null.
function linkTariff(env, payload) {
  const m = /^t\|(\d+)\|(\d+)$/.exec(payload || "");
  if (!m || !paymentsOn(env)) return null;
  return tariffs(env).find((t) => t.days === Number(m[1]) && t.stars === Number(m[2])) || null;
}

// Must be answered within 10 seconds. Approve only what is on sale right now, at its price.
async function onPreCheckout(q, env) {
  let ok = false;
  try {
    const tariff = linkTariff(env, q.invoice_payload);
    if (tariff) {
      ok = q.currency === "XTR" && q.total_amount === tariff.stars;
    } else {
      await tables(env);
      const order = await env.DB.prepare("SELECT * FROM vpn_orders WHERE id = ?1").bind(q.invoice_payload).first();
      ok = Boolean(order) && order.status === "new" && order.user_id === q.from.id && q.currency === "XTR" && order.stars === q.total_amount;
    }
  } catch (e) {
    console.error("pre-checkout", e.message);
  }
  return tg(env, "answerPreCheckoutQuery", ok
    ? { pre_checkout_query_id: q.id, ok: true }
    : { pre_checkout_query_id: q.id, ok: false, error_message: TEXTS[language(env, q.from)].fail });
}

async function onPaid(msg, env) {
  const pay = msg.successful_payment;
  const texts = TEXTS[language(env, msg.from)];
  const charge = pay.telegram_payment_charge_id;
  await tables(env);

  // Claim the payment exactly once, even if Telegram delivers this update twice.
  let id, days;
  const tariff = linkTariff(env, pay.invoice_payload);
  if (/^t\|/.test(pay.invoice_payload || "")) {
    id = charge;
    days = tariff ? tariff.days : Number(pay.invoice_payload.split("|")[1]); // paid is paid, even if the tariff just changed
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO vpn_orders (id, user_id, days, stars, status, charge_id, created) VALUES (?1, ?2, ?3, ?4, 'paid', ?1, ?5)"
    ).bind(id, msg.from.id, days, pay.total_amount, Math.floor(Date.now() / 1000)).run();
    if (!claim.meta || claim.meta.changes !== 1) return;
  } else {
    id = pay.invoice_payload;
    const claim = await env.DB.prepare("UPDATE vpn_orders SET status = 'paid', charge_id = ?2 WHERE id = ?1 AND status = 'new'")
      .bind(id, charge).run();
    if (!claim.meta || claim.meta.changes !== 1) return;
    days = (await env.DB.prepare("SELECT days FROM vpn_orders WHERE id = ?1").bind(id).first()).days;
  }

  try {
    const user = await deliver(env, msg.from.id, days);
    await env.DB.prepare("UPDATE vpn_orders SET status = 'done' WHERE id = ?1").bind(id).run();
    // Show the result in the card the client has open. No extra chat message when that works.
    const card = await env.DB.prepare("SELECT chat_id, message_id FROM vpn_cards WHERE user_id = ?1").bind(msg.from.id).first();
    let shown = false;
    if (card) {
      const edit = await tg(env, "editMessageWidgetData", {
        chat_id: card.chat_id,
        message_id: card.message_id,
        chat_data: JSON.stringify(await cardData(env, msg.from.id, language(env, msg.from))),
      });
      shown = edit.ok;
    }
    if (!shown) {
      const until = new Date(user.expireAt);
      const date = until.getUTCDate() + " " + texts.mo[until.getUTCMonth()] + " " + until.getUTCFullYear();
      await tg(env, "sendMessage", { chat_id: msg.chat.id, text: texts.paid.replace("{date}", date) });
    }
  } catch (e) {
    console.error("deliver", id, e.message);
    const refund = await tg(env, "refundStarPayment", { user_id: msg.from.id, telegram_payment_charge_id: charge });
    await env.DB.prepare("UPDATE vpn_orders SET status = ?2 WHERE id = ?1").bind(id, refund.ok ? "refunded" : "failed").run();
    await tg(env, "sendMessage", { chat_id: msg.chat.id, text: refund.ok ? texts.refunded : texts.stuck.replace("{id}", id) });
  }
}

// Gives the client `days` of service: extends an existing user or creates a new one.
async function deliver(env, telegramId, days) {
  const user = await findUser(env, telegramId);
  if (user) {
    // Remnawave: an EXPIRED user restarts from today and becomes ACTIVE, others get days added.
    const updated = await panel(env, `/users/${user.id}/actions/extend`, { days });
    return updated && updated.expireAt ? updated : await findUser(env, telegramId);
  }
  const gb = Number(env.NEW_USER_TRAFFIC_GB) || 0;
  const devices = Number(env.NEW_USER_DEVICES) || 0;
  const body = {
    username: "tg_" + telegramId,
    telegramId: Number(telegramId),
    status: "ACTIVE",
    expireAt: new Date(Date.now() + days * 86400000).toISOString(),
    trafficLimitBytes: Math.round(gb * 1073741824),
    trafficLimitStrategy: gb > 0 ? "MONTH" : "NO_RESET",
    activeInternalSquads: await newUserSquads(env),
    description: "Created by the Telegram bot",
  };
  if (devices > 0) body.hwidDeviceLimit = devices;
  const created = await panel(env, "/users", body);
  if (!created || !created.expireAt) throw new Error("the panel did not return the new user");
  return created;
}

async function newUserSquads(env) {
  const set = (env.NEW_USER_SQUADS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (set.length) return set;
  const r = await panel(env, "/internal-squads");
  const list = r.internalSquads || r.squads || (Array.isArray(r) ? r : []);
  if (list.length !== 1) throw new Error(`set NEW_USER_SQUADS: the panel has ${list.length} internal squads`);
  return [list[0].uuid];
}

// ----------------------------------------------------------------- setup ---
// Panel check for the setup page. Prints field NAMES only, never user data.
async function panelCheck(env) {
  const lines = [];
  try {
    const page = await panel(env, "/users?start=0&size=1");
    const user = (page.users || [])[0];
    lines.push("Panel: ok, users in panel: " + (page.total ?? (page.users || []).length));
    if (user) {
      const need = ["id", "status", "expireAt", "telegramId", "subscriptionUrl", "trafficLimitBytes", "hwidDeviceLimit"];
      const lost = need.filter((k) => !(k in user));
      const used = (user.userTraffic && "usedTrafficBytes" in user.userTraffic) || "usedTrafficBytes" in user;
      if (!used) lost.push("usedTrafficBytes");
      lines.push("Panel fields: " + (lost.length ? "MISSING " + lost.join(", ") + " (send this line to the developer)" : "ok"));
    } else {
      lines.push("Panel fields: no users yet, nothing to check");
    }
  } catch (e) {
    lines.push("Panel: FAILED: " + e.message);
  }

  return lines;
}

async function paymentsCheck(env) {
  const list = tariffs(env);
  const buyable = list.filter((t) => t.stars > 0).length;
  if (!buyable) return ['Stars payments: off (add "days" and "stars" to TARIFFS)'];
  if (buyable < list.length) return ['Stars payments: off (every TARIFFS entry needs "days" and "stars")'];
  if (!env.DB) return ["Stars payments: off (bind a D1 database to this Worker as DB)"];
  const lines = [];
  try {
    await tables(env);
    lines.push("Stars payments: on (" + (env.INVOICE_AS_MESSAGE ? "invoice as a message" : "payment window opens from the card") + "), " + list.map((t) => `${t.title} = ${t.days} days for ${t.stars} Stars`).join("; "));
  } catch (e) {
    return ["Stars payments: FAILED: orders database: " + e.message];
  }
  try {
    const squads = await newUserSquads(env);
    lines.push("New clients: will be created in " + squads.length + " internal squad(s)");
  } catch (e) {
    lines.push("New clients: CANNOT be created: " + e.message.replace(/^set /, "set ") + " (renewals still work)");
  }
  return lines;
}

async function setup(url, env, secret) {
  const lines = [];
  const routed = Boolean(env.BEHIND_ROUTER);
  if (routed) {
    lines.push("Webhook: owned by the router Worker (BEHIND_ROUTER is set)");
  } else {
    const hook = await tg(env, "setWebhook", {
      url: url.origin + "/hook",
      secret_token: secret,
      allowed_updates: ["message", "widget_query", "shared_widget_query", "pre_checkout_query"],
    });
    lines.push("Webhook: " + (hook.ok ? "ok" : "FAILED: " + hook.description));
    await tg(env, "setMyCommands", { commands: [{ command: "start", description: TEXTS.en.caption }] });
  }

  if (env.DEMO) {
    lines.push("Demo mode: on (no panel, a made-up subscription for everyone, nothing is charged)");
  } else {
    lines.push(...(await panelCheck(env)));
    lines.push("Renew tab: " + (tariffs(env).length || link(env.RENEW_URL) ? "on" : "off (set TARIFFS and RENEW_URL to show it)"));
    lines.push(...(await paymentsCheck(env)));
  }
  const me = await tg(env, "getMe");
  if (!me.ok) lines.push("Bot token: FAILED: " + me.description);
  else if (!routed) lines.push("Now open https://t.me/" + me.result.username + " and send /start");
  return text(lines.join("\n"));
}
