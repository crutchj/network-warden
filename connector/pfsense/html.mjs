const ENTITY_MAP = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function decodeHtml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (entity, name) => ENTITY_MAP[name.toLowerCase()] ?? entity);
}

export function textContent(value) {
  return decodeHtml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function isLoginPage(html) {
  return /<body[^>]+id=["']login["']/i.test(html) ||
    /<input[^>]+name=["']usernamefld["']/i.test(html);
}

export function isAccessDeniedPage(html) {
  const text = textContent(html);
  return /access denied|not authorized|insufficient privileges/i.test(text);
}

export function extractCsrfToken(html) {
  const input = html.match(/<input\b[^>]*name=["']__csrf_magic["'][^>]*>/i)?.[0];
  if (!input) return null;
  return input.match(/\bvalue=["']([^"']+)["']/i)?.[1] ?? null;
}

export function extractLabelValuePairs(html) {
  const pairs = new Map();

  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((match) => textContent(match[1]))
      .filter(Boolean);
    if (cells.length >= 2) pairs.set(cells[0].replace(/:$/, ""), cells.slice(1).join(" · "));
  }

  for (const item of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const label = textContent(item[1]).replace(/:$/, "");
    const value = textContent(item[2]);
    if (label && value) pairs.set(label, value);
  }

  for (const group of html.matchAll(/<div\b[^>]*class=["'][^"']*\bform-group\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)) {
    const label = textContent(group[1].match(/<label\b[^>]*>([\s\S]*?)<\/label>/i)?.[1] ?? "").replace(/:$/, "");
    const controls = group[1].match(/<div\b[^>]*class=["'][^"']*\bcol-sm-\d+\b[^"']*["'][^>]*>([\s\S]*)/i)?.[1] ?? "";
    const value = textContent(controls);
    if (label && value) pairs.set(label, value);
  }

  return pairs;
}

function pairValue(pairs, patterns) {
  for (const [label, value] of pairs) {
    if (patterns.some((pattern) => pattern.test(label))) return value;
  }
  return null;
}

function interfaceSections(html) {
  const headings = [...html.matchAll(
    /<(?:h[1-6]|div)\b[^>]*class=["'][^"']*(?:panel-title|card-title)[^"']*["'][^>]*>([\s\S]*?)<\/(?:h[1-6]|div)>/gi,
  )];
  if (!headings.length) return [{ title: "", html }];
  return headings.map((heading, index) => ({
    title: textContent(heading[1]),
    html: html.slice(
      heading.index,
      headings[index + 1]?.index ?? html.length,
    ),
  }));
}

export function parseInterfacesPage(html) {
  const sections = interfaceSections(html);
  const interfaces = sections
    .map(({ title, html: sectionHtml }) => {
      const pairs = extractLabelValuePairs(sectionHtml);
      const name = /\bWAN\b/i.test(title)
        ? "WAN"
        : /\bLAN\b/i.test(title)
          ? "LAN"
          : title.replace(/\s+interface.*$/i, "").trim();
      return {
        name: name || "Interface",
        title,
        status: pairValue(pairs, [/^status$/i, /^link status$/i]),
        dhcpStatus: pairValue(pairs, [/^dhcp$/i, /dhcp.*status/i]),
        ipv4Address: pairValue(pairs, [/^ipv4 address$/i, /^ip address$/i]),
        ipv4Gateway: pairValue(pairs, [/ipv4.*gateway/i, /^gateway$/i]),
        media: pairValue(pairs, [/^media$/i]),
        macAddress: pairValue(pairs, [/mac.*address/i]),
      };
    })
    .filter((item) => item.title || Object.values(item).some(Boolean));

  const wan = interfaces.find((item) => item.name === "WAN") ??
    interfaces.find((item) => /\bwan\b/i.test(item.title)) ??
    null;

  return { interfaces, wan };
}

export function parseGatewaysPage(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const gateways = [];

  for (const table of tables) {
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((row) => [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map((cell) => textContent(cell[1])));
    if (rows.length < 2) continue;
    const headers = rows[0].map((header) => header.toLowerCase());
    const nameIndex = headers.findIndex((header) => /name|gateway/.test(header));
    const statusIndex = headers.findIndex((header) => /status/.test(header));
    const monitorIndex = headers.findIndex((header) => /monitor/.test(header));
    const delayIndex = headers.findIndex((header) => /delay|rtt/.test(header));
    const lossIndex = headers.findIndex((header) => /loss/.test(header));
    if (nameIndex < 0 || statusIndex < 0) continue;

    for (const cells of rows.slice(1)) {
      if (!cells[nameIndex]) continue;
      gateways.push({
        name: cells[nameIndex],
        status: cells[statusIndex] ?? "Unknown",
        monitor: monitorIndex >= 0 ? cells[monitorIndex] ?? null : null,
        delay: delayIndex >= 0 ? cells[delayIndex] ?? null : null,
        loss: lossIndex >= 0 ? cells[lossIndex] ?? null : null,
      });
    }
  }

  return gateways;
}

export function parseCpuLoadPage(html) {
  const text = textContent(html);
  const percentage = text.match(/(\d+(?:\.\d+)?)\s*%/)?.[1] ??
    text.match(/^\s*(\d+(?:\.\d+)?)\s*$/)?.[1];
  return percentage === undefined ? null : Number(percentage);
}
