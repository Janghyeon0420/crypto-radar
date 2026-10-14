import { NextResponse } from 'next/server';
import { knowledgeEntries, knowledgeVersion } from '@/lib/forecast/knowledge';

export function GET() {
  return NextResponse.json({ version: knowledgeVersion, entries: knowledgeEntries });
}
