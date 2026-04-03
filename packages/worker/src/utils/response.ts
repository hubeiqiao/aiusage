export function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function jsonOk<T>(data: T, isPublic = false): Response {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (isPublic) Object.assign(headers, corsHeaders());
  return new Response(JSON.stringify({ ok: true, ...data }), { status: 200, headers });
}

export function jsonError(status: number, code: string, message: string, isPublic = false): Response {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (isPublic) Object.assign(headers, corsHeaders());
  return new Response(
    JSON.stringify({ ok: false, error: { code, message } }),
    { status, headers },
  );
}
