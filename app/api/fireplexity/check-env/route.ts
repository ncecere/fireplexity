import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    hasFirecrawlKey: !!process.env.FIRECRAWL_API_KEY,
    hasFirecrawlBaseUrl: !!process.env.FIRECRAWL_BASE_URL,
    hasSearxBaseUrl: !!process.env.SEARXNG_BASE_URL,
    hasSearxApiKey: !!process.env.SEARXNG_API_KEY,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasOpenAIBaseUrl: !!process.env.OPENAI_BASE_URL,
    hasOpenAIModel: !!process.env.OPENAI_MODEL,
    hasOpenAIApiMode: !!process.env.OPENAI_API_MODE
  })
}
