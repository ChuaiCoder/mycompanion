import {
  apiErrorResponseSchema,
  healthResponseSchema,
  type HealthResponse,
} from "@mycompanion/shared";

export class ApiRequestError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.details = details;
  }
}

export async function readApiPayload(response: Response): Promise<unknown> {
  const payload = (await response.json()) as unknown;
  if (response.ok) {
    return payload;
  }

  const error = apiErrorResponseSchema.safeParse(payload);
  if (error.success) {
    throw new ApiRequestError(
      error.data.error.code,
      error.data.error.message,
      error.data.error.details ?? [],
    );
  }
  throw new ApiRequestError(
    "API_REQUEST_FAILED",
    `请求失败（HTTP ${response.status}）。`,
  );
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}.`);
  }

  return healthResponseSchema.parse(await response.json());
}
