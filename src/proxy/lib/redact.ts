// Redaction for anything written to server logs.
//
// A failing upstream call can carry a leaked key or a Bearer header in its error
// message. The client only ever sees a generic error; the full detail is logged
// server-side, but it goes through redact() first so a credential never lands in
// a log line.

import { SECRET_LEAK_PATTERN } from '../../patterns/secret.js'

const SECRET_GLOBAL = new RegExp(SECRET_LEAK_PATTERN.source, 'g')
const BEARER_GLOBAL = /Bearer\s+\S+/g

export function redact(input: string): string {
  return input.replace(BEARER_GLOBAL, 'Bearer ***').replace(SECRET_GLOBAL, '***')
}
