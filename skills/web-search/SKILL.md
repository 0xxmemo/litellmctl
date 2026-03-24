---
name: web-search
description: Web search via SearXNG
---

## Configuration

```bash
GATEWAY_URL=__GATEWAY_URL__
API_KEY=__API_KEY__
```

## Execute

```bash
curl -s "$GATEWAY_URL/api/search?q=YOUR_QUERY" -H "Authorization: Bearer $API_KEY"
```

## Params

Append to URL as needed:
- `&categories=it` (it, science, news, social_media)
- `&time_range=week` (day, week, month, year)
- `&engines=google` (google, duckduckgo, brave)
- `&language=en` (en, de, fr, ja)

## Example

```bash
curl -s "$GATEWAY_URL/api/search?q=latest+AI+trends&categories=it&time_range=week" \
  -H "Authorization: Bearer $API_KEY"
```
