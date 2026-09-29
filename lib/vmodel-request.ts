type VModelTaskResult = {
  status?: string;
  output?: string[];
  error?: string;
};

export type VModelTaskResponse = {
  result?: VModelTaskResult;
  error?: string;
  message?: string;
};

const MIN_REQUEST_GAP_MS = 650;
const DEFAULT_RETRY_MS = 700;
const MAX_RETRY_MS = 5000;

type RateState = typeof globalThis & {
  __pixoraVModelNextAt?: Map<string, number>;
};

function state() {
  const target = globalThis as RateState;
  if (!target.__pixoraVModelNextAt) {
    target.__pixoraVModelNextAt = new Map<string, number>();
  }
  return target.__pixoraVModelNextAt;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTurn(token: string) {
  if (!token) return;
  const schedule = state();
  const now = Date.now();
  const reserved = Math.max(now, schedule.get(token) || 0);
  schedule.set(token, reserved + MIN_REQUEST_GAP_MS);
  const wait = reserved - now;
  if (wait > 0) await sleep(wait);
}

function retryDelay(response: Response, payload: unknown, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_MS, Math.max(MIN_REQUEST_GAP_MS, Math.ceil(seconds * 1000) + 100));
    }
  }

  const text = typeof payload === "object" && payload
    ? [
        "error" in payload ? String((payload as { error?: unknown }).error || "") : "",
        "message" in payload ? String((payload as { message?: unknown }).message || "") : "",
        "result" in payload && (payload as { result?: { error?: unknown } }).result
          ? String((payload as { result?: { error?: unknown } }).result?.error || "")
          : "",
      ].join(" ")
    : String(payload || "");

  const milliseconds = text.match(/wait\s+(\d+)\s*milliseconds?/i);
  if (milliseconds) {
    return Math.min(
      MAX_RETRY_MS,
      Math.max(MIN_REQUEST_GAP_MS, Number(milliseconds[1]) + 150),
    );
  }

  return Math.min(MAX_RETRY_MS, DEFAULT_RETRY_MS + (attempt * 250));
}

function isRateLimited(response: Response, payload: unknown) {
  if (response.status === 429) return true;
  const text = typeof payload === "string"
    ? payload
    : JSON.stringify(payload || {});
  return /please\s+wait\s+\d+\s*milliseconds?/i.test(text) ||
    /rate\s*limit/i.test(text);
}

export async function fetchVModelTask(
  taskId: string,
  token: string,
  attempts = 8,
) {
  let lastResponse: Response | null = null;
  let lastData: VModelTaskResponse = {};

  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForTurn(token);

    const response = await fetch(
      `https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(taskId)}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      },
    );
    const data = await response.json().catch(() => ({})) as VModelTaskResponse;

    lastResponse = response;
    lastData = data;

    if (!isRateLimited(response, data)) {
      return { response, data };
    }

    await sleep(retryDelay(response, data, attempt));
  }

  return {
    response: lastResponse || new Response(null, { status: 429 }),
    data: lastData,
  };
}

export async function fetchVModelAsset(
  sourceUrl: string,
  token: string,
  init: RequestInit = {},
  attempts = 6,
) {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForTurn(token);

    const headers = new Headers(init.headers || {});
    if (!headers.has("Accept")) {
      headers.set(
        "Accept",
        "image/png,image/jpeg,image/webp,image/avif,image/*,*/*;q=0.8",
      );
    }
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const response = await fetch(sourceUrl, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "follow",
    });
    lastResponse = response;

    if (response.status !== 429) return response;

    await response.body?.cancel().catch(() => undefined);
    await sleep(retryDelay(response, "", attempt));
  }

  return lastResponse || new Response(null, { status: 429 });
}
