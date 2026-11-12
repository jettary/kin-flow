import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/server/db';
import { OAuthError, registerClient } from '@/server/oauth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
export async function POST(request: NextRequest) {
  try {
    const text = await request.text();
    if (text.length > 16384) throw new OAuthError('invalid_client_metadata', 'Request is too large.');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError('invalid_client_metadata', 'Invalid JSON.');
    }
    return NextResponse.json(await registerClient(await getDB(), body), { status: 201, headers });
  } catch (error) {
    if (error instanceof OAuthError)
      return NextResponse.json(error.body(), { status: error.status, headers });
    console.error('KinFlow client registration failed', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'server_error' }, { status: 500, headers });
  }
}
