# M6 container contrast: the honest "other end of the spectrum".
#
# WHY A CONTAINER AND NOT AN ISOLATE (the whole point of this milestone):
# Binary `.fit` parsing needs a full CPython environment plus a FIT decoding library.
# That cannot run in a V8 isolate — so this workload FORCES the container runtime. The
# training-policy plugins are pure JS logic → V8 isolate (ms startup, ~free); this parser
# needs Python + native-ish decoding → container (seconds of cold start, real cost). Same
# trust design (pure function in, all writes back on the validated DO path), different
# runtime, and that difference is measured (see WIRING.md for where cold-start is timed).
#
# python:3.12-slim keeps the image small so cold start is as honest-low as possible while
# still being a genuinely container-only workload.
FROM python:3.12-slim

WORKDIR /app

# Install deps first so Docker layer-caches them independently of the source.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pure-function parser + stdlib HTTP server. No fixtures baked in (they are test-only).
COPY server.py .

# Cloudflare Containers route external traffic to the port the container listens on.
# server.py reads PORT (defaults to 8080). EXPOSE is documentation; the class in
# wrangler/WIRING.md sets defaultPort to match.
ENV PORT=8080
EXPOSE 8080

# Pure function, no writes, no model, no outbound calls. Just: bytes in → sets JSON out.
CMD ["python", "server.py"]
