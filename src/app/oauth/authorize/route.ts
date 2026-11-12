import { NextRequest, NextResponse } from 'next/server';
import { appURL, currentUser, sameOrigin } from '@/server/auth';
import { getDB } from '@/server/db';
import { AppError } from '@/server/errors';
import {
  authorizeRedirect,
  clientHost,
  issueCode,
  OAuthError,
  parseAuthorize,
  UntrustedRedirect,
  type AuthorizeRequest,
} from '@/server/oauth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to KinFlow</title><style>
:root{--bg:#f6f7f4;--surface:#fff;--ink:#263b33;--muted:#859086;--line:#e7ebe4;--pine:#254f42;--sage:#edf2e9;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--ink);background:var(--bg)}
@media (prefers-color-scheme:dark){:root{--bg:#141a17;--surface:#1c2420;--ink:#e6ece8;--muted:#9aa69e;--line:#2c3631;--pine:#7fb39f;--sage:#22302a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box}
main{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:28px;max-width:420px;width:100%;box-sizing:border-box}
.eyebrow{color:var(--muted);font-size:12px;letter-spacing:.08em;margin:0 0 8px}h1{font-size:20px;margin:0 0 4px}.host{color:var(--muted);margin:0 0 20px}
ul{padding-left:18px;margin:0 0 16px}.note{background:var(--sage);border-radius:14px;padding:12px 14px;font-size:13px;margin:0 0 16px}
label{display:flex;gap:10px;align-items:flex-start;margin:0 0 20px}input[type=checkbox]{margin-top:3px;accent-color:var(--pine)}
.actions{display:flex;gap:10px}button{flex:1;border-radius:14px;padding:12px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
button[value=allow]{background:var(--pine);border-color:var(--pine);color:#fff}a{color:var(--pine)}
</style></head><body><main><p class="eyebrow">KINFLOW</p>${body}</main></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      },
    },
  );
}
const problem = (message: string) =>
  page(`<h1>Cannot connect</h1><p>${escape(message)}</p><p><a href="/">Open KinFlow</a></p>`, 400);

function consent(request: AuthorizeRequest, query: string, userName: string) {
  const name = escape(request.client.name),
    host = escape(clientHost(request.client));
  return page(`<h1>${name} wants to access your KinFlow</h1>
<p class="host">${host} · signed in as ${escape(userName)}</p>
<p>It will act as you, with your role in each of your families:</p>
<ul><li>see your shared and personal accounts, transactions, budgets and history</li><li>record and change entries, settings and memberships, if you allow changes</li></ul>
<p class="note">Your financial data will be sent to ${name}, which is operated by a third party under its own terms. Disconnect any time in More → Account.</p>
<form method="post" action="/oauth/authorize?${escape(query)}">
${request.scope.includes('write') ? '<label><input type="checkbox" name="write" value="1" checked><span>Allow changes<br><small>Without this the assistant can only read.</small></span></label>' : ''}
<div class="actions"><button name="decision" value="deny">Cancel</button><button name="decision" value="allow">Allow</button></div>
</form>`);
}

async function handle(request: NextRequest) {
  const db = await getDB(),
    base = appURL(request),
    query = request.nextUrl.searchParams.toString();
  let parsed: AuthorizeRequest;
  try {
    parsed = await parseAuthorize(db, request.nextUrl.searchParams, base);
  } catch (error) {
    if (error instanceof UntrustedRedirect) return problem(error.message);
    if (error instanceof OAuthError) {
      const e = error as OAuthError & { redirect: string; state?: string };
      return NextResponse.redirect(
        authorizeRedirect(e.redirect, base, {
          error: e.code,
          error_description: e.message,
          state: e.state,
        }),
        303,
      );
    }
    throw error;
  }
  const user = await currentUser(db, request);
  if (request.method === 'GET') {
    if (!user)
      return NextResponse.redirect(
        `${base}/api/auth/google?returnTo=${encodeURIComponent(`/oauth/authorize?${query}`)}`,
      );
    return consent(parsed, query, user.name);
  }
  try {
    sameOrigin(request);
  } catch {
    return problem('Request origin is not allowed.');
  }
  if (!user) return problem('Your KinFlow session has expired. Start connecting again.');
  const form = await request.formData();
  if (form.get('decision') !== 'allow')
    return NextResponse.redirect(
      authorizeRedirect(parsed.redirectUri, base, { error: 'access_denied', state: parsed.state }),
      303,
    );
  const scope = parsed.scope.filter((s) => s !== 'write' || form.get('write') === '1');
  const code = await issueCode(db, { ...parsed, scope }, user.id);
  return NextResponse.redirect(
    authorizeRedirect(parsed.redirectUri, base, { code, state: parsed.state }),
    303,
  );
}
async function guarded(request: NextRequest) {
  try {
    return await handle(request);
  } catch (error) {
    if (error instanceof AppError) return problem(error.message);
    console.error('KinFlow authorization failed', error instanceof Error ? error.name : 'UnknownError');
    return problem('Something went wrong. Please try again.');
  }
}
export { guarded as GET, guarded as POST };
