// Read-only Deye Cloud OpenAPI client.
// Spec: https://eu1-developer.deyecloud.com/v2/api-docs (Swagger 2.0).
// Every request is a POST with a JSON body and a Bearer token.
// API errors come back as HTTP 200 with { success: false, code, msg }.

import { getMetaJson, setMeta } from "./meta";

const TOKEN_KEY = "deye_token";
const TOKEN_MIN_LEFT_S = 24 * 3600;

export class DeyeHttpError extends Error {
  constructor(
    public status: number,
    public retryAfterS: number | null,
  ) {
    super(`Deye HTTP ${status}`);
  }
}

export class DeyeApiError extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(`Deye API ${code}: ${msg}`);
  }
}

interface ApiEnvelope {
  success: boolean;
  code?: string;
  msg?: string;
  requestId?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // unix seconds
}

export interface StationItem {
  id: number;
  name: string;
  regionTimezone?: string;
  lastUpdateTime?: string | number;
}

// Power fields are either W or kW depending on DEYE_POWER_UNIT, see wrangler.jsonc.
export interface StationPowerItem {
  timeStamp?: string | number;
  generationPower?: number | null;
  consumptionPower?: number | null;
  gridPower?: number | null;
  purchasePower?: number | null;
  wirePower?: number | null;
  batteryPower?: number | null;
  chargePower?: number | null;
  dischargePower?: number | null;
  batterySOC?: number | null;
}

export interface StationLatest extends StationPowerItem {
  lastUpdateTime?: string | number;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class DeyeClient {
  constructor(
    private env: Env,
    private db: D1Database,
  ) {}

  private async login(): Promise<CachedToken> {
    const url = `${this.env.DEYE_BASE_URL}/v1.0/account/token?appId=${encodeURIComponent(this.env.DEYE_APP_ID)}`;
    const body = {
      appSecret: this.env.DEYE_APP_SECRET,
      email: this.env.DEYE_EMAIL,
      password: await sha256Hex(this.env.DEYE_PASSWORD),
    };
    const res = await this.post(url, body, null);
    const data = (await res.json()) as ApiEnvelope & { accessToken?: string; expiresIn?: string | number };
    if (!data.success || !data.accessToken) {
      throw new DeyeApiError(data.code ?? "?", data.msg ?? "token request failed");
    }
    const token: CachedToken = {
      accessToken: data.accessToken.replace(/^Bearer\s+/i, ""),
      expiresAt: Math.floor(Date.now() / 1000) + Number(data.expiresIn ?? 3600),
    };
    await setMeta(this.db, TOKEN_KEY, token);
    return token;
  }

  private async token(force = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const cached = force ? null : await getMetaJson<CachedToken>(this.db, TOKEN_KEY);
    if (cached && cached.expiresAt - now > TOKEN_MIN_LEFT_S) return cached.accessToken;
    return (await this.login()).accessToken;
  }

  private async post(url: string, body: unknown, bearer: string | null): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    await this.recordUsage(res);
    if (res.status === 429 || res.status >= 500) {
      const ra = res.headers.get("retry-after");
      throw new DeyeHttpError(res.status, ra && /^\d+$/.test(ra) ? Number(ra) : null);
    }
    if (!res.ok) throw new DeyeHttpError(res.status, null);
    return res;
  }

  // Counts calls per day and keeps the last rate-limit headers seen, so usage is visible in /api/status.
  private async recordUsage(res: Response): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const key = `api_calls:${day}`;
    await this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
      )
      .bind(key)
      .run();
    const limits: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (/ratelimit|rate-limit|retry-after/i.test(k)) limits[k] = v;
    });
    if (Object.keys(limits).length) await setMeta(this.db, "ratelimit_headers", limits);
  }

  async call<T extends ApiEnvelope>(path: string, body: unknown): Promise<T> {
    const url = `${this.env.DEYE_BASE_URL}${path}`;
    let res = await this.post(url, body, await this.token());
    let data = (await res.json()) as T;
    if (!data.success && /token/i.test(data.msg ?? "")) {
      // Token rejected: log in again once.
      res = await this.post(url, body, await this.token(true));
      data = (await res.json()) as T;
    }
    if (!data.success) throw new DeyeApiError(data.code ?? "?", data.msg ?? "unknown error");
    return data;
  }

  async stationList(): Promise<StationItem[]> {
    const data = await this.call<ApiEnvelope & { stationList?: StationItem[] }>("/v1.0/station/list", {
      page: 1,
      size: 50,
    });
    return data.stationList ?? [];
  }

  async stationLatest(stationId: number): Promise<StationLatest> {
    return this.call<ApiEnvelope & StationLatest>("/v1.0/station/latest", { stationId });
  }

  // 5 minute frames between two unix timestamps (seconds). Range must be <= 12 months.
  async stationHistoryPower(stationId: number, startTs: number, endTs: number): Promise<StationPowerItem[]> {
    const data = await this.call<ApiEnvelope & { stationDataItems?: StationPowerItem[] }>(
      "/v1.0/station/history/power",
      { stationId, startTimestamp: startTs, endTimestamp: endTs },
    );
    return data.stationDataItems ?? [];
  }
}
