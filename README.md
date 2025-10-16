# Fireplexity v2

AI search engine with web, news, and images.

<img src="https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExNjBxbWFxamZycWRkMmVhMGFiZnNuZjMxc3lpNHpuamR4OWlwa3F4NSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/QbfaTCB1OmkRmIQwzJ/giphy.gif" width="100%" alt="Fireplexity Demo" />

## Setup

```bash
git clone https://github.com/mendableai/fireplexity.git
cd fireplexity
npm install
```

## Configure

```bash
cp .env.example .env.local
```

Add your keys to `.env.local`:
```
FIRECRAWL_API_KEY=fc-your-api-key
FIRECRAWL_BASE_URL=https://api.firecrawl.dev
SEARXNG_BASE_URL=https://searxng.your-domain.com
SEARXNG_API_KEY=                                  # optional
SEARXNG_LANGUAGE=en                               # optional
SEARXNG_SAFESEARCH=1                              # optional
SEARXNG_GENERAL_CATEGORY=general                  # optional
SEARXNG_NEWS_CATEGORY=news                        # optional
SEARXNG_IMAGES_CATEGORY=images                    # optional
OPENAI_API_KEY=sk-your-openai-api-key
OPENAI_BASE_URL=https://api.openai.com/v1       # optional
OPENAI_MODEL=gpt-4o-mini                        # optional
OPENAI_API_MODE=chat                            # optional (use chat for chat-completions proxies)
FIRECRAWL_SCRAPE_LIMIT=5                        # optional
```

## Run

```bash
npm run dev
```

Open http://localhost:3000

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/mendableai/fireplexity)

## Get API Keys

- [Firecrawl](https://firecrawl.dev)
- [OpenAI (or compatible proxy)](https://platform.openai.com)

MIT License
