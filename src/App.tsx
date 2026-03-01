import { ThemeProvider } from "@/components/theme-provider"
import { ModeToggle } from "@/components/mode-toggle"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Toaster } from "@/components/ui/sonner"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Check, CircleDashed, CircleHelp, Download, PlugZap, ShieldCheck, Trash2, Upload, User, Users, AlertTriangle } from "lucide-react"
import { getStatusesFromLogins, validateGitHubToken } from "@/lib/github"
import { hasRequiredScopes, isValidLogin, parseSeparated, parseJsonLogins, parseXmlLogins, escapeXml } from "@/lib/helpers"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import logo from "./assets/logo.svg"
import logoDark from "./assets/logo-dark.svg"

/**
 * GitHub Login Availability Checker UI
 * - Manages an in-browser list of GitHub logins and their availability status.
 * - Uses GraphQL to check if a login exists (User/Organization) or is available.
 * - Persists entries and token in `localStorage` for convenience.
 * - Import/Export helpers live in `src/lib` to keep UI lean.
 *
 * Key UX:
 * - Add logins manually or import from CSV/TSV/JSON/XML
 * - Validate token and scopes (read:user, read:org)
 * - Debounced token validation and guarded checking actions
 */

/**
 * Status states for a login within the app.
 * - unchecked: not yet checked against GitHub
 * - available: not found, can be registered
 * - user/organization: taken by a User/Organization respectively
 * - invalid: fails local format validation, will not be checked
 * - error: unexpected error state after a check
 */
type Status = "unchecked" | "available" | "user" | "organization" | "error" | "invalid"

/** A single entry in the in-memory list. */
type Entry = {
  login: string
  status: Status
  error?: string
}

/** localStorage key for the GitHub token */
const TOKEN_KEY = "gh_token"
/** localStorage key for the entries list */
const ENTRIES_KEY = "gh_entries"

