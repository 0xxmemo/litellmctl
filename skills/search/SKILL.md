---
name: search
description: Privacy-respecting web search via SearXNG. Use when you need to search the web for information, research topics, or find current documentation.
allowed-tools: Bash(curl *)
---

# Search Skill

Privacy-respecting web search powered by SearXNG. This skill provides authenticated search queries with JSON results.

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

### Search with Specific Categories

```
/search <query> in categories: programming,science
```

### Search with Time Range

```
/search <query> from last week
```

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
