import { NextRequest, NextResponse } from 'next/server';
import { appURL } from '@/server/auth';
import { protectedResourceMetadata } from '@/server/oauth';
export const dynamic = 'force-dynamic';
// Served both at the root and path-suffixed (/api/mcp), as clients probe either.
export function GET(request: NextRequest) {
  return NextResponse.json(protectedResourceMetadata(appURL(request)));
}
