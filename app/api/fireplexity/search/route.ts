import { NextResponse } from 'next/server'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText, generateText, createUIMessageStream, createUIMessageStreamResponse, convertToModelMessages } from 'ai'
import type { ModelMessage } from 'ai'
import { detectCompanyTicker } from '@/lib/company-ticker-map'
import { selectRelevantContent } from '@/lib/content-selection'

export async function POST(request: Request) {
  const requestId = Math.random().toString(36).substring(7)
  
  try {
    const body = await request.json()
    const messages = body.messages || []
    
    // Extract query from v5 message structure (messages have parts array)
    let query = body.query
    if (!query && messages.length > 0) {
      const lastMessage = messages[messages.length - 1]
      if (lastMessage.parts) {
        // v5 structure
        const textParts = lastMessage.parts.filter((p: any) => p.type === 'text')
        query = textParts.map((p: any) => p.text).join(' ')
      } else if (lastMessage.content) {
        // Fallback for v4 structure
        query = lastMessage.content
      }
    }

    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 })
    }

    // Always read credentials from the environment so the same config applies to every user
    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY
    const firecrawlBaseUrl = process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev'
    const searxBaseUrlEnv = process.env.SEARXNG_BASE_URL
    const searxApiKey = process.env.SEARXNG_API_KEY
    const searxLanguage = process.env.SEARXNG_LANGUAGE
    const searxSafeSearch = process.env.SEARXNG_SAFESEARCH
    const searxGeneralCategory = process.env.SEARXNG_GENERAL_CATEGORY || 'general'
    const searxNewsCategory = process.env.SEARXNG_NEWS_CATEGORY || 'news'
    const searxImagesCategory = process.env.SEARXNG_IMAGES_CATEGORY || 'images'
    const openAIApiKey = process.env.OPENAI_API_KEY
    const openAIBaseUrl = process.env.OPENAI_BASE_URL
    const openAIModel = process.env.OPENAI_MODEL || 'gpt-4o-mini'
    const openAIProviderMode = process.env.OPENAI_API_MODE?.toLowerCase() || 'responses'
    
    if (!firecrawlApiKey) {
      return NextResponse.json({ error: 'Firecrawl API key not configured' }, { status: 500 })
    }
    
    if (!openAIApiKey) {
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 })
    }

    if (!searxBaseUrlEnv) {
      return NextResponse.json({ error: 'SearxNG base URL not configured' }, { status: 500 })
    }

    const searxBaseUrl = searxBaseUrlEnv.replace(/\/$/, '')

    // Configure OpenAI client using the AI SDK with optional custom base URL
    const openai = createOpenAI({
      apiKey: openAIApiKey,
      baseURL: openAIBaseUrl
    })
    const selectModel = () => {
      switch (openAIProviderMode) {
        case 'chat':
        case 'chat-completions':
          return openai.chat(openAIModel)
        case 'completions':
        case 'completion':
          return openai.completion(openAIModel)
        case 'responses':
        default:
          return openai(openAIModel)
      }
    }
    const getOpenAITextModel = () => selectModel()

    // Always perform a fresh search for each query to ensure relevant results
    const isFollowUp = messages.length > 2
    
    // Create a UIMessage stream with custom data parts
    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        try {
          let sources: Array<{
            url: string
            title: string
            description?: string
            content?: string
            markdown?: string
            publishedDate?: string
            author?: string
            image?: string
            favicon?: string
            siteName?: string
          }> = []
          let newsResults: Array<{
            url: string
            title: string
            description?: string
            publishedDate?: string
            source?: string
            image?: string
          }> = []
          let imageResults: Array<{
            url: string
            title: string
            thumbnail?: string
            source?: string
            width?: number
            height?: number
            position?: number
          }> = []
          let context = ''
          
          // Send status updates as transient data parts
          writer.write({
            type: 'data-status',
            id: 'status-1',
            data: { message: 'Starting search...' },
            transient: true
          })
          
          writer.write({
            type: 'data-status',
            id: 'status-2',
            data: { message: 'Searching for relevant sources...' },
            transient: true
          })
          // Normalized search endpoint
          const baseUrl = firecrawlBaseUrl.endsWith('/')
            ? firecrawlBaseUrl.slice(0, -1)
            : firecrawlBaseUrl
          const searchEndpoint = `${baseUrl}/v2/search`

          // Helper to perform a SearxNG search for a specific source/category
          const performSourceSearch = async (category: string | null) => {
            const params = new URLSearchParams({
              q: query,
              format: 'json'
            })

            if (category) {
              params.set('categories', category)
            }

            if (searxLanguage) {
              params.set('language', searxLanguage)
            }

            if (searxSafeSearch) {
              params.set('safesearch', searxSafeSearch)
            }

            if (searxApiKey) {
              params.set('api_key', searxApiKey)
            }

            const searxSearchUrl = new URL('/search', `${searxBaseUrl}/`)
            searxSearchUrl.search = params.toString()

            const response = await fetch(searxSearchUrl.toString(), {
              method: 'GET',
              headers: {
                'Accept': 'application/json'
              }
            })

            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}))
              throw new Error(
                `SearxNG search error: ${errorData.error || response.statusText}`
              )
            }

            const json = await response.json()
            return json || {}
          }

          // Run SearxNG queries in parallel (web/news/images)
          const [webData, newsData, imagesData] = await Promise.all([
            performSourceSearch(searxGeneralCategory),
            (async () => {
              try {
                return await performSourceSearch(searxNewsCategory)
              } catch (error) {
                console.warn('[fireplexity] news source unavailable', {
                  requestId,
                  message: error instanceof Error ? error.message : error
                })
                return null
              }
            })(),
            (async () => {
              try {
                return await performSourceSearch(searxImagesCategory)
              } catch (error) {
                console.warn('[fireplexity] images source unavailable', {
                  requestId,
                  message: error instanceof Error ? error.message : error
                })
                return null
              }
            })()
          ])

          // Extract results from SearxNG responses (falling back when instances map data differently)
          const webResults = Array.isArray(webData.results) ? webData.results : []
          const newsSource = Array.isArray(newsData?.results)
            ? newsData.results
            : Array.isArray(newsData?.news)
            ? newsData.news
            : []
          const imageSource = Array.isArray(imagesData?.results)
            ? imagesData.results
            : Array.isArray(imagesData?.images)
            ? imagesData.images
            : []
          
          const buildHostInfo = (url: string | undefined) => {
            if (!url) return { host: undefined, siteName: undefined }
            try {
              const { hostname } = new URL(url)
              const cleaned = hostname.replace(/^www\./, '')
              return { host: hostname, siteName: cleaned }
            } catch {
              return { host: undefined, siteName: undefined }
            }
          }

          const buildFavicon = (host: string | undefined) =>
            host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : undefined
          
          // Transform general web sources
          sources = webResults
            .map((item: any) => {
              const url = item.url || item.href || item.link
              if (!url) return null
              const { host, siteName } = buildHostInfo(url)
              return {
                url,
                title: item.title || url,
                description: item.content || item.summary || item.abstract,
                content: item.content,
                markdown: undefined as string | undefined,
                favicon: buildFavicon(host),
                image: item.img_src || item.thumbnail || item.image,
                siteName: siteName || host
              }
            })
            .filter(Boolean) as Array<{
              url: string
              title: string
              description?: string
              content?: string
              markdown?: string
              favicon?: string
              image?: string
              siteName?: string
            }>

          // Transform news results from SearxNG output (with fallbacks)
          newsResults = newsSource.map((item: any) => {
            const itemUrl = item.url || item.link || item.pageUrl || item.sourceUrl;
            const imageUrl =
              item.imageUrl ||
              item.image_url ||
              item.image ||
              item.thumbnail ||
              item.thumbnailUrl ||
              item.img_src ||
              item.img ||
              item.img_srcset;
            const publishedDate =
              item.date ||
              item.publishedDate ||
              item.published_at ||
              item.publishedAt ||
              item.published ||
              item.time;
            const { siteName } = buildHostInfo(itemUrl)
            return {
              url: itemUrl,
              title: item.title,
              description: item.content || item.summary || item.description,
              publishedDate,
              source: item.source || item.engines?.[0] || siteName,
              image: imageUrl  // Support different key names
            };
          }).filter((item: any) => item.url) || []

          // Transform image results - support multiple field names from API variations
          imageResults = imageSource.map((item: any) => {
            const targetUrl = item.url || item.link || item.pageUrl || item.sourceUrl || item.img_src;
            const imageUrl =
              item.imageUrl ||
              item.image_url ||
              item.image ||
              item.thumbnail ||
              item.thumbnailUrl ||
              item.img_src ||
              item.thumbnail_src;
            if (!targetUrl) {
              return null;
            }
            return {
              url: targetUrl,
              title: item.title || 'Untitled',
              thumbnail: imageUrl,
              source: buildHostInfo(targetUrl).siteName,
              width: item.imageWidth,
              height: item.imageHeight,
              position: item.position
            };
          }).filter(Boolean) || []  // Filter out null entries
          
          // Optionally enrich top sources with Firecrawl scraping for markdown/context
          if (sources.length > 0) {
            writer.write({
              type: 'data-status',
              id: 'status-3a',
              data: { message: 'Fetching full article content...' },
              transient: true
            })

            const firecrawlScrapeEndpoint = `${firecrawlBaseUrl.replace(/\/$/, '')}/v1/scrape`
            const parsedLimit = Number(process.env.FIRECRAWL_SCRAPE_LIMIT ?? 5)
            const scrapeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 5
            const targets = sources.slice(0, Math.max(1, scrapeLimit))

            const scraped = await Promise.allSettled(
              targets.map(async (source) => {
                const scrapeResponse = await fetch(firecrawlScrapeEndpoint, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${firecrawlApiKey}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    url: source.url,
                    formats: ['markdown'],
                    onlyMainContent: true
                  })
                })

                if (!scrapeResponse.ok) {
                  const errorData = await scrapeResponse.json().catch(() => ({}))
                  throw new Error(errorData.error || scrapeResponse.statusText)
                }

                const scrapeJson = await scrapeResponse.json()
                return {
                  url: source.url,
                  markdown: scrapeJson.data?.markdown || undefined,
                  content: scrapeJson.data?.content || undefined
                }
              })
            )

            scraped.forEach((result) => {
              if (result.status === 'fulfilled') {
                const match = sources.find((s) => s.url === result.value.url)
                if (match) {
                  match.markdown = result.value.markdown || match.markdown
                  match.content = result.value.content || match.content
                }
              }
            })

            // Send an updated payload so UI components can reflect enriched content if needed
            writer.write({
              type: 'data-sources',
              id: 'sources-1',
              data: {
                sources,
                newsResults,
                imageResults
              }
            })
          } else {
            // Even without enrichment, send the collected sources to the client
            writer.write({
              type: 'data-sources',
              id: 'sources-1',
              data: {
                sources,
                newsResults,
                imageResults
              }
            })
          }

          if (sources.length > 0) {
            writer.write({
              type: 'data-status',
              id: 'status-2b',
              data: { message: 'Analyzing detailed content...' },
              transient: true
            })
          }

          // Small delay to ensure sources render/update before proceeding
          await new Promise(resolve => setTimeout(resolve, 150))
          
          // Update status
          writer.write({
            type: 'data-status',
            id: 'status-3',
            data: { message: 'Analyzing sources and generating answer...' },
            transient: true
          })
          
          // Detect if query is about a company
          const ticker = detectCompanyTicker(query)
          if (ticker) {
            writer.write({
              type: 'data-ticker',
              id: 'ticker-1',
              data: { symbol: ticker }
            })
          }
          
          // Prepare context from sources with intelligent content selection
          context = sources
            .map((source: { title: string; markdown?: string; content?: string; url: string }, index: number) => {
              const content = source.markdown || source.content || ''
              const relevantContent = selectRelevantContent(content, query, 2000)
              return `[${index + 1}] ${source.title}\nURL: ${source.url}\n${relevantContent}`
            })
            .join('\n\n---\n\n')

          
          // Prepare messages for the AI
          let aiMessages: ModelMessage[] = []
          
          if (!isFollowUp) {
            // Initial query with sources
            aiMessages = [
              {
                role: 'system',
                content: `You are a friendly assistant that helps users find information.

                CRITICAL FORMATTING RULE:
                - NEVER use LaTeX/math syntax ($...$) for regular numbers in your response
                - Write ALL numbers as plain text: "1 million" NOT "$1$ million", "50%" NOT "$50\\%$"
                - Only use math syntax for actual mathematical equations if absolutely necessary
                
                RESPONSE STYLE:
                - For greetings (hi, hello), respond warmly and ask how you can help
                - For simple questions, give direct, concise answers
                - For complex topics, provide detailed explanations only when needed
                - Match the user's energy level - be brief if they're brief
                
                FORMAT:
                - Use markdown for readability when appropriate
                - Keep responses natural and conversational
                - Include citations inline as [1], [2], etc. when referencing specific sources
                - Citations should correspond to the source order (first source = [1], second = [2], etc.)
                - Use the format [1] not CITATION_1 or any other format`
              },
              {
                role: 'user',
                content: `Answer this query: "${query}"\n\nBased on these sources:\n${context}`
              }
            ]
          } else {
            // Follow-up question - still use fresh sources from the new search
            aiMessages = [
              {
                role: 'system',
                content: `You are a friendly assistant continuing our conversation.

                CRITICAL FORMATTING RULE:
                - NEVER use LaTeX/math syntax ($...$) for regular numbers in your response
                - Write ALL numbers as plain text: "1 million" NOT "$1$ million", "50%" NOT "$50\\%$"
                - Only use math syntax for actual mathematical equations if absolutely necessary
                
                REMEMBER:
                - Keep the same conversational tone from before
                - Build on previous context naturally
                - Match the user's communication style
                - Use markdown when it helps clarity
                - Include citations inline as [1], [2], etc. when referencing specific sources
                - Citations should correspond to the source order (first source = [1], second = [2], etc.)
                - Use the format [1] not CITATION_1 or any other format`
              },
              // Include conversation context - convert UIMessages to ModelMessages
              ...convertToModelMessages(messages.slice(0, -1)),
              // Add the current query with the fresh sources
              {
                role: 'user',
                content: `Answer this query: "${query}"\n\nBased on these sources:\n${context}`
              }
            ]
          }
          
          // Stream the text generation using the configured OpenAI-compatible model
          const result = streamText({
            model: getOpenAITextModel(),
            messages: aiMessages,
            temperature: 0.7,
            maxRetries: 2
          })
          
          // Merge the AI stream into our UIMessage stream
          writer.merge(result.toUIMessageStream())
          
          // Get the full answer for follow-up generation
          const fullAnswer = await result.text
          
          // Generate follow-up questions
          const conversationPreview = isFollowUp 
            ? messages.map((m: { role: string; parts?: any[] }) => {
                const content = m.parts 
                  ? m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ')
                  : ''
                return `${m.role}: ${content}`
              }).join('\n\n')
            : `user: ${query}`
            
          try {
            const followUpResponse = await generateText({
              model: getOpenAITextModel(),
              messages: [
                {
                  role: 'system',
                  content: `Generate 5 natural follow-up questions based on the query and answer.\n                \n                ONLY generate questions if the query warrants them:\n                - Skip for simple greetings or basic acknowledgments\n                - Create questions that feel natural, not forced\n                - Make them genuinely helpful, not just filler\n                - Focus on the topic and sources available\n                \n                If the query doesn't need follow-ups, return an empty response.
                  ${isFollowUp ? 'Consider the full conversation history and avoid repeating previous questions.' : ''}
                  Return only the questions, one per line, no numbering or bullets.`
                },
                {
                  role: 'user',
                  content: `Query: ${query}\n\nAnswer provided: ${fullAnswer.substring(0, 500)}...\n\n${sources.length > 0 ? `Available sources about: ${sources.map((s: { title: string }) => s.title).join(', ')}\n\n` : ''}Generate 5 diverse follow-up questions that would help the user learn more about this topic from different angles.`
                }
              ],
              temperature: 0.7,
              maxRetries: 2
            })
            
            // Process follow-up questions
            const followUpQuestions = followUpResponse.text
              .split('\n')
              .map((q: string) => q.trim())
              .filter((q: string) => q.length > 0)
              .slice(0, 5)

            // Send follow-up questions as a data part
            writer.write({
              type: 'data-followup',
              id: 'followup-1',
              data: { questions: followUpQuestions }
            })
          } catch (followUpError) {
            // Error generating follow-up questions
          }
          
        } catch (error) {
          console.error('[fireplexity] search execution error', {
            requestId,
            message: error instanceof Error ? error.message : error
          })
          
          // Handle specific error types
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          const statusCode = error && typeof error === 'object' && 'statusCode' in error 
            ? error.statusCode 
            : error && typeof error === 'object' && 'status' in error
            ? error.status
            : undefined
          
          // Provide user-friendly error messages
          const errorResponses: Record<number, { error: string; suggestion?: string }> = {
            401: {
              error: 'Invalid API key',
              suggestion: 'Please check your Firecrawl API key is correct.'
            },
            402: {
              error: 'Insufficient credits',
              suggestion: 'You\'ve run out of Firecrawl credits. Please upgrade your plan.'
            },
            429: {
              error: 'Rate limit exceeded',
              suggestion: 'Too many requests. Please wait a moment and try again.'
            },
            504: {
              error: 'Request timeout',
              suggestion: 'The search took too long. Try a simpler query or fewer sources.'
            }
          }
          
          const errorResponse = statusCode && errorResponses[statusCode as keyof typeof errorResponses] 
            ? errorResponses[statusCode as keyof typeof errorResponses]
            : { error: errorMessage }
          
          writer.write({
            type: 'data-error',
            id: 'error-1',
            data: {
              error: errorResponse.error,
              ...(errorResponse.suggestion ? { suggestion: errorResponse.suggestion } : {}),
              ...(statusCode ? { statusCode } : {})
            }
          })
        }
      }
    })
    
    return createUIMessageStreamResponse({ stream })
    
  } catch (error) {
    console.error('[fireplexity] route error', {
      requestId,
      message: error instanceof Error ? error.message : error
    })
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : ''
    return NextResponse.json(
      { error: 'Search failed', message: errorMessage, details: errorStack },
      { status: 500 }
    )
  }
}
