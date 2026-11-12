import { NextRequest, NextResponse } from 'next/server';
import { appURL } from '@/server/auth';
import { authorizationServerMetadata } from '@/server/oauth';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return NextResponse.json(authorizationServerMetadata(appURL(request)));
}
