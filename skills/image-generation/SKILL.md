---
name: image-generation
description: Generate images via the LitellmCTL gateway (any configured image_generation model). Use whenever the user asks for a picture, illustration, icon, banner, logo, photo, diagram, or any other visual.
---

## Configuration

```bash
GATEWAY_URL=__GATEWAY_URL__
API_KEY=__API_KEY__
```

## Execute

```bash
# Required
PROMPT="${PROMPT:?set PROMPT to a detailed description of the image}"
# Optional
MODEL="${MODEL:-google/nano-banana-pro}"   # any model with mode=image_generation
N="${N:-1}"                                  # 1-4
OUT_DIR="${OUT_DIR:-/tmp}"

export MODEL PROMPT N OUT_DIR
export TS="$(date +%s)"
export RESP="$(mktemp)"
trap 'rm -f "$RESP"' EXIT

# Buffer the response to a temp file. A single image is ~1 MB of base64,
# which blows past ARG_MAX as a command argument *and* conflicts with a
# python3 heredoc if we try to pipe (heredoc redirects stdin and wins).
curl -fsS --max-time 180 -o "$RESP" "$GATEWAY_URL/v1/images/generations" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,os; print(json.dumps({"model":os.environ["MODEL"],"prompt":os.environ["PROMPT"],"n":int(os.environ["N"])}))')" \
  || { echo "ERROR: request to $GATEWAY_URL failed" >&2; exit 1; }

python3 <<'PY'
import os, json, base64, pathlib, sys
doc = json.load(open(os.environ["RESP"]))
out_dir = pathlib.Path(os.environ["OUT_DIR"])
ts = os.environ["TS"]
images = doc.get("data") or []
if not images:
    print("ERROR: no images returned", file=sys.stderr)
    print(json.dumps(doc)[:500], file=sys.stderr)
    sys.exit(1)
for i, img in enumerate(images):
    b64 = img.get("b64_json")
    if not b64:
        continue
    head = base64.b64decode(b64[:16], validate=False)
    ext = "png"
    if head.startswith(b"\xff\xd8\xff"): ext = "jpg"
    elif head.startswith(b"RIFF"):        ext = "webp"
    path = out_dir / f"image-{ts}-{i}.{ext}"
    path.write_bytes(base64.b64decode(b64))
    print(path)
PY
```

The script prints one absolute path per generated image (one per line). Open the file to view it, or embed it in your reply using `![alt](<path>)`.

## Params

- `PROMPT` (required) — detailed description of the image. Include style, subject, composition, lighting, mood when relevant.
- `MODEL` — any gateway model whose `model_info.mode == "image_generation"`. Defaults to `google/nano-banana-pro`.
- `N` — number of images (1-4). Default 1.
- `OUT_DIR` — where to write the files. Default `/tmp`.

To list configured image models on this gateway:

```bash
curl -fsS "$GATEWAY_URL/api/models/extended" -H "Authorization: Bearer $API_KEY" \
  | python3 -c "import sys,json; print('\n'.join(m['id'] for m in json.load(sys.stdin).get('models',[]) if m.get('mode')=='image_generation'))"
```

## Example

```bash
PROMPT="A polished red cube centered on a pure white background, studio softbox lighting, gentle shadow, 1:1 composition" \
  MODEL="google/nano-banana-pro" \
  OUT_DIR="$HOME/Desktop" \
  bash <this-skill>
# → /Users/<you>/Desktop/image-1713721234-0.jpg
```