/** Root application component. */
function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) || "")
  const [tokenValid, setTokenValid] = useState<null | { valid: boolean; scopes: string[] }>(null)
  const [savingToken, setSavingToken] = useState(false)
  const [tokenPopoverOpen, setTokenPopoverOpen] = useState(false)

  const [input, setInput] = useState("")
  const [entries, setEntries] = useState<Entry[]>(() => {
    try {
      const raw = localStorage.getItem(ENTRIES_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as Entry[]
      // Ensure shape
      return parsed.map(e => ({ login: e.login, status: e.status ?? "unchecked" as Status, error: e.error }))
    } catch {
      return []
    }
  })

  const [checking, setChecking] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingImportType, setPendingImportType] = useState<null | "csv" | "tsv" | "json" | "xml">(null)

  // using helpers from src/lib/helpers for validation & parsing

  // Persist entries whenever list changes
  useEffect(() => {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries))
  }, [entries])

  // If token exists, validate on mount (debounced on change)
  useEffect(() => {
    let ignore = false
    const id = setTimeout(async () => {
      if (!token) {
        setTokenValid(null)
        return
      }
      try {
        const res = await validateGitHubToken(token)
        if (!ignore) setTokenValid(res)
      } catch {
        if (!ignore) setTokenValid({ valid: false, scopes: [] })
      }
    }, 300)
    return () => {
      ignore = true
      clearTimeout(id)
    }
  }, [token])

  /** List of logins pending a check. */
  const unchecked = useMemo(() => entries.filter(e => e.status === "unchecked").map(e => e.login), [entries])

  // hasRequiredScopes moved to helpers

  /** Persist current token to localStorage and show a toast. */
  function saveToken() {
    setSavingToken(true)
    try {
      localStorage.setItem(TOKEN_KEY, token.trim())
      showToast("success", "Token saved", { description: "Stored locally in your browser." })
    } finally {
      setTimeout(() => setSavingToken(false), 200)
    }
  }

  /**
   * Parse the freeform input box and append unique logins.
   * Performs local format validation to mark invalid immediately.
   */
  function addLoginsFromInput() {
    const raw = input.trim()
    if (!raw) return
    if (!token) {
      setTokenPopoverOpen(true)
      showToast("default", "GitHub token required", {
        description: "Please add a token with read:user and read:org.",
      })
      return
    }
    // allow comma separated; treat newlines as commas for convenience
    const parts = raw
      .replace(/\n+/g, ",")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
    if (!parts.length) return

    setEntries(prev => {
      const existing = new Set(prev.map(p => p.login.toLowerCase()))
      const next: Entry[] = [...prev]
      for (const p of parts) {
        const login = p
        if (!existing.has(login.toLowerCase())) {
          // Mark invalid immediately on insert so users get instant feedback
          next.push({ login, status: isValidLogin(login) ? "unchecked" : "invalid" })
          existing.add(login.toLowerCase())
        }
      }
      return next
    })
    setInput("")
  }

  /** Remove an entry by exact login. */
  function removeEntry(login: string) {
    setEntries(prev => prev.filter(e => e.login !== login))
  }

  /** Remove all entries. */
  function clearAll() {
    setEntries([])
  }

  /**
   * Check all currently-unchanged logins against GitHub GraphQL API.
   * Requires a token with read:user and read:org.
   */
  async function checkUnchecked() {
    const toCheck = unchecked
    if (!token) {
      setTokenPopoverOpen(true)
      showToast("default", "Please set a GitHub token first.")
      return
    }
    if (!(tokenValid?.valid && hasRequiredScopes(tokenValid.scopes))) {
      setTokenPopoverOpen(true)
      showToast("default", "Token missing required scopes: read:user, read:org")
      return
    }
    if (!toCheck.length) {
      showToast("default", "Nothing to check. Add usernames above.")
      return
    }
    // Flip loading state first and yield so the UI can update
    setChecking(true)
    showToast("default", "Checking...")
    // Yield to the browser to avoid perceived freeze on large lists
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    // Pre-validate locally and mark invalid before hitting GraphQL
    const invalid = toCheck.filter(l => !isValidLogin(l))
    const valid = toCheck.filter(l => isValidLogin(l))
    if (invalid.length) {
      setEntries(prev => prev.map(e => invalid.includes(e.login) ? { ...e, status: "invalid" } : e))
    }
    if (!valid.length) {
      showToast("default", "No valid usernames to check.")
      setChecking(false)
      return
    }
    try {
      const { logins, rateLimit } = await getStatusesFromLogins(token, valid)
      setEntries(prev =>
        prev.map(e =>
          valid.includes(e.login)
            ? { login: e.login, status: (logins[e.login] as Status) ?? "error" }
            : e
        )
      )
      const until = rateLimit.resetAt instanceof Date ? rateLimit.resetAt : new Date(rateLimit.resetAt as unknown as string)
      const formatted = isNaN(until.getTime()) ? "unknown" : until.toLocaleString()
      const msg = `Done. Rate limit: ${rateLimit.remaining}/${rateLimit.limit} left until ${formatted}`
      showToast("success", "Checked usernames", { description: msg })
    } catch (err) {
      showToast("error", "Check failed", { description: (err as Error).message || "Unknown error" })
      // mark them as error to avoid re-hitting immediately; keep as unchecked? Spec says only check "unchecked".
      // We'll keep them unchecked so user can retry.
    } finally {
      setChecking(false)
    }
  }

  /** Reset all entries to the unchecked state. */
  function resetStatuses() {
    setEntries(prev => prev.map(e => ({ ...e, status: "unchecked", error: undefined })))
  }

  /** Append unique logins to the list, marking invalid locally when needed. */
  function addLogins(logins: string[]) {
    if (!logins?.length) return
    setEntries(prev => {
      const existing = new Set(prev.map(p => p.login.toLowerCase()))
      const next: Entry[] = [...prev]
      for (const raw of logins) {
        const login = String(raw || "").trim()
        if (!login) continue
        if (!existing.has(login.toLowerCase())) {
          // Validate on import/insert as well
          next.push({ login, status: isValidLogin(login) ? "unchecked" : "invalid" })
          existing.add(login.toLowerCase())
        }
      }
      return next
    })
  }

  /** Export current entries as CSV/TSV/JSON/XML and trigger a download. */
  async function exportEntries(format: "csv" | "tsv" | "json" | "xml") {
    if (!entries.length) {
      showToast("default", "Nothing to export", { description: "Add entries first." })
      return
    }
    // Allow the menu to close and UI to update before generating large strings
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const rows = entries
    let content = ""
    let mime = "text/plain;charset=utf-8"
    let ext = format
    if (format === "csv" || format === "tsv") {
      const sep = format === "csv" ? "," : "\t"
      const header = ["login", "status"].join(sep)
      const body = rows.map(r => [r.login, r.status].join(sep)).join("\n")
      content = header + "\n" + body
      mime = format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8"
    } else if (format === "json") {
      content = JSON.stringify(rows.map(r => ({ login: r.login, status: r.status })), null, 2)
      mime = "application/json;charset=utf-8"
    } else if (format === "xml") {
      const xmlBody = rows
        .map(r => `  <entry login="${escapeXml(r.login)}" status="${escapeXml(r.status)}"/>`)
        .join("\n")
      content = `<?xml version="1.0" encoding="UTF-8"?>\n<entries>\n${xmlBody}\n</entries>\n`
      mime = "application/xml;charset=utf-8"
    }
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `github-logins.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  /** Programmatically trigger a file selection for a given import type. */
  function triggerImport(type: "csv" | "tsv" | "json" | "xml") {
    setPendingImportType(type)
    const input = fileInputRef.current
    if (!input) return
    const accept = type === "csv" ? ".csv,text/csv" : type === "tsv" ? ".tsv,text/tab-separated-values" : type === "json" ? ".json,application/json" : ".xml,application/xml,text/xml"
    input.setAttribute("accept", accept)
    input.click()
  }

  /** Handle file selection and import logins using helper parsers. */
  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    try {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file || !pendingImportType) return
      const text = await file.text()
      const type = pendingImportType
      setPendingImportType(null)
      // Show a quick toast and yield so the UI doesn't feel frozen on large files
      showToast("default", "Importing...", { description: file.name })
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      let logins: string[] = []
      if (type === "csv" || type === "tsv") {
        const sep = type === "csv" ? "," : "\t"
        logins = parseSeparated(text, sep)
      } else if (type === "json") {
        logins = parseJsonLogins(text)
      } else if (type === "xml") {
        logins = parseXmlLogins(text)
      }
      logins = Array.from(new Set(logins.map(s => s.trim()).filter(Boolean)))
      if (!logins.length) {
        showToast("default", "No logins found", { description: "Could not parse any usernames." })
        return
      }
      addLogins(logins)
      showToast("success", "Imported", { description: `${logins.length} usernames added.` })
    } catch (err) {
      showToast("error", "Import failed", { description: (err as Error).message || "Unknown error" })
    }
  }

  // parsing helpers moved to helpers

  /** Render a compact status badge for a given entry. */
  function statusBadge(entry: Entry) {
    const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
    switch (entry.status) {
      case "unchecked":
        return <span className={`${base} bg-muted text-muted-foreground`}><CircleHelp className="size-3" /> unchecked</span>
      case "available":
        return <span className={`${base} bg-emerald-500/15 text-emerald-400`}><Check className="size-3" /> available</span>
      case "user":
        return <span className={`${base} bg-sky-500/15 text-sky-400`}><User className="size-3" /> user</span>
      case "organization":
        return <span className={`${base} bg-violet-500/15 text-violet-400`}><Users className="size-3" /> organization</span>
      case "invalid":
        return <span className={`${base} bg-amber-500/15 text-amber-400`}><AlertTriangle className="size-3" /> invalid</span>
      case "error":
      default:
        return <span className={`${base} bg-destructive/20 text-destructive`}><CircleDashed className="size-3" /> error</span>
    }
  }

  // Toast behavior: keep the latest toast visible until a newer one appears.
  // When a new toast is shown, the previous one starts a 5s countdown to dismiss.
  const lastToastIdRef = useRef<string | number | null>(null)
  function showToast(
    kind: "default" | "success" | "error",
    title: string,
    options?: Parameters<typeof toast>[1]
  ) {
    const prev = lastToastIdRef.current
    if (prev != null) {
      // start countdown for previous toast
      setTimeout(() => toast.dismiss(prev), 5000)
    }
    const base = { duration: 60 * 60 * 1000 } // effectively persistent (~1h)
    let id: string | number
    if (kind === "success") id = toast.success(title, { ...base, ...options })
    else if (kind === "error") id = toast.error(title, { ...base, ...options })
    else id = toast(title, { ...base, ...options })
    lastToastIdRef.current = id
    return id
  }

  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <div className="min-h-dvh w-full bg-background text-foreground">
        <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <div className="flex h-10 items-center gap-2">
              <img
                src={logo}
                alt=""
                className="h-5 w-5 block dark:hidden"
                aria-hidden
              />
              <img
                src={logoDark}
                alt=""
                className="h-5 w-5 hidden dark:block"
                aria-hidden
              />
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold tracking-tight leading-none">GitHub Login Availability</span>
                <span className="text-muted-foreground leading-none">•</span>
                <span className="text-muted-foreground leading-none">check usernames availability, fast</span>
              </div>
            </div>
            <div className="flex h-10 items-center gap-2">
              <Popover open={tokenPopoverOpen} onOpenChange={setTokenPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm">
                    <PlugZap className="size-4" />
                    Token
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <PlugZap className="size-4 text-primary" />
                      <span>GitHub Token</span>
                    </div>
                    {tokenValid?.valid && hasRequiredScopes(tokenValid.scopes) ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400"><ShieldCheck className="size-3" /> valid</span>
                    ) : token ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/20 px-2 py-0.5 text-xs font-medium text-destructive"><CircleDashed className="size-3" /> invalid</span>
                    ) : null}
                  </div>
                  <div className="grid gap-2">
                    <input
                      type="password"
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:border-ring"
                      placeholder="Paste your GitHub token"
                      value={token}
                      onChange={e => setToken(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <Button onClick={saveToken} disabled={savingToken} className="h-9 flex-1">
                        Save Token
                      </Button>
                      <a
                        href="https://github.com/settings/tokens/new?description=Login+Availability&scopes=read:user,read:org"
                        target="_blank"
                        rel="noreferrer"
                        className="h-9 rounded-md border px-3 text-sm inline-flex items-center justify-center hover:bg-accent"
                      >
                        Get Token
                      </a>
                    </div>
                    {tokenValid?.scopes?.length ? (
                      <div className="text-xs text-muted-foreground">
                        Scopes: {tokenValid.scopes.join(", ")}
                      </div>
                    ) : null}
                    {token && tokenValid && (!tokenValid.valid || !hasRequiredScopes(tokenValid.scopes)) ? (
                      <div className="text-xs text-destructive">
                        Token must include read:user and read:org scopes.
                      </div>
                    ) : null}
                  </div>
                </PopoverContent>
              </Popover>
              <ModeToggle />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-4xl px-4 py-6">

          {/* Entry Input */}
          <Card className="mb-6">
            <CardHeader className="pb-0">
              <div className="text-sm font-medium">Usernames</div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <input
                  type="text"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:border-ring"
                  placeholder="e.g. octocat, charmander, golang"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addLoginsFromInput()
                    }
                  }}
                />
                <Button onClick={addLoginsFromInput} className="h-10 sm:w-32">Add</Button>
              </div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="default" onClick={checkUnchecked} disabled={checking || !unchecked.length} className="gap-2">
                    {checking ? <CircleDashed className="size-4 animate-spin" /> : <Check className="size-4" />}
                    <span className="hidden sm:inline">Check</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{unchecked.length}</span>
                  </Button>
                  <Button variant="outline" onClick={resetStatuses} disabled={!entries.length}>
                    <span className="hidden sm:inline">Reset Statuses</span>
                    <span className="sm:hidden">Reset</span>
                  </Button>
                  <Button variant="ghost" onClick={clearAll} disabled={!entries.length} className="text-destructive hover:bg-destructive/10 gap-1">
                    <Trash2 className="size-4" />
                    <span className="hidden sm:inline">Clear All</span>
                    <span className="sm:hidden">Clear</span>
                  </Button>
                </div>
                <div className="flex items-center gap-2 sm:ml-auto">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="gap-2">
                        <Upload className="size-4" /> / <Download className="size-4" />
                        <span className="hidden sm:inline">Import / Export</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>Import</DropdownMenuLabel>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>From CSV/TSV</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuItem className="cursor-pointer" onClick={() => triggerImport("csv")}>CSV (.csv)</DropdownMenuItem>
                          <DropdownMenuItem className="cursor-pointer" onClick={() => triggerImport("tsv")}>TSV (.tsv)</DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => triggerImport("json")}>From JSON (.json)</DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => triggerImport("xml")}>From XML (.xml)</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Export</DropdownMenuLabel>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => exportEntries("csv")}>Export CSV</DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => exportEntries("tsv")}>Export TSV</DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => exportEntries("json")}>Export JSON</DropdownMenuItem>
                      <DropdownMenuItem className="cursor-pointer" onClick={() => exportEntries("xml")}>Export XML</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {/* Feedback button moved to bottom-right floating position */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.tsv,.json,.xml"
                    className="hidden"
                    onChange={onFileSelected}
                  />
                </div>
              </div>

            </CardContent>
          </Card>

          {/* Results */}
          <Card>
            {entries.length === 0 ? (
              <CardContent>
                <div className="text-center text-sm text-muted-foreground">No usernames yet. Add some above to check.</div>
              </CardContent>
            ) : (
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-[1] bg-card/80 backdrop-blur">
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="px-3 py-2 text-left font-medium">Username</th>
                        <th className="px-3 py-2 text-left font-medium">Status</th>
                        <th className="px-3 py-2 text-right font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.login} className="border-b last:border-0">
                          <td className="px-3 py-2 font-mono">{e.login}</td>
                          <td className="px-3 py-2">{statusBadge(e)}</td>
                          <td className="px-3 py-2 text-right">
                            <Button size="sm" variant="ghost" onClick={() => removeEntry(e.login)} className="text-destructive hover:bg-destructive/10">
                              <Trash2 className="size-4" />
                              Remove
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            )}
          </Card>
        </main>
        {/* Feedback button removed; toasts provide real-time messages */}
        <Toaster richColors position="bottom-right" />
      </div>
    </ThemeProvider>
  )
}

export default App
