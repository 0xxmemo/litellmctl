#!/usr/bin/env bash
# Web search skill executor - makes authenticated request to LLM Gateway search endpoint
set -euo pipefail

# Configuration (injected during installation)
GATEWAY_URL="${GATEWAY_URL:-__GATEWAY_URL__}"
API_KEY="${API_KEY:-__API_KEY__}"

# Read input from stdin if no args provided
if [ $# -eq 0 ]; then
    INPUT=$(cat)
else
    INPUT="${*}"
fi

if [ -z "$INPUT" ]; then
    echo "Usage: /web-search <your query> [categories=programming,science] [time_range=week] [engines=google,duckduckgo]"
    echo "Example: /web-search latest TypeScript features categories=it,time_range=month"
    exit 1
fi

# Parse query and parameters
QUERY="$INPUT"
CATEGORIES=""
TIME_RANGE=""
ENGINES=""
LANGUAGE=""

# Extract categories= parameter
if [[ "$INPUT" =~ categories=([^ ]+) ]]; then
    CATEGORIES="${BASH_REMATCH[1]}"
    QUERY=$(echo "$QUERY" | sed -E 's/ *categories=[^ ]+//g')
fi

# Extract time_range= parameter (supports: day, week, month, year)
if [[ "$INPUT" =~ time_range=([^ ]+) ]]; then
    TIME_RANGE="${BASH_REMATCH[1]}"
    QUERY=$(echo "$QUERY" | sed -E 's/ *time_range=[^ ]+//g')
fi

# Extract engines= parameter
if [[ "$INPUT" =~ engines=([^ ]+) ]]; then
    ENGINES="${BASH_REMATCH[1]}"
    QUERY=$(echo "$QUERY" | sed -E 's/ *engines=[^ ]+//g')
fi

# Extract language= parameter
if [[ "$INPUT" =~ language=([^ ]+) ]]; then
    LANGUAGE="${BASH_REMATCH[1]}"
    QUERY=$(echo "$QUERY" | sed -E 's/ *language=[^ ]+//g')
fi

# Trim whitespace from query
QUERY=$(echo "$QUERY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

if [ -z "$QUERY" ]; then
    echo "Error: No search query provided"
    exit 1
fi

# Build URL with query parameters
URL="${GATEWAY_URL}/api/search?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$QUERY'''))")"

# Add optional parameters
if [ -n "$CATEGORIES" ]; then
    URL="${URL}&categories=${CATEGORIES}"
fi

if [ -n "$TIME_RANGE" ]; then
    URL="${URL}&time_range=${TIME_RANGE}"
fi

if [ -n "$ENGINES" ]; then
    URL="${URL}&engines=${ENGINES}"
fi

if [ -n "$LANGUAGE" ]; then
    URL="${URL}&language=${LANGUAGE}"
fi

# Make the search request
RESPONSE=$(curl -sf "$URL" -H "Authorization: Bearer ${API_KEY}")

CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
    echo "Error: Web search request failed. Is the gateway running at ${GATEWAY_URL}?"
    exit 1
fi

# Parse and display results using Python (available on most systems)
echo "$RESPONSE" | python3 -c "
import sys
import json

try:
    data = json.load(sys.stdin)
    results = data.get('results', [])

    if not results:
        print('No results found for: $QUERY')
        sys.exit(0)

    print(f'Found {len(results)} results for: \"$QUERY\"\n')

    for i, r in enumerate(results[:10], 1):
        title = r.get('title', 'Untitled')
        url = r.get('url', '')
        content = r.get('content', '')
        engine = r.get('engine', '')
        score = r.get('score', 0)

        print(f'{i}. {title}')
        print(f'   URL: {url}')
        if content:
            print(f'   {content}')
        print(f'   (via {engine}, score: {score})')
        print()

except Exception as e:
    print(f'Error parsing results: {e}')
    print(sys.stdin.read())
"
