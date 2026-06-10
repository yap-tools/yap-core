/** Minimal REST client for integration tests. */

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export function apiClient(baseUrl: string, key?: string) {
  const request = async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // leave as text
    }
    return { status: res.status, body: parsed };
  };
  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body),
    patch: (path: string, body?: unknown) => request("PATCH", path, body),
    put: (path: string, body?: unknown) => request("PUT", path, body),
    delete: (path: string) => request("DELETE", path),
  };
}

export type ApiClient = ReturnType<typeof apiClient>;
