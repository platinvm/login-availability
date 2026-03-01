// Utility and parsing helpers for the App

/**
 * Validate a GitHub login string.
 * Rules: 1–39 chars, alnum or hyphen, no leading/trailing hyphen.
 * @param login The candidate GitHub username or org login.
 * @returns True when the login matches GitHub constraints.
 */
export function isValidLogin(login: string) {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)
}

/**
 * Check whether the provided scope list contains the required scopes.
 * Required: `read:user` and `read:org`.
 * @param scopes OAuth scopes list from GitHub response headers.
 * @returns True if both required scopes are present.
 */
export function hasRequiredScopes(scopes: string[] | undefined | null) {
  if (!scopes) return false
  const s = new Set(scopes.map(v => v.toLowerCase()))
  return s.has("read:user") && s.has("read:org")
}

/**
 * Extract logins from a separated-value file (CSV/TSV).
 * If a header row contains one of [login|username|user], that column is used; otherwise first column is used.
 * @param text Raw CSV/TSV text.
 * @param sep Separator, typically "," or "\t".
 * @returns List of trimmed login strings (possibly empty).
 */
export function parseSeparated(text: string, sep: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(l => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const header = lines[0].split(sep).map(s => s.trim().toLowerCase())
  let idx = header.findIndex(h => h === "login" || h === "username" || h === "user")
  const start = 1
  const hasHeader = idx !== -1
  if (!hasHeader) idx = 0
  const result: string[] = []
  for (let i = hasHeader ? start : 0; i < lines.length; i++) {
    const cols = lines[i].split(sep)
    if (cols[idx] !== undefined) result.push(cols[idx].trim())
  }
  return result
}

/**
 * Extract logins from a flexible JSON structure.
 * Accepts arrays of strings or objects, or nested objects with common keys: login|username|user|entries|users|logins.
 * @param text Raw JSON string.
 * @throws When the JSON cannot be parsed.
 */
export function parseJsonLogins(text: string): string[] {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("Invalid JSON file")
  }
  const out: string[] = []
  const collect = (v: any) => {
    if (!v) return
    if (Array.isArray(v)) {
      for (const item of v) collect(item)
    } else if (typeof v === "string") {
      out.push(v)
    } else if (typeof v === "object") {
      if (typeof (v as any).login === "string") out.push((v as any).login)
      else if (typeof (v as any).username === "string") out.push((v as any).username)
      else if (typeof (v as any).user === "string") out.push((v as any).user)
      const anyV = v as any
      if (Array.isArray(anyV.entries)) collect(anyV.entries)
      if (Array.isArray(anyV.users)) collect(anyV.users)
      if (Array.isArray(anyV.logins)) collect(anyV.logins)
    }
  }
  collect(data)
  return out
}

/**
 * Extract logins from XML.
 * Supports attributes like `[login]`, text tags `<login|username|user>`,
 * and common containers `<entry|item|user name|id>`.
 * @param text Raw XML string.
 * @throws When XML parsing fails.
 */
export function parseXmlLogins(text: string): string[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, "text/xml")
  const parseErr = doc.querySelector("parsererror")
  if (parseErr) throw new Error("Invalid XML file")
  const results = new Set<string>()
  ;[...doc.querySelectorAll("*[login]")].forEach(el => {
    const v = el.getAttribute("login")?.trim()
    if (v) results.add(v)
  })
  ;["login", "username", "user"].forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => {
      const v = el.textContent?.trim()
      if (v) results.add(v)
    })
  })
  // also support <entry><login>..</login></entry>
  doc.querySelectorAll("entry, item, user").forEach(el => {
    const v = el.getAttribute("name") || el.getAttribute("id")
    if (v) results.add(v.trim())
  })
  return Array.from(results)
}

/**
 * Escape a string for XML attributes/contents.
 * @param s Input string.
 * @returns Escaped XML-safe string.
 */
export function escapeXml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
