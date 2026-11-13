import { CredentialError } from "../auth";
import { lockoutUntil } from "./rate-limit";
import { exhaustedQuota, httpStatus, providerErrorEvidence, QuotaError, transientFailure } from "./retry";

const guidance = {
  "total-timeout": "The request reached Orca's total time limit. Resume to try again.",
  "idle-timeout": "The request made no progress before Orca's idle deadline. Resume to try again.",
  quota: "The provider reports an account allowance or billing limit. Check usage or switch accounts.",
  "rate-limit": "Provider rate limit. Wait before resuming. The remaining account allowance is unknown.",
  authentication: "The provider rejected authentication. Sign in again.",
  permission: "The account lacks access to the requested resource. Check model and account permissions.",
  "model-unavailable": "The requested model or endpoint is unavailable. Check model access or select another model.",
  "input-too-large": "The request exceeds the provider's input limit. Reduce context or attachments.",
  "image-limit": "The provider rejected image dimensions or the image count. Run /compact to archive older images, then resume; originals remain saved.",
  "output-limit": "The response hit its output limit. Ask for a shorter response or split the work.",
  "request-timeout": "The provider timed out the request. Resume to try again.",
  conflict: "The provider reported a request conflict. Resume to try again.",
  "invalid-request": "The provider rejected the request. Check model settings, tools and inputs.",
  overload: "The provider is overloaded. Wait before resuming.",
  "provider-service": "The provider reported a service error. Resume after it recovers.",
  "credentials-invalid": "Saved credentials are missing or invalid. Sign in again.",
  "credential-lock": "The credentials are locked by another operation. Check for an active sign-in or refresh.",
  "oauth-connection": "The credential exchange could not reach the sign-in service. Check connectivity and retry.",
  "oauth-http": "The sign-in service rejected the credential exchange.",
  "oauth-response": "The sign-in service returned an unusable credential response. Try again.",
  connection: "The model connection failed before a usable response. Check connectivity and retry.",
  response: "The model response failed or was incomplete. Resume to try again.",
  setup: "The request failed during setup. Check local credentials, model settings and inputs.",
} as const;

type Reason = keyof typeof guidance;
type Kind = "total-timeout" | "idle-timeout" | "quota" | "interrupted" | "exhausted" | "permanent";
export type RequestStage = "setup" | "connection" | "response";

export class ModelRequestError extends Error {
  readonly reason: Reason;
  constructor(readonly kind: Kind, readonly status?: number, reason?: Reason, detail?: string, readonly oauthStatus?: number) {
    const category = reason ?? (kind === "permanent" ? "setup" : kind === "interrupted" ? "response"
      : kind === "exhausted" ? status === 429 ? "rate-limit" : "connection" : kind);
    const http = status ? ` HTTP ${status}.` : oauthStatus ? ` Sign-in HTTP ${oauthStatus}.` : "";
    const interrupted = kind === "interrupted" ? " The response already started." : "";
    super(`${detail ?? guidance[category]}${http}${interrupted}`);
    this.name = "ModelRequestError";
    this.reason = category;
  }
}

function reasonFor(error: unknown, status: number | undefined, stage: RequestStage): Reason {
  const evidence = providerErrorEvidence(error);
  const code = evidence?.code ?? evidence?.type;
  if (status === 429 || code === "rate_limit_error" || code === "rate_limit_exceeded") return "rate-limit";
  if (status === 401 || code === "authentication_error" || code === "invalid_api_key") return "authentication";
  if (status === 403 || code === "permission_error") return "permission";
  if (status === 404 || code === "model_not_found" || code === "not_found_error") return "model-unavailable";
  if (status === 413 || code === "context_length_exceeded" || code === "request_too_large") return "input-too-large";
  // Classify known image-limit failures without echoing provider bodies (which
  // can contain user data). Switching accounts cannot repair the same payload.
  if ((status === 400 || code === "invalid_request_error") && typeof evidence?.message === "string"
    && /many-image requests|too many images|image dimensions? (?:exceed|must)|image exceeds (?:the )?(?:dimension|size|pixel)/i.test(evidence.message)) return "image-limit";
  if (code === "max_output_tokens" || (error as { response?: { incomplete_details?: { reason?: unknown } } })?.response?.incomplete_details?.reason === "max_output_tokens") return "output-limit";
  if (status === 529 || code === "overloaded_error") return "overload";
  if ((status !== undefined && status >= 500) || code === "server_error" || code === "api_error") return "provider-service";
  if (status === 408) return "request-timeout";
  if (status === 409) return "conflict";
  if ((status !== undefined && status < 500) || code === "invalid_request_error") return "invalid-request";
  return stage;
}

export function diagnoseModelError(error: unknown, consumed = false, stage: RequestStage = "setup"): ModelRequestError {
  if (error instanceof ModelRequestError) return error;
  const quota = error instanceof QuotaError ? error.explanation : exhaustedQuota(error);
  const status = httpStatus(error);
  if (quota) return new ModelRequestError("quota", status, "quota", quota + " Check usage or switch accounts.");
  const lockout = lockoutUntil(error);
  if (lockout) {
    const until = new Date(lockout).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return new ModelRequestError("exhausted", 429, "rate-limit", `The provider rate limited this account until ${until}. Switch accounts or resume after that.`);
  }

  // SDK wrappers can preserve the locally typed credential failure in their cause.
  for (let cause = error, depth = 0; cause instanceof Error && depth < 5; cause = cause.cause, depth++) {
    if (cause instanceof CredentialError) {
      const detail = cause.oauthStatus && [400, 401, 403].includes(cause.oauthStatus)
        ? "The sign-in service rejected the credential exchange. Sign in again."
        : undefined;
      return new ModelRequestError("permanent", undefined, cause.reason, detail, cause.oauthStatus);
    }
  }
  const transient = transientFailure(error);
  return new ModelRequestError(consumed ? "interrupted" : transient ? "exhausted" : "permanent",
    status, reasonFor(error, status, consumed ? "response" : transient ? "connection" : stage));
}
