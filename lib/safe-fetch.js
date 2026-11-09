// Outbound page fetch restricted to public HTTP(S) endpoints.
// DNS addresses are validated at connection time to prevent DNS rebinding.
import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";

function publicIp(address) {
  if (!isIP(address)) return false;
  if (address.includes(":")) {
    const ip = address.toLowerCase();
    if (ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") ||
        /^fe[89ab]/.test(ip) || ip.startsWith("ff") || ip.startsWith("2001:db8:") ||
        ip.startsWith("2001:0db8:") || ip.startsWith("::ffff:")) return false;
    return true;
  }
  const a = address.split(".").map(Number);
  const [x, y, z] = a;
  return !(x === 0 || x === 10 || x === 127 || x >= 224 ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && (y === 168 || (y === 0 && (z === 0 || z === 2)))) ||
    (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) ||
    (x === 203 && y === 0 && z === 113) ||
    (x === 192 && y === 88 && z === 99));
}

export function validatePageUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      !url.hostname || url.hostname.endsWith(".local") || url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") || (isIP(url.hostname) && !publicIp(url.hostname))) {
    throw new Error("Unsafe page URL");
  }
  return url;
}

export async function fetchPublicText(raw, maxBytes = 512 * 1024) {
  const url = validatePageUrl(raw);
  const dispatcher = new Agent({
    connect: {
      lookup(host, options, callback) {
        lookup(host, options, (error, address, family) => {
          if (error) return callback(error);
          if (Array.isArray(address)) {
            if (!address.length || address.some((entry) => !publicIp(entry.address))) {
              return callback(new Error("Private DNS address blocked"));
            }
            return callback(null, address, family);
          }
          if (!publicIp(address)) return callback(new Error("Private DNS address blocked"));
          callback(null, address, family);
        });
      },
    },
  });
  try {
    const response = await fetch(url, {
      dispatcher,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "MorganResearch/1.0", Accept: "text/html,text/plain" },
    });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !/text\/(html|plain)/i.test(type)) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("Page too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  } finally {
    await dispatcher.close();
  }
}
