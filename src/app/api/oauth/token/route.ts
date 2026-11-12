import { NextRequest, NextResponse } from 'next/server';
import { appURL } from '@/server/auth';
import { getDB } from '@/server/db';
import { exchangeToken, OAuthError } from '@/server/oauth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
export async function POST(request: NextRequest) {
  try {
    const text = await request.text();
    if (text.length > 16384) throw new OAuthError('invalid_request', 'Request is too large.');
    const params = new URLSearchParams(text);
    const tokens = await exchangeToken(
      await getDB(),
      params,
      request.headers.get('authorization'),
      appURL(request),
    );
    return NextResponse.json(tokens, { headers });
  } catch (error) {
    if (error instanceof OAuthError)
      return NextResponse.json(error.body(), { status: error.status, headers });
    console.error('KinFlow token request failed', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'server_error' }, { status: 500, headers });
  }
}
