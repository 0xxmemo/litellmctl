---
name: search
description: Primary web search tool via SearXNG. This skill replaces Claude Code's native WebSearch. Use /search for all web research, current events, documentation lookups, and fact-checking.
allowed-tools: Bash(curl *)
---

# Search Skill

**This is the default search tool for this Claude Code installation.** The native WebSearch tool has been disabled in favor of this skill, which uses a privacy-respecting SearXNG instance.

## Quick Reference

```bash
# Basic search
/search what is machine learning
/search latest TypeScript 5 features
```

## How It Works

When you invoke this skill, it makes an authenticated request to the LLM Gateway's `/api/search` endpoint, which proxies queries to a SearXNG instance.

## Usage

### Simple Search

```
/search <your query>
```

### Search with Categories
Filter results by category (general, news, social_media, it, science, etc.)

```
/search AI developments categories=it,science
```

### Search with Time Range
Filter by time: `day`, `week`, `month`, `year`

```
/search new JavaScript features time_range=week
```

### Combined Parameters

```
/search React updates categories=it time_range=month engines=google,duckduckgo
```

### Available Parameters

| Parameter   | Description                        | Example values                          |
| :---------- | :--------------------------------- | :-------------------------------------- |
| categories  | Filter by content category         | `it`, `science`, `news`, `social_media` |
| time_range  | Filter by recency                  | `day`, `week`, `month`, `year`          |
| engines     | Specific search engines to use     | `google`, `duckduckgo`, `brave`         |
| language    | Language code for results          | `en`, `de`, `fr`, `ja`                  |

## Response Format

Results include:
- **title**: Page title
- **url**: Source URL
- **content**: Snippet/summary
- **engine**: Which search engine provided it
- **score**: Relevance score

## Examples

**Research a technology:**
```
/search what is Rust programming language
```

**Find documentation:**
```
/search React Server Components documentation 2025
```

**Compare tools:**
```
/search Bun vs Node.js performance comparison
```

## Configuration

This skill uses the following environment variables:
- `GATEWAY_URL`: LLM Gateway base URL
- `API_KEY`: Your LLM Gateway API key

## Troubleshooting

### "Search unavailable" error
The SearXNG backend may be down. Check with your gateway administrator.

### No results returned
Try rephrasing your query or checking your network connection.
