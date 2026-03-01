/**
 * Batch-check GitHub usernames/organizations via GraphQL.
 * For each login, builds an aliased field and infers availability:
 * - null => available
 * - User => user
 * - Organization => organization
 * Also returns current rate limit state.
 * @param token GitHub token (requires read:user and read:org).
 * @param logins Unique list of candidate logins to check.
 */
export async function getStatusesFromLogins(token: string, logins: string[]): Promise<{
    logins: { [key: string]: "available" | "user" | "organization" },
    rateLimit: {
        limit: number,
        remaining: number,
        used: number,
        resetAt: Date
    }
}> {
    const aliasEntries: { login: string; alias: string }[] = [];
    const aliasCounts = new Map<string, number>();

    for (const login of logins) {
        const safeLogin = login.replace(/[^0-9A-Za-z_]/g, "_");
        const baseAlias = `check_${safeLogin || "entry"}`;
        const existingCount = aliasCounts.get(baseAlias) ?? 0;
        aliasCounts.set(baseAlias, existingCount + 1);
        const alias = existingCount === 0 ? baseAlias : `${baseAlias}_${existingCount}`;
        aliasEntries.push({ login, alias });
    }

    const queryFields = aliasEntries
        .map(({ alias, login }) => {
            const escapedLogin = login.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            return `
            ${alias}: repositoryOwner(login: "${escapedLogin}") {
                __typename
                ... on Organization {}
                ... on User {}
            }
        `;
        })
        .join(" ");

    const query = `
        query {
            ${queryFields}
            rateLimit {
                limit
                remaining
                used
                resetAt
            }
        }
    `
        .replace(/[\n\t]+/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();

    let response;
    try {
        response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                Authorization: `bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ query })
        });
    } catch (err) {
        throw new Error(`Network error contacting GitHub: ${(err as Error).message}`);
    }

    const raw = await response.text();
    if (!response.ok) {
        let message = raw;
        try {
            const parsed = JSON.parse(raw);
            if (parsed?.message) message = parsed.message;
            else if (parsed?.errors?.length) message = parsed.errors.map((e: any) => e.message).join("; ");
        } catch { }
        throw new Error(`GitHub GraphQL HTTP ${response.status} ${response.statusText}: ${message}`);
    }

    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("Invalid JSON received from GitHub GraphQL API");
    }

    if (parsed?.errors?.length) {
        const messages = parsed.errors.map((e: any) => e.message).join("; ");
        throw new Error(`GitHub GraphQL errors: ${messages}`);
    }

    if (!parsed || !parsed.data) {
        throw new Error("No data in GitHub GraphQL response");
    }

    const result = parsed as {
        data: {
            rateLimit: {
                limit: number,
                remaining: number,
                used: number,
                resetAt: string
            }
        } & Record<string, { __typename: "User" | "Organization" } | null>
    }

    const statuses: { [key: string]: "available" | "user" | "organization" } = {};

    for (const { login, alias } of aliasEntries) {
        const entry = result.data[alias];
        statuses[login] = entry === null
            ? "available"
            : (entry.__typename === "User" ? "user" : "organization");
    }

    return {
        logins: statuses,
        rateLimit: {
            ...result.data.rateLimit,
            resetAt: new Date(result.data.rateLimit.resetAt)
        }
    }
}

/**
 * Validate a GitHub token by calling the REST `/user` endpoint and
 * parsing the `x-oauth-scopes` response header.
 * @param tokenToCheck Token to validate.
 * @returns `{ valid, scopes }` where `scopes` is a parsed list.
 */
export async function validateGitHubToken(tokenToCheck: string): Promise<{ valid: boolean; scopes: string[] }> {
    if (!tokenToCheck) return { valid: false, scopes: [] };

    let resp: Response;
    try {
        resp = await fetch("https://api.github.com/user", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${tokenToCheck}`,
                Accept: "application/vnd.github+json"
            }
        });
    } catch {
        return { valid: false, scopes: [] };
    }

    const scopesHeader = resp.headers.get("x-oauth-scopes") || "";
    const scopes = scopesHeader
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

    if (resp.status === 200) {
        return { valid: true, scopes };
    }

    if (resp.status === 401) {
        return { valid: false, scopes: [] };
    }

    return { valid: resp.ok, scopes };
}
