/**
 * Captures the response body of the SDK's POST to /connect so we can read the real
 * backend identifiers the server returns. The SDK only stores `character_session_id` and
 * `room_url`/`token` from that response — `session_id` (the unique session token used
 * server-side for diagnostics) is dropped.
 *
 * We monkey-patch window.fetch ONCE before the SDK runs. The patch:
 *   - Forwards every request unchanged.
 *   - For URLs ending in /connect, tees the response (via .clone()) and stores the
 *     parsed JSON body. The original response remains untouched so the SDK behavior
 *     is unaffected.
 *
 * Per-call disambiguation: an endUserId (=== eval session id) is recorded so a worker
 * driving multiple SDK connections in the future could fan out. Today there's one connect
 * per worker, so a single global slot is fine.
 *
 * Source of truth: core-service/models/api.py:315-323 (ConnectResponse).
 */

export interface ConnectInfo {
  session_id?: string; // Backend "unique session token" (server-side session_auth_token)
  character_session_id?: string; // Per-connection interaction id
  room_name?: string; // LiveKit room name
  end_user_id?: string;
}

let captured: ConnectInfo = {};
let installed = false;

export function installConnectIntercept(): void {
  if (installed) return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await originalFetch(input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (response.ok && /\/connect(\?|$)/.test(url)) {
        const cloned = response.clone();
        cloned
          .json()
          .then((body) => {
            if (body && typeof body === "object") {
              const b = body as Record<string, unknown>;
              captured = {
                session_id: typeof b.session_id === "string" ? b.session_id : undefined,
                character_session_id:
                  typeof b.character_session_id === "string" ? b.character_session_id : undefined,
                room_name: typeof b.room_name === "string" ? b.room_name : undefined,
                end_user_id: typeof b.end_user_id === "string" ? b.end_user_id : undefined,
              };
            }
          })
          .catch(() => {
            // Body wasn't JSON or already consumed elsewhere; ignore.
          });
      }
    } catch {
      // Defensive: anything thrown here must not break the SDK's actual request.
    }
    return response;
  };
}

export function getCapturedConnectInfo(): ConnectInfo {
  return captured;
}
