import { NextResponse } from 'next/server';
import { clearEvents, readEvents } from '@/lib/alerts/store';

export async function GET() {
  return NextResponse.json({ events: await readEvents() });
}

export async function DELETE() {
  return NextResponse.json({ events: await clearEvents() });
}
