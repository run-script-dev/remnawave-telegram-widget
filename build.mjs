// Builds worker.js:
//   src/card.js (minified) -> src/card.html -> the CARD constant in src/worker.template.js
// and fails if the card may not fit into Telegram's 4 KB limit.
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { minify } from "terser";

const texts = JSON.parse(readFileSync("src/texts.json", "utf8"));
const min = await minify(readFileSync("src/card.js", "utf8"), {
  compress: { passes: 3 },
  mangle: { toplevel: true, reserved: ["__CFG__"] },
  toplevel: true,
});
const html = readFileSync("src/card.html", "utf8").trim().replace(/\n/g, "").replace("/*CARD*/", () => min.code);

// The bot puts a config into the card when it sends it, so measure the largest one it can
// produce: 5 tariffs with the longest allowed titles, a long brand, Russian texts.
const SERVER_ONLY = ["left", "was", "copied", "copy", "sent", "mo", "daysShort", "invoice", "paid", "refunded", "stuck", "linkmsg", "caption", "error"];
const shown = Object.fromEntries(Object.entries(texts.ru).filter(([k]) => !SERVER_ONLY.includes(k)));
const worst = {
  n: "Очень Длинное Название Сервиса VPN",
  a: "Happ",
  r: "https://t.me/example_bot?start=renew",
  h: "https://t.me/example_support",
  z: "https://t.me/PremiumBot",
  c: "#5B8CFF",
  t: [1, 2, 3, 4, 5].map((i) => ({ title: i * 3 + " месяцев подписки", price: i * 199 + " ★" })),
  p: true,
  s: shown,
};
const sample = html.replace("__CFG__", () => JSON.stringify(worst));
const packed = deflateSync(sample, { level: 9 }).length;
console.log(`card, worst case: ${Buffer.byteLength(sample)} / 32768 bytes, packed ${packed} / 4096 bytes`);
if (packed > 3990) {
  console.error("Too close to Telegram's limit. Make the card smaller.");
  process.exit(1);
}

const worker = readFileSync("src/worker.template.js", "utf8")
  .replace("__CARD__", () => JSON.stringify(html))
  .replace("__TEXTS__", () => JSON.stringify(texts, null, 2));
writeFileSync("worker.js", worker);
console.log("worker.js is ready");
