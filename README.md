# cassette

record and replay openai-compatible api traffic, so agent tests run offline
and deterministic. node 18+, zero dependencies.

the problem: your agent's tests hit a live model. slow, costs money, flakes.
cassette sits in the middle once, records every request/response pair to a
tape file, then replays the tape forever after.

## install

```sh
npm i -g .
# or just
node bin/cassette.js --help
```

## record

```sh
cassette record --tape gpt-smoke --upstream https://api.openai.com
# proxy is now on http://127.0.0.1:11434
# point your client at it, run your agent, ctrl-c when done
```

every exchange lands in `./tapes/gpt-smoke.json`. authorization headers,
api keys in query strings, and credential-looking json fields are stored as
`[redacted]`, so tapes are safe to commit.

## replay

```sh
cassette replay --tape gpt-smoke
OPENAI_BASE_URL=http://127.0.0.1:11434 npm test
```

requests are matched by method + path + body (key order and spacing don't
matter). streaming responses replay chunk for chunk. a request with no
recorded match gets a 502 telling you what to do.

useful flags:

- `--passthrough --upstream URL` - unmatched requests hit the real api and
  get appended to the tape. good for growing a tape over time.
- `--chunk-delay MS` - replay streamed chunks with realistic timing.
- `-v` - log hits and misses.

## tapes

```sh
cassette list
cassette show gpt-smoke
cassette rm old-tape
```

a tape is just json: name, upstream, and a list of exchanges with the
request (method, path, redacted headers/body, fingerprint) and the response
(status, headers, body or sse chunks). hand-editable if you need to.

## how matching works

each request gets a sha256 fingerprint of method + path + canonical json
body. two identical requests in a row replay the first two recorded
responses in order, then wrap around. query-string api keys are redacted
before fingerprinting, so rotating keys don't break matching.

## why not just mockllm

a hand-written fake is great for unit tests. cassette is for the next step:
capture one real session against the actual api, then run your whole eval
suite against the tape a hundred times for free.

## license

mit
